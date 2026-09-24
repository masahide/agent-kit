import type { On, Timer } from 'claude-code'

import { parseAnswer } from './form/answer'
import { REVIEW_INPUT_SCHEMA, TOOL_INPUT_SCHEMA } from './form/schema'
import { validateForm } from './form/validate'
import type { Host } from './host'
import {
  COMMAND_NAME,
  EVIDENCE_DIR,
  PANE_ID,
  REVIEW_TOOL_NAME,
  TOOL_NAME,
} from './names'
import {
  cleanupArgv,
  isPython3,
  linkUrlOf,
  openBrowserArgv,
  parseStartOutput,
  PYTHON_CANDIDATES,
  receiverArgv,
  stopArgv,
  urlOf,
  type ReceiverInfo,
} from './receiver'
import { formatReply } from './reply/format'
import { parseReviewAnswer } from './review/answer'
import { documentErrors } from './review/document'
import { formatReviewReply } from './review/format'
import { validateReview } from './review/validate-review'
import { renderHtml } from './sheet/render-html'
import { renderReviewHtml } from './sheet/render-review'
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
 * 証跡ファイルの置き場。`doc` は指摘の画面で Claude が書き出す文書の HTML です。
 */
type Paths = {
  form: string
  html: string
  answer: string
  md: string
  doc: string
}

/**
 * 待機が終わった理由 (同期待ちの結果 `cancelled` の reason に使います)。
 */
type DropReason = 'cancelled' | 'replaced'

/**
 * 人に出す画面 1 つ分。質問票 (`open_form`) と指摘の画面 (`open_review`) の違いはここに閉じ込めます。
 */
type Sheet = {
  documentId: string
  revision: number
  label: string
  /** ペインの 1 行目 */
  heading: string
  paths: Paths
  /** 回答ファイルの中身を回答固定形にする。この画面の回答でなければ null */
  replyOf: (text: string) => string | null
  /** 結果の `files` (answered では answer と md を足す) */
  files: Record<string, string>
  /** `answered` と `pending` の結果に添える context */
  answeredContext: string
  pendingContext: string
}

/**
 * 待機中の画面 1 つ分の状態。
 */
