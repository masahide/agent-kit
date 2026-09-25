#!/usr/bin/env python3
"""doc-desk Mod のローカル受信サーバ (一回限り) と、OS ごとに違う小さな操作。

Mod はシェル (sh) を使わず、このスクリプトのサブコマンドだけを呼びます。
OS ごとの違い (背景での起動、ブラウザ、ファイルの削除、プロセスの停止) はここで吸収し、
macOS、Linux、Windows で同じ argv のまま動かします。

  start --token T --html H --out O [--port N]   serve を切り離して起動し、{"port": n, "pid": n} を 1 行出して終わる
  serve --token T --html H --out O [--port N]   受信サーバを前面で動かす (start が使う)
  open URL                                      既定のブラウザで URL を開く
  clean PATH...                                 ファイルを消す (無いものは飛ばす)
  stop PID                                      受信サーバを止める (もう無ければ何もしない)

受信サーバは HTML シートを配り、/answer への POST を 1 件ファイルに書いて終了します。
python3 の標準ライブラリだけを使い、127.0.0.1 にだけ bind します。ログは出しません。

経路 (すべて ?t=<token> が必要。不一致は 403):
  GET  /        -> HTML (200)
  GET  /wait    -> 回答が POST 済みなら即 {"answered":true}。未着なら回答の POST か
                   &timeout=<秒> (上限 WAIT_TIMEOUT_MAX 秒) の経過まで応答を保留し、
                   経過なら {"answered":false} を返す (Mod の同期待ちが使うロングポーリング)
  POST /answer  -> 本文を <out>.tmp に書き、os.replace で <out> にして {"ok":true} を返し、
                   保留中の /wait に {"answered":true} を返してから終了
  それ以外      -> 404

/wait と POST を同時に捌くため ThreadingHTTPServer を使います。
serve は listen した直後に {"port": n, "pid": n} を stdout に 1 行書いて stdout を閉じ、以後は何も書きません。
start はその 1 行を読んで自分の stdout に写して終わります (Mod はこの 1 行で URL を組みます)。
IDLE_TIMEOUT_SECONDS 秒のあいだ回答が無ければ終了します (保留中の /wait には {"answered":false} を返します)。
ポートは --port があればそれを使い、塞がっていれば (または無ければ) OS に選ばせます。
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# /wait が 1 回に保留する上限 (秒)。Mod 側は中断後 5 秒 (lingerMs) までしか動けないので、
# それより短い 4 秒で呼びます。ここはその上限を丸めるだけです。
WAIT_TIMEOUT_MAX = 5.0

# 回答が無いまま受信サーバが待つ上限 (秒)。
IDLE_TIMEOUT_SECONDS = 3600

# start が serve の 1 行を待つ上限 (秒)。超えたら serve を止め、何も出さずに終わる。
START_TIMEOUT_SECONDS = 3.0

IS_WINDOWS = os.name == 'nt'


def parse_args(argv):
    parser = argparse.ArgumentParser(description='doc-desk Mod の受信サーバ')
    commands = parser.add_subparsers(dest='command', required=True)
    for name, help_text in (('start', '受信サーバを切り離して起動する'), ('serve', '受信サーバを前面で動かす')):
        command = commands.add_parser(name, help=help_text)
        command.add_argument('--token', required=True, help='?t= で照合するトークン')
        command.add_argument('--html', required=True, help='配る HTML のパス')
        command.add_argument('--out', required=True, help='回答 JSON を書くパス')
        command.add_argument('--port', type=int, default=0, help='使いたい port (塞がっていれば OS に選ばせる)')
    commands.add_parser('open', help='既定のブラウザで URL を開く').add_argument('url')
    commands.add_parser('clean', help='ファイルを消す').add_argument('paths', nargs='+')
    commands.add_parser('stop', help='受信サーバを止める').add_argument('pid', type=int)
    return parser.parse_args(argv)


def write_atomically(path, text):
    """tmp に書いてから os.replace で置き、途中の状態が見えないようにする。"""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.replace(tmp, path)


def wait_timeout_of(query):
    """?timeout= を秒として読み、0〜WAIT_TIMEOUT_MAX に丸める。読めなければ上限。"""
    try:
        seconds = float(query.get('timeout', [str(WAIT_TIMEOUT_MAX)])[0])
    except ValueError:
        return WAIT_TIMEOUT_MAX
    return max(0.0, min(WAIT_TIMEOUT_MAX, seconds))


def detached_options():
    """親 (Mod の process.run) が終わっても残り、親の出力をつかまない子の起動オプション。

    process.run は子の出力が閉じるまで戻らないので、標準入出力は DEVNULL にします
    (start は serve の stdout だけを PIPE に差し替え、serve は 1 行書いたらそれを閉じます)。
    Windows は新しいプロセスグループとしてコンソールから切り離し、POSIX は新しいセッションにします。
    """
    options = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL, 'close_fds': True}
    if IS_WINDOWS:
        options['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    return options


def start(args):
    """serve を切り離して起動し、serve が出す {"port": n, "pid": n} の 1 行を写して終わる。

    serve の stdout だけを pipe で受けます (stdin と stderr は DEVNULL)。serve は 1 行書いたら
    stdout を閉じるので、start が先に終わっても serve は書き込みで止まりません。
    START_TIMEOUT_SECONDS 秒のうちに 1 行来なければ serve を止め、何も出さずに終わります
    (Mod はこれを受信サーバの起動失敗として扱います)。
    """
    command = [
        sys.executable,
        os.path.abspath(__file__),
        'serve',
        '--token', args.token,
        '--html', args.html,
        '--out', args.out,
        '--port', str(args.port),
    ]
    options = {**detached_options(), 'stdout': subprocess.PIPE}
    if IS_WINDOWS:
        # 親がジョブで子をまとめて止める設定でも残るよう、まずジョブから外して起動する。
        # ジョブが外すことを許していなければ OSError になるので、外さずに起動し直す
        try:
            child = subprocess.Popen(command, **{**options, 'creationflags': options['creationflags'] | subprocess.CREATE_BREAKAWAY_FROM_JOB})
        except OSError:
            child = subprocess.Popen(command, **options)
    else:
        child = subprocess.Popen(command, **options)

    lines = []
    reader = threading.Thread(target=lambda: lines.append(child.stdout.readline()), daemon=True)
    reader.start()
    reader.join(START_TIMEOUT_SECONDS)
    line = lines[0].decode('utf-8', 'replace').strip() if lines else ''
    if not line:
        try:
            child.kill()
        except OSError:
            pass
        return 1
    print(line, flush=True)
    return 0


def open_url(url):
    """既定のブラウザで開く (macOS は open、Windows は関連付け、それ以外は xdg-open)。"""
    if IS_WINDOWS:
        os.startfile(url)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', url], **detached_options())
    else:
        subprocess.Popen(['xdg-open', url], **detached_options())
    return 0


def clean(paths):
    """ファイルを消す。無いものは飛ばす (rm -f の代わり)。"""
    for path in paths:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    return 0


def stop(pid):
    """受信サーバを止める。もう無ければ何もしない (kill の代わり)。"""
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    return 0


def bind_server(server_class, handler, port):
    """127.0.0.1 の port で listen する。port が 0、範囲外 (1〜65535 でない)、塞がっているなら OS に選ばせる。"""
    if 0 < port < 65536:
        try:
            return server_class(('127.0.0.1', port), handler)
        except (OSError, OverflowError):
            pass
    return server_class(('127.0.0.1', 0), handler)


def announce(line):
    """1 行を stdout に書いて stdout を閉じる。以後 stdout には何も書かない。

    sys.stdout.close() は fd 1 を閉じない (closefd=False) ので、fd も閉じて start の読み取りを終わらせます。
    """
    sys.stdout.write(line + '\n')
    sys.stdout.flush()
    sys.stdout.close()
    try:
        os.close(1)
    except OSError:
        pass


def serve(args):
    with open(args.html, encoding='utf-8') as handle:
        html = handle.read()

    # 回答の状態。release は「回答が書けた」か「終了する」で set され、保留中の /wait を起こします。
    # answered は回答ファイルを書き終えたあとにだけ True になります (release の set より前)。
    state = {'answered': False}
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body, content_type='text/plain; charset=utf-8', code=200):
            data = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def _query(self):
            return parse_qs(urlparse(self.path).query)

        def _authorized(self):
            token = self._query().get('t', [''])[0]
            return token == args.token

        def _shutdown_later(self):
            # serve_forever と同じスレッドから shutdown を呼ぶと止まるため、別スレッドで呼ぶ
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def do_GET(self):
            if not self._authorized():
                return self._send('forbidden', code=403)
            path = urlparse(self.path).path
            if path == '/':
                return self._send(html, 'text/html; charset=utf-8')
            if path == '/wait':
                # 回答済みなら即返す。未着なら POST か timeout まで保留する
                if not state['answered']:
                    release.wait(wait_timeout_of(self._query()))
                body = '{"answered":true}' if state['answered'] else '{"answered":false}'
                return self._send(body, 'application/json')
            return self._send('not found', code=404)

        def do_POST(self):
            if not self._authorized():
                return self._send('forbidden', code=403)
            if urlparse(self.path).path != '/answer':
                return self._send('not found', code=404)
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length).decode('utf-8')
            write_atomically(args.out, body)
            # ファイルを書き終えてから保留中の /wait を起こす (Mod は /wait の応答後にファイルを読む)
            state['answered'] = True
            release.set()
            self._send('{"ok":true}', 'application/json')
            self._shutdown_later()

        def log_message(self, *log_args):
            # ログは出さない
            pass

    class Server(ThreadingHTTPServer):
        # 応答中の /wait スレッドを終了時に待つ (daemon にすると応答前に切られる)。
        # server_close は block_on_close (既定 True) で全スレッドの終了を待つ
        daemon_threads = False
        # Windows の SO_REUSEADDR は使用中の port も取れてしまう (--port で他のサーバを乗っ取る) ので、
        # Windows では付けずに SO_EXCLUSIVEADDRUSE を付ける。POSIX は TIME_WAIT の port を取り直すために付ける
        allow_reuse_address = not IS_WINDOWS

        def server_bind(self):
            if IS_WINDOWS:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    server = bind_server(Server, Handler, args.port)
    port = server.server_address[1]
    announce(json.dumps({'port': port, 'pid': os.getpid()}))

    timer = threading.Timer(IDLE_TIMEOUT_SECONDS, server.shutdown)
    timer.daemon = True
    timer.start()

    try:
        server.serve_forever()
    finally:
        # 終了する: 保留中の /wait を {"answered":false} で解放してから閉じる
        release.set()
        server.server_close()
    return 0


def main(argv):
    args = parse_args(argv)
    if args.command == 'start':
        return start(args)
    if args.command == 'serve':
        return serve(args)
    if args.command == 'open':
        return open_url(args.url)
    if args.command == 'clean':
        return clean(args.paths)
    return stop(args.pid)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
