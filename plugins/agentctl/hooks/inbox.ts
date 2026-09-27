import { PROTOCOL_VERSION, type Ack, type AckStatus, type InboxMessage } from './protocol'

/**
 * `$.fs.list` の結果から、まだ処理していないメッセージのファイル名を古い順に返します。
 *
 * CLI は一時名 (`<id>.json.tmp`) で書いてから rename するので、`.json` で終わる名前だけを見ます。
 */
export function pendingNames(entries: unknown, done: ReadonlySet<string>): string[] {
  if (!Array.isArray(entries)) {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name
    const kind = typeof entry === 'string' ? 'file' : (entry as { kind?: unknown } | null)?.kind
    if (typeof name !== 'string' || kind !== 'file' || !name.endsWith('.json') || name.startsWith('.') || done.has(name)) {
      continue
    }
    names.push(name)
  }
  return names.sort()
}

/** 受信箱のファイルを読みます。形が違えば undefined */
export function parseMessage(text: string): InboxMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const m = value as Record<string, unknown>
  if (m.v !== PROTOCOL_VERSION || typeof m.id !== 'string' || m.id === '' || typeof m.createdAt !== 'number') {
    return undefined
  }
  if (m.kind === 'interrupt') {
    return { v: PROTOCOL_VERSION, id: m.id, kind: 'interrupt', createdAt: m.createdAt }
  }
  if (m.kind === 'prompt' && typeof m.text === 'string' && m.text.trim() !== '') {
    return { v: PROTOCOL_VERSION, id: m.id, kind: 'prompt', text: m.text, createdAt: m.createdAt }
  }
  return undefined
}

/** ack を作ります */
export function makeAck(id: string, status: AckStatus, at: number, detail?: string): Ack {
  return detail ? { v: PROTOCOL_VERSION, id, status, detail, at } : { v: PROTOCOL_VERSION, id, status, at }
}

/** `$.prompt.submit` の結果を ack の状態にします (`{ drop }` は受け付けられなかった) */
export function submitStatus(result: unknown): { status: AckStatus; detail?: string } {
  if (typeof result === 'object' && result !== null && 'drop' in result) {
    const drop = (result as { drop?: unknown }).drop
    return { status: 'dropped', detail: typeof drop === 'string' ? drop : 'dropped' }
  }
  return { status: 'submitted' }
}

/** ファイル名 `<id>.json` から id を取ります */
export function idOf(name: string): string {
  return name.slice(0, -'.json'.length)
}
