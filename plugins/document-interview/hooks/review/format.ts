import { INTERVIEW_DIR, REPLY_HEADING } from '../names'
import type { ReviewAnswerV1, ReviewV1 } from './review-v1'

/**
 * 指摘の回答の末尾の締めの 1 文。不変です。
 */
export const REVIEW_CLOSING =
  '上の指摘を反映して文書を直してください。「ここは良い」の指摘がある箇所は直さないでください。指摘が無ければ、そのまま完了報告に進んでください。'

/**
 * 「指摘した段落」に載せる段落の文字数の上限。超えた分は「…」にします。
 */
export const MAX_BLOCK_EXCERPT = 400

const flattened = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim()

const excerptOf = (text: string): string => {
  const flat = flattened(text)
  return flat.length > MAX_BLOCK_EXCERPT ? `${flat.slice(0, MAX_BLOCK_EXCERPT)}…` : flat
}

/**
 * 指摘の回答 JSON から、回答固定形 (references/review-mode.md の「指摘の回答」) を作ります。
 *
 * ```
 * 【インタビュー回答】<documentId>
 * 対象: interview/<label>.doc.html (<index>/<total>)
 * ## 指摘
 * #3 [短くする]
 * #7 [根拠が要る] 「応答が速くなる」 何秒から何秒になるかを足してほしい
 * ## 指摘した段落
 * #3 <段落の文字列>
 * #7 <段落の文字列>
 * 全体へのコメント: <人の記述 (複数行あり得る)>
 * ---
 * <締めの 1 文>
 * ```
 *
 * - 指摘は段落番号の順、同じ段落の中は付けた順に並べます。
 * - 指摘が無ければ `## 指摘` の下は `(指摘なし)` で、`## 指摘した段落` は出しません。
 * - 選んだ文字列とコメントの改行は空白 1 つに畳みます。
 * - `全体へのコメント:` は空なら行ごと省きます。複数行はそのまま載せます。
 *
 * @param review 検証済みの指摘の画面
 * @param answer ブラウザが POST した回答
 * @returns 固定形の全文 (末尾に改行なし)
 */
export function formatReviewReply(review: ReviewV1, answer: ReviewAnswerV1): string {
  const part = review.part ? ` (${review.part.index}/${review.part.total})` : ''
  const lines: string[] = [
    `${REPLY_HEADING}${review.documentId}`,
    `対象: ${INTERVIEW_DIR}/${review.label}.doc.html${part}`,
    '## 指摘',
  ]

  const comments = answer.comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => a.comment.block - b.comment.block || a.index - b.index)
    .map(entry => entry.comment)

  if (comments.length === 0) {
    lines.push('(指摘なし)')
  } else {
    for (const comment of comments) {
      const parts = [`#${comment.block}`]
      if (comment.chip !== null) parts.push(`[${comment.chip}]`)
      const quote = flattened(comment.quote)
      if (quote !== '') parts.push(`「${quote}」`)
      const text = flattened(comment.text)
      if (text !== '') parts.push(text)
      lines.push(parts.join(' '))
    }

    lines.push('## 指摘した段落')
    const numbers = [...new Set(comments.map(comment => comment.block))]
    for (const number of numbers) {
      const text = answer.blocks[String(number)]
      lines.push(`#${number} ${typeof text === 'string' ? excerptOf(text) : '(段落の文字列は届いていません)'}`)
    }
  }

  const globalNote = typeof answer.globalNote === 'string' ? answer.globalNote : ''
  if (globalNote.trim() !== '') {
    lines.push(`全体へのコメント: ${globalNote}`)
  }

  lines.push('---')
  lines.push(REVIEW_CLOSING)

  return lines.join('\n')
}
