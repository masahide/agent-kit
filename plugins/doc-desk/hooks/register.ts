import type { On, PluginOptions, Timer } from 'claude-code'

import { parseAnswer } from './form/answer'
import { questionsOf, type FormV1 } from './form/form-v1'
import { REVIEW_INPUT_SCHEMA, TOOL_INPUT_SCHEMA } from './form/schema'
import { validateForm } from './form/validate'
import { buildDecisionRecord, isDecisionRecord, type SettledReply } from './compact/record'
import { isSamePath, normalizePath, writeTargetOf } from './guard/paths'
import type { Host } from './host'
import {
  COMMAND_NAME,
  EVIDENCE_DIR,
  PANE_ID,
  PLUGIN_NAME,
  REVIEW_TOOL_NAME,
  TOOL_NAME,
} from './names'
import {
  cleanupArgv,
  removeArgv,
  isPython3,
  linkUrlOf,
  openBrowserArgv,
  parseStartOutput,
  PYTHON_CANDIDATES,
  receiverArgv,
  stopArgv,
  urlOf,
  waitUrlOf,
  type ReceiverInfo,
} from './receiver'
import { formatReply } from './reply/format'
import { summarizeReply, type ReplySummary } from './reply/summary'
import { parseReviewAnswer } from './review/answer'
import { candidatePrompt, parseCandidates, wantsSelfReview, type ReviewCandidate } from './review/candidates'
import { documentErrors, numberedBlocks } from './review/document'
import { formatReviewReply } from './review/format'
import type { ReviewV1 } from './review/review-v1'
import { validateReview } from './review/validate-review'
import { renderHtml } from './sheet/render-html'
import { renderReviewHtml } from './sheet/render-review'
import {
  HEARTBEAT_INTERVAL_MS,
  isOwnedByOther,
  LEASE_MS,
  isStale,
  parsePendingRecord,
  recordKeyOf,
  recordPrefixOf,
  type PendingRecord,
} from './store/pending-record'
import { paneView } from './views/pane-view'
import { replyRow } from './views/reply-row'
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
  /** 指摘の画面に出した Claude の候補 (証跡) */
  candidates: string
}

/**
 * 待機が終わった理由 (同期待ちの結果 `cancelled` の reason に使います)。
 */
type DropReason = 'cancelled' | 'replaced' | 'released'

/**
 * 人に出す画面 1 つ分。質問票 (`open_form`) と指摘の画面 (`open_review`) の違いはここに閉じ込めます。
 */
type Sheet = {
  kind: PendingRecord['kind']
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
  /** 回答待ちの間、Write / Edit / NotebookEdit を止めるパス (書いたまま。照合のときに正規化する) */
  guardedPaths: string[]
  /** 回答固定形を畳んだ 1 行の中身 (質問票は問いの題が分かるので、題に紛らわしい文字列があっても読める) */
  summaryOf: (reply: string) => ReplySummary | null
}

/**
 * 待機中の画面 1 つ分の状態。
 */
type Pending = {
  sheet: Sheet
  receiver: ReceiverInfo
  token: string
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
  /** `turn.complete` で回答先の URL を添えたか (1 つの待機につき 1 回) */
  isUrlShown: boolean
}

/**
 * 起動時に見つけた、まだ Claude に送っていない回答。`/doc-desk` で送ります。
 */
type Unsent = {
  sheet: Sheet
  reply: string
}

/**
 * 質問票の画面を組みます。
 */
function sheetOfForm(form: FormV1, paths: Paths): Sheet {
  return {
    kind: 'form',
    documentId: form.documentId,
    revision: form.revision,
    label: form.label,
    heading: STRINGS.headerOf(form.label, form.revision),
    paths,
    replyOf: text => {
      const answer = parseAnswer(text, form)
      return answer ? formatReply(form, answer) : null
    },
    summaryOf: reply => summarizeReply(reply, questionsOf(form).map(question => question.title)),
    files: { form: paths.form, html: paths.html },
    answeredContext: STRINGS.answeredContext,
    pendingContext: STRINGS.toolContext,
    guardedPaths: form.source === undefined ? [] : [form.source],
  }
}

/**
 * 指摘の画面を組みます。
 */
