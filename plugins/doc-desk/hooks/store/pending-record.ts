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
  /** 待機を持っているセッションの id (`$.session.id()`) */
  sessionId: string
  /** 持っているセッションが最後に生きていると書いた時刻 (ms)。監視のたびに進める */
  heartbeatAtMs: number
}

/**
 * この日数より古い記録は、起動し直さずに捨てます。
 */
export const RECORD_MAX_AGE_DAYS = 7

const RECORD_MAX_AGE_MS = RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

/**
 * 持っているセッションが生きているとみなす間 (ms)。heartbeat はこれより短い間隔 (`HEARTBEAT_INTERVAL_MS`) で書きます。
 */
export const LEASE_MS = 90 * 1000

/**
 * heartbeat を書く間隔 (ms)。
 */
export const HEARTBEAT_INTERVAL_MS = 30 * 1000

/**
 * 同じフォルダの記録のキーに共通する頭。`$.store` は plugin ごとに 1 つで、プロジェクトをまたいで共有されるので
 * cwd を含めます。同じフォルダが別のキーにならないよう、区切りを `/` にそろえ、末尾の `/` を外し、
 * Windows (ドライブ名で始まる) では小文字にします。
 */
export function recordPrefixOf(cwd: string): string {
  const slashed = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return `pending:${/^[A-Za-z]:(\/|$)/.test(slashed) ? slashed.toLowerCase() : slashed}:`
}

/**
 * 記録のキー `pending:<cwd>:<セッション id>`。同じフォルダで同時に動くセッションが互いの記録を上書きしないよう、
 * セッションごとに分けます。
 */
export const recordKeyOf = (cwd: string, sessionId: string): string => `${recordPrefixOf(cwd)}${sessionId}`

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
    // 持ち主の欄が無い記録は、持ち主がいない (誰でも引き継げる) ものとして読む
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    heartbeatAtMs: typeof record.heartbeatAtMs === 'number' && Number.isFinite(record.heartbeatAtMs) ? record.heartbeatAtMs : 0,
  }
}

/**
 * 記録が `RECORD_MAX_AGE_DAYS` 日より古いか。
 */
export const isStale = (record: PendingRecord, nowMs: number): boolean => nowMs - record.startedAtMs > RECORD_MAX_AGE_MS

/**
 * 別のセッションが今も持っている記録か (持ち主の id が違い、heartbeat が `LEASE_MS` 以内)。
 * そうなら引き継がず、取り消しで消しもしません。
 */
export const isOwnedByOther = (record: PendingRecord, sessionId: string, nowMs: number): boolean =>
  record.sessionId !== '' && record.sessionId !== sessionId && nowMs - record.heartbeatAtMs <= LEASE_MS
