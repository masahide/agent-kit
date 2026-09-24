import { REPLY_HEADING } from '../names'

/**
 * 回答固定形を畳んだ 1 行の中身。
 */
export type ReplySummary = {
  /** `【doc-desk 回答】<documentId>` の documentId */
  documentId: string
  /** 見出しに続ける要約 (`Q1=A  Q2=お任せ  補足 1 件` や `指摘 3 件  書き換え 2 件`) */
  detail: string
}

const FORM_LINE = /^Q(\d+)\. .*?: (?:(\S+) — |\(未選択 = お任せ\))/
const GLOBAL_NOTE = '全体へのコメント: '
const REVIEW_TARGET = /^対象: \S+/
const REVIEW_COMMENT = /^#\d+( |$)/
const REVIEW_EDIT = /^#\d+ (?:書き換え|削除|移動|の後に追加)/

/**
 * 回答固定形 (references/reply-format-v1.md、指摘の画面は references/review-mode.md) を 1 行に畳みます。
 * 固定形は Mod 自身が作る形式なので、その規則で読みます。読めなければ null (描き換えない)。
 *
 * - 質問票: `Q1=A  Q2=お任せ  補足 n 件` (補足は問いごとの補足と全体へのコメントの数。0 件なら省く)
 * - 指摘の画面: `指摘 n 件  書き換え m 件` (書き換えは削除、移動、追加も数える。0 件なら省く)
 *
 * @param text user turn の本文
 */
export function summarizeReply(text: string): ReplySummary | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const head = lines[0] ?? ''
  if (!head.startsWith(REPLY_HEADING)) {
    return null
  }
  const documentId = head.slice(REPLY_HEADING.length).trim()
  if (documentId === '' || !lines.includes('---')) {
    return null
  }
  const hasGlobalNote = lines.some(line => line.startsWith(GLOBAL_NOTE))

  if (REVIEW_TARGET.test(lines[1] ?? '')) {
    let section = ''
    let comments = 0
    let edits = 0
    for (const line of lines.slice(2)) {
      // 全体へのコメントは人の自由記述 (複数行あり得る) なので、その中の行は数えない
      if (line === '---' || line.startsWith(GLOBAL_NOTE)) {
        break
      }
      if (line.startsWith('## ')) {
        section = line
        continue
      }
      if (section === '## 指摘' && REVIEW_COMMENT.test(line)) {
        comments += 1
      } else if (section === '## 書き換え' && REVIEW_EDIT.test(line)) {
        edits += 1
      }
    }
    const parts = [`指摘 ${comments} 件`]
    if (edits > 0) {
      parts.push(`書き換え ${edits} 件`)
    }
    if (hasGlobalNote) {
      parts.push('全体へのコメントあり')
    }
    return { documentId, detail: parts.join('  ') }
  }

  const picks: string[] = []
  let notes = hasGlobalNote ? 1 : 0
  for (const line of lines.slice(1)) {
    // 表の無い質問票では、問いの行のすぐ後に全体へのコメントが来る
    if (line.startsWith('## ') || line === '---' || line.startsWith(GLOBAL_NOTE)) {
      break
    }
    const match = FORM_LINE.exec(line)
    if (!match) {
      return null
    }
    picks.push(`Q${match[1]}=${match[2] ?? 'お任せ'}`)
    if (line.includes(' / 補足: ')) {
      notes += 1
    }
  }
  if (picks.length === 0) {
    return null
  }
  if (notes > 0) {
    picks.push(`補足 ${notes} 件`)
  }
  return { documentId, detail: picks.join('  ') }
}