function sheetOfReview(review: ReviewV1, paths: Paths, hasCandidates: boolean): Sheet {
  return {
    kind: 'review',
    documentId: review.documentId,
    revision: review.revision,
    label: review.label,
    heading: STRINGS.reviewHeaderOf(review.label, review.revision),
    paths,
    replyOf: text => {
      const answer = parseReviewAnswer(text, review)
      return answer ? formatReviewReply(review, answer) : null
    },
    summaryOf: reply => summarizeReply(reply),
    files: { doc: paths.doc, review: paths.form, html: paths.html, ...(hasCandidates && { candidates: paths.candidates }) },
    answeredContext: STRINGS.reviewAnsweredContext,
    pendingContext: STRINGS.reviewPendingContext,
    guardedPaths: [...(review.source === undefined ? [] : [review.source]), paths.doc],
  }
}

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * `$.prompt.submit` の結果が、投入を受け付けたものか (`{ drop }` で resolve したら受け付けられていない)。
 */
const isAccepted = (result: { drop?: string }): boolean => result.drop === undefined

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
 * 待機は `$.store` の `pending:<cwd>` にも記録し、次の `session.start` で引き継ぎます:
 *
 * ```
 * 記録あり + 回答ファイルあり --人がいる--> unsent (/doc-desk で送る)
 *                             ---p / SDK--> prompt.submit で届ける
 * 記録あり + 受信サーバが生きている --> waiting(async) (ブラウザもペインも開かない)
 * 記録あり + 受信サーバが死んでいる --> 同じ port と token で起動し直して waiting(async)
 * 記録が古い (7 日超) / 証跡が無い --> 記録を消す
 * ```
 *
 * @param on エンジンの登録関数
 * @param options plugin.json の `userConfig` の値 (`selfReview`: 指摘の画面に Claude の候補を出すか。既定 true)
 */
