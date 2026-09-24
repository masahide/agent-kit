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
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM_NO_TABLES, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    const result = await $.session.compact(COMPACT)
    expect(result.messages?.at(-1)?.text).toContain('質問票 spec-auth-01-nt は回答待ちです。')
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
    expect(decision).toBe(Fixtures.REPLY_FULL.split('\n').slice(0, 3).join('\n'))
    const shortened = buildDecisionRecord([first, second], null, 400)
    expect(shortened).toContain(`${decision}\n(全文: /w/doc-desk/a.md)`)
    expect(shortened).not.toContain('## 表')
    expect(shortened!.length).toBeLessThanOrEqual(400)

    const newestOnly = buildDecisionRecord([first, second], null, 250)
    expect(newestOnly).toContain('(入りきらなかった回答: a → /w/doc-desk/a.md)')
    expect(newestOnly).toContain(decisionPartOf(Fixtures.REPLY_BARE))
    expect(newestOnly!.length).toBeLessThanOrEqual(250)
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
