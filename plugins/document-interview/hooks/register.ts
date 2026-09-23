import type { On, Timer } from 'claude-code'

import type { AnswerV1, FormV1 } from './form/form-v1'
import { parseAnswer } from './form/answer'
import { TOOL_INPUT_SCHEMA } from './form/schema'
import { validateForm } from './form/validate'
import type { Host } from './host'
import {
  COMMAND_NAME,
  INTERVIEW_DIR,
  PANE_ID,
  TOOL_NAME,
} from './names'
import {
  cleanupArgv,
  killArgv,
  linkUrlOf,
  openBrowserArgv,
  parsePortFile,
  receiverArgv,
  urlOf,
  type ReceiverInfo,
} from './receiver'
import { formatReply } from './reply/format'
import { renderHtml } from './sheet/render-html'
import { paneView } from './views/pane-view'
import { STRINGS } from './views/strings'
import { clampWaitSeconds, waitForAnswer } from './wait/sync-wait'

/**
 * 回答の監視間隔 (ms)。
 */
const WATCH_INTERVAL_MS = 500

/**
 * ペインの経過秒数を更新する間隔 (監視の回数)。500 ms × 10 = 5 秒。
 */
const REDRAW_EVERY_TICKS = 10

/**
 * port-file を待つ間隔と回数。250 ms × 12 = 3 秒。
 */
const PORT_FILE_POLL_MS = 250
const PORT_FILE_POLL_COUNT = 12

/**
 * 証跡ファイルの置き場。
 */
type Paths = {
  form: string
  html: string
  portFile: string
  answer: string
  md: string
}

/**
 * 待機が終わった理由 (同期待ちの結果 `cancelled` の reason に使います)。
 */
type DropReason = 'cancelled' | 'replaced'

/**
 * 待機中の質問票 1 つ分の状態。
 */
type Pending = {
  form: FormV1
  label: string
  receiver: ReceiverInfo
  url: string
  linkUrl: string
  paths: Paths
  startedAtMs: number
  timer: Timer
  ticks: number
  isChecking: boolean
  /** `tool.call` の中で回答を待っている間 true。監視タイマーはその間 回答を届けない */
  isSyncWaiting: boolean
  /** `dropPending` で片付けられたときの理由 */
  dropReason: DropReason | null
}

/**
 * Document Interview Mod のフックを登録します。
 *
 * 状態機械:
 *
 * ```
 * idle --open_form--> waiting(sync) --回答検知 (tool.call の中)--> idle  (結果 answered)
 * waiting(sync) --waitSeconds 到達 / 中断 / 受信サーバ喪失--> waiting(async)  (結果 pending)
 * waiting(async) --回答検知 (監視タイマー)--> submitting --prompt.submit 済--> idle
 * waiting --open_form (別の質問票)--> 前の受信サーバを kill、監視停止 → 新しい waiting
 * waiting --[取り消す]--> kill、監視停止、ペイン閉 → idle  (同期待ち中なら結果 cancelled)
 * waiting --ui.close (人)--> waiting のまま (監視は続く)
 * waiting --/interview--> ペインとブラウザを開き直す
 * ```
 *
 * @param on エンジンの登録関数
 */