export function register(on: On, options: PluginOptions = {}) {
  let host: Host | null = null
  let cwd = ''
  /** このセッションの id (`$.session.id()`)。待機の記録の持ち主に書く */
  let sessionId = ''
  /** このセッションが持っている待機の記録。heartbeat で時刻を進める */
  let ownedRecord: PendingRecord | null = null
  /** 「別のセッションが待っている」を案内した記録の token (lease が切れる頃にもう一度見るとき、案内を繰り返さない) */
  const announcedOwnedByOther = new Set<string>()
  let pythonProbe: Promise<readonly string[] | null> | null = null
  let pending: Pending | null = null
  let unsent: Unsent | null = null
  let isPaneOpen = false
  let elapsedSeconds = 0
  /** このセッションで届けた回答固定形 → 保存した `.md` (畳んだ回答行に出す) */
  const mdPathOfReply = new Map<string, string>()
  /** このセッションで届けた回答固定形 → 畳んだ 1 行 (質問票の題を知っている画面で作ったもの) */
  const summaryOfReply = new Map<string, ReplySummary | null>()
  /** このセッションで Claude に届けた回答 (古い順、label ごとに最新の 1 つ)。圧縮で原文を差し戻す */
  let settled: { label: string; mdPath: string }[] = []

  const rememberSettled = (sheet: Sheet) => {
    settled = [...settled.filter(entry => entry.label !== sheet.label), { label: sheet.label, mdPath: sheet.paths.md }]
  }

  const pathsOf = (label: string): Paths => {
    const base = `${cwd}/${EVIDENCE_DIR}/${label}`
    return {
      form: `${base}.json`,
      html: `${base}.html`,
      answer: `${base}.answer.json`,
      md: `${base}.md`,
      doc: `${base}.doc.html`,
      candidates: `${base}.candidates.json`,
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

  /**
   * 待機を `$.store` に記録します (次の `session.start` で引き継ぐため)。書けなくても待機は続けます。
   */
  async function saveRecord(engine: Host, current: Pending) {
    await claimRecord(engine, {
      kind: current.sheet.kind,
      label: current.sheet.label,
      documentId: current.sheet.documentId,
      revision: current.sheet.revision,
      token: current.token,
      port: current.receiver.port,
      pid: current.receiver.pid,
      startedAtMs: current.startedAtMs,
      sessionId,
      heartbeatAtMs: 0,
    })
  }

  /**
   * 記録をこのセッションのものとして書きます (持ち主の id と heartbeat の時刻を入れる)。
   */
  async function claimRecord(engine: Host, record: PendingRecord) {
    ownedRecord = { ...record, sessionId, heartbeatAtMs: await engine.now() }
    await engine.storeSet(recordKeyOf(cwd, sessionId), ownedRecord).catch(() => undefined)
  }

  /**
   * このセッションの記録を消します。同じフォルダの別のセッションの記録には触りません。
   */
  async function forgetRecord(engine: Host) {
    ownedRecord = null
    await engine.storeDelete(recordKeyOf(cwd, sessionId)).catch(() => undefined)
  }

  /**
   * このセッションが記録を持っていれば heartbeat の時刻を進めます。
   *
   * 自分のキーの記録が消えていて、同じ token の記録が別のセッションのキーにあれば (このセッションが止まっている
   * 間に lease が切れ、別のセッションが引き継いだ)、受信サーバは止めずに手を引きます。そうでなければ
   * (書き込みの失敗などで消えただけ) 記録を書き直し、届け手がいなくならないようにします。
   */
  async function heartbeat(engine: Host) {
    const owned = ownedRecord
    if (!owned) {
      return
    }
    const key = recordKeyOf(cwd, sessionId)
    const stored = await engine.storeGet(key).catch(() => null)
    if (ownedRecord !== owned) {
      return
    }
    if (stored === undefined && (await isTakenOver(engine, owned))) {
      if (ownedRecord !== owned) {
        return
      }
      ownedRecord = null
      unsent = null
      const current = pending
      if (current && current.token === owned.token) {
        pending = null
        current.dropReason = 'released'
        current.timer.cancel()
        engine.status(undefined)
        await closePane(engine)
      }
      engine.uiLog(STRINGS.ownedByOtherOf(owned.kind, owned.label))
      return
    }
    ownedRecord = { ...owned, heartbeatAtMs: await engine.now() }
    await engine.storeSet(key, ownedRecord).catch(() => undefined)
  }

  /**
   * 同じフォルダの別のセッションのキーに、同じ token の記録があるか (その待機が引き継がれたか)。
   */
  async function isTakenOver(engine: Host, owned: PendingRecord): Promise<boolean> {
    const prefix = recordPrefixOf(cwd)
    const mine = recordKeyOf(cwd, sessionId)
    for (const key of await engine.storeKeys().catch(() => [] as string[])) {
      if (!key.startsWith(prefix) || key === mine) {
        continue
      }
      const record = parsePendingRecord(await engine.storeGet(key).catch(() => undefined))
      if (record && record.token === owned.token && record.sessionId !== sessionId) {
        return true
      }
    }
    return false
  }

  /**
   * 同じフォルダの記録のうち、このセッションが引き継げるものを探します。別のセッションが今も持っているものは
   * 案内だけ出して飛ばし、形の違うものは消します。残りを待機を始めたのが新しい順に、キーと一緒に返します。
   */
  async function recordToCarryOver(
    engine: Host,
  ): Promise<{ candidates: { key: string; record: PendingRecord }[]; leaseEndMs: number | null }> {
    const prefix = recordPrefixOf(cwd)
    const keys = (await engine.storeKeys().catch(() => [] as string[])).filter(key => key.startsWith(prefix))
    const nowMs = await engine.now()
    const free: { key: string; record: PendingRecord }[] = []
    let leaseEndMs: number | null = null
    for (const key of keys) {
      const record = parsePendingRecord(await engine.storeGet(key).catch(() => undefined))
      if (!record) {
        await engine.storeDelete(key).catch(() => undefined)
        continue
      }
      if (isOwnedByOther(record, sessionId, nowMs)) {
        // 同じフォルダで動いている別のセッションが待っている。両方で届けたり、取り消しで相手の受信サーバを止めたりしない。
        // 案内は記録ごとに 1 回だけ出す (lease が切れる頃にもう一度見るので)
        if (!announcedOwnedByOther.has(record.token)) {
          announcedOwnedByOther.add(record.token)
          engine.uiLog(STRINGS.ownedByOtherOf(record.kind, record.label))
        }
        const end = record.heartbeatAtMs + LEASE_MS
        leaseEndMs = leaseEndMs === null ? end : Math.min(leaseEndMs, end)
        continue
      }
      free.push({ key, record })
    }
    free.sort((a, b) => b.record.startedAtMs - a.record.startedAtMs)
    return { candidates: free, leaseEndMs }
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
   * 待機中の画面を片付けます: 受信サーバを止め、監視を止め、ペインを閉じ、記録を消します。
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
    await forgetRecord(engine)
    const python = await pythonOf(engine)
    if (python) {
      await engine
        .run(stopArgv(python, engine.pluginRoot, current.receiver.pid), { timeoutMs: 5000 })
        .catch(() => undefined)
    }
    await closePane(engine)
  }

  /**
   * 回答固定形を `<label>.md` に書き、ペインを閉じ、記録を消します。
   * 同期経路はこの文を Tool result で、非同期経路は `prompt.submit` で Claude に届けます。
   */
  async function settle(engine: Host, sheet: Sheet, reply: string) {
    await writeReply(engine, sheet, reply)
    engine.status(undefined)
    await forgetRecord(engine)
    await closePane(engine)
    engine.uiLog(STRINGS.receivedOf(sheet.paths.md))
    engine.toast(STRINGS.receivedToastOf(sheet.label))
  }

  /**
   * 回答固定形を `<label>.md` に書き、畳んだ回答行のために覚えます。
   */
  async function writeReply(engine: Host, sheet: Sheet, reply: string) {
    await engine.writeFile(sheet.paths.md, `${reply}\n`)
    mdPathOfReply.set(reply, sheet.paths.md)
    summaryOfReply.set(reply, sheet.summaryOf(reply))
  }

  /**
   * 回答ファイルがあり、この画面の回答として読めれば回答固定形を返します。
   */
  async function readReply(engine: Host, sheet: Sheet): Promise<string | null> {
    if (!(await engine.exists(sheet.paths.answer))) {
      return null
    }
    return sheet.replyOf(await engine.readFile(sheet.paths.answer).catch(() => ''))
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

      if (current.isSyncWaiting) {
        return
      }
      const reply = await readReply(engine, current.sheet)
      if (reply === null || pending !== current || current.isSyncWaiting) {
        return
      }

      pending = null
      current.timer.cancel()
      await settle(engine, current.sheet, reply)
      const submitted = await engine.submitPrompt({ text: reply }).catch(() => null)
      if (submitted !== null && isAccepted(submitted)) {
        rememberSettled(current.sheet)
      } else {
        // 投入が受け付けられなかった。回答を失わないよう、未送として記録を戻し、/doc-desk で送れるようにする
        if (!pending) {
          unsent = { sheet: current.sheet, reply }
          await saveRecord(engine, current)
        }
        engine.uiLog(STRINGS.unsentFailedOf(current.sheet.kind, current.sheet.label))
        engine.toast(STRINGS.unsentFailedOf(current.sheet.kind, current.sheet.label))
        void engine.suggest({ text: `/${COMMAND_NAME}` }).catch(() => undefined)
      }
    })()
      .catch((error: unknown) => {
        engine.uiLog(`インタビューの回答を処理できませんでした: ${String(error)}`)
      })
      .finally(() => {
        current.isChecking = false
      })
  }

  /**
   * 受信サーバを起動します。起動できなければ理由の文を返します。
   *
   * @param preferredPort 使いたい port (引き継ぎで起動し直すとき)。塞がっていれば receiver.py が選び直す
   */
  async function startReceiver(
    engine: Host,
    python: readonly string[],
    sheet: Sheet,
    token: string,
    preferredPort?: number,
  ): Promise<ReceiverInfo | string> {
    const { paths } = sheet
    const argv = receiverArgv(python, { pluginRoot: engine.pluginRoot, html: paths.html, out: paths.answer }, token, preferredPort)
    try {
      return parseStartOutput((await engine.run(argv, { timeoutMs: 10000 })).stdout) ?? STRINGS.noPort
    } catch (error) {
      return `受信サーバを起動できませんでした (${String(error)})`
    }
  }

  /**
   * 待機を組みます: `pending` を置き、回答ファイルの監視を始め、記録を書きます。
   * ブラウザとペインは開きません (呼ぶ側が決めます)。
   */
  async function armPending(
    engine: Host,
    sheet: Sheet,
    receiver: ReceiverInfo,
    options: { token: string; startedAtMs: number; isSyncWaiting: boolean },
  ): Promise<Pending> {
    const current: Pending = {
      sheet,
      receiver,
      token: options.token,
      url: urlOf(receiver.port, options.token),
      linkUrl: linkUrlOf(receiver.port, options.token),
      startedAtMs: options.startedAtMs,
      timer: { cancel: () => undefined },
      ticks: 0,
      isChecking: false,
      isSyncWaiting: options.isSyncWaiting,
      dropReason: null,
      isUrlShown: false,
    }
    current.timer = engine.every(WATCH_INTERVAL_MS, () => tick(engine, current))
    pending = current
    elapsedSeconds = Math.max(0, Math.floor(((await engine.now()) - options.startedAtMs) / 1000))
    await saveRecord(engine, current)
    return current
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
    // 同じ label を出し直すと前回の回答ファイルは消えるので、起動時に見つけた同じ label の未送の回答も捨てる
    if (unsent?.sheet.label === sheet.label) {
      unsent = null
    }
    const python = await pythonOf(engine)
    if (!python) {
      return failed(STRINGS.noPython, sheet)
    }

    // 同じ label の前回の回答を消す (残っていると古い回答を拾う)
    await engine.run(cleanupArgv(python, engine.pluginRoot, { out: paths.answer }), { timeoutMs: 5000 }).catch(() => undefined)

    const token = tokenOf(options.nowMs)
    const receiver = await startReceiver(engine, python, sheet, token)
    if (typeof receiver === 'string') {
      return failed(receiver, sheet)
    }

    const current = await armPending(engine, sheet, receiver, {
      token,
      startedAtMs: options.nowMs,
      isSyncWaiting: options.waitSeconds > 0,
    })
    const { url } = current

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

    // 回答が読めても、その間に差し替えや取り消しがあれば届けない (差し替え先の記録やペインを触らない)
    if (end.kind === 'answered' && pending === current) {
      pending = null
      current.timer.cancel()
      await settle(engine, sheet, end.answer)
      // 同期経路は Tool result で届くので、ここで数える
      rememberSettled(sheet)
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

    if (end.kind !== 'pending') {
      return {
        result: JSON.stringify({
          status: 'cancelled',
          ...identity,
          reason:
            current.dropReason === 'replaced'
              ? STRINGS.replacedByAnother
              : current.dropReason === 'released'
                ? STRINGS.releasedToOther
                : STRINGS.cancelledByPerson,
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

  /**
   * 記録から画面を組み直します。`doc-desk/<label>.json` が無い、検証を通らない、記録と版が違うときは null。
   * 配る HTML が消えていれば書き直します。
   */
  async function sheetOfRecord(engine: Host, record: PendingRecord): Promise<Sheet | null> {
    const paths = pathsOf(record.label)
    if (!(await engine.exists(paths.form))) {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await engine.readFile(paths.form))
    } catch {
      return null
    }

    let sheet: Sheet
    let renderSheet: () => Promise<string | null>
    if (record.kind === 'form') {
      const validation = validateForm(parsed)
      if (!validation.ok) {
        return null
      }
      const { form } = validation
      sheet = sheetOfForm(form, paths)
      renderSheet = async () => renderHtml({ form, date: dateOf(record.startedAtMs) })
    } else {
      const validation = validateReview(parsed)
      if (!validation.ok) {
        return null
      }
      const { review } = validation
      sheet = sheetOfReview(review, paths, await engine.exists(paths.candidates))
      renderSheet = async () => {
        const html = await engine.readFile(paths.doc).catch(() => null)
        return html === null ? null : renderReviewHtml({ review, html, date: dateOf(record.startedAtMs) })
      }
    }
    if (sheet.documentId !== record.documentId || sheet.revision !== record.revision) {
      return null
    }

    if (!(await engine.exists(paths.html))) {
      const html = await renderSheet()
      if (html === null) {
        return null
      }
      await engine.writeFile(paths.html, html)
    }
    return sheet
  }

  /**
   * 受信サーバが生きていて、まだ回答を受けていなければ true。`GET /wait?timeout=0` で見ます。
   */
  async function isReceiverWaiting(engine: Host, record: PendingRecord): Promise<boolean> {
    try {
      const response = await engine.fetch(waitUrlOf(record.port, record.token, 0))
      if (!response.ok) {
        return false
      }
      return (JSON.parse(response.text) as { answered?: unknown }).answered === false
    } catch {
      return false
    }
  }

  /**
   * 起動時に見つけた回答を届けます。人がいる surface では勝手に turn を始めず、
   * `/doc-desk` を候補に出して待ちます (記録は送るまで残します)。
   */
  async function deliverOnStart(engine: Host, sheet: Sheet, reply: string, isHeadless: boolean) {
    await writeReply(engine, sheet, reply)
    if (isHeadless) {
      engine.uiLog(STRINGS.receivedOf(sheet.paths.md))
      // session.start は最初の prompt より前に待たれるので、turn の開始を待たない。
      // 記録は投入が受け付けられてから消す (その前にプロセスが終わっても、次の起動でまた届ける)
      void engine.submitPrompt({ text: reply }).then(
        result => {
          if (!isAccepted(result)) {
            engine.uiLog(STRINGS.unsentFailedOf(sheet.kind, sheet.label))
            return
          }
          rememberSettled(sheet)
          return forgetRecord(engine)
        },
        () => engine.uiLog(STRINGS.unsentFailedOf(sheet.kind, sheet.label)),
      )
      return
    }
    unsent = { sheet, reply }
    engine.uiLog(STRINGS.unsentOf(sheet.kind, sheet.label))
    engine.toast(STRINGS.unsentOf(sheet.kind, sheet.label))
    void engine.suggest({ text: `/${COMMAND_NAME}` }).catch(() => undefined)
  }

  /**
   * 引き継ぎの候補を新しい順に試し、最初に使えるものをこのセッションの記録にします。
   *
   * 先にこのセッションのキーへ書いてから前のキーを消します (逆の順だと、その間に lease の切れた持ち主の heartbeat が
   * 「引き継がれていない」と判断して書き直し、両方が記録を持ってしまう)。古い、または証跡の無い候補は消して次を試し、
   * 使える候補が決まったら、それより古い候補は差し替わったものとして片付けます (後日また引き継がない)。
   */
  async function claimFirstUsable(
    engine: Host,
    candidates: readonly { key: string; record: PendingRecord }[],
  ): Promise<{ record: PendingRecord; sheet: Sheet } | null> {
    for (const [index, { key, record }] of candidates.entries()) {
      if (isStale(record, await engine.now())) {
        await engine.storeDelete(key).catch(() => undefined)
        engine.uiLog(STRINGS.staleRecordOf(record.kind, record.label))
        continue
      }
      const sheet = await sheetOfRecord(engine, record)
      if (!sheet) {
        await engine.storeDelete(key).catch(() => undefined)
        continue
      }
      await claimRecord(engine, record)
      if (key !== recordKeyOf(cwd, sessionId)) {
        await engine.storeDelete(key).catch(() => undefined)
      }
      for (const older of candidates.slice(index + 1)) {
        await engine.storeDelete(older.key).catch(() => undefined)
        engine.uiLog(STRINGS.supersededOf(older.record.kind, older.record.label))
      }
      return { record, sheet }
    }
    return null
  }

  /**
   * 前のセッションの待機を引き継ぎます (`session.start` から呼びます)。
   */
  async function carryOver(engine: Host, isHeadless: boolean) {
    // このセッションがもう自分の待機を持っていれば、引き継ぎで上書きしない
    if (pending || unsent || ownedRecord) {
      return
    }
    const { candidates, leaseEndMs } = await recordToCarryOver(engine)
    const found = await claimFirstUsable(engine, candidates)
    if (!found) {
      if (leaseEndMs !== null) {
        // 別のセッションが持っている記録がある。そのセッションがクラッシュして session.end が来なかったときに備え、
        // lease が切れる頃にもう一度見る (持ち主が生きていれば heartbeat で lease が延び、また待つ)
        const waitMs = Math.max(1000, leaseEndMs - (await engine.now()) + 1000)
        engine.after(waitMs, () => {
          void carryOver(engine, isHeadless).catch((error: unknown) => {
            engine.uiLog(`前回の質問票を引き継げませんでした: ${String(error)}`)
          })
        })
      }
      return
    }
    const { record, sheet } = found

    const reply = await readReply(engine, sheet)
    if (reply !== null) {
      await deliverOnStart(engine, sheet, reply, isHeadless)
      return
    }

    let receiver: ReceiverInfo = { port: record.port, pid: record.pid }
    if (!(await isReceiverWaiting(engine, record))) {
      // `/wait` が answered を返した直後に回答ファイルが置かれることもあるので、もう一度だけ見る
      const late = await readReply(engine, sheet)
      if (late !== null) {
        await deliverOnStart(engine, sheet, late, isHeadless)
        return
      }
      const python = await pythonOf(engine)
      if (!python) {
        engine.uiLog(`${STRINGS.restartFailedOf(sheet.kind, sheet.label)} (${STRINGS.noPython})`)
        return
      }
      const restarted = await startReceiver(engine, python, sheet, record.token, record.port)
      if (typeof restarted === 'string') {
        engine.uiLog(`${STRINGS.restartFailedOf(sheet.kind, sheet.label)} (${restarted})`)
        return
      }
      if (restarted.port !== record.port && (await isReceiverWaiting(engine, record))) {
        // 同じ port を取れなかったのは、古い受信サーバが生きていたから (さっきの確認は一時的な失敗)。
        // 起動し直した方 (pid が確かなもの) を止めて、古い方を使う。古い pid は他のプロセスに使い回されて
        // いるかもしれないので、こちらからは止めない
        await engine.run(stopArgv(python, engine.pluginRoot, restarted.pid), { timeoutMs: 5000 }).catch(() => undefined)
      } else {
        receiver = restarted
        if (receiver.port !== record.port) {
          engine.uiLog(STRINGS.portChangedOf(sheet.kind, sheet.label, urlOf(receiver.port, record.token)))
        }
      }
    }

    await armPending(engine, sheet, receiver, { token: record.token, startedAtMs: record.startedAtMs, isSyncWaiting: false })
    engine.status(STRINGS.carriedOverOf(sheet.kind, sheet.label))
  }

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
      stat: (path, options) => $.fs.stat(path, options),
      fetch: (url, init) => $.http.fetch(url, init),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeDelete: key => $.store.delete(key),
      storeKeys: () => $.store.keys(),
      openPane: pane => $.ui.open(pane),
      closePane: pane => $.ui.close(pane),
      invalidate: () => $.ui.invalidate('ui.render'),
      uiLog: text => $.ui.log(text),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      submitPrompt: input => $.prompt.submit(input),
      suggest: input => $.prompt.suggest(input),
      fork: request => $.model.fork(request),
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

    sessionId = await $.session.id().catch(() => '')
    engine.every(HEARTBEAT_INTERVAL_MS, () => {
      void heartbeat(engine).catch(() => undefined)
    })

    try {
      await carryOver(engine, e.surface === null)
    } catch (error) {
      engine.uiLog(`前回の質問票を引き継げませんでした: ${String(error)}`)
    }

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

    await engine.writeFile(paths.form, `${JSON.stringify(form, null, 2)}\n`)
    await engine.writeFile(paths.html, renderHtml({ form, date: dateOf(nowMs) }))

    return serveSheet(engine, sheetOfForm(form, paths), {
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

    // Claude 自身の指摘の候補 (fork に 1 問だけ投げる)。失敗しても候補なしで進む
    let candidates: ReviewCandidate[] = []
    const isSelfReview = wantsSelfReview(options, e.selfReview)
    if (isSelfReview) {
      const blocks = numberedBlocks(html)
      const reply = await engine.fork({ prompt: candidatePrompt(blocks, review.title) }).catch(() => null)
      // fork を待つ間に人が中断したら (fork はその turn の中断で aborted を返す)、受信サーバもブラウザも出さずに終える
      if (next.signal.aborted || (reply !== null && !reply.isAnswered && reply.reason === 'aborted')) {
        return {
          result: JSON.stringify({
            status: 'cancelled',
            documentId: review.documentId,
            revision: review.revision,
            reason: STRINGS.abortedDuringSelfReview,
          }),
        }
      }
      if (reply?.isAnswered) {
        candidates = parseCandidates(reply.text, blocks.length)
      }
      await engine.writeFile(paths.candidates, `${JSON.stringify(candidates, null, 2)}\n`)
    } else if (await engine.exists(paths.candidates)) {
      // 前回の候補の証跡を残すと、今回の画面に出した候補と取り違えるので消す
      const python = await pythonOf(engine)
      if (python) {
        await engine.run(removeArgv(python, engine.pluginRoot, [paths.candidates]), { timeoutMs: 5000 }).catch(() => undefined)
      }
    }

    await dropPending(engine, 'replaced')

    const nowMs = await engine.now()

    await engine.writeFile(paths.form, `${JSON.stringify(review, null, 2)}\n`)
    await engine.writeFile(paths.html, renderReviewHtml({ review, html, date: dateOf(nowMs), candidates }))

    return serveSheet(engine, sheetOfReview(review, paths, isSelfReview), {
      nowMs,
      isBrowserWanted: e.openBrowser !== false,
      waitSeconds: clampWaitSeconds(e.waitSeconds),
      signal: next.signal,
    })
  })

  on('command.run', { command: 'doc-desk' }, async () => {
    const engine = host
    if (!engine) {
      return { text: STRINGS.nothingPending }
    }

    // 起動時に見つけた回答が未送なら送る
    const waiting = unsent
    if (waiting) {
      unsent = null
      engine.uiLog(STRINGS.receivedOf(waiting.sheet.paths.md))
      // command.run の中の prompt.submit はエンジンが拒む (このコマンドが握る turn を待つことになる) ので、
      // タイマーでコマンドが終わった後に回す。記録は投入が受け付けられてから消し、失敗したら未送に戻す
      engine.after(0, () => {
        const restoreUnsent = () => {
          unsent = waiting
          engine.uiLog(STRINGS.unsentFailedOf(waiting.sheet.kind, waiting.sheet.label))
        }
        void engine.submitPrompt({ text: waiting.reply }).then(async result => {
          if (!isAccepted(result)) {
            restoreUnsent()
            return
          }
          rememberSettled(waiting.sheet)
          if (!pending) {
            await forgetRecord(engine)
          }
        }, restoreUnsent)
      })
      return { text: STRINGS.sentUnsentOf(waiting.sheet.kind, waiting.sheet.label) }
    }

    const current = pending
    if (!current) {
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

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, ($, e, next) => {
    const { origin } = e.props
    if (e.props.isExpanded || origin.kind !== 'plugin' || origin.name !== PLUGIN_NAME) {
      return next(e)
    }
    const summary = summaryOfReply.get(e.props.text) ?? summarizeReply(e.props.text)
    if (!summary) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    return replyRow({ Box, Text }, summary, mdPathOfReply.get(e.props.text))
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const current = pending
    if (e.agentId !== undefined || e.reason !== 'answer' || !current || current.isUrlShown) {
      return result
    }
    current.isUrlShown = true
    return { ...result, text: STRINGS.answerUrlOf(current.url) }
  })

  /**
   * パスの綴りの集まり: 正規化した綴りと、ファイルがあれば realPath (シンボリックリンク越しの書き込みを拾う)。
   */
  async function spellingsOf(engine: Host, path: string): Promise<string[]> {
    const normalized = normalizePath(path, cwd)
    const realOf = (target: string) =>
      engine.stat(target, { resolve: true }).then(
        stat => stat.realPath,
        () => undefined,
      )
    let real = await realOf(normalized)
    if (real === undefined) {
      // まだ無いファイル: 親のフォルダの realPath に名前を足す (シンボリックリンクのフォルダ越しの新規作成を拾う)
      const slash = normalized.lastIndexOf('/')
      const parent = slash > 0 ? await realOf(normalized.slice(0, slash)) : undefined
      if (parent !== undefined) {
        real = `${parent.replace(/[\\/]+$/, '')}/${normalized.slice(slash + 1)}`
      }
    }
    return real === undefined ? [normalized] : [normalized, normalizePath(real, cwd)]
  }

  /**
   * 回答待ちの画面が守るパスへの書き込みなら `deny` を返します。そうでなければ null (`next` に任せる)。
   * 実際の呼び出し (`tool_use_id` あり) だけを止め、`$.tool.check` の問い合わせには答えません。
   */
  async function guardWrite(e: { input: unknown; tool_use_id?: string }) {
    const engine = host
    // 回答を待っている間と、届いた回答をまだ Claude に送っていない間 (起動時に見つけた未送の回答) の両方で止める
    const current = pending ?? unsent
    if (!engine || !current || e.tool_use_id === undefined || current.sheet.guardedPaths.length === 0) {
      return null
    }
    const target = writeTargetOf(e.input)
    if (target === null) {
      return null
    }
    const targetSpellings = await spellingsOf(engine, target)
    for (const guarded of current.sheet.guardedPaths) {
      if (isSamePath(targetSpellings, await spellingsOf(engine, guarded))) {
        // 照合の間に回答が届いていれば (送っていれば) 止めない
        if ((pending ?? unsent) !== current) {
          return null
        }
        const reason =
          current === pending
            ? STRINGS.guardReasonOf(current.sheet.label, target)
            : STRINGS.guardUnsentReasonOf(current.sheet.label, target)
        return { decision: 'deny' as const, reason }
      }
    }
    return null
  }

  on('tool.check', { tool: 'Write' }, async ($, e, next) => (await guardWrite(e)) ?? next(e))
  on('tool.check', { tool: 'Edit' }, async ($, e, next) => (await guardWrite(e)) ?? next(e))
  on('tool.check', { tool: 'NotebookEdit' }, async ($, e, next) => (await guardWrite(e)) ?? next(e))

  on('session.compact', async ($, e, next) => {
    const engine = host
    if (e.agentId !== undefined || !engine || settled.length === 0) {
      return next(e)
    }

    const replies: SettledReply[] = []
    for (const entry of settled) {
      const text = await engine.readFile(entry.mdPath).catch(() => null)
      if (text !== null) {
        replies.push({ ...entry, text })
      }
    }
    const waiting = pending
    const record = buildDecisionRecord(
      replies,
      waiting ? { kind: waiting.sheet.kind, label: waiting.sheet.label, url: waiting.url } : null,
    )
    if (record === null) {
      return next(e)
    }

    const instructions = [e.instructions, STRINGS.compactInstructions].filter(Boolean).join('\n\n')
    const result = await next({ ...e, instructions })
    if (result.skip !== undefined) {
      return result
    }
    // 前の圧縮 (precompute を含む) で足した記録が残っていれば除いてから、新しい記録を 1 つだけ足す。
    // handle の無い message は「組み立てた文」として読まれる
    const kept = result.messages.filter(message => !isDecisionRecord(message.text))
    return { ...result, messages: [...kept, { role: 'user' as const, text: record, toolUses: [] }] }
  })

  on('session.end', async ($, e, next) => {
    // 正常に終わるときは lease を手放す (heartbeat を 0 に戻す)。次のセッションは 90 秒待たずに引き継げる。
    // /clear と resume ではプロセスが続き、監視も続くので手放さない (手放すと、次の heartbeat までの間に
    // 同じフォルダの別のセッションが引き継ぎ、両方で回答を届けてしまう)
    if (e.reason === 'clear' || e.reason === 'resume') {
      return next(e)
    }
    const owned = ownedRecord
    if (owned && host) {
      await host.storeSet(recordKeyOf(cwd, sessionId), { ...owned, heartbeatAtMs: 0 }).catch(() => undefined)
    }
    return next(e)
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
