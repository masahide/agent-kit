#!/usr/bin/env python3
"""一回限りのローカル受信サーバ。フォーム HTML を配り、/answer への POST を 1 件ファイルに書いて終了する。"""
import argparse
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=0)
ap.add_argument('--token', required=True)
ap.add_argument('--form', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--port-file')
a = ap.parse_args()
FORM = open(a.form, encoding='utf-8').read()


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype='text/html; charset=utf-8', code=200):
        data = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return parse_qs(urlparse(self.path).query).get('t', [''])[0] == a.token

    def do_GET(self):
        if not self._authorized():
            return self._send('forbidden', 'text/plain', 403)
        self._send(FORM.replace('__TOKEN__', a.token))

    def do_POST(self):
        if not self._authorized() or urlparse(self.path).path != '/answer':
            return self._send('forbidden', 'text/plain', 403)
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8')
        tmp = a.out + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(body)
        os.replace(tmp, a.out)
        self._send('{"ok":true}', 'application/json')
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *args):
        pass


srv = HTTPServer(('127.0.0.1', a.port), H)
port = srv.server_address[1]
if a.port_file:
    with open(a.port_file, 'w') as f:
        f.write(str(port))
print(port, flush=True)
srv.serve_forever()
