/**
 * 会話の圧縮 (`session.compact`) の結果に差し戻す「決定の記録」を組みます。
 *
 * 人が答えた回答固定形 (`doc-desk/<label>.md`) を原文のまま足し、要約で薄まらないようにします。
 */

/**
 * 決定の記録の見出し。SKILL.md の手順 6 はこの見出しで記録を探します。
 */
export const RECORD_HEADING = '【doc-desk 決定の記録】'

/**
 * 差し戻す文の上限 (文字)。超えたら各回答を決定の部分だけにし、それでも超えれば新しいものから入れます。
 */
export const RECORD_MAX_CHARS = 20000

/**
 * このセッションで届いた回答 1 つ分。
 */
export type SettledReply = {
  label: string
  /** `doc-desk/<label>.md` */
  mdPath: string
  /** `.md` の中身 (回答固定形) */
  text: string
}

/**
 * 回答固定形の決定の部分。質問票は見出しと `Qn.` の行、指摘の画面は見出しと対象、`## 指摘` の節、
 * `## 書き換え` の各項目の見出し行 (`前:` と `後:` の全文は外す) です。全体へのコメントと締めの文は外します。
 */
export function decisionPartOf(text: string): string {
  const kept: string[] = []
  let section = ''
  for (const line of text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n')) {
    if (line === '---' || line.startsWith('全体へのコメント: ')) {
      break
    }
    if (line.startsWith('## ')) {
      section = line
      if (line === '## 指摘' || line === '## 書き換え') {
        kept.push(line)
      }
      continue
    }
    if (section === '## 表' || section === '## 指摘した段落') {
      continue
    }
    if (section === '## 書き換え' && (line.startsWith('前: ') || line.startsWith('後: ') || line.startsWith('  '))) {
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 差し戻す文を組みます。届いた回答が無ければ null (圧縮に手を加えない)。
 *
 * 1. 全文 (古い順) が上限に収まればそのまま載せる。
 * 2. 収まらなければ各回答を決定の部分 (`decisionPartOf`) にする。
 * 3. それでも収まらなければ新しいものから入れ、入らなかった回答はパスだけ書く。
 *
 * @param replies このセッションで届いた回答 (古い順)
 * @param waitingLabel 回答待ちの画面の label。あれば「届くまで対象の文書を書かない」を足す
 * @param maxChars 上限 (テスト用)
 */
export function buildDecisionRecord(
  replies: readonly SettledReply[],
  waitingLabel: string | null,
  maxChars: number = RECORD_MAX_CHARS,
): string | null {
  if (replies.length === 0) {
    return null
  }
  const tail = waitingLabel === null ? [] : [`質問票 ${waitingLabel} は回答待ちです。回答が届くまで対象の文書を書きません。`]
  const compose = (bodies: readonly string[]): string => [RECORD_HEADING, ...bodies, ...tail].join('\n\n')

  const full = replies.map(reply => reply.text.replace(/\s+$/, ''))
  if (compose(full).length <= maxChars) {
    return compose(full)
  }

  const parts = replies.map(reply => `${decisionPartOf(reply.text)}\n(全文: ${reply.mdPath})`)
  if (compose(parts).length <= maxChars) {
    return compose(parts)
  }

  // 新しいものから入れる。入らなかったものはパスだけ
  const chosen: (string | null)[] = replies.map(() => null)
  const pathOnly = (index: number) => `(入りきらなかった回答: ${replies[index]!.label} → ${replies[index]!.mdPath})`
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const trial = chosen.map((body, at) => (at === index ? parts[index]! : (body ?? pathOnly(at))))
    if (compose(trial).length <= maxChars) {
      chosen[index] = parts[index]!
    }
  }
  return compose(chosen.map((body, at) => body ?? pathOnly(at)))
}
