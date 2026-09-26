#!/usr/bin/env python3
"""doc-desk Mod のローカル受信サーバ (一回限り) と、OS ごとに違う小さな操作。

Mod はシェル (sh) を使わず、このスクリプトのサブコマンドだけを呼びます。
OS ごとの違い (背景での起動、ブラウザ、ファイルの削除、プロセスの停止) はここで吸収し、
macOS、Linux、Windows で同じ argv のまま動かします。

  start --token T --html H --out O [--port N]   serve を切り離して起動し、{"port": n, "pid": n} を 1 行出して終わる
  serve --token T --html H --out O [--port N]   受信サーバを前面で動かす (start が使う)
  start --live --token T --html H [--port N]    ライブ表示の受信サーバを切り離して起動する (回答は受けない)
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

ライブ表示 (--live) の受信サーバは回答を受けず、Claude が書いている文書をブラウザへ流します
(docs/doc-desk/live-view-design.md の 3 章)。経路は serve_live の説明にあります。

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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty, Queue
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
        command.add_argument('--out', default='', help='回答 JSON を書くパス (--live では使わない)')
        command.add_argument('--port', type=int, default=0, help='使いたい port (塞がっていれば OS に選ばせる)')
        command.add_argument('--live', action='store_true', help='ライブ表示の受信サーバにする (回答は受けない)')
    commands.add_parser('open', help='既定のブラウザで URL を開く').add_argument('url')
    commands.add_parser('clean', help='ファイルを消す').add_argument('paths', nargs='+')
    commands.add_parser('stop', help='受信サーバを止める').add_argument('pid', type=int)
    args = parser.parse_args(argv)
    if args.command in ('start', 'serve') and not args.live and not args.out:
        parser.error('--out が要ります (--live のときだけ省けます)')
    return args


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
        *(['--live'] if args.live else []),
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


class Server(ThreadingHTTPServer):
    # 応答中の /wait (と /events) のスレッドを終了時に待つ (daemon にすると応答前に切られる)。
    # server_close は block_on_close (既定 True) で全スレッドの終了を待つ
    daemon_threads = False
    # Windows の SO_REUSEADDR は使用中の port も取れてしまう (--port で他のサーバを乗っ取る) ので、
    # Windows では付けずに SO_EXCLUSIVEADDRUSE を付ける。POSIX は TIME_WAIT の port を取り直すために付ける
    allow_reuse_address = not IS_WINDOWS

    def server_bind(self):
        if IS_WINDOWS:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class TokenHandler(BaseHTTPRequestHandler):
    """2 つの受信サーバ (serve と serve_live) が共有する応答と照合。token は起動時に子クラスで決める。"""

    token = ''

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
        return self._query().get('t', [''])[0] == self.token

    def log_message(self, *log_args):
        # ログは出さない
        pass


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

    class Handler(TokenHandler):
        token = args.token

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


# ライブ表示で受信サーバが持つ文書の上限 (文字)。指摘の画面と同じ 10 万文字で、超えたら末尾を残す。
LIVE_MAX_TEXT = 100000

# ライブ表示の SSE の ping の間隔 (秒)。
LIVE_PING_SECONDS = 15.0

# ライブ指摘の上限 (件) と、引用とコメントの上限 (文字)。
LIVE_MAX_COMMENTS = 200
LIVE_MAX_QUOTE = 200
LIVE_MAX_COMMENT_TEXT = 2000

# /finish { url } のあと、redirect を流してから終了するまでの秒数。
LIVE_FINISH_DELAY_SECONDS = 1.0

# 自分で終わるかを見る間隔 (秒)。
LIVE_WATCH_SECONDS = 2.0

# Mod からの接触 (/document、/finish、/wait) がこの秒数途絶えたら、セッションが死んだとみなして終わる。
# 手動の確認のために環境変数 DOC_DESK_LIVE_CONTACT_TIMEOUT_SECONDS で短くできる。
LIVE_CONTACT_TIMEOUT_SECONDS = 600.0

# /finish { close: true } のあと、closed を流してから終了するまでの秒数。
LIVE_CLOSE_DELAY_SECONDS = 0.5

# 受信サーバ自身が流す状態 (moving と closed) は文言を持たない。文言は画面 (hooks/sheet/render-live.ts が
# hooks/views/strings.ts から埋める) が種類と理由から決める。closed の理由:
#   replaced = 配っている HTML が消えたか書き換わった、lost = Mod からの接触が途絶えた、closed = Mod が閉じた

# Mod とブラウザから受ける本文の上限 (バイト)。文書 10 万文字を JSON で逃がしても収まる大きさ。
LIVE_MAX_BODY_BYTES = 4 * 1024 * 1024

# Mod が送ってよい状態の種類 (receiver 自身の moving と closed は受けない)。
LIVE_MOD_PHASES = ('waiting', 'writing', 'fixing', 'done', 'stopped', 'aborted', 'ended')

# 指摘の欄 (Mod とブラウザに渡すもの)。
LIVE_COMMENT_KEYS = ('id', 'quote', 'text', 'mode', 'at', 'state')


def contact_timeout_of(value):
    """環境変数の秒数を読む。無い、読めない、0 以下なら LIVE_CONTACT_TIMEOUT_SECONDS。"""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return LIVE_CONTACT_TIMEOUT_SECONDS
    return seconds if seconds > 0 else LIVE_CONTACT_TIMEOUT_SECONDS


def serve_live(args):
    """ライブ表示の受信サーバ (docs/doc-desk/live-view-design.md の 3 章)。回答は受けません。

    経路 (すべて ?t=<token> が必要。不一致は 403):
      GET  /          -> ライブ表示の HTML
      GET  /events    -> SSE。接続時に snapshot (全文、状態、指摘の一覧、切り詰めたか) を送り、以後は
                         append / replace / status / comments / truncated / redirect を流す。LIVE_PING_SECONDS 秒ごとに ': ping'
      POST /document  -> Mod が送る { seq, kind: replace|append|status, text?, phase?, delivered?, stopped? }。
                         replace と append は seq の順に並べ直して当て、古い seq は捨てる (text が文字列でない append は
                         空として番号だけ埋める)。status は { text, phase } を画面に流す。
                         応答は { ok, comments: まだ Mod に渡していない指摘, stop } で、渡した指摘は taken にする
      POST /comments  -> ブラウザが送るライブ指摘 { id, quote, text, mode: after|now, at }。now は stop の印を立てる。
                         /finish の後は 409 (指摘は指摘の画面で付けてもらう)
      POST /finish    -> Mod が送る。{ } なら未渡しの指摘を返して carried にし、以後の /comments を断る。
                         { url } なら SSE に redirect を流し、LIVE_FINISH_DELAY_SECONDS 秒後に終了する。
                         { close: true } なら status (phase: closed, reason: closed) を流し、
                         LIVE_CLOSE_DELAY_SECONDS 秒後に終了する (Mod が取り消し、別の文書、開き直しで閉じるとき)
      GET  /wait      -> {"answered": false} を即返す (生存確認)

    次のどちらかで自分で終わります (pid と token はどこにも残さないので、次のセッションは止めに来ません)。
    LIVE_WATCH_SECONDS 秒ごとの監視スレッド 1 本が見て、終わる直前に SSE で status (phase: closed) を流します。
      - 配っている HTML (--html) が消えたか、mtime が起動時と違う (同じ label で開き直された、clean で消された)
      - Mod からの接触 (/document、/finish、/wait) が LIVE_CONTACT_TIMEOUT_SECONDS 秒途絶えた (セッションが死んだ)
    ブラウザからの /events と /comments は接触に数えません。Mod は開いている間 60 秒ごとに /wait を投げるので、
    セッションが生きている間は終わりません。serve にある「起動から IDLE_TIMEOUT_SECONDS 秒」の上限はここには付けません。
    """
    with open(args.html, encoding='utf-8') as handle:
        html = handle.read()
    html_mtime = os.stat(args.html).st_mtime_ns
    contact_timeout = contact_timeout_of(os.environ.get('DOC_DESK_LIVE_CONTACT_TIMEOUT_SECONDS'))

    lock = threading.Lock()
    release = threading.Event()
    # 全文、当てた通し番号、並べ直し待ちの append、状態、指摘、止める印、Mod から最後に何か来た時刻
    state = {
        'text': '',
        'seq': 0,
        'held': {},
        'status': {'text': '', 'phase': ''},
        'truncated': False,
        'finishing': False,
        'comments': [],
        'stop': False,
        'last_contact': time.monotonic(),
    }
    subscribers = []

    def broadcast(event, payload):
        """SSE の購読者すべてに 1 件流す (lock の中で呼ぶ)。"""
        line = 'event: %s\ndata: %s\n\n' % (event, json.dumps(payload, ensure_ascii=False))
        for queue in subscribers:
            queue.put(line)

    def comments_of():
        return [{key: comment[key] for key in LIVE_COMMENT_KEYS} for comment in state['comments']]

    def set_text(text, can_untruncate):
        """全文を置き、上限を超えたら末尾だけ残す。切ったかどうかが変わったら画面に知らせる (lock の中で呼ぶ)。

        can_untruncate は replace のときだけ True (Edit で短くなれば、切った印を戻す)。
        """
        truncated = len(text) > LIVE_MAX_TEXT
        if truncated:
            text = text[-LIVE_MAX_TEXT:]
        if truncated != state['truncated'] and (truncated or can_untruncate):
            state['truncated'] = truncated
            broadcast('truncated', {'truncated': truncated})
        state['text'] = text

    def set_status(text, phase, reason=None):
        """状態を置いて画面に流す (lock の中で呼ぶ)。"""
        state['status'] = {'text': text, 'phase': phase, **({'reason': reason} if reason else {})}
        broadcast('status', state['status'])

    def apply_document(seq, kind, text):
        """replace と append を seq の順に当てる (lock の中で呼ぶ)。

        append は切り詰めた後もそのまま流す (画面も同じ上限で末尾を残す)。10 万文字の replace を毎回流さない。
        """
        if seq <= state['seq']:
            return
        if kind == 'replace':
            state['seq'] = seq
            set_text(text, True)
            state['held'] = {key: value for key, value in state['held'].items() if key > seq}
            broadcast('replace', {'text': state['text']})
        else:
            state['held'][seq] = text
        # 並べ直し待ちの append を続きから当てる
        while state['seq'] + 1 in state['held']:
            state['seq'] += 1
            piece = state['held'].pop(state['seq'])
            set_text(state['text'] + piece, False)
            if piece:
                broadcast('append', {'text': piece})

    def mark(ids, new_state):
        """id の指摘の状態を変える (lock の中で呼ぶ)。変えたら True。"""
        wanted = set(item for item in ids if isinstance(item, str))
        changed = False
        for comment in state['comments']:
            if comment['id'] in wanted and comment['state'] != new_state:
                comment['state'] = new_state
                changed = True
        return changed

    def take_comments(new_state):
        """まだ Mod に渡していない指摘を返し、new_state にする (lock の中で呼ぶ)。"""
        taken = []
        for comment in state['comments']:
            if comment['state'] == 'waiting':
                comment['state'] = new_state
                taken.append({key: comment[key] for key in ('id', 'quote', 'text', 'mode', 'at')})
        return taken

    class Handler(TokenHandler):
        token = args.token

        def _json(self, value):
            return self._send(json.dumps(value, ensure_ascii=False), 'application/json; charset=utf-8')

        def _body(self):
            """本文を JSON のオブジェクトとして読む。読めない、大きすぎるなら None。"""
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                return None
            if length < 0 or length > LIVE_MAX_BODY_BYTES:
                return None
            try:
                value = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
            except ValueError:
                return None
            return value if isinstance(value, dict) else None

        def do_GET(self):
            if not self._authorized():
                return self._send('forbidden', code=403)
            path = urlparse(self.path).path
            if path == '/':
                return self._send(html, 'text/html; charset=utf-8')
            if path == '/wait':
                state['last_contact'] = time.monotonic()
                return self._json({'answered': False})
            if path == '/events':
                return self._events()
            return self._send('not found', code=404)

        def _events(self):
            queue = Queue()
            with lock:
                subscribers.append(queue)
                snapshot = {
                    'text': state['text'],
                    'status': state['status'],
                    'comments': comments_of(),
                    'truncated': state['truncated'],
                }
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                first = 'event: snapshot\ndata: %s\n\n' % json.dumps(snapshot, ensure_ascii=False)
                self.wfile.write(first.encode('utf-8'))
                self.wfile.flush()
                while not release.is_set():
                    try:
                        line = queue.get(timeout=LIVE_PING_SECONDS)
                    except Empty:
                        line = ': ping\n\n'
                    if line is None:
                        break
                    self.wfile.write(line.encode('utf-8'))
                    self.wfile.flush()
            except OSError:
                # ブラウザがタブを閉じた (BrokenPipe、ConnectionReset など)
                pass
            finally:
                with lock:
                    if queue in subscribers:
                        subscribers.remove(queue)
                self.close_connection = True

        def do_POST(self):
            if not self._authorized():
                return self._send('forbidden', code=403)
            path = urlparse(self.path).path
            body = self._body()
            if body is None:
                # 大きすぎる本文は読まずに接続を閉じる (読み残しがあるので keep-alive にしない)
                self.close_connection = True
                return self._send('bad request', code=400)
            if path == '/document':
                return self._document(body)
            if path == '/comments':
                return self._comment(body)
            if path == '/finish':
                return self._finish(body)
            return self._send('not found', code=404)

        def _document(self, body):
            kind = body.get('kind')
            seq = body.get('seq')
            text = body.get('text')
            if kind not in ('replace', 'append', 'status') or not isinstance(seq, int) or isinstance(seq, bool):
                return self._send('bad request', code=400)
            if kind == 'replace' and not isinstance(text, str):
                return self._send('bad request', code=400)
            with lock:
                state['last_contact'] = time.monotonic()
                if kind != 'status':
                    # 文字列でない append も番号だけは埋める (欠番で後の append が止まらないように)
                    apply_document(seq, kind, text if isinstance(text, str) else '')
                phase = body.get('phase')
                if kind == 'status' and isinstance(text, str) and text != '' and phase in LIVE_MOD_PHASES:
                    if state['status'] != {'text': text, 'phase': phase}:
                        set_status(text, phase)
                changed = False
                if isinstance(body.get('delivered'), list):
                    changed = mark(body['delivered'], 'delivered') or changed
                if isinstance(body.get('stopped'), list):
                    changed = mark(body['stopped'], 'stopped') or changed
                comments = take_comments('taken')
                stop = state['stop']
                state['stop'] = False
                if changed or comments:
                    broadcast('comments', {'comments': comments_of()})
            return self._json({'ok': True, 'comments': comments, 'stop': stop})

        def _comment(self, body):
            comment_id = body.get('id')
            quote = body.get('quote', '')
            text = body.get('text')
            mode = body.get('mode')
            at = body.get('at', 0)
            if (
                not isinstance(comment_id, str) or not comment_id or len(comment_id) > 64
                or not isinstance(quote, str) or not isinstance(text, str) or not text.strip()
                or mode not in ('after', 'now') or not isinstance(at, int) or isinstance(at, bool)
            ):
                return self._send('bad request', code=400)
            with lock:
                if state['finishing']:
                    # Mod はもう指摘を取りに来ない (指摘の画面に移る)。黙って失わないよう断る
                    return self._send('finishing', code=409)
                if any(comment['id'] == comment_id for comment in state['comments']):
                    return self._json({'ok': True})
                if len(state['comments']) >= LIVE_MAX_COMMENTS:
                    return self._send('too many comments', code=429)
                state['comments'].append({
                    'id': comment_id,
                    'quote': quote[:LIVE_MAX_QUOTE],
                    'text': text[:LIVE_MAX_COMMENT_TEXT],
                    'mode': mode,
                    'at': max(0, at),
                    'state': 'waiting',
                })
                if mode == 'now':
                    state['stop'] = True
                broadcast('comments', {'comments': comments_of()})
            return self._json({'ok': True})

        def _finish(self, body):
            url = body.get('url')
            with lock:
                state['last_contact'] = time.monotonic()
                comments = take_comments('carried')
                if body.get('close') is True:
                    # Mod が閉じる: 画面に closed を流し、再接続をやめさせてから終わる
                    state['finishing'] = True
                    set_status('', 'closed', 'closed')
                    timer = threading.Timer(LIVE_CLOSE_DELAY_SECONDS, self.server.shutdown)
                    timer.daemon = True
                    timer.start()
                    return self._json({'ok': True, 'comments': comments})
                if not state['finishing']:
                    state['finishing'] = True
                    set_status('', 'moving')
                broadcast('comments', {'comments': comments_of()})
                if isinstance(url, str) and url.startswith('http://127.0.0.1:'):
                    broadcast('redirect', {'url': url})
                    timer = threading.Timer(LIVE_FINISH_DELAY_SECONDS, self.server.shutdown)
                    timer.daemon = True
                    timer.start()
            return self._json({'ok': True, 'comments': comments})

    server = bind_server(Server, Handler, args.port)
    port = server.server_address[1]
    announce(json.dumps({'port': port, 'pid': os.getpid()}))

    def reason_to_end():
        """自分で終わる理由 (replaced / lost)。終わらないなら None。"""
        try:
            if os.stat(args.html).st_mtime_ns != html_mtime:
                return 'replaced'
        except OSError:
            return 'replaced'
        if time.monotonic() - state['last_contact'] > contact_timeout:
            return 'lost'
        return None

    def watch():
        while not release.wait(LIVE_WATCH_SECONDS):
            reason = reason_to_end()
            if reason is not None:
                # 終わる理由を画面に出してから止める (status は SSE の終わりの印より先に積まれる)
                with lock:
                    set_status('', 'closed', reason)
                server.shutdown()
                return

    threading.Thread(target=watch, daemon=True).start()

    try:
        server.serve_forever()
    finally:
        # 終了する: SSE のループを抜けさせてから閉じる (server_close は全スレッドの終了を待つ)
        release.set()
        with lock:
            for queue in subscribers:
                queue.put(None)
        server.server_close()
    return 0


def main(argv):
    args = parse_args(argv)
    if args.command == 'start':
        return start(args)
    if args.command == 'serve':
        return serve_live(args) if args.live else serve(args)
    if args.command == 'open':
        return open_url(args.url)
    if args.command == 'clean':
        return clean(args.paths)
    return stop(args.pid)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
