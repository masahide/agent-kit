import type { Elements, RenderElement } from 'claude-code'

import { REPLY_HEADING } from '../names'
import type { ReplySummary } from '../reply/summary'
import { STRINGS } from './strings'

/**
 * 畳んだ回答行を描くのに要る要素。`Box` と `Text` だけ使います (4 つの surface すべてにあります)。
 */
export type ReplyRowKit = Pick<Elements['terminal'], 'Box' | 'Text'>

/**
 * 非同期経路で届いた回答固定形の user turn を畳んだ行。terminal と desktop で同じ木です。
 *
 * ```
 * 【doc-desk 回答】<documentId>  Q1=B  Q2=お任せ  補足 1 件
 *   /work/doc-desk/<label>.md  (ctrl+o で全文)
 * ```
 *
 * @param mdPath 固定形を保存した `.md`。この Mod が届けた回答でなければ (別のセッションで届けたものなど) undefined
 */
export function replyRow(kit: ReplyRowKit, summary: ReplySummary, mdPath: string | undefined): RenderElement {
  const { Box, Text } = kit

  return Box({
    flexDirection: 'column',
    children: [
      Text({ bold: true, wrap: 'truncate-end', children: `${REPLY_HEADING}${summary.documentId}  ${summary.detail}` }),
      Text({ dimColor: true, wrap: 'truncate-middle', children: `  ${STRINGS.replyRowHintOf(mdPath)}` }),
    ],
  })
}
