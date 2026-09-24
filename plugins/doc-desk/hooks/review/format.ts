import { EVIDENCE_DIR, REPLY_HEADING } from '../names'
import { EDIT_MODE_LABELS, type ReviewAnswerV1, type ReviewEdit, type ReviewV1 } from './review-v1'

/**
 * 指摘の回答の末尾の締めの 1 文。不変です。
 */
export const REVIEW_CLOSING =
  '上の指摘と書き換えを反映して文書を直してください。書き換えと追加は、(そのまま) の文は一字一句そのまま使い、' +
  '(参考にして直す) の文は意図に沿って前後の文に合わせて直してください。' +
  '「ここは良い」の指摘がある箇所は直さないでください。指摘も書き換えも無ければ、そのまま完了報告に進んでください。'

/**
 * Claude の候補を人が採用した指摘の行末に付ける印。
 */
export const CANDIDATE_MARK = '(Claude の候補)'

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
 * `前:` と `後:` の行。全文をそのまま載せ、2 行目以降は行頭に空白 2 つを付けます (コードの段落の改行を保つため)。
 */
const fullOf = (label: string, text: string): string =>
  `${label}: ${text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n').join('\n  ')}`

/**
 * 同じ段落の中の並び: 書き換えか削除、移動、追加 (付けた順)。
 */
const EDIT_ORDER: Record<ReviewEdit['kind'], number> = { rewrite: 0, delete: 0, move: 1, add: 2 }

function editLines(edit: ReviewEdit, before: string | undefined): string[] {
  const original = before ?? '(段落の文字列は届いていません)'
  switch (edit.kind) {
    case 'rewrite':
      return [`#${edit.block} 書き換え (${EDIT_MODE_LABELS[edit.mode]})`, fullOf('前', original), fullOf('後', edit.text)]
    case 'delete':
      return [`#${edit.block} 削除`, fullOf('前', original)]
    case 'move':
      return [`#${edit.block} 移動 (#${edit.to} の後へ)`, fullOf('前', original)]
    case 'add':
      return [`#${edit.block} の後に追加 (${EDIT_MODE_LABELS[edit.mode]})`, fullOf('後', edit.text)]
  }
}

/**
 * 指摘の回答 JSON から、回答固定形 (references/review-mode.md の「指摘の回答」) を作ります。
 *
 * ```
 * 【doc-desk 回答】<documentId>
 * 対象: doc-desk/<label>.doc.html (<index>/<total>)
 * ## 指摘
 * #3 [短くする]
 * #7 [根拠が要る] 「応答が速くなる」 何秒から何秒になるかを足してほしい
 * #9 [短くする] 前置きを削る (Claude の候補)
 * ## 指摘した段落
 * #3 <段落の文字列>
 * #7 <段落の文字列>
 * ## 書き換え
 * #2 書き換え (そのまま)
 * 前: <書き換える前の全文>
 * 後: <書き換えた後の全文>
 * #4 削除
 * 前: <消す段落の全文>
 * #5 移動 (#1 の後へ)
 * 前: <動かす段落の全文>
 * #6 の後に追加 (参考にして直す)
 * 後: <足す段落の全文>
 * 全体へのコメント: <人の記述 (複数行あり得る)>
 * ---
 * <締めの 1 文>
 * ```
 *
 * - 指摘は段落番号の順、同じ段落の中は付けた順に並べます。
 * - 指摘が無ければ `## 指摘` の下は `(指摘なし)` で、`## 指摘した段落` は出しません。
 * - `## 書き換え` は添削があるときだけ出します。段落番号の順、同じ段落の中は書き換えか削除、移動、追加の順です。
 *   書き換えと追加には、文の使い方 (`(そのまま)` か `(参考にして直す)`) を添えます。
 * - 選んだ文字列とコメントの改行は空白 1 つに畳みます。`前:` と `後:` は全文で、2 行目以降は行頭に空白 2 つです。
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
    `対象: ${EVIDENCE_DIR}/${review.label}.doc.html${part}`,
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
      if (comment.source === 'claude') parts.push(CANDIDATE_MARK)
      lines.push(parts.join(' '))
    }

    lines.push('## 指摘した段落')
    const numbers = [...new Set(comments.map(comment => comment.block))]
    for (const number of numbers) {
      const text = answer.blocks[String(number)]
      lines.push(`#${number} ${typeof text === 'string' ? excerptOf(text) : '(段落の文字列は届いていません)'}`)
    }
  }

  const edits = (answer.edits ?? [])
    .map((edit, index) => ({ edit, index }))
    .sort(
      (a, b) =>
        a.edit.block - b.edit.block || EDIT_ORDER[a.edit.kind] - EDIT_ORDER[b.edit.kind] || a.index - b.index,
    )
    .map(entry => entry.edit)
  if (edits.length > 0) {
    lines.push('## 書き換え')
    for (const edit of edits) {
      lines.push(...editLines(edit, answer.blocks[String(edit.block)]))
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
