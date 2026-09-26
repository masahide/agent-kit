import type { Args, ModelForkResult, On, PaneOpenArgs, RenderInput, SessionStartInput } from 'claude-code'
import { mock, type MockClock } from 'claude-code/testing'

import { PANE_ID, PLUGIN_NAME } from '../../hooks/names'

/**
 * 模した受信サーバのポートと pid。
 */
export const RECEIVER_PORT = 47321
export const RECEIVER_PID = 4242

/**
 * /work で始まる対話セッション。
 */
export const SESSION: SessionStartInput = {
  surface: 'terminal',
  isInteractive: true,
  cwd: '/work',
}

/**
 * 160 列の terminal に dock されたインタビューのペイン。
 */
export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PANE_ID,
  viewport: { columns: 160, rows: 40, isFullscreen: true },
  props: {
    title: 'doc-desk',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

/**
 * 人が `/doc-desk-resume` と打ったときの入力。
 */
export const DESK_COMMAND: Args<'command.run'> = {
  command: 'doc-desk-resume',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}

/**
 * 模した受信サーバの `GET /wait` の 1 回分。
 */
export type WaitCall = {
  url: string
  /** `&timeout=` の秒数 */
  timeoutSeconds: number
  /** 何回目の /wait か (1 から) */
  count: number
}

/**
 * `GET /wait` の答え。`'error'` は受信サーバに届かない (fetch が失敗する)。
 */
export type WaitReply = { answered: boolean } | 'error'

/**
 * `--version` に Python 3 と答えるコマンド。null はどれも答えない (Python が無い)。
 * `python3` 以外を選ぶと、`python3` は Windows の Microsoft Store の案内 (スタブ) を模して失敗する。
 */
export type PythonCommand = 'python3' | 'python' | 'py' | null

export type WorldOptions = {
  /** false なら receiver.py start が何も印字せずに終わる (起動失敗を模す) */
  isReceiverUp?: boolean
  /** 受信サーバの起動がこの回数までは成功し、以後は失敗する (ライブ表示の後の指摘の画面だけを失敗させる) */
  receiverStartsUp?: number
  /** `--version` に Python 3 と答えるコマンド。省略時は `python3` */
  python?: PythonCommand
  /** `GET /wait` の答え。省略時は毎回 `{ answered: false }` (timeout まで回答が無かった) */
  waitReply?: (call: WaitCall) => WaitReply | Promise<WaitReply>
  /** true なら `$.prompt.submit` を `{ drop }` で断る */
  dropSubmits?: boolean
  /** 最初のこの回数の `$.prompt.submit` を失敗させる */
  refuseSubmits?: number
  /** `--port` で指定されても取れない (使用中の) port */
  busyPorts?: number[]
  /** `$.session.id()` の答え。省略時は `session-now` */
  sessionId?: string
  /** `$.store` の初めの中身 (前のセッションが残した記録を模す) */
  store?: Record<string, unknown>
  /** シンボリックリンク: リンクのパス → 行き先のパス (`fs.stat` の realPath) */
  links?: Record<string, string>
  /** `$.model.fork` の答え。省略時は `nothing-to-fork` (会話がまだ無い) */
  forkReply?: ModelForkResult
  /** ライブ表示の受信サーバの `POST /document` と `POST /finish` の答え。省略時は指摘なし、止めない */
  liveReply?: (call: LiveCall) => LiveReply | 'error'
  /** true なら `$.turn.abort` を断る (止める turn が違う) */
  refuseAbort?: boolean
}

/**
 * 模したライブ表示の受信サーバへの POST 1 回分。
 */
export type LiveCall = {
  /** `/document` か `/finish` */
  path: string
  body: Record<string, unknown>
}

/**
 * 模したライブ表示の受信サーバの答え。
 */
export type LiveReply = {
  comments?: unknown[]
  stop?: boolean
}

/**
 * ファイルの Map のキー。Windows のエンジンは `$.fs` のパスを `C:\work\doc-desk\x.json` の形に
 * 直して渡すので、区切りを `/` にしてドライブ名を外し、`/work/doc-desk/x.json` にそろえます。
 */
export const keyOf = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')

/**
 * argv が receiver.py のどのサブコマンドを呼んでいるか。receiver.py でなければ null。
 */
export function receiverCommandOf(argv: readonly string[]): string | null {
  const index = argv.findIndex(arg => arg.endsWith('receiver.py'))
  return index < 0 ? null : (argv[index + 1] ?? null)
}

/**
 * Mod の下の世界を記憶で答えます: ファイルは Map、プロセスは台本、時計は mock.clock、
 * 受信サーバの `/wait` は `options.waitReply`。
 *
 * receiver.py の `start` を受けると、stdout に `{"port": n, "pid": n}` を 1 行返します。
 * `clean <paths...>` は Map から消します。`open` と `stop` は記録するだけです。
 *
 * @param on テストの `on`
 * @param options 受信サーバと Python の有無、/wait の答え
 * @returns 記録と時計
 */
export function world(on: On, options: WorldOptions = {}) {
  const files = new Map<string, string>()
  const runs: (readonly string[])[] = []
  const opened: PaneOpenArgs[] = []
  const closed: Args<'ui.close'>[] = []
  const logged: string[] = []
  const statuses: (string | undefined)[] = []
  const submitted: Args<'prompt.submit'>[] = []
  const registeredTools: string[] = []
  const registeredCommands: string[] = []
  const fetched: WaitCall[] = []
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  /** `$.store` への書き込みと削除の順 (`set <key>` / `delete <key>`) */
  const storeOps: string[] = []
  const toasts: string[] = []
  const suggested: string[] = []
  const forkPrompts: string[] = []
  /** ライブ表示の受信サーバへの POST (送った順) */
  const livePosts: LiveCall[] = []
  /** `$.turn.abort` に渡された turnId */
  const aborted: string[] = []
  let invalidations = 0
  let startCount = 0

  const clock = mock.clock(on, { now: Date.UTC(2026, 8, 22, 12, 0, 0) })

  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('session.id', () => ({ value: options.sessionId ?? 'session-now' }))

  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  on('tool.register', ($, e) => {
    registeredTools.push(e.name)
    return { value: { tool: `mcp__${PLUGIN_NAME}__${e.name}` } }
  })

  on('command.register', ($, e) => {
    // エンジンと同じく、この plugin のスキル /doc-desk:doc-desk の短い形 /doc-desk と重なる名前は断る
    if (e.name === PLUGIN_NAME) {
      return { deny: `"/${e.name}" refused: it is the plugin's /${PLUGIN_NAME}:${PLUGIN_NAME}` }
    }
    registeredCommands.push(e.name)
    return { value: { command: e.name } }
  })

  on('fs.write', ($, e) => {
    files.set(keyOf(e.path), e.text)
    return { value: undefined }
  })

  on('fs.read', ($, e) => {
    const text = files.get(keyOf(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  on('fs.exists', ($, e) => ({ value: files.has(keyOf(e.path)) }))

  on('fs.stat', ($, e) => {
    const key = keyOf(e.path)
    const real = options.links?.[key] ?? key
    const text = files.get(real)
    // ファイルが無くても、その下にファイルがあればフォルダとして答える
    const isDir = text === undefined && [...files.keys()].some(path => path.startsWith(`${real}/`))
    if (text === undefined && !isDir) {
      return { deny: `ENOENT: ${e.path}` }
    }
    const stat = { kind: isDir ? ('dir' as const) : ('file' as const), size: text?.length ?? 0, mtimeMs: 0, isLink: real !== key }
    return { value: e.resolve ? { ...stat, realPath: real } : stat }
  })

  on('store.get', ($, e) => ({ value: store.get(e.key) }))

  on('store.set', ($, e) => {
    storeOps.push(`set ${e.key}`)
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })

  on('store.delete', ($, e) => {
    storeOps.push(`delete ${e.key}`)
    store.delete(e.key)
    return { value: undefined }
  })

  on('store.keys', () => ({ value: [...store.keys()] }))

  on('process.run', ($, e) => {
    runs.push(e.argv)
    const python = options.python === undefined ? 'python3' : options.python

    if (e.argv.includes('--version')) {
      if (e.argv[0] === python) {
        return { value: { exitCode: 0, stdout: 'Python 3.14.2\n', stderr: '' } }
      }
      if (e.argv[0] === 'python3' && python !== null) {
        // Windows の python3 スタブ: Python は入っているが、Microsoft Store の案内だけを出す
        return {
          value: { exitCode: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' },
        }
      }
      return { value: { exitCode: 127, stdout: '', stderr: `${e.argv[0]}: not found` } }
    }

    const command = receiverCommandOf(e.argv)
    if (command === 'clean') {
      const index = e.argv.indexOf('clean')
      for (const path of e.argv.slice(index + 1)) {
        files.delete(keyOf(path))
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }

    if (command === 'start') {
      startCount += 1
      if (options.isReceiverUp === false || (options.receiverStartsUp !== undefined && startCount > options.receiverStartsUp)) {
        return { value: { exitCode: 1, stdout: '', stderr: '' } }
      }
      // --port があり、塞がっていなければその port を使う (receiver.py と同じ)
      const wanted = e.argv.includes('--port') ? Number(e.argv[e.argv.indexOf('--port') + 1]) : 0
      const port = wanted > 0 && !(options.busyPorts ?? []).includes(wanted) ? wanted : RECEIVER_PORT
      return { value: { exitCode: 0, stdout: `${JSON.stringify({ port, pid: RECEIVER_PID })}\n`, stderr: '' } }
    }

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })

  on('http.fetch', async ($, e) => {
    const path = new URL(e.url).pathname
    if (path === '/document' || path === '/finish') {
      const call: LiveCall = { path, body: JSON.parse(e.init?.body ?? '{}') as Record<string, unknown> }
      livePosts.push(call)
      const reply = (options.liveReply ?? ((): LiveReply | 'error' => ({})))(call)
      if (reply === 'error') {
        return { deny: `ECONNREFUSED: ${e.url}` }
      }
      const text = JSON.stringify({ ok: true, comments: reply.comments ?? [], stop: reply.stop ?? false })
      return { value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text } }
    }
    const timeout = /[?&]timeout=(\d+)/.exec(e.url)?.[1]
    // 引き継ぎの生死確認 (timeout=0) も /wait として数える
    const call: WaitCall = { url: e.url, timeoutSeconds: Number(timeout ?? 0), count: fetched.length + 1 }
    fetched.push(call)
    const reply = await (options.waitReply ?? (() => ({ answered: false })))(call)
    if (reply === 'error') {
      return { deny: `ECONNREFUSED: ${e.url}` }
    }
    return { value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: JSON.stringify(reply) } }
  })

  on('ui.open', ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })

  on('ui.close', ($, e) => {
    closed.push(e)
    return { value: undefined }
  })

  on('ui.invalidate', () => {
    invalidations += 1
    return { value: undefined }
  })

  on('ui.log', ($, e) => {
    logged.push(e.text)
    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })

  let refusedSubmits = 0
  on('prompt.submit', ($, e) => {
    if (refusedSubmits < (options.refuseSubmits ?? 0)) {
      // 投入が受け付けられない (フックが失敗し、下の層も答えないので $.prompt.submit が reject する)
      refusedSubmits += 1
      throw new Error('prompt.submit refused')
    }
    if (options.dropSubmits) {
      // 投入が他のフックに断られた ($.prompt.submit は reject せず { drop } で resolve する)
      return { drop: 'blocked by a hook' }
    }
    submitted.push(e)
    return { text: e.text, ...(e.context && { context: e.context }) }
  })

  // core は答えの文をそのまま返す
  on('turn.complete', ($, e) => ({ text: e.answer, ...(e.usage && { usage: e.usage }) }))

  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  on('turn.abort', ($, e) => {
    if (options.refuseAbort) {
      return { deny: `turn ${e.turnId} is not running` }
    }
    aborted.push(e.turnId)
    return { value: undefined }
  })

  // Write と Edit は Map のファイルに書く (core の代わり。相対パスはセッションの cwd /work から)
  const absolute = (path: string) => (keyOf(path).startsWith('/') ? keyOf(path) : `/work/${path}`)
  on('tool.call', { tool: 'Write' }, ($, e) => {
    files.set(absolute(e.file_path), e.content)
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })

  on('tool.call', { tool: 'Edit' }, ($, e) => {
    const before = files.get(absolute(e.file_path)) ?? ''
    files.set(absolute(e.file_path), before.replace(e.old_string, e.new_string))
    return { result: 'edited' as never }
  })

  on('model.fork', ($, e) => {
    forkPrompts.push(e.prompt)
    return { value: options.forkReply ?? { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
  })

  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  on('prompt.suggest', ($, e) => {
    suggested.push(e.text)
    return { isShown: true }
  })

  return {
    files,
    runs,
    opened,
    closed,
    logged,
    statuses,
    submitted,
    fetched,
    store,
    storeOps,
    toasts,
    suggested,
    forkPrompts,
    livePosts,
    aborted,
    registeredTools,
    registeredCommands,
    clock,
    invalidations: () => invalidations,
    /** 受信サーバの起動 (receiver.py の start) だけ */
    receiverRuns: () => runs.filter(argv => receiverCommandOf(argv) === 'start'),
    /** receiver.py の指定のサブコマンド (clean、open、stop) の run だけ */
    receiverCommandRuns: (command: string) => runs.filter(argv => receiverCommandOf(argv) === command),
  }
}
