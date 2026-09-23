/**
 * 受信サーバ (scripts/receiver.py) の起動引数と、port-file の読み取り、URL。
 */

/**
 * 受信サーバを起動するのに要るパス。
 */
export type ReceiverPaths = {
  /** plugin.json のあるディレクトリ (絶対) */
  pluginRoot: string
  /** 配る HTML (絶対) */
  html: string
  /** 回答を書く先 (絶対) */
  out: string
  /** `{"port": n, "pid": n}` を書く先 (絶対) */
  portFile: string
}

/**
 * port-file の中身。
 */
export type ReceiverInfo = {
  port: number
  pid: number
}

/**
 * `sh -c` に渡す 1 引数を単引用符で囲みます。
 */
export const shellQuoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * 受信サーバを起動する前に、同じ label の前回の回答ファイルと port-file を消す argv。
 * 消さないと、同じ label を使い回したときに Mod が前回の回答を新しい回答として拾います。
 */
export const cleanupArgv = (paths: Pick<ReceiverPaths, 'out' | 'portFile'>): string[] => [
  'rm',
  '-f',
  paths.out,
  paths.portFile,
]

/**
 * 受信サーバを切り離して起動する argv。`nohup ... &` で背景に回し、`echo started`
 * ですぐ戻ります (plan.md 4 章 V2)。
 *
 * @param paths ファイルの置き場
 * @param token `?t=` で照合するトークン
 * @returns `$.process.run` に渡す argv
 */
export function receiverArgv(paths: ReceiverPaths, token: string): string[] {
  const script = `${paths.pluginRoot}/scripts/receiver.py`
  const command =
    `nohup python3 ${shellQuoted(script)}` +
    ` --port-file ${shellQuoted(paths.portFile)}` +
    ` --token ${shellQuoted(token)}` +
    ` --html ${shellQuoted(paths.html)}` +
    ` --out ${shellQuoted(paths.out)}` +
    ' >/dev/null 2>&1 & echo started'
  return ['sh', '-c', command]
}

/**
 * port-file の JSON を読みます。形が違えば null。
 */
export function parsePortFile(text: string): ReceiverInfo | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isInteger((parsed as { port?: unknown }).port) &&
      Number.isInteger((parsed as { pid?: unknown }).pid)
    ) {
      const { port, pid } = parsed as { port: number; pid: number }
      return port > 0 && pid > 0 ? { port, pid } : null
    }
  } catch {
    // JSON でなければ null
  }
  return null
}

/**
 * ブラウザに開かせる URL。受信サーバは 127.0.0.1 にだけ bind しています。
 */
export const urlOf = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`

/**
 * ペインの `Link` に置く URL。`Link` の `href` は `https:` か `http://localhost` しか
 * 通らない (claude-code.d.ts の LinkProps) ので、127.0.0.1 の代わりに localhost で書きます。
 *
 * 受信サーバは 127.0.0.1 (IPv4) にだけ bind しているため、ブラウザが localhost を
 * ::1 (IPv6) に先に解決しても、接続拒否のあと 127.0.0.1 に切り替わることを当てにします
 * (curl では 127.0.0.1 に届くことを確認済み。主要ブラウザは両方を試します)。
 */
export const linkUrlOf = (port: number, token: string): string =>
  `http://localhost:${port}/?t=${encodeURIComponent(token)}`

/**
 * 同期待ちのロングポーリング `GET /wait` の URL。受信サーバは回答の POST か
 * `timeout` 秒の経過まで応答を保留します。
 */
export const waitUrlOf = (port: number, token: string, timeoutSeconds: number): string =>
  `http://127.0.0.1:${port}/wait?t=${encodeURIComponent(token)}&timeout=${timeoutSeconds}`

/**
 * ブラウザを開く argv。macOS は `open`、それ以外は `xdg-open`。
 */
export function openBrowserArgv(url: string): string[] {
  return [
    'sh',
    '-c',
    'if [ "$(uname)" = Darwin ]; then open "$0"; else xdg-open "$0"; fi',
    url,
  ]
}

/**
 * 受信サーバを止める argv。
 */
export const killArgv = (pid: number): string[] => ['kill', String(pid)]