export function register(on: On) {
  let host: Host | null = null
  let cwd = ''
  let pythonProbe: Promise<boolean> | null = null
  let pending: Pending | null = null
  let isPaneOpen = false
  let elapsedSeconds = 0

  const pathsOf = (label: string): Paths => {
    const base = `${cwd}/${INTERVIEW_DIR}/${label}`
    return {
      form: `${base}.json`,
      html: `${base}.html`,
      portFile: `${base}.port.json`,
      answer: `${base}.answer.json`,
      md: `${base}.md`,
    }
  }

  /**
   * 受信サーバと照合するトークン。ローカルの一回限りなので乱数で足ります。
   */
  const tokenOf = (nowMs: number): string =>
    `${nowMs.toString(16)}${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`

  /**
   * python3 があるかを 1 回だけ確かめ、結果を保持します。
   */
  function hasPython(engine: Host): Promise<boolean> {
    pythonProbe ??= engine
      .run(['python3', '--version'], { timeoutMs: 10000 })
      .then(result => result.exitCode === 0)
      .catch(() => false)
    return pythonProbe
  }

  const wait = (engine: Host, ms: number): Promise<void> =>
    new Promise(resolve => {
      engine.after(ms, resolve)
    })

  /**
   * port-file を 250 ms 間隔で最大 3 秒待って読みます。
   */
  async function readPortFile(engine: Host, path: string): Promise<ReceiverInfo | null> {
    for (let attempt = 0; attempt < PORT_FILE_POLL_COUNT; attempt += 1) {
      if (attempt > 0) {
        await wait(engine, PORT_FILE_POLL_MS)
      }
      if (await engine.exists(path)) {
        const info = parsePortFile(await engine.readFile(path).catch(() => ''))
        if (info) {
          return info
        }
      }
    }
    return null
  }

  function openBrowser(engine: Host, url: string) {
    void engine.run(openBrowserArgv(url), { timeoutMs: 10000 }).catch(() => undefined)
  }

  async function openPane(engine: Host, focus: boolean) {
    await engine
      .openPane({ id: PANE_ID, title: STRINGS.paneTitle, ...(focus && { focus: true }) })
      .catch(() => undefined)
    isPaneOpen = true
  }

  async function closePane(engine: Host) {
    if (!isPaneOpen) {
      return
    }
    isPaneOpen = false
    await engine.closePane({ id: PANE_ID }).catch(() => undefined)
  }

  /**
   * 待機中の質問票を片付けます: 受信サーバを kill、監視を止め、ペインを閉じます。
   * 同期待ちの最中なら、次の周回で `dropReason` を見て `cancelled` を返します。
   */
  async function dropPending(engine: Host, reason: DropReason) {
    const current = pending
    if (!current) {
      return
    }
    pending = null
    current.dropReason = reason
    current.timer.cancel()
    engine.status(undefined)
    await engine.run(killArgv(current.receiver.pid), { timeoutMs: 5000 }).catch(() => undefined)
    await closePane(engine)
  }

  /**
   * 回答を固定形にして `<label>.md` に書き、ペインを閉じます。
   * 同期経路はこの文を Tool result で、非同期経路は `prompt.submit` で Claude に届けます。
   *
   * @returns 回答固定形
   */
  async function settle(engine: Host, current: Pending, answer: AnswerV1): Promise<string> {
    const text = formatReply(current.form, answer)
    await engine.writeFile(current.paths.md, `${text}\n`)
    engine.status(undefined)
    await closePane(engine)
    engine.uiLog(STRINGS.receivedOf(current.paths.md))
    return text
  }

  /**
   * 監視タイマーの 1 回分。回答ファイルがあれば読んで `prompt.submit` で届けます。
   * 同じ回答を 2 回届けないよう、届ける前に `pending` を消し、タイマーを止めます。
   * 同期待ち中 (`isSyncWaiting`) は経過秒数の更新だけ行い、回答は `tool.call` 側に任せます。
   */
  function tick(engine: Host, current: Pending) {
    if (pending !== current || current.isChecking) {
      return
    }
    current.isChecking = true

    void (async () => {
      current.ticks += 1
      if (current.ticks % REDRAW_EVERY_TICKS === 0) {
        elapsedSeconds = Math.max(0, Math.floor(((await engine.now()) - current.startedAtMs) / 1000))
        if (isPaneOpen) {
          engine.invalidate()
        }
      }

      if (current.isSyncWaiting || !(await engine.exists(current.paths.answer))) {
        return
      }
      const answer = parseAnswer(await engine.readFile(current.paths.answer), current.form)
      if (!answer || pending !== current || current.isSyncWaiting) {
        return
      }

      pending = null
      current.timer.cancel()
      const text = await settle(engine, current, answer)
      await engine.submitPrompt({ text })
    })()
      .catch((error: unknown) => {
        engine.uiLog(`インタビューの回答を処理できませんでした: ${String(error)}`)
      })
      .finally(() => {
        current.isChecking = false
      })
  }

  const failed = (reason: string, paths: Paths) =>
    ({
      result: JSON.stringify({
        status: 'failed',
        reason: `${reason}。${STRINGS.fallbackOf(paths.html)}`,
        files: { form: paths.form, html: paths.html },
      }),
    }) as const

  on('session.start', async ($, e, next) => {
    cwd = e.cwd

    const engine: Host = {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
      run: (argv, init) => $.process.run(argv, init),
      writeFile: (path, text) => $.fs.write(path, text),
      readFile: path => $.fs.read(path),
      exists: path => $.fs.exists(path),
      fetch: (url, init) => $.http.fetch(url, init),
      openPane: pane => $.ui.open(pane),
      closePane: pane => $.ui.close(pane),
      invalidate: () => $.ui.invalidate('ui.render'),
      uiLog: text => $.ui.log(text),
      status: text => $.ui.status(text),
      submitPrompt: input => $.prompt.submit(input),
      pluginRoot: $.plugin.root,
    }
    host = engine

    try {
      await $.tool.register({
        name: TOOL_NAME,
        description: STRINGS.toolDescription,
        inputSchema: TOOL_INPUT_SCHEMA,
      })
    } catch (error) {
      engine.uiLog(`ツール ${TOOL_NAME} を登録できませんでした: ${String(error)}`)
    }

    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: STRINGS.commandDescription,
      })
    } catch (error) {
      engine.uiLog(`/${COMMAND_NAME} を登録できませんでした: ${String(error)}`)
    }

    void hasPython(engine)

    return next(e)
  })

  on('tool.call', { tool: 'mcp__document-interview__open_form' }, async ($, e, next) => {
    const engine = host
    if (!engine) {
      return { result: JSON.stringify({ status: 'failed', reason: 'session.start がまだ実行されていません' }) }
    }

    const validation = validateForm(e.form)
    if (!validation.ok) {
      return { result: JSON.stringify({ status: 'invalid', errors: validation.errors }) }
    }
    const { form } = validation
    const isBrowserWanted = e.openBrowser !== false
    const waitSeconds = clampWaitSeconds(e.waitSeconds)

    await dropPending(engine, 'replaced')

    const paths = pathsOf(form.label)
    const nowMs = await engine.now()
    const date = new Date(nowMs).toISOString().slice(0, 10)

    await engine.writeFile(paths.form, `${JSON.stringify(form, null, 2)}\n`)
    await engine.writeFile(paths.html, renderHtml({ form, date }))

    if (!(await hasPython(engine))) {
      return failed(STRINGS.noPython, paths)
    }

    // 同じ label の前回の回答と port-file を消す (残っていると古い回答を拾う)
    await engine.run(cleanupArgv({ out: paths.answer, portFile: paths.portFile }), { timeoutMs: 5000 }).catch(() => undefined)

    const token = tokenOf(nowMs)
    const argv = receiverArgv(
      { pluginRoot: engine.pluginRoot, html: paths.html, out: paths.answer, portFile: paths.portFile },
      token,
    )

    try {
      await engine.run(argv, { timeoutMs: 10000 })
    } catch (error) {
      return failed(`受信サーバを起動できませんでした (${String(error)})`, paths)
    }

    const receiver = await readPortFile(engine, paths.portFile)
    if (!receiver) {
      return failed(STRINGS.noPortFile, paths)
    }

    const url = urlOf(receiver.port, token)
    const current: Pending = {
      form,
      label: form.label,
      receiver,
      url,
      linkUrl: linkUrlOf(receiver.port, token),
      paths,
      startedAtMs: nowMs,
      timer: { cancel: () => undefined },
      ticks: 0,
      isChecking: false,
      isSyncWaiting: waitSeconds > 0,
      dropReason: null,
    }
    current.timer = engine.every(WATCH_INTERVAL_MS, () => tick(engine, current))
    pending = current
    elapsedSeconds = 0

    if (isBrowserWanted) {
      openBrowser(engine, url)
    }
    void openPane(engine, false)

    const identity = { documentId: form.documentId, revision: form.revision }
    const files = { form: paths.form, html: paths.html }

    // 同期待ち: 上限までは tool.call の中で回答を待ち、Tool result で返す
    const end = await waitForAnswer(
      engine,
      { form, answerPath: paths.answer, port: receiver.port, token },
      { waitSeconds, signal: next.signal, isStillPending: () => pending === current },
    )
    current.isSyncWaiting = false

    if (end.kind === 'answered') {
      if (pending === current) {
        pending = null
        current.timer.cancel()
      }
      const reply = await settle(engine, current, end.answer)
      return {
        result: JSON.stringify({
          status: 'answered',
          ...identity,
          reply,
          files: { ...files, answer: paths.answer, md: paths.md },
        }),
        context: [STRINGS.answeredContext],
      }
    }

    if (end.kind === 'dropped') {
      return {
        result: JSON.stringify({
          status: 'cancelled',
          ...identity,
          reason: current.dropReason === 'replaced' ? STRINGS.replacedByAnother : STRINGS.cancelledByPerson,
        }),
      }
    }

    // 回答は届いていない。以後は監視タイマーが prompt.submit で届ける
    return {
      result: JSON.stringify({
        status: 'pending',
        ...identity,
        url,
        files,
        wait: { seconds: end.waitedSeconds, endedBy: end.endedBy },
      }),
      context: [STRINGS.toolContext],
    }
  })

  on('command.run', { command: 'interview' }, async () => {
    const engine = host
    const current = pending
    if (!engine || !current) {
      return { text: STRINGS.nothingPending }
    }
    await openPane(engine, true)
    openBrowser(engine, current.url)
    return { text: STRINGS.reopenedOf(current.url) }
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    const engine = host
    const current = pending
    if (e.requestId !== PANE_ID || !engine || !current) {
      return next(e)
    }

    const { Box, Text, Button, Link } = $.ui.resolve(e)

    return paneView(
      { Box, Text, Button, Link },
      {
        label: current.label,
        revision: current.form.revision,
        url: current.url,
        linkUrl: current.linkUrl,
        elapsedSeconds,
      },
      {
        openBrowser: () => openBrowser(engine, current.url),
        cancel: () => {
          void dropPending(engine, 'cancelled').then(() => engine.uiLog(STRINGS.cancelled))
        },
      },
    )
  })

  on('ui.close', { id: 'interview' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      isPaneOpen = false
    }
    if (e.origin?.kind === 'person' && pending && host) {
      host.status(STRINGS.closedHint)
    }
    return result
  })
}