type Pending = {
  sheet: Sheet
  receiver: ReceiverInfo
  url: string
  linkUrl: string
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
 * doc-desk Mod のフックを登録します。
 *
 * 状態機械 (open_review も open_form と同じ):
 *
 * ```
 * idle --open_form--> waiting(sync) --回答検知 (tool.call の中)--> idle  (結果 answered)
 * waiting(sync) --waitSeconds 到達 / 中断 / 受信サーバ喪失--> waiting(async)  (結果 pending)
 * waiting(async) --回答検知 (監視タイマー)--> submitting --prompt.submit 済--> idle
 * waiting --open_form / open_review (別の画面)--> 前の受信サーバを kill、監視停止 → 新しい waiting
 * waiting --[取り消す]--> kill、監視停止、ペイン閉 → idle  (同期待ち中なら結果 cancelled)
 * waiting --ui.close (人)--> waiting のまま (監視は続く)
 * waiting --/doc-desk--> ペインとブラウザを開き直す
 * ```
 *
 * @param on エンジンの登録関数
 */
export function register(on: On) {
  let host: Host | null = null
  let cwd = ''
  let pythonProbe: Promise<readonly string[] | null> | null = null
  let pending: Pending | null = null
  let isPaneOpen = false
  let elapsedSeconds = 0

  const pathsOf = (label: string): Paths => {
    const base = `${cwd}/${EVIDENCE_DIR}/${label}`
    return {
      form: `${base}.json`,
      html: `${base}.html`,
      answer: `${base}.answer.json`,
      md: `${base}.md`,
      doc: `${base}.doc.html`,
    }
  }

  /**
   * 受信サーバと照合するトークン。ローカルの一回限りなので乱数で足ります。
   */
  const tokenOf = (nowMs: number): string =>
    `${nowMs.toString(16)}${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`

  /**
   * Python 3 を起動する argv を `PYTHON_CANDIDATES` の順に 1 回だけ探し、結果を保持します。
   * どれも Python 3 でなければ null です。
   */
  function pythonOf(engine: Host): Promise<readonly string[] | null> {
    pythonProbe ??= (async () => {
      for (const candidate of PYTHON_CANDIDATES) {
        const result = await engine.run([...candidate, '--version'], { timeoutMs: 10000 }).catch(() => null)
        if (result && isPython3(result)) {
          return candidate
        }
      }
      return null
    })()
    return pythonProbe
  }

  function openBrowser(engine: Host, url: string) {
    void pythonOf(engine)
      .then(python => python && engine.run(openBrowserArgv(python, engine.pluginRoot, url), { timeoutMs: 10000 }))
      .catch(() => undefined)
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
   * 待機中の画面を片付けます: 受信サーバを止め、監視を止め、ペインを閉じます。
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
    const python = await pythonOf(engine)
    if (python) {
      await engine
        .run(stopArgv(python, engine.pluginRoot, current.receiver.pid), { timeoutMs: 5000 })
        .catch(() => undefined)
    }
    await closePane(engine)
  }

  /**
   * 回答固定形を `<label>.md` に書き、ペインを閉じます。
   * 同期経路はこの文を Tool result で、非同期経路は `prompt.submit` で Claude に届けます。
   */
  async function settle(engine: Host, sheet: Sheet, reply: string) {
    await engine.writeFile(sheet.paths.md, `${reply}\n`)
    engine.status(undefined)
    await closePane(engine)
    engine.uiLog(STRINGS.receivedOf(sheet.paths.md))
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

      if (current.isSyncWaiting || !(await engine.exists(current.sheet.paths.answer))) {
        return
      }
      const reply = current.sheet.replyOf(await engine.readFile(current.sheet.paths.answer))
      if (reply === null || pending !== current || current.isSyncWaiting) {
        return
      }

      pending = null
      current.timer.cancel()
      await settle(engine, current.sheet, reply)
      await engine.submitPrompt({ text: reply })
    })()
      .catch((error: unknown) => {
        engine.uiLog(`インタビューの回答を処理できませんでした: ${String(error)}`)
      })
      .finally(() => {
        current.isChecking = false
      })
  }

  const failed = (reason: string, sheet: Sheet) =>
    ({
      result: JSON.stringify({
        status: 'failed',
        reason: `${reason}。${STRINGS.fallbackOf(sheet.paths.html)}`,
        files: sheet.files,
      }),
    }) as const

  const invalid = (errors: string[]) => ({ result: JSON.stringify({ status: 'invalid', errors }) }) as const

  /**
   * 書き終えた画面の HTML を受信サーバで配り、回答を待ちます (open_form と open_review で共通)。
   * 前の待機は差し替えます。`waitSeconds` までは呼び出しの中で待ち、届けば `answered` を返します。
   */
  async function serveSheet(
    engine: Host,
    sheet: Sheet,
    options: { nowMs: number; isBrowserWanted: boolean; waitSeconds: number; signal: AbortSignal },
  ) {
    const { paths } = sheet
    const python = await pythonOf(engine)
    if (!python) {
      return failed(STRINGS.noPython, sheet)
    }

    // 同じ label の前回の回答を消す (残っていると古い回答を拾う)
    await engine.run(cleanupArgv(python, engine.pluginRoot, { out: paths.answer }), { timeoutMs: 5000 }).catch(() => undefined)

    const token = tokenOf(options.nowMs)
    const argv = receiverArgv(python, { pluginRoot: engine.pluginRoot, html: paths.html, out: paths.answer }, token)

    let receiver: ReceiverInfo | null
    try {
      receiver = parseStartOutput((await engine.run(argv, { timeoutMs: 10000 })).stdout)
    } catch (error) {
      return failed(`受信サーバを起動できませんでした (${String(error)})`, sheet)
    }
    if (!receiver) {
      return failed(STRINGS.noPort, sheet)
    }

    const url = urlOf(receiver.port, token)
    const current: Pending = {
      sheet,
      receiver,
      url,
      linkUrl: linkUrlOf(receiver.port, token),
      startedAtMs: options.nowMs,
      timer: { cancel: () => undefined },
      ticks: 0,
      isChecking: false,
      isSyncWaiting: options.waitSeconds > 0,
      dropReason: null,
    }
    current.timer = engine.every(WATCH_INTERVAL_MS, () => tick(engine, current))
    pending = current
    elapsedSeconds = 0

    if (options.isBrowserWanted) {
      openBrowser(engine, url)
    }
    void openPane(engine, false)

    const identity = { documentId: sheet.documentId, revision: sheet.revision }

    // 同期待ち: 上限までは tool.call の中で回答を待ち、Tool result で返す
    const end = await waitForAnswer(
      engine,
      { read: sheet.replyOf, answerPath: paths.answer, port: receiver.port, token },
      { waitSeconds: options.waitSeconds, signal: options.signal, isStillPending: () => pending === current },
    )
    current.isSyncWaiting = false

    if (end.kind === 'answered') {
      if (pending === current) {
        pending = null
        current.timer.cancel()
      }
      await settle(engine, sheet, end.answer)
      return {
        result: JSON.stringify({
          status: 'answered',
          ...identity,
          reply: end.answer,
          files: { ...sheet.files, answer: paths.answer, md: paths.md },
        }),
        context: [sheet.answeredContext],
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
        files: sheet.files,
        wait: { seconds: end.waitedSeconds, endedBy: end.endedBy },
      }),
      context: [sheet.pendingContext],
    }
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd

    const engine: Host = {
      now: () => $.clock.now(),
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

    for (const tool of [
      { name: TOOL_NAME, description: STRINGS.toolDescription, inputSchema: TOOL_INPUT_SCHEMA },
      { name: REVIEW_TOOL_NAME, description: STRINGS.reviewToolDescription, inputSchema: REVIEW_INPUT_SCHEMA },
    ]) {
      try {
        await $.tool.register(tool)
      } catch (error) {
        engine.uiLog(`ツール ${tool.name} を登録できませんでした: ${String(error)}`)
      }
    }

    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: STRINGS.commandDescription,
      })
    } catch (error) {
      engine.uiLog(`/${COMMAND_NAME} を登録できませんでした: ${String(error)}`)
    }

    void pythonOf(engine)

    return next(e)
  })

  on('tool.call', { tool: 'mcp__doc-desk__open_form' }, async ($, e, next) => {
    const engine = host
    if (!engine) {
      return { result: JSON.stringify({ status: 'failed', reason: 'session.start がまだ実行されていません' }) }
    }

    const validation = validateForm(e.form)
    if (!validation.ok) {
      return invalid(validation.errors)
    }
    const { form } = validation

    await dropPending(engine, 'replaced')

    const paths = pathsOf(form.label)
    const nowMs = await engine.now()
    const date = new Date(nowMs).toISOString().slice(0, 10)

    await engine.writeFile(paths.form, `${JSON.stringify(form, null, 2)}\n`)
    await engine.writeFile(paths.html, renderHtml({ form, date }))

    const sheet: Sheet = {
      documentId: form.documentId,
      revision: form.revision,
      label: form.label,
      heading: STRINGS.headerOf(form.label, form.revision),
      paths,
      replyOf: text => {
        const answer = parseAnswer(text, form)
        return answer ? formatReply(form, answer) : null
      },
      files: { form: paths.form, html: paths.html },
      answeredContext: STRINGS.answeredContext,
      pendingContext: STRINGS.toolContext,
    }
    return serveSheet(engine, sheet, {
      nowMs,
      isBrowserWanted: e.openBrowser !== false,
      waitSeconds: clampWaitSeconds(e.waitSeconds),
      signal: next.signal,
    })
  })

  on('tool.call', { tool: 'mcp__doc-desk__open_review' }, async ($, e, next) => {
    const engine = host
    if (!engine) {
      return { result: JSON.stringify({ status: 'failed', reason: 'session.start がまだ実行されていません' }) }
    }

    const validation = validateReview(e.review)
    if (!validation.ok) {
      return invalid(validation.errors)
    }
    const { review } = validation
    const paths = pathsOf(review.label)

    if (!(await engine.exists(paths.doc))) {
      return invalid([`${paths.doc}: ${STRINGS.noDocument}`])
    }
    const html = await engine.readFile(paths.doc).catch(() => null)
    if (html === null) {
      return invalid([`${paths.doc}: ${STRINGS.unreadableDocument}`])
    }
    const errors = documentErrors(html)
    if (errors.length > 0) {
      return invalid(errors.map(message => `${paths.doc}: ${message}`))
    }

    await dropPending(engine, 'replaced')

    const nowMs = await engine.now()
    const date = new Date(nowMs).toISOString().slice(0, 10)

    await engine.writeFile(paths.form, `${JSON.stringify(review, null, 2)}\n`)
    await engine.writeFile(paths.html, renderReviewHtml({ review, html, date }))

    const sheet: Sheet = {
      documentId: review.documentId,
      revision: review.revision,
      label: review.label,
      heading: STRINGS.reviewHeaderOf(review.label, review.revision),
      paths,
      replyOf: text => {
        const answer = parseReviewAnswer(text, review)
        return answer ? formatReviewReply(review, answer) : null
      },
      files: { doc: paths.doc, review: paths.form, html: paths.html },
      answeredContext: STRINGS.reviewAnsweredContext,
      pendingContext: STRINGS.reviewPendingContext,
    }
    return serveSheet(engine, sheet, {
      nowMs,
      isBrowserWanted: e.openBrowser !== false,
      waitSeconds: clampWaitSeconds(e.waitSeconds),
      signal: next.signal,
    })
  })

  on('command.run', { command: 'doc-desk' }, async () => {
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
        heading: current.sheet.heading,
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

  on('ui.close', { id: 'doc-desk' }, async ($, e, next) => {
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
