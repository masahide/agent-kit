import type { ReviewV1 } from './review-v1'

/**
 * 検証の結果。通れば `review`、落ちれば `errors` (全部) を返します。
 */
export type ReviewValidation =
  | { ok: true; review: ReviewV1 }
  | { ok: false; errors: string[] }

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PARTS = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/**
 * `open_review` の `review` を検証します (規則は references/review-mode.md)。
 * 文書の HTML の中身は `document.ts` の `documentErrors` が別に検査します。
 *
 * @param input ツールに渡された `review`
 * @returns 通れば `{ ok: true, review }`、落ちれば `{ ok: false, errors }`
 */
export function validateReview(input: unknown): ReviewValidation {
  const errors: string[] = []
  const fail = (path: string, message: string) => {
    errors.push(`${path}: ${message}`)
  }

  if (!isRecord(input)) {
    return { ok: false, errors: ['review: オブジェクトにしてください'] }
  }

  if (input.schemaVersion !== 1) {
    fail('schemaVersion', '1 にしてください')
  }

  for (const key of ['documentId', 'label'] as const) {
    const value = input[key]
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      fail(key, '1〜64 文字の英数字と - と _ にしてください')
    }
  }

  if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
    fail('revision', '1 以上の整数にしてください')
  }

  if (!isFilled(input.title)) {
    fail('title', '空でない文字列にしてください')
  }

  if (input.source !== undefined && !isFilled(input.source)) {
    fail('source', '省略するか、空でない文字列 (元の文書のパス) にしてください')
  }

  if (input.part !== undefined) {
    const part = input.part
    if (
      !isRecord(part) ||
      !Number.isInteger(part.index) ||
      !Number.isInteger(part.total) ||
      (part.total as number) < 2 ||
      (part.total as number) > MAX_PARTS ||
      (part.index as number) < 1 ||
      (part.index as number) > (part.total as number)
    ) {
      fail('part', `省略するか、{ index, total } (1 ≦ index ≦ total、total は 2〜${MAX_PARTS}) にしてください`)
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, review: input as unknown as ReviewV1 }
}
