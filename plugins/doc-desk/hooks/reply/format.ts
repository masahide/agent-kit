import { REPLY_HEADING } from '../names'
import type { AnswerV1, FormV1 } from '../form/form-v1'
import { questionsOf } from '../form/form-v1'

/**
 * 末尾の締めの 1 文。不変です。
 */
export const REPLY_CLOSING =
  '上の回答を反映して文書を作成してください。お任せの項目は推奨案で確定してください。'

/**
 * 改行を空白 1 つに畳みます (補足と表のセル用)。
 * 人の記述の文字は改変せず、改行だけを畳みます。
 */
const flattened = (text: string): string => text.replace(/\r?\n/g, ' ')

/**
 * 表のセルの `|` を `\|` に逃がします。
 */
const cellOf = (text: string): string => flattened(text).replace(/\|/g, '\\|')

/**
 * Markdown の表の 1 行。空のセルは `| |` (空白 1 つ) のまま載せます。
 */
const rowOf = (cells: string[]): string =>
  `|${cells.map(cell => (cell === '' ? ' ' : ` ${cell} `)).join('|')}|`

/**
 * 回答 JSON と質問票から回答固定形 v1 (references/reply-format-v1.md) を作ります。
 *
 * - `Qn.` は質問票の並び順 (テーマ順 → 問い順) で 1 から振ります。
 * - 選択肢は `<id> — <label>`。補足が空なら ` / 補足:` を省きます。
 * - `## 表` は表が 1 つ以上あるときだけ出します。
 * - `全体へのコメント:` は空なら行ごと省きます。複数行はそのまま載せます。
 * - 回答に質問票に無い ID があれば無視し、回答に無い問いは未選択として扱います。
 *
 * @param form 検証済みの質問票
 * @param answer ブラウザが POST した回答
 * @returns 固定形の全文 (末尾に改行なし)
 */
export function formatReply(form: FormV1, answer: AnswerV1): string {
  const lines: string[] = [`${REPLY_HEADING}${form.documentId}`]

  questionsOf(form).forEach((question, index) => {
    const given = answer.answers?.[question.id]
    const choice = given?.choice ?? null
    const note = typeof given?.note === 'string' ? flattened(given.note) : ''
    const option = choice === null ? undefined : question.options.find(o => o.id === choice)

    const picked = option ? `${option.id} — ${option.label}` : '(未選択 = お任せ)'
    const suffix = note.trim() === '' ? '' : ` / 補足: ${note}`

    lines.push(`Q${index + 1}. ${question.title}: ${picked}${suffix}`)
  })

  const tables = form.tables ?? []
  if (tables.length > 0) {
    lines.push('## 表')
    for (const table of tables) {
      const filled = answer.tables?.[table.id]
      lines.push(`### ${table.title}`)
      lines.push(rowOf(table.columns.map(cellOf)))
      lines.push(`|${table.columns.map(() => '---').join('|')}|`)
      table.rows.forEach((row, rowIndex) => {
        const cells = row.map((original, cellIndex) => {
          const value = filled?.[rowIndex]?.[cellIndex]
          return cellOf(typeof value === 'string' ? value : original)
        })
        lines.push(rowOf(cells))
      })
    }
  }

  const globalNote = typeof answer.globalNote === 'string' ? answer.globalNote : ''
  if (globalNote.trim() !== '') {
    lines.push(`全体へのコメント: ${globalNote}`)
  }

  lines.push('---')
  lines.push(REPLY_CLOSING)

  return lines.join('\n')
}
