/**
 * 待機の記録。`$.store` に残し、次の `session.start` で「届いていれば渡す、届いていなければ待ちを再開する」
 * のに使います。画面の中身 (`Sheet`) は `doc-desk/<label>.json` から組み直せるので記録には入れません。
 */

/**
 * 記録 1 件。`kind` は画面の種類 (`open_form` なら form、`open_review` なら review)。
 */
export type PendingRecord = {
  kind: 'form' | 'review'
  label: string
  documentId: string
  revision: number
  /** 受信サーバと照合するトークン。起動し直すときも同じものを使う (ブラウザのタブの URL が生きる) */
  token: string
  port: number
  pid: number
  /** 待機を始めた時刻 (ms)。古さの判定に使う */
  startedAtMs: number
}

/**
 * この日数より古い記録は、起動し直さずに捨てます。
 */
export const RECORD_MAX_AGE_DAYS = 7

const RECORD_MAX_AGE_MS = RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

/**
 * 記録のキー。`$.store` は plugin ごとに 1 つで、プロジェクトをまたいで共有されるので cwd を含めます。
 */
export const recordKeyOf = (cwd: string): string => `pending:${cwd}`

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * `$.store.get` の値を記録として読みます。形が違えば null。
 */
export function parsePendingRecord(value: unknown): PendingRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    (record.kind !== 'form' && record.kind !== 'review') ||
    !isNonEmptyString(record.label) ||
    !isNonEmptyString(record.documentId) ||
    !isPositiveInteger(record.revision) ||
    !isNonEmptyString(record.token) ||
    !isPositiveInteger(record.port) ||
    !isPositiveInteger(record.pid) ||
    typeof record.startedAtMs !== 'number' ||
    !Number.isFinite(record.startedAtMs)
  ) {
    return null
  }
  return {
    kind: record.kind,
    label: record.label,
    documentId: record.documentId,
    revision: record.revision,
    token: record.token,
    port: record.port,
    pid: record.pid,
    startedAtMs: record.startedAtMs,
  }
}

/**
 * 記録が `RECORD_MAX_AGE_DAYS` 日より古いか。
 */
export const isStale = (record: PendingRecord, nowMs: number): boolean => nowMs - record.startedAtMs > RECORD_MAX_AGE_MS
