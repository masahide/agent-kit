/**
 * 受信サーバ (scripts/receiver.py) の起動引数と、port-file の読み取り、URL。
 *
 * Mod はシェル (sh) を使わず、`<python> receiver.py <サブコマンド>` だけを `$.process.run` に渡します。
 * 背景での起動、ブラウザ、ファイルの削除、プロセスの停止の OS ごとの違いは receiver.py が吸収するので、
 * macOS、Linux、Windows で同じ argv になります。
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
 * Python 3 を起動する argv の候補。先に見つかったものを使います。
 *
 * Windows の `python3` は、Python が入っていても Microsoft Store の案内だけを出す
 * スタブに当たることがあるので、`python` と `py -3` (Windows の Python ランチャー) も試します。
 */
export const PYTHON_CANDIDATES: readonly (readonly string[])[] = [['python3'], ['python'], ['py', '-3']]

/**
 * `<python> --version` の結果が Python 3 のものか。スタブの案内文や Python 2 は落とします。
 */
export const isPython3 = (result: { exitCode: number; stdout: string; stderr: string }): boolean =>
  result.exitCode === 0 && /^Python 3\./m.test(`${result.stdout}\n${result.stderr}`)

const scriptOf = (pluginRoot: string): string => `${pluginRoot}/scripts/receiver.py`

/**
 * 受信サーバを起動する前に、同じ label の前回の回答ファイルと port-file を消す argv。
 * 消さないと、同じ label を使い回したときに Mod が前回の回答を新しい回答として拾います。
 */
export const cleanupArgv = (
  python: readonly string[],
  pluginRoot: string,
  paths: Pick<ReceiverPaths, 'out' | 'portFile'>,
): string[] => [...python, scriptOf(pluginRoot), 'clean', paths.out, paths.portFile]

/**
 * 受信サーバを切り離して起動する argv。receiver.py の `start` が `serve` を背景に回し、
 * `started` を出してすぐ戻ります。
 *
 * @param python Python 3 を起動する argv (`PYTHON_CANDIDATES` のどれか)
 * @param paths ファイルの置き場
 * @param token `?t=` で照合するトークン
 * @returns `$.process.run` に渡す argv
 */
export function receiverArgv(python: readonly string[], paths: ReceiverPaths, token: string): string[] {
  return [
    ...python,
    scriptOf(paths.pluginRoot),
    'start',
    '--port-file',
    paths.portFile,
    '--token',
    token,
    '--html',
    paths.html,
    '--out',
    paths.out,
  ]
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
 * ブラウザを開く argv。receiver.py の `open` が OS ごとの方法 (macOS は open、
 * Windows は関連付け、それ以外は xdg-open) で開きます。
 */
export const openBrowserArgv = (python: readonly string[], pluginRoot: string, url: string): string[] => [
  ...python,
  scriptOf(pluginRoot),
  'open',
  url,
]

/**
 * 受信サーバを止める argv。receiver.py の `stop` が止めます (もう無ければ何もしません)。
 */
export const stopArgv = (python: readonly string[], pluginRoot: string, pid: number): string[] => [
  ...python,
  scriptOf(pluginRoot),
  'stop',
  String(pid),
]
