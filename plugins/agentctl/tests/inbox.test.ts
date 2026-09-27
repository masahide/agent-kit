import { describe, expect, test, tier } from 'claude-code/testing'

import { idOf, makeAck, parseMessage, pendingNames, submitStatus } from '../hooks/inbox'
import { ackDropped, ackQueued, inboxInterrupt, inboxPrompt } from './fixtures/protocol'

tier('user')

describe('pendingNames', () => {
  test('.json のファイルだけを古い順に返し、一時ファイルと処理済みを飛ばす', () => {
    const entries = [
      { name: '1790498063999-bbbb.json', kind: 'file', size: 10, isLink: false },
      { name: '1790498063477-aaaa.json', kind: 'file', size: 10, isLink: false },
      { name: '1790498064000-cccc.json.tmp', kind: 'file', size: 10, isLink: false },
      { name: 'sub', kind: 'directory', size: 0, isLink: false },
      { name: '1790498064001-dddd.json', kind: 'file', size: 10, isLink: false },
    ]
    expect(pendingNames(entries, new Set(['1790498064001-dddd.json']))).toEqual([
      '1790498063477-aaaa.json',
      '1790498063999-bbbb.json',
    ])
  })

  test('配列でなければ空', () => {
    expect(pendingNames(undefined, new Set())).toEqual([])
  })
})

describe('parseMessage', () => {
  test('CLI が書く見本 (Go のテストと共有) を読む', () => {
    expect(parseMessage(JSON.stringify(inboxPrompt))).toEqual(inboxPrompt)
    expect(parseMessage(JSON.stringify(inboxInterrupt))).toEqual(inboxInterrupt)
  })

  test('版が違う、本文が空、JSON でないものは読まない', () => {
    expect(parseMessage(JSON.stringify({ ...inboxPrompt, v: 2 }))).toBeUndefined()
    expect(parseMessage(JSON.stringify({ ...inboxPrompt, text: '  ' }))).toBeUndefined()
    expect(parseMessage('{')).toBeUndefined()
  })
})

describe('makeAck と submitStatus', () => {
  test('ack は見本 (Go のテストと共有) と同じ形になる', () => {
    expect(makeAck(ackQueued.id, 'queued', ackQueued.at)).toEqual(ackQueued)
    expect(makeAck(ackDropped.id, 'dropped', ackDropped.at, ackDropped.detail)).toEqual(ackDropped)
  })

  test('{ drop } は dropped、それ以外は submitted', () => {
    expect(submitStatus({ drop: 'the session is shutting down' })).toEqual({
      status: 'dropped',
      detail: 'the session is shutting down',
    })
    expect(submitStatus({ text: 'x', origin: { kind: 'plugin', name: 'agentctl' } })).toEqual({ status: 'submitted' })
  })

  test('ファイル名から id を取る', () => {
    expect(idOf('1790498063477-8dd10162.json')).toBe('1790498063477-8dd10162')
  })
})
