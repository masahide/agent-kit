#!/usr/bin/env python3
"""Document Interview Mod のローカル受信サーバ (一回限り)。

HTML シートを配り、/answer への POST を 1 件ファイルに書いて終了します。
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
--port-file には {"port": n, "pid": n} を JSON で書きます (tmp に書いて os.replace)。
IDLE_TIMEOUT_SECONDS 秒のあいだ回答が無ければ終了します (保留中の /wait には {"answered":false} を返します)。
ポートは OS に選ばせます。
"""
import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# /wait が 1 回に保留する上限 (秒)。Mod 側は中断後 5 秒 (lingerMs) までしか動けないので、
# それより短い 4 秒で呼びます。ここはその上限を丸めるだけです。
WAIT_TIMEOUT_MAX = 5.0

# 回答が無いまま受信サーバが待つ上限 (秒)。
IDLE_TIMEOUT_SECONDS = 3600


def parse_args():
    parser = argparse.ArgumentParser(description='Document Interview Mod の受信サーバ')
    parser.add_argument('--port-file', required=True, help='{"port": n, "pid": n} を書くパス')
    parser.add_argument('--token', required=True, help='?t= で照合するトークン')
    parser.add_argument('--html', required=True, help='配る HTML のパス')
    parser.add_argument('--out', required=True, help='回答 JSON を書くパス')
    return parser.parse_args()


ARGS = parse_args()

with open(ARGS.html, encoding='utf-8') as handle:
    HTML = handle.read()

# 回答の状態。RELEASE は「回答が書けた」か「終了する」で set され、保留中の /wait を起こします。
# ANSWERED は回答ファイルを書き終えたあとにだけ True になります (RELEASE の set より前)。
STATE = {'answered': False}
RELEASE = threading.Event()


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
        return token == ARGS.token

    def _shutdown_later(self):
        # serve_forever と同じスレッドから shutdown を呼ぶと止まるため、別スレッドで呼ぶ
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def do_GET(self):
        if not self._authorized():
            return self._send('forbidden', code=403)
        path = urlparse(self.path).path
        if path == '/':
            return self._send(HTML, 'text/html; charset=utf-8')
        if path == '/wait':
            # 回答済みなら即返す。未着なら POST か timeout まで保留する
            if not STATE['answered']:
                RELEASE.wait(wait_timeout_of(self._query()))
            body = '{"answered":true}' if STATE['answered'] else '{"answered":false}'
            return self._send(body, 'application/json')
        return self._send('not found', code=404)

    def do_POST(self):
        if not self._authorized():
            return self._send('forbidden', code=403)
        if urlparse(self.path).path != '/answer':
            return self._send('not found', code=404)
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length).decode('utf-8')
        write_atomically(ARGS.out, body)
        # ファイルを書き終えてから保留中の /wait を起こす (Mod は /wait の応答後にファイルを読む)
        STATE['answered'] = True
        RELEASE.set()
        self._send('{"ok":true}', 'application/json')
        self._shutdown_later()

    def log_message(self, *args):
        # ログは出さない
        pass


class Server(ThreadingHTTPServer):
    # 応答中の /wait スレッドを終了時に待つ (daemon にすると応答前に切られる)。
    # server_close は block_on_close (既定 True) で全スレッドの終了を待つ
    daemon_threads = False


def main():
    server = Server(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    write_atomically(ARGS.port_file, json.dumps({'port': port, 'pid': os.getpid()}))

    timer = threading.Timer(IDLE_TIMEOUT_SECONDS, server.shutdown)
    timer.daemon = True
    timer.start()

    try:
        server.serve_forever()
    finally:
        # 終了する: 保留中の /wait を {"answered":false} で解放してから閉じる
        RELEASE.set()
        server.server_close()


if __name__ == '__main__':
    main()
