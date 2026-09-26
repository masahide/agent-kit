import type { Timer, ToolCallResult, TurnStepChunk } from 'claude-code'

import { normalizePath, isSamePath, writeTargetOf } from '../guard/paths'
import type { Host } from '../host'
import { EVIDENCE_DIR } from '../names'
import {
  documentUrlOf,
  finishUrlOf,
  linkUrlOf,
  liveReceiverArgv,
  parseStartOutput,
  stopArgv,
  urlOf,
  waitUrlOf,
  type ReceiverInfo,
} from '../receiver'
import { liveCandidatesOf, type ReviewCandidate } from '../review/candidates'
import { renderLiveHtml } from '../sheet/render-live'
import { STRINGS } from '../views/strings'
import { afterContextOf, stopPromptOf, withRecords, type LiveCommentRecord, type LiveDelivery } from './comments'
import { feedJson, initialJsonStream, type JsonStreamState } from './json-stream'
import { parseLiveReply, validateLive, type LiveComment, type LivePhase, type LiveServerReply, type LiveV1 } from './live-v1'

/**
 * 貯めた文をまとめて送る文字数 (改行が来たら、最後の改行までを送る)。
 */
const LIVE_FLUSH_CHARS = 200

/**
 * ペインの経過秒数を進める間隔 (ms)。
 */
const LIVE_TICK_MS = 5000

/**
 * 受信サーバに生きていることを知らせる間隔 (タイマーの回数)。5 秒 × 12 = 60 秒。
 * 受信サーバは Mod からの接触が 10 分途絶えると自分で終わるので、それより十分短くします。
 */
const KEEPALIVE_EVERY_TICKS = 12

/**
 * keepalive がこの回数続けて失敗したら、受信サーバは死んだとみなしてライブ表示を閉じます (設計書 5.5)。
 */
const KEEPALIVE_MAX_FAILURES = 3

/**
 * Mod が受信サーバへ送る文書の上限 (文字)。受信サーバと画面の上限 (receiver.py の LIVE_MAX_TEXT) と同じで、
 * 超えた分は先頭から落とします (受信サーバの本文の上限 4 MiB を超えて接続ごと断られないように)。
 */
const LIVE_MAX_TEXT = 100000

/**
 * 開いているライブ表示 1 つ分の状態 (docs/doc-desk/live-view-design.md の 5.1)。`pending` とは別に持ちます。
 */
export type Live = {
  input: LiveV1
  paths: { input: string; html: string; comments: string }
  /** `source` の綴り (正規化したものと、開いた時点でファイルがあれば realPath) */
  spellings: string[]
  receiver: ReceiverInfo
  url: string
  linkUrl: string
  documentUrl: string
  finishUrl: string
  keepaliveUrl: string
  startedAtMs: number
  /** replace と append の通し番号 (status は番号を進めない) */
  seq: number
  /** 画面とペインの状態の文 */
  state: string
  /** 受信サーバから受け取り、まだ Claude に届けていない指摘 */
  comments: LiveComment[]
  /** 証跡 `doc-desk/<label>.comments.json` の中身 */
  records: LiveCommentRecord[]
  /** [今すぐ止めて直す] で turn を止めている間 true */
  isStopping: boolean
  /** [今すぐ止めて直す] で止めた turn の id (その turn の `turn.complete` で状態を上書きしない) */
  stoppedTurnId: string | null
  /** ペインの経過秒数と keepalive のタイマー */
  timer: Timer
  ticks: number
  /** keepalive が続けて失敗した回数 */
  keepaliveFailures: number
}

/**
 * `turn.step` の中で読んでいる、Write か Edit の呼び出し 1 つ分。
 */
type LiveWriting = {
  tool: 'Write' | 'Edit'
  decoder: JsonStreamState
  /** `file_path` が `source` か。まだ分からなければ null */
  isTarget: boolean | null
  /** まだ送っていない文 */
  buffer: string
}

/**
 * `turn.step` 1 回分の観察者。チャンクを見て文を流し、stream が終わったら残りを送ります。
 */
export type StepObserver = {
  chunk: (chunk: TurnStepChunk) => void
  end: () => void
}

/**
 * 同じ文書の `open_review` へ引き渡すもの。
 */
