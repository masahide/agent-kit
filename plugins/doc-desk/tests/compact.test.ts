import type { SessionCompactInput, SessionMessage } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import { buildDecisionRecord, decisionPartOf, RECORD_HEADING } from '../hooks/compact/record'
import { FULL_TOOL_NAME } from '../hooks/names'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

tier('user')

const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'
const MD_PATH = '/work/doc-desk/spec-auth-01.md'

/**
 * 圧縮される会話 (人の依頼 1 通)。
 */
const COMPACT: SessionCompactInput = {
  trigger: 'manual',
  messages: [{ role: 'user', text: '認証の仕様書を書いて', toolUses: [] }],
}

/**
 * core の要約。受け取った instructions を覚え、要約 1 通を返す。
 */
function summarizer(on: Parameters<typeof Fixtures.world>[0]) {
  const seen: (string | undefined)[] = []
  const summary: SessionMessage = { role: 'user', text: '(要約) 認証の仕様書を書いている', toolUses: [] }
  on('session.compact', ($, e) => {
    seen.push(e.instructions)
    return { messages: [summary] }
  })
  return { seen, summary }
}

describe('圧縮で決定を残す', () => {
  test('届いた回答があれば、要約に指示を足し、結果の末尾に固定形の全文を足す', async ($, on) => {
    const world = Fixtures.world(on)
    const core = summarizer(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.files.get(MD_PATH)).toBe(`${Fixtures.REPLY_FULL}\n`)

    const result = await $.session.compact({ ...COMPACT, instructions: '認証の話を残して' })

    expect(core.seen).toEqual([`認証の話を残して\n\n${STRINGS.compactInstructions}`])
    expect(result.skip).toBeUndefined()
    const messages = result.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ text: core.summary.text })
    expect(messages[1]).toMatchObject({ role: 'user', text: `${RECORD_HEADING}\n\n${Fixtures.REPLY_FULL}` })
  })

  test('回答待ちの画面があれば、届くまで書かないことを足す', async ($, on) => {
    const world = Fixtures.world(on)
    summarizer(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)

    const answered =await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM_NO_TABLES, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    const result = await $.session.compact(COMPACT)
    const text = result.messages?.at(-1)?.text ?? ''
    expect(text).toContain('質問票 spec-auth-01-nt は回答待ちです。')
    expect(text, '圧縮で消える回答先の URL を載せる').toContain(url)
    expect(text).toContain('/doc-desk')
  })

  test('指摘の画面の回答待ちは「指摘の画面」と書く', () => {
    const reply = { label: 'a', mdPath: '/w/doc-desk/a.md', text: Fixtures.REPLY_BARE }
    const record = buildDecisionRecord([reply], { kind: 'review', label: 'a-review', url: 'http://127.0.0.1:1/?t=x' })
    expect(record).toContain('指摘の画面 a-review は回答待ちです。')
  })

  test('core が前の記録を残した messages を返しても (precompute の再利用など)、記録は 1 つだけにする', async ($, on) => {
    const world = Fixtures.world(on)
    const stale: SessionMessage = { role: 'user', text: `${RECORD_HEADING}\n\n古い記録`, toolUses: [] }
    const summary: SessionMessage = { role: 'user', text: '(要約)', toolUses: [] }
    on('session.compact', () => ({ messages: [summary, stale] }))
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)

    const result = await $.session.compact({ ...COMPACT, trigger: 'precompute' })
    const records = (result.messages ?? []).filter(message => message.text.startsWith(RECORD_HEADING))
    expect(records).toHaveLength(1)
    expect(records[0]?.text).toContain(Fixtures.REPLY_FULL)
    expect(result.messages?.[0]).toMatchObject({ text: '(要約)' })
  })

  test('core が圧縮を見送った ({ skip }) ときは何も足さない', async ($, on) => {
    const world = Fixtures.world(on)
    on('session.compact', () => ({ skip: 'PreCompact hook blocked' }))
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)

    expect(await $.session.compact(COMPACT)).toEqual({ skip: 'PreCompact hook blocked' })
  })

  test('同じ label が 2 回届いたら新しい方だけ載せ、.md が消えた回答は載せない', async ($, on) => {
    const world = Fixtures.world(on)
    summarizer(on)
    await $.session.start(Fixtures.SESSION)
    for (const answer of [Fixtures.ANSWER_FULL, { ...Fixtures.ANSWER_FULL, globalNote: '2 回目' }]) {
      await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
      await world.clock.settle()
      world.files.set(ANSWER_PATH, JSON.stringify(answer))
      await world.clock.advance(500)
    }
    const once = await $.session.compact(COMPACT)
    const text = once.messages?.at(-1)?.text ?? ''
    expect(text.split('【doc-desk 回答】spec-auth-01')).toHaveLength(2)
    expect(text).toContain('全体へのコメント: 2 回目')

    world.files.delete(MD_PATH)
    const none = await $.session.compact(COMPACT)
    expect(none.messages?.some(message => message.text.startsWith(RECORD_HEADING)), '.md が無ければ足さない').toBe(false)
  })

  test('届いた回答が無ければ何も変えない', async ($, on) => {
    const world = Fixtures.world(on)
    const core = summarizer(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    const result = await $.session.compact({ ...COMPACT, instructions: 'x' })
    expect(core.seen).toEqual(['x'])
    expect(result.messages).toEqual([core.summary])
  })

  test('subagent の会話の圧縮には何も足さない', async ($, on) => {
    const world = Fixtures.world(on)
    const core = summarizer(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)

    const result = await $.session.compact({ ...COMPACT, agentId: 'a1' })
    expect(core.seen).toEqual([undefined])
    expect(result.messages).toEqual([core.summary])
  })

  test('buildDecisionRecord: 上限を超えると決定の部分だけにし、それでも超えれば新しいものから入れる', () => {
    const first = { label: 'a', mdPath: '/w/doc-desk/a.md', text: `${Fixtures.REPLY_FULL}\n` }
    const second = { label: 'b', mdPath: '/w/doc-desk/b.md', text: `${Fixtures.REPLY_BARE}\n` }

    expect(buildDecisionRecord([], null)).toBeNull()
    expect(buildDecisionRecord([first, second], null)).toBe(
      `${RECORD_HEADING}\n\n${Fixtures.REPLY_FULL}\n\n${Fixtures.REPLY_BARE}`,
    )

    const decision = decisionPartOf(Fixtures.REPLY_FULL)
    expect(decision, '人が埋めた表は決定として残し、全体へのコメントと締めは外す').toBe(
      Fixtures.REPLY_FULL.split('\n').slice(0, 9).join('\n'),
    )
    const fullLength = buildDecisionRecord([first, second], null)!.length
    const shortened = buildDecisionRecord([first, second], null, fullLength - 1)
    expect(shortened).toContain(`${decision}\n(全文: /w/doc-desk/a.md)`)
    expect(shortened).not.toContain('全体へのコメント')
    expect(shortened!.length).toBeLessThan(fullLength)

    const newestLimit = [
      RECORD_HEADING,
      '(入りきらなかった回答: a → /w/doc-desk/a.md)',
      `${decisionPartOf(Fixtures.REPLY_BARE)}\n(全文: /w/doc-desk/b.md)`,
    ].join('\n\n').length
    const newestOnly = buildDecisionRecord([first, second], null, newestLimit)
    expect(newestOnly).toContain('(入りきらなかった回答: a → /w/doc-desk/a.md)')
    expect(newestOnly).toContain(decisionPartOf(Fixtures.REPLY_BARE))
    expect(newestOnly!.length).toBeLessThanOrEqual(newestLimit)
  })

  test('decisionPartOf: 指摘の画面は指摘と書き換えの見出しだけを残す', () => {
    const text = [
      '【doc-desk 回答】d',
      '対象: doc-desk/d-review.doc.html',
      '## 指摘',
      '#3 [短くする]',
      '## 指摘した段落',
      '#3 長い段落',
      '## 書き換え',
      '#2 書き換え (そのまま)',
      '前: a',
      '  a2',
      '後: b',
      '全体へのコメント: よい',
      '---',
      '締め',
    ].join('\n')
    expect(decisionPartOf(text)).toBe(
      ['【doc-desk 回答】d', '対象: doc-desk/d-review.doc.html', '## 指摘', '#3 [短くする]', '## 書き換え', '#2 書き換え (そのまま)'].join(
        '\n',
      ),
    )
  })
})
