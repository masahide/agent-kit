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
    title: 'インタビュー',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

/**
 * 人が `/interview` と打ったときの入力。
 */
export const INTERVIEW_COMMAND: Args<'command.run'> = {
  command: 'interview',
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

export type WorldOptions = {
  /** false なら受信サーバが port-file を書かない (起動失敗を模す) */
  isReceiverUp?: boolean
  /** false なら `python3 --version` が失敗する */
  hasPython?: boolean
  /** `GET /wait` の答え。省略時は毎回 `{ answered: false }` (timeout まで回答が無かった) */
  waitReply?: (call: WaitCall) => WaitReply | Promise<WaitReply>
}

/**
 * Mod の下の世界を記憶で答えます: ファイルは Map、プロセスは台本、時計は mock.clock、
 * 受信サーバの `/wait` は `options.waitReply`。
 *
 * 受信サーバの起動 (argv に receiver.py を含む `process.run`) を受けると、
 * コマンド文字列から `--port-file` のパスを読み取り、port-file を Map に置きます。
 * `rm -f <paths...>` は Map から消します。
 *
 * @param on テストの `on`
 * @param options 受信サーバと python3 の有無、/wait の答え
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
  let invalidations = 0

  const clock = mock.clock(on, { now: Date.UTC(2026, 8, 22, 12, 0, 0) })

  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('tool.register', ($, e) => {
    registeredTools.push(e.name)
    return { value: { tool: `mcp__${PLUGIN_NAME}__${e.name}` } }
  })

  on('command.register', ($, e) => {
    registeredCommands.push(e.name)
    return { value: { command: e.name } }
  })

  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })

  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))

  on('process.run', ($, e) => {
    runs.push(e.argv)
    const command = e.argv.join(' ')

    if (e.argv[0] === 'python3') {
      return options.hasPython === false
        ? { value: { exitCode: 127, stdout: '', stderr: 'python3: not found' } }
        : { value: { exitCode: 0, stdout: 'Python 3.14.2\n', stderr: '' } }
    }

    if (e.argv[0] === 'rm') {
      for (const path of e.argv.slice(1)) {
        if (!path.startsWith('-')) {
          files.delete(path)
        }
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }

    if (command.includes('receiver.py')) {
      const match = /--port-file '([^']+)'/.exec(command)
      if (match?.[1] !== undefined && options.isReceiverUp !== false) {
        files.set(match[1], JSON.stringify({ port: RECEIVER_PORT, pid: RECEIVER_PID }))
      }
      return { value: { exitCode: 0, stdout: 'started\n', stderr: '' } }
    }

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })

  on('http.fetch', async ($, e) => {
    const timeout = /[?&]timeout=(\d+)/.exec(e.url)?.[1]
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
    return { value: undefined }
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

  on('prompt.submit', ($, e) => {
    submitted.push(e)
    return { text: e.text, ...(e.context && { context: e.context }) }
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
    registeredTools,
    registeredCommands,
    clock,
    invalidations: () => invalidations,
    /** 受信サーバの起動 (receiver.py を含む run) だけ */
    receiverRuns: () => runs.filter(argv => argv.join(' ').includes('receiver.py')),
  }
}