export type LiveHandoff = {
  /** 指摘の画面に埋める候補 (まだ届けていないライブ指摘) */
  candidates: ReviewCandidate[]
  /** 指摘の画面の受信サーバが立った後に呼ぶ (タブを移す) */
  serve: (url: string) => Promise<void>
  /** 指摘の画面を出せなかったときに呼ぶ (ライブ表示の受信サーバを閉じる) */
  abandon: () => Promise<void>
}

/**
 * ライブ表示が `register.ts` から借りるもの。`$` は渡さず、`session.start` で束ねた Host を通して呼びます。
 */
export type LiveDeps = {
  host: () => Host | null
  cwd: () => string
  /** 回答待ちの画面があるか */
  isPending: () => boolean
  isPaneOpen: () => boolean
  pythonOf: (engine: Host) => Promise<readonly string[] | null>
  spellingsOf: (engine: Host, path: string) => Promise<string[]>
  openBrowser: (engine: Host, url: string) => void
  openPane: (engine: Host) => Promise<void>
  closePane: (engine: Host) => Promise<void>
  tokenOf: (nowMs: number) => string
  dateOf: (ms: number) => string
}

/**
 * ライブ表示を開くか。plugin の設定 (`userConfig.liveView`) が false なら開きません。
 *
 * @param options `register(on, options)` の options
 */
export const isLiveViewEnabled = (options: { liveView?: unknown }): boolean => options.liveView !== false

const failedLive = (reason: string) => ({
  result: JSON.stringify({ status: 'failed', reason: `${reason}。${STRINGS.liveFallback}` }),
})

const invalid = (errors: string[]) => ({ result: JSON.stringify({ status: 'invalid', errors }) })

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * ライブ表示 (docs/doc-desk/live-view-design.md) の状態と振る舞いをまとめた閉包を作ります。
 * `register.ts` はフックからこの関数群を呼ぶだけにします。
 */
