import type { AnswerV1, FormV1 } from './form-v1'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * 回答ファイルの中身を、質問票に対する回答として読みます。
 *
 * JSON でない、`answers` が無い、`documentId` か `revision` が質問票と違う、のいずれかなら null
 * (別の質問票の回答や、同じ label の古い回答を拾わないため)。
 *
 * @param text `interview/<label>.answer.json` の中身
 * @param form 待っている質問票
 * @returns 質問票に対する回答。違えば null
 */
export function parseAnswer(text: string, form: FormV1): AnswerV1 | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    return null
  }
  if (parsed.documentId !== form.documentId || parsed.revision !== form.revision) {
    return null
  }
  return parsed as unknown as AnswerV1
}
