import type { RenderInput } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import { FULL_TOOL_NAME, PLUGIN_NAME } from '../hooks/names'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

tier('user')

const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'
const MD_PATH = '/work/doc-desk/spec-auth-01.md'

/**
 * エンジン自身の描き方の代わりに、テストの下のフックが描く印。
 */
const ENGINE_ROW = 'ENGINE_ROW'

const rowProps = (text: string, overrides: Partial<RenderInput<'UserMessage'>['props']> = {}) => ({
  text,
  origin: { kind: 'plugin' as const, name: PLUGIN_NAME },
  isExpanded: false,
  ...overrides,
})

const TURN = { answer: '質問票を出しました。', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' } as const

describe('回答行を畳む、回答先を添える、届いたら知らせる', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: plugin の投入した回答固定形の行を 1 行に畳み、.md のパスを添える`, async ($, on) => {
      const world = Fixtures.world(on)
      on('ui.render', { component: 'UserMessage' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ENGINE_ROW })
      })
      await $.session.start(Fixtures.SESSION)
      await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
      await world.clock.settle()
      world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
      await world.clock.advance(500)
      expect(world.submitted).toHaveLength(1)

      const mount = (props: RenderInput<'UserMessage'>['props']) =>
        $.ui.mount({ plugin: PLUGIN_NAME, surface, component: 'UserMessage', requestId: 'm1', props })

      const folded = await mount(rowProps(Fixtures.REPLY_FULL))
      expect(await folded.find({ type: 'Text', text: '【doc-desk 回答】spec-auth-01  Q1=A  Q2=お任せ  補足 2 件' })).toBeDefined()
      expect(await folded.find({ type: 'Text', text: `  ${STRINGS.replyRowHintOf(MD_PATH)}` })).toBeDefined()
      expect(await folded.find({ type: 'Text', text: ENGINE_ROW })).toBeUndefined()
      await folded.unmount()

      const expanded = await mount(rowProps(Fixtures.REPLY_FULL, { isExpanded: true }))
      expect(await expanded.find({ type: 'Text', text: ENGINE_ROW }), 'ctrl+o では全文 (next)').toBeDefined()
      await expanded.unmount()

      const plain = await mount(rowProps('ふつうの投入'))
      expect(await plain.find({ type: 'Text', text: ENGINE_ROW }), '固定形でなければ next').toBeDefined()
      await plain.unmount()

      const other = await mount(rowProps(Fixtures.REPLY_FULL, { origin: { kind: 'plugin', name: 'other' } }))
      expect(await other.find({ type: 'Text', text: ENGINE_ROW }), '他の plugin の投入は素通し').toBeDefined()
      await other.unmount()

      const typed = await mount(rowProps(Fixtures.REPLY_FULL, { origin: { kind: 'composer' } }))
      expect(await typed.find({ type: 'Text', text: ENGINE_ROW }), '人が打った行は素通し').toBeDefined()
      await typed.unmount()
    })
  }

  test('このセッションで届けていない固定形も畳むが、.md のパスは出さない', async ($, on) => {
    Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)

    const ui = await $.ui.mount({
      plugin: PLUGIN_NAME,
      surface: 'terminal',
      component: 'UserMessage',
      requestId: 'm1',
      props: rowProps(Fixtures.REPLY_BARE),
    })
    expect(await ui.find({ type: 'Text', text: '【doc-desk 回答】spec-auth-01  Q1=B  Q2=A' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `  ${STRINGS.replyRowHintOf(undefined)}` })).toBeDefined()
    await ui.unmount()
  })

  test('turn.complete は待機中の最初の 1 回だけ回答先の URL を答えの下に添える', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)

    expect(await $.turn.complete(TURN), '待機中でなければ何も足さない').toMatchObject({ text: TURN.answer })

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    expect(await $.turn.complete({ ...TURN, agentId: 'a1' }), 'subagent の turn には足さない').toMatchObject({
      text: TURN.answer,
    })
    expect(await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true }), '中断には足さない').toMatchObject({
      text: TURN.answer,
    })
    expect(await $.turn.complete(TURN)).toMatchObject({ text: STRINGS.answerUrlOf(url) })
    expect(await $.turn.complete(TURN), '2 回目は足さない').toMatchObject({ text: TURN.answer })
  })

  test('回答が届くと通知が 1 回出る', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    await world.clock.advance(5000)

    expect(world.toasts).toEqual([STRINGS.receivedToastOf('spec-auth-01')])
  })
})
