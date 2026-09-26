import type { LiveComment } from './live-v1'

/**
 * ライブ指摘を Claude に届ける文の見出し語。
 */
export const LIVE_HEADING = '【doc-desk ライブ指摘】'

/**
 * 1 行に収めるため、改行と続く空白を 1 つの空白にします。
 */
const flattened = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim()

/**
 * 指摘の番号付きの行: `1. 引用: 「…」 / 指摘: …`。
 */
export const commentLinesOf = (comments: readonly LiveComment[]): string[] =>
  comments.map((comment, index) => {
    const quote = flattened(comment.quote)
    return `${index + 1}. 引用: ${quote === '' ? '(無し)' : `「${quote}」`} / 指摘: ${flattened(comment.text)}`
  })

/**
 * [書き終わったら直す] の指摘を、Write か Edit の Tool result の `context` として届ける文。
 */
export const afterContextOf = (comments: readonly LiveComment[]): string =>
  [
    `${LIVE_HEADING}人がライブ表示で、書いている途中の文書に次の指摘を付けました。`,
    '先へ進む前に反映してください (該当箇所は「引用」で探し、Edit で直します)。',
    ...commentLinesOf(comments),
  ].join('\n')

/**
 * [今すぐ止めて直す] で turn を止めた後、新しい user turn として投入する文。
 *
 * @param source 書いていた文書のパス
 */
export const stopPromptOf = (source: string, comments: readonly LiveComment[]): string =>
  [
    `${LIVE_HEADING}文書 ${source} を書いている途中で、人がライブ表示で次の指摘を付けたので中断しました。`,
    '指摘を反映して書き直してください。書き終わったら今までどおり指摘の画面 (open_review) に進みます。',
    ...commentLinesOf(comments),
  ].join('\n')

/**
 * 指摘をどう扱ったか。`context` = Tool result で届けた、`prompt` = turn を止めて user turn で届けた、
 * `review` = 指摘の画面に候補として持ち越した、`dropped` = 届けずに片付けた (別の文書の画面に移った、取り消した)。
 */
export type LiveDelivery = 'context' | 'prompt' | 'review' | 'dropped'

/**
 * 証跡 `doc-desk/<label>.comments.json` の 1 件。
 */
export type LiveCommentRecord = LiveComment & {
  how: LiveDelivery
  /** 扱った時刻 (ISO 8601) */
  handledAt: string
}

/**
 * 証跡に今回の分を足した一覧を返します (同じ id は新しい方で置き換える)。
 */
export function withRecords(
  records: readonly LiveCommentRecord[],
  comments: readonly LiveComment[],
  how: LiveDelivery,
  nowMs: number,
): LiveCommentRecord[] {
  const iso = new Date(nowMs).toISOString()
  const ids = new Set(comments.map(comment => comment.id))
  return [...records.filter(record => !ids.has(record.id)), ...comments.map(comment => ({ ...comment, how, handledAt: iso }))]
}
