import type { Args, On, PaneOpenArgs, RenderInput, SessionStartInput } from 'claude-code'
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
 * 人が `/doc-desk` と打ったときの入力。
 */
export const DESK_COMMAND: Args<'command.run'> = {
  command: 'doc-desk',
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
  /** `--version` に Python 3 と答えるコマンド。省略時は `python3` */
  python?: PythonCommand
  /** `GET /wait` の答え。省略時は毎回 `{ answered: false }` (timeout まで回答が無かった) */
  waitReply?: (call: WaitCall) => WaitReply | Promise<WaitReply>
  /** 最初のこの回数の `$.prompt.submit` を失敗させる */
  refuseSubmits?: number
  /** `--port` で指定されても取れない (使用中の) port */
  busyPorts?: number[]
  /** `$.session.id()` の答え。省略時は `session-now` */
  sessionId?: string
  /** `$.store` の初めの中身 (前のセッションが残した記録を模す) */
  store?: Record<string, unknown>
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
  const toasts: string[] = []
  const suggested: string[] = []
  let invalidations = 0

  const clock = mock.clock(on, { now: Date.UTC(2026, 8, 22, 12, 0, 0) })

  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('session.id', () => ({ value: options.sessionId ?? 'session-now' }))

  on('tool.register', ($, e) => {
    registeredTools.push(e.name)
    return { value: { tool: `mcp__${PLUGIN_NAME}__${e.name}` } }
  })

  on('command.register', ($, e) => {
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

  on('store.get', ($, e) => ({ value: store.get(e.key) }))

  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })

  on('store.delete', ($, e) => {
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
      if (options.isReceiverUp === false) {
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
    submitted.push(e)
    return { text: e.text, ...(e.context && { context: e.context }) }
  })

  // core は答えの文をそのまま返す
  on('turn.complete', ($, e) => ({ text: e.answer }))

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
    toasts,
    suggested,
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
