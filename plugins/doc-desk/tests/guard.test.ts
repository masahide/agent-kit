import { describe, expect, test, tier } from 'claude-code/testing'

import { isSamePath, normalizePath, writeTargetOf } from '../hooks/guard/paths'
import { FULL_REVIEW_TOOL_NAME, FULL_TOOL_NAME, PANE_ID, PLUGIN_NAME } from '../hooks/names'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

tier('user')

const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'

/**
 * エンジンの判定の代わりに、テストの下のフックがいつも allow を返す。
 */
function allowBeneath(on: Parameters<typeof Fixtures.world>[0]) {
  on('tool.check', () => ({ decision: 'allow' as const }))
}

const write = (file_path: string) => ({ tool: 'Write', input: { file_path, content: 'x' }, tool_use_id: 'toolu_1' })

describe('回答前の書き込みを止める', () => {
  test('source 付きの質問票で待機中に、source への Write を deny する。別のパスと回答後は通す', async ($, on) => {
    const world = Fixtures.world(on)
    allowBeneath(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(await $.tool.check(write('docs/auth.md'))).toEqual({
      decision: 'deny',
      reason: STRINGS.guardReasonOf('spec-auth-01', 'docs/auth.md'),
    })
    expect(await $.tool.check(write('/work/docs/./x/../auth.md')), '絶対パスと .. でも止める').toMatchObject({
      decision: 'deny',
    })
    expect(await $.tool.check(write('/work/docs/other.md'))).toEqual({ decision: 'allow' })
    expect(
      await $.tool.check({ tool: 'Write', input: { file_path: 'docs/auth.md', content: 'x' } }),
      '問い合わせ (tool_use_id なし) には答えない',
    ).toEqual({ decision: 'allow' })
    expect(
      await $.tool.check({ tool: 'NotebookEdit', input: { notebook_path: '/work/docs/auth.md' }, tool_use_id: 't' }),
    ).toMatchObject({ decision: 'deny' })

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted).toHaveLength(1)
    expect(await $.tool.check(write('docs/auth.md')), '回答が届いた後は通す').toEqual({ decision: 'allow' })
  })

  test('[取り消す] の後は通す', async ($, on) => {
    const world = Fixtures.world(on)
    allowBeneath(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    const ui = await $.ui.mount({
      plugin: PLUGIN_NAME,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE_ID,
      props: Fixtures.PANE.props,
    })
    await ui.press({ key: 'cancel' })
    await world.clock.settle()
    await ui.unmount()

    expect(await $.tool.check(write('docs/auth.md'))).toEqual({ decision: 'allow' })
  })

  test('source の無い質問票では止めない', async ($, on) => {
    const world = Fixtures.world(on)
    allowBeneath(on)
    await $.session.start(Fixtures.SESSION)
    const { source: _source, ...withoutSource } = Fixtures.FORM
    await $.tool.call({ tool: FULL_TOOL_NAME, form: withoutSource, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(await $.tool.check(write('docs/auth.md'))).toEqual({ decision: 'allow' })
  })

  test('指摘の画面で待機中は、review.source と .doc.html への Edit を deny する', async ($, on) => {
    const world = Fixtures.world(on)
    allowBeneath(on)
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    await $.tool.call({
      tool: FULL_REVIEW_TOOL_NAME,
      review: { ...Fixtures.REVIEW, source: 'docs/auth.md' },
      openBrowser: false,
      waitSeconds: 0,
    })
    await world.clock.settle()

    const edit = (file_path: string) => ({
      tool: 'Edit',
      input: { file_path, old_string: 'a', new_string: 'b' },
      tool_use_id: 'toolu_2',
    })
    expect(await $.tool.check(edit('docs/auth.md'))).toMatchObject({ decision: 'deny' })
    expect(await $.tool.check(edit(Fixtures.DOC_PATH))).toMatchObject({ decision: 'deny' })
    expect(await $.tool.check(edit('docs/other.md'))).toEqual({ decision: 'allow' })
  })

  test('シンボリックリンク越しの書き込みも止める', async ($, on) => {
    const world = Fixtures.world(on, { links: { '/work/link.md': '/work/docs/auth.md' } })
    allowBeneath(on)
    world.files.set('/work/docs/auth.md', '# 認証')
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(await $.tool.check(write('/work/link.md'))).toMatchObject({ decision: 'deny' })
  })

  test('normalizePath: 相対と絶対、\\ と /、..、Windows の大文字小文字', () => {
    expect(normalizePath('docs/auth.md', '/work')).toBe('/work/docs/auth.md')
    expect(normalizePath('/work/docs/../docs/./auth.md', '/work')).toBe('/work/docs/auth.md')
    expect(normalizePath('./docs//auth.md/', '/work/')).toBe('/work/docs/auth.md')
    expect(normalizePath('docs\\auth.md', 'C:\\Work')).toBe('c:/work/docs/auth.md')
    expect(normalizePath('C:\\WORK\\Docs\\Auth.md', 'c:\\work')).toBe('c:/work/docs/auth.md')
    expect(normalizePath('..\\..\\x.md', 'C:\\a\\b\\c')).toBe('c:/a/x.md')
    expect(normalizePath('/Work/A.md', '/work'), 'POSIX は大文字小文字を区別する').toBe('/Work/A.md')
  })

  test('writeTargetOf と isSamePath', () => {
    expect(writeTargetOf({ file_path: 'a.md' })).toBe('a.md')
    expect(writeTargetOf({ notebook_path: 'n.ipynb' })).toBe('n.ipynb')
    expect(writeTargetOf({ command: 'ls' })).toBeNull()
    expect(writeTargetOf(null)).toBeNull()
    expect(isSamePath(['/a', '/b'], ['/c', '/b'])).toBe(true)
    expect(isSamePath(['/a'], ['/c'])).toBe(false)
  })
})
