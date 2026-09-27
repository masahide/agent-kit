/**
 * 共有ディレクトリ ~/.agentctl/claude/<sessionId>/ のファイルの形。
 *
 * CLI (tools/agentctl/internal/claude/protocol.go) も同じ形を読み書きします。形を変えるときは
 * tests/fixtures/protocol/*.json の見本から直し、Go と Mod の両方のテストを通します。
 */

export const PROTOCOL_VERSION = 1

/** この Mod の版。mod.json に書きます */
export const MOD_VERSION = '0.1.0'

/** mod.json: Mod が session.start で書く */
export type ModFile = {
  v: 1
  sessionId: string
  pid: number
  modVersion: string
  /** epoch ms */
  startedAt: number
}

/** inbox/<id>.json: CLI だけが書く */
export type InboxMessage = {
  v: 1
  id: string
  kind: 'prompt' | 'interrupt'
  text?: string
  /** epoch ms */
  createdAt: number
}

/** ack の状態。queued だけは途中の状態で、turn が始まると submitted に書き換える */
export type AckStatus = 'queued' | 'submitted' | 'dropped' | 'aborted' | 'no_turn' | 'error'

/** acks/<id>.json: Mod だけが書く */
export type Ack = {
  v: 1
  id: string
  status: AckStatus
  detail?: string
  /** epoch ms */
  at: number
}
