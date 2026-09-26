import type { ReviewAnswerV1, ReviewComment, ReviewEdit, ReviewV1 } from './review-v1'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 指摘 1 件を読みます。形が違えば null (その指摘だけ捨てます)。
 */
function commentOf(value: unknown): ReviewComment | null {
  if (!isRecord(value) || !Number.isInteger(value.block) || (value.block as number) < 1) {
    return null
  }
  const chip = typeof value.chip === 'string' && value.chip.trim() !== '' ? value.chip : null
  const quote = typeof value.quote === 'string' ? value.quote : ''
  const text = typeof value.text === 'string' ? value.text : ''
  if (chip === null && text.trim() === '') {
    return null
  }
  const source = value.source === 'claude' || value.source === 'live' ? value.source : undefined
  return { block: value.block as number, chip, quote, text, ...(source && { source }) }
}

const isBlock = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1

/**
 * 添削 1 件を読みます。形が違えば null (その 1 件だけ捨てます)。
 */
function editOf(value: unknown): ReviewEdit | null {
  if (!isRecord(value) || !isBlock(value.block)) {
    return null
  }
  const block = value.block
  switch (value.kind) {
    case 'rewrite':
    case 'add':
      return typeof value.text === 'string' && value.text.trim() !== ''
        ? { kind: value.kind, block, text: value.text, mode: value.mode === 'guide' ? 'guide' : 'exact' }
        : null
    case 'delete':
      return { kind: 'delete', block }
    case 'move':
      return isBlock(value.to) && value.to !== block ? { kind: 'move', block, to: value.to } : null
    default:
      return null
  }
}

/**
 * 回答ファイルの中身を、指摘の画面に対する回答として読みます。
 *
 * JSON でない、`kind` が `review` でない、`comments` が配列でない、`documentId` か `revision` が
 * 違う、のいずれかなら null (別の画面の回答や、同じ label の古い回答を拾わないため)。
 *
 * @param text `doc-desk/<label>.answer.json` の中身
 * @param review 待っている指摘の画面
 * @returns 回答。違えば null
 */
export function parseReviewAnswer(text: string, review: ReviewV1): ReviewAnswerV1 | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.kind !== 'review' || !Array.isArray(parsed.comments)) {
    return null
  }
  if (parsed.documentId !== review.documentId || parsed.revision !== review.revision) {
    return null
  }
  const blocks: Record<string, string> = {}
  if (isRecord(parsed.blocks)) {
    for (const [key, value] of Object.entries(parsed.blocks)) {
      if (typeof value === 'string') blocks[key] = value
    }
  }
  return {
    schemaVersion: 1,
    kind: 'review',
    documentId: review.documentId,
    revision: review.revision,
    comments: parsed.comments.map(commentOf).filter((comment): comment is ReviewComment => comment !== null),
    edits: Array.isArray(parsed.edits) ? parsed.edits.map(editOf).filter((edit): edit is ReviewEdit => edit !== null) : [],
    blocks,
    ...(typeof parsed.globalNote === 'string' && { globalNote: parsed.globalNote }),
    ...(typeof parsed.submittedAt === 'string' && { submittedAt: parsed.submittedAt }),
  }
}
