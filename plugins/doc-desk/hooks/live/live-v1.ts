/**
 * ライブ表示 (docs/doc-desk/live-view-design.md) のデータの形と検証。
 *
 * Claude は文書を書き始める前に `open_live` にこの形の `live` を渡します。Mod は `source` への Write と Edit を
 * 拾い、書いている文をブラウザへ流します。人が読みながら付けた指摘 (ライブ指摘) は受信サーバから Mod に届きます。
 */
export type LiveV1 = {
  /** 文書の識別子。`^[A-Za-z0-9_-]{1,64}$`。同じ文書の `open_review` と揃えると、完成時にタブが指摘の画面へ移る */
  documentId: string
  /** 証跡の名前 (`doc-desk/<label>.json` と `.html`)。質問票や指摘の画面と別にする */
  label: string
  /** これから書く文書のパス (質問票の `source` と同じ値)。このパスへの Write と Edit だけを流す */
  source: string
  /** 画面の上に出す文書の題名 */
  title: string
}

/**
 * 人が読みながら付けた指摘 1 件 (受信サーバの `POST /comments` で届き、`POST /document` の応答で Mod に渡る)。
 */
export type LiveComment = {
  /** ブラウザが振った id */
  id: string
  /** 人が選んだ文字列 (選ばなければ空) */
  quote: string
  /** コメント */
  text: string
  /** `after` = 今の Write が終わったら届ける。`now` = turn を止めて届ける */
  mode: 'after' | 'now'
  /** 付けた時点の文書の文字数 */
  at: number
}

/**
 * ライブ表示の状態の種類。画面は文言ではなくこれで振る舞いを決めます (文言は `views/strings.ts`)。
 *
 * Mod が送るもの: `waiting` (書き始めるのを待っている)、`writing`、`fixing` (Edit で直している)、`done` (書き終わった)、
 * `stopped` ([今すぐ止めて直す] で止めた)、`aborted` (人が中断した)、`ended` (セッションが終わった)。
 * 受信サーバが自分で送るもの (receiver.py): `moving` (指摘の画面へ移る)、`closed` (受信サーバが終わる)。
 */
export type LivePhase = 'waiting' | 'writing' | 'fixing' | 'done' | 'stopped' | 'aborted' | 'ended' | 'moving' | 'closed'

/**
 * 検証の結果。通れば `live`、落ちれば `errors` (全部) を返します。
 */
export type LiveValidation = { ok: true; live: LiveV1 } | { ok: false; errors: string[] }

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** `source` の上限 (質問票の `source` と同じ) */
const MAX_SOURCE = 1024
/** 受信サーバの上限と揃える (receiver.py の LIVE_MAX_QUOTE と LIVE_MAX_COMMENT_TEXT) */
const MAX_QUOTE = 200
const MAX_TEXT = 2000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * `open_live` の `live` を検証します。
 *
 * @param input ツールに渡された `live`
 */
export function validateLive(input: unknown): LiveValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: ['live: オブジェクトにしてください'] }
  }
  const errors: string[] = []
  for (const key of ['documentId', 'label'] as const) {
    const value = input[key]
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      errors.push(`${key}: 1〜64 文字の英数字と - と _ にしてください`)
    }
  }
  if (!isFilled(input.source) || input.source.length > MAX_SOURCE) {
    errors.push(`source: 空でない ${MAX_SOURCE} 文字以内の文字列 (これから書く文書のパス) にしてください`)
  }
  if (!isFilled(input.title)) {
    errors.push('title: 空でない文字列にしてください')
  }
  if (errors.length > 0) {
    return { ok: false, errors }
  }
  const { documentId, label, source, title } = input as LiveV1
  return { ok: true, live: { documentId, label, source, title } }
}

/**
 * 受信サーバから来た指摘 1 件を読みます。形が違えば null (その 1 件だけ捨てます)。
 */
export function liveCommentOf(value: unknown): LiveComment | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, quote, text, mode, at } = value
  if (typeof id !== 'string' || id === '' || id.length > 64) {
    return null
  }
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) {
    return null
  }
  if (quote !== undefined && (typeof quote !== 'string' || quote.length > MAX_QUOTE)) {
    return null
  }
  if (mode !== 'after' && mode !== 'now') {
    return null
  }
  return { id, quote: typeof quote === 'string' ? quote : '', text, mode, at: Number.isInteger(at) ? (at as number) : 0 }
}

/**
 * 受信サーバの `POST /document` と `POST /finish` の応答。
 */
export type LiveServerReply = {
  comments: LiveComment[]
  stop: boolean
}

/**
 * `POST /document` と `POST /finish` の応答の本文を読みます。読めなければ指摘なし、止めない。
 */
export function parseLiveReply(text: string): LiveServerReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { comments: [], stop: false }
  }
  if (!isRecord(parsed)) {
    return { comments: [], stop: false }
  }
  const comments = Array.isArray(parsed.comments)
    ? parsed.comments.map(liveCommentOf).filter((comment): comment is LiveComment => comment !== null)
    : []
  return { comments, stop: parsed.stop === true }
}