export function createLiveController(deps: LiveDeps) {
  let live: Live | null = null
  let elapsedSeconds = 0
  /** 動いている main の turn の id (`turn.start` で覚え、`turn.complete` で消す)。[今すぐ止めて直す] が止める */
  let mainTurnId: string | null = null

  /**
   * 受信サーバへ `POST /document` を送り、応答の指摘と「止めて」の印を受けます。
   * replace と append は通し番号を進め (受信サーバが順に並べ直す)、status は今の番号のまま送ります。
   * 失敗は無視します (次の replace で追いつき、指摘は次の POST で届きます)。
   *
   * @param canStop 応答の「止めて」で turn を止めてよいか。`tool.call` の中からは false
   *   (その中では `$.prompt.submit` が拒まれ、turn だけ止まって指摘が届かないため)
   */
  async function post(
    engine: Host,
    current: Live,
    body: { kind: 'replace' | 'append' | 'status'; text?: string; phase?: LivePhase; delivered?: string[]; stopped?: string[] },
    canStop = true,
  ): Promise<void> {
    if (body.kind !== 'status') {
      current.seq += 1
    } else if (body.text !== undefined && body.text !== current.state) {
      current.state = body.text
      if (deps.isPaneOpen() && !deps.isPending()) {
        engine.invalidate()
      }
    }
    let reply: LiveServerReply
    try {
      const response = await engine.fetch(current.documentUrl, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, seq: current.seq }),
      })
      if (!response.ok) {
        return
      }
      reply = parseLiveReply(response.text)
    } catch {
      return
    }
    receive(engine, current, reply, canStop)
  }

  /**
   * 受信サーバから来た指摘を貯め、「止めて」の印があれば (止めてよい所からなら) turn を止めます。
   * 止める処理は `$.clock.after(0)` で今のディスパッチの外へ出します。
   */
  function receive(engine: Host, current: Live, reply: LiveServerReply, canStop: boolean) {
    if (live !== current) {
      return
    }
    const known = new Set([...current.comments, ...current.records].map(comment => comment.id))
    current.comments = [...current.comments, ...reply.comments.filter(comment => !known.has(comment.id))]
    if (reply.stop && canStop) {
      engine.after(0, () => {
        void stopForComments(engine, current)
      })
    }
  }

  /**
   * 指摘の扱いを証跡 `doc-desk/<label>.comments.json` に書きます。
   */
  async function record(engine: Host, current: Live, comments: readonly LiveComment[], how: LiveDelivery) {
    if (comments.length === 0) {
      return
    }
    current.records = withRecords(current.records, comments, how, await engine.now())
    await engine.writeFile(current.paths.comments, `${JSON.stringify(current.records, null, 2)}\n`).catch(() => undefined)
  }

  const asAfter = (comments: readonly LiveComment[]): LiveComment[] =>
    comments.map(comment => ({ ...comment, mode: 'after' as const }))

  /**
   * [今すぐ止めて直す]: `turn.start` で覚えた turn を `$.turn.abort` で止め、まだ届けていない指摘を
   * 新しい user turn として投入します。
   *
   * 止める指摘 (`now`) がもう無い (Write の後の `context` で届いた) なら止めません。止めている最中に来た指摘は、
   * 次の Write か Edit の後に届けます。止める turn が分からなければ [書き終わったら直す] と同じ扱いにします。
   */
  async function stopForComments(engine: Host, current: Live) {
    if (live !== current || current.isStopping || !current.comments.some(comment => comment.mode === 'now')) {
      return
    }
    const turnId = mainTurnId
    if (turnId === null) {
      current.comments = asAfter(current.comments)
      engine.uiLog(STRINGS.liveNoTurnToStop)
      return
    }
    current.isStopping = true
    current.stoppedTurnId = turnId
    // 途中で何が失敗しても isStopping を戻す (戻らないと以後の [今すぐ止めて直す] が効かなくなる)
    try {
      try {
        await engine.abortTurn({ turnId })
      } catch {
        current.stoppedTurnId = null
        current.comments = asAfter(current.comments)
        engine.uiLog(STRINGS.liveNoTurnToStop)
        return
      }
      const comments = current.comments
      current.comments = []
      let isSubmitted = false
      try {
        await record(engine, current, comments, 'prompt')
        void post(engine, current, {
          kind: 'status',
          text: STRINGS.liveStopped,
          phase: 'stopped',
          stopped: comments.map(comment => comment.id),
        })
        // $.prompt.submit は session が idle になってから turn を始める (止めた turn の後片付けを待つ)
        const submitted = await engine.submitPrompt({ text: stopPromptOf(current.input.source, comments) })
        isSubmitted = submitted.drop === undefined
      } catch {
        isSubmitted = false
      }
      if (!isSubmitted) {
        // 届かなかった指摘は、次の Write の後か指摘の画面で届ける
        if (live === current) {
          current.comments = [...asAfter(comments), ...current.comments]
        }
        engine.uiLog(STRINGS.liveStopSubmitFailed)
      }
    } finally {
      current.isStopping = false
    }
  }

  async function stopReceiver(engine: Host, current: Live) {
    const python = await deps.pythonOf(engine)
    if (python) {
      await engine.run(stopArgv(python, engine.pluginRoot, current.receiver.pid), { timeoutMs: 5000 }).catch(() => undefined)
    }
  }

  /**
   * 受信サーバを閉じます。まず `POST /finish { close: true }` で画面に `closed` を流させて自分で終わらせ
   * (画面が再接続を試み続けないように)、届かなければ pid で止めます。
   */
  async function closeReceiver(engine: Host, current: Live) {
    try {
      const response = await engine.fetch(current.finishUrl, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ close: true }),
      })
      if (response.ok) {
        return
      }
    } catch {
      // 下で pid で止める
    }
    await stopReceiver(engine, current)
  }

  /**
   * 受信サーバには触らずにライブ表示を手放します (受信サーバが死んでいるとき。pid は使い回されているかもしれない)。
   */
  async function forget(engine: Host, current: Live) {
    if (live !== current) {
      return
    }
    live = null
    current.timer.cancel()
    await record(engine, current, current.comments, 'dropped')
    if (!deps.isPending()) {
      await deps.closePane(engine)
    }
    engine.uiLog(STRINGS.liveReceiverGone)
  }

  /**
   * ライブ表示を片付けます: 受信サーバを止め、まだ届けていない指摘を証跡に「届けずに片付けた」と書きます。
   * ペインは、回答待ちの画面が無ければ閉じます。
   */
  async function close(engine: Host) {
    const current = live
    if (!current) {
      return
    }
    live = null
    current.timer.cancel()
    await record(engine, current, current.comments, 'dropped')
    await closeReceiver(engine, current)
    if (!deps.isPending()) {
      await deps.closePane(engine)
    }
  }

  /**
   * `open_live` の本体。検証し、HTML を書き、`--live` の受信サーバを起動します。
   */
  async function open(engine: Host, input: { live: unknown; openBrowser?: boolean }) {
    const validation = validateLive(input.live)
    if (!validation.ok) {
      return invalid(validation.errors)
    }
    const value = validation.live
    // 回答が届く前に文書を書くことは止めているので、ライブ表示もその前には開かない
    if (deps.isPending()) {
      return invalid([STRINGS.livePendingExists])
    }

    await close(engine)

    const base = `${deps.cwd()}/${EVIDENCE_DIR}/${value.label}`
    const paths = { input: `${base}.json`, html: `${base}.html`, comments: `${base}.comments.json` }
    const nowMs = await engine.now()

    // HTML を書き直すと、同じ label の前回の受信サーバ (前のセッションの残り) は自分で終わる。
    // 証跡の指摘も空から始める (前回の同じ label の指摘と混ぜない)
    await engine.writeFile(paths.input, `${JSON.stringify(value, null, 2)}\n`)
    await engine.writeFile(paths.html, renderLiveHtml({ live: value, date: deps.dateOf(nowMs) }))
    await engine.writeFile(paths.comments, '[]\n')

    const python = await deps.pythonOf(engine)
    if (!python) {
      return failedLive(STRINGS.noPython)
    }
    const token = deps.tokenOf(nowMs)
    let receiver: ReceiverInfo | null
    try {
      const argv = liveReceiverArgv(python, { pluginRoot: engine.pluginRoot, html: paths.html }, token)
      receiver = parseStartOutput((await engine.run(argv, { timeoutMs: 10000 })).stdout)
    } catch (error) {
      return failedLive(`受信サーバを起動できませんでした (${String(error)})`)
    }
    if (!receiver) {
      return failedLive(STRINGS.noPort)
    }

    const current: Live = {
      input: value,
      paths,
      spellings: await deps.spellingsOf(engine, value.source),
      receiver,
      url: urlOf(receiver.port, token),
      linkUrl: linkUrlOf(receiver.port, token),
      documentUrl: documentUrlOf(receiver.port, token),
      finishUrl: finishUrlOf(receiver.port, token),
      keepaliveUrl: waitUrlOf(receiver.port, token, 0),
      startedAtMs: nowMs,
      seq: 0,
      state: '',
      comments: [],
      records: [],
      isStopping: false,
      stoppedTurnId: null,
      timer: { cancel: () => undefined },
      ticks: 0,
      keepaliveFailures: 0,
    }
    live = current
    elapsedSeconds = 0
    current.timer = engine.every(LIVE_TICK_MS, () => tick(engine, current))
    void post(engine, current, { kind: 'status', text: STRINGS.liveWaiting, phase: 'waiting' })

    if (input.openBrowser !== false) {
      deps.openBrowser(engine, current.url)
    }
    void deps.openPane(engine)

    return {
      result: JSON.stringify({
        status: 'opened',
        documentId: value.documentId,
        url: current.url,
        files: { live: paths.input, html: paths.html },
      }),
      context: [STRINGS.liveOpenedContext],
    }
  }

  /**
   * タイマーの 1 回分: ペインの経過秒数を進め、60 秒ごとに受信サーバへ `GET /wait` を投げて生きていることを知らせます
   * (人が書き終わった文書を 10 分以上読んでいても、セッションが生きている間は受信サーバが終わらないように)。
   * 3 回続けて届かなければ、受信サーバは死んだとみなしてライブ表示を手放します (`/doc-desk-resume` が死んだ URL を開かないように)。
   */
  function tick(engine: Host, current: Live) {
    if (live !== current) {
      return
    }
    current.ticks += 1
    if (current.ticks % KEEPALIVE_EVERY_TICKS === 0) {
      void engine
        .fetch(current.keepaliveUrl)
        .then(
          response => response.ok,
          () => false,
        )
        .then(isAlive => {
          current.keepaliveFailures = isAlive ? 0 : current.keepaliveFailures + 1
          if (current.keepaliveFailures >= KEEPALIVE_MAX_FAILURES) {
            return forget(engine, current)
          }
          return undefined
        })
    }
    void engine.now().then(now => {
      elapsedSeconds = Math.max(0, Math.floor((now - current.startedAtMs) / 1000))
      if (live === current && deps.isPaneOpen() && !deps.isPending()) {
        engine.invalidate()
      }
    })
  }

  /**
   * 同じ文書の `open_review` へ渡すため、ライブ表示を切り離します (1 段目の `POST /finish {}`)。
   * 受信サーバはこの後の指摘を受け付けないので、まだ届けていない指摘 (受信サーバがまだ Mod に渡していないものを含む) は
   * すべて指摘の画面の候補になります。別の文書のライブ表示なら片付けて null を返します。
   */
  async function takeForReview(engine: Host, documentId: string): Promise<LiveHandoff | null> {
    const current = live
    if (!current) {
      return null
    }
    if (current.input.documentId !== documentId) {
      await close(engine)
      return null
    }
    live = null
    current.timer.cancel()
    let untaken: LiveComment[] = []
    try {
      const response = await engine.fetch(current.finishUrl, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
      if (response.ok) {
        untaken = parseLiveReply(response.text).comments
      }
    } catch {
      // 受け取れなかった指摘は受信サーバの画面に残るだけ
    }
    const known = new Set(current.comments.map(comment => comment.id))
    const comments = [...current.comments, ...untaken.filter(comment => !known.has(comment.id))]
    current.comments = []
    await record(engine, current, comments, 'review')
    return {
      candidates: liveCandidatesOf(comments),
      serve: url => handOff(engine, current, url),
      abandon: () => closeReceiver(engine, current),
    }
  }

  /**
   * 指摘の画面の受信サーバが立った後、ライブ表示のタブをそちらへ移します (2 段目の `POST /finish { url }`)。
   * 送れなければライブ表示の受信サーバを止め、指摘の画面をブラウザで開きます。
   */
  async function handOff(engine: Host, current: Live, url: string) {
    try {
      const response = await engine.fetch(current.finishUrl, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ url }),
      })
      if (response.ok) {
        return
      }
    } catch {
      // 下で閉じて開き直す
    }
    await closeReceiver(engine, current)
    deps.openBrowser(engine, url)
  }

  /**
   * `turn.step` 1 回分の観察者を返します。ライブ表示が開いていない、または subagent の step なら null (素通し)。
   */
  function observeStep(agentId: string | undefined): StepObserver | null {
    const engine = deps.host()
    const current = live
    if (!engine || !current || agentId !== undefined) {
      return null
    }
    const writings = new Map<number, LiveWriting>()
    const flush = () => {
      for (const writing of writings.values()) {
        if (writing.buffer !== '') {
          const text = writing.buffer
          writing.buffer = ''
          void post(engine, current, { kind: 'append', text })
        }
      }
    }
    return {
      chunk: chunk => {
        if (live === current) {
          observeChunk(engine, current, writings, chunk, flush)
        }
      },
      end: () => {
        if (live === current) {
          flush()
        }
      },
    }
  }

  /**
   * `turn.step` のチャンク 1 つを見て、`source` への Write の文を流します。チャンクは変えません。
   */
  function observeChunk(
    engine: Host,
    current: Live,
    writings: Map<number, LiveWriting>,
    chunk: TurnStepChunk,
    flush: () => void,
  ) {
    switch (chunk.kind) {
      case 'tool':
        if (chunk.name === 'Write' || chunk.name === 'Edit') {
          writings.set(chunk.index, { tool: chunk.name, decoder: initialJsonStream(), isTarget: null, buffer: '' })
        }
        // 次のツール呼び出しが始まった: 文が流れていない間に付いた指摘を取りに行く
        void post(engine, current, { kind: 'status' })
        return
      case 'input': {
        const writing = writings.get(chunk.index)
        if (!writing || writing.isTarget === false) {
          return
        }
        const out = feedJson(writing.decoder, chunk.json)
        writing.decoder = out.state
        if (out.filePath !== null) {
          writing.isTarget = current.spellings.includes(normalizePath(out.filePath, deps.cwd()))
          if (!writing.isTarget) {
            return
          }
          if (writing.tool === 'Write') {
            void post(engine, current, { kind: 'status', text: STRINGS.liveWriting, phase: 'writing' })
            void post(engine, current, { kind: 'replace', text: '' })
          } else {
            void post(engine, current, { kind: 'status', text: STRINGS.liveFixing, phase: 'fixing' })
          }
        }
        if (writing.tool !== 'Write' || writing.isTarget !== true || out.content === '') {
          return
        }
        writing.buffer += out.content
        // 改行が来たら最後の改行までを送り (行の途中は次に回す)、改行が無いまま長くなったら全部送る
        const end = writing.buffer.lastIndexOf('\n') + 1
        const size = end > 0 ? end : writing.buffer.length >= LIVE_FLUSH_CHARS ? writing.buffer.length : 0
        if (size > 0) {
          const text = writing.buffer.slice(0, size)
          writing.buffer = writing.buffer.slice(size)
          void post(engine, current, { kind: 'append', text })
        }
        return
      }
      case 'stop':
        flush()
        void post(engine, current, { kind: 'status' })
        return
      default:
        return
    }
  }

  /**
   * `source` への Write か Edit が終わった後: 全文を読み直して replace で流し (途中で流した文がずれていても揃う)、
   * まだ届けていない指摘があれば、`mode` を問わず Tool result の `context` に 1 つ足して届けます。
   * Write はもう終わっているので、[今すぐ止めて直す] もここでは止めずに届けます。
   */
  async function afterWrite(
    e: { file_path?: unknown; agentId?: string },
    result: ToolCallResult,
  ): Promise<ToolCallResult> {
    const engine = deps.host()
    const current = live
    if (!engine || !current || e.agentId !== undefined || result.deny !== undefined || result.isError) {
      return result
    }
    const target = writeTargetOf(e)
    if (target === null) {
      return result
    }
    const sourceSpellings = [...current.spellings, ...(await deps.spellingsOf(engine, current.input.source))]
    if (!isSamePath(await deps.spellingsOf(engine, target), sourceSpellings)) {
      return result
    }
    const isAbsolute = target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(target)
    const text = await engine.readFile(isAbsolute ? target : `${deps.cwd()}/${target}`).catch(() => null)
    if (live !== current) {
      return result
    }
    if (text !== null) {
      const tail = text.length > LIVE_MAX_TEXT ? text.slice(text.length - LIVE_MAX_TEXT) : text
      await post(engine, current, { kind: 'replace', text: tail }, false)
    }
    await post(engine, current, { kind: 'status', text: STRINGS.liveWriting, phase: 'writing' }, false)
    if (live !== current || current.isStopping || current.comments.length === 0) {
      return result
    }
    const due = current.comments
    current.comments = []
    await record(engine, current, due, 'context')
    void post(engine, current, { kind: 'status', delivered: due.map(comment => comment.id) }, false)
    return { ...result, context: [...(result.context ?? []), afterContextOf(due)] }
  }

  return {
    /** 開いているライブ表示 (無ければ null) */
    current: (): Live | null => live,
    elapsedSeconds: (): number => elapsedSeconds,
    open,
    close,
    takeForReview,
    observeStep,
    afterWrite,
    onTurnStart: (turnId: string) => {
      mainTurnId = turnId
    },
    /**
     * main の turn の終わり: 「書き終わりました」か「中断しました」を流します。
     * [今すぐ止めて直す] で止めた turn は、止めた側が状態を流すので触りません。
     */
    onTurnComplete: (e: { agentId?: string; turnId: string; reason: string }) => {
      if (e.agentId !== undefined) {
        return
      }
      if (mainTurnId === e.turnId) {
        mainTurnId = null
      }
      const engine = deps.host()
      const current = live
      if (!engine || !current || current.isStopping || current.stoppedTurnId === e.turnId) {
        return
      }
      if (e.reason === 'answer') {
        void post(engine, current, { kind: 'status', text: STRINGS.liveDone, phase: 'done' })
        if (current.comments.length > 0) {
          engine.uiLog(STRINGS.liveUndeliveredOf(current.comments.length))
        }
      } else if (e.reason === 'aborted') {
        void post(engine, current, { kind: 'status', text: STRINGS.liveAborted, phase: 'aborted' })
      }
    },
    /**
     * セッションの終わり: 受信サーバは止めず (人がまだ読んでいるかもしれない)、状態だけ待たずに投げます。
     * 受信サーバは Mod からの接触が 10 分途絶えると自分で終わります。
     */
    onSessionEnd: () => {
      const engine = deps.host()
      const current = live
      if (engine && current) {
        void post(engine, current, { kind: 'status', text: STRINGS.liveSessionEnded, phase: 'ended' })
      }
    },
  }
}

export type LiveController = ReturnType<typeof createLiveController>
