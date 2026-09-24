import { describe, expect, test, tier } from 'claude-code/testing'

import { FULL_TOOL_NAME, PANE_ID, PLUGIN_NAME } from '../hooks/names'
import { recordKeyOf, type PendingRecord } from '../hooks/store/pending-record'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

tier('user')

const KEY = recordKeyOf('/work')
const FORM_PATH = '/work/doc-desk/spec-auth-01.json'
const HTML_PATH = '/work/doc-desk/spec-auth-01.html'
const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'
const MD_PATH = '/work/doc-desk/spec-auth-01.md'

/**
 * 前のセッションが残した記録。時計 (2026-09-22 12:00 UTC) の 1 時間前に待機を始めた。
 */
const RECORD: PendingRecord = {
  kind: 'form',
  label: 'spec-auth-01',
  documentId: 'spec-auth-01',
  revision: 1,
  token: 'feedc0de',
  port: 50123,
  pid: 777,
  startedAtMs: Date.UTC(2026, 8, 22, 11, 0, 0),
}

const HEADLESS = { ...Fixtures.SESSION, surface: null, isInteractive: false } as const

/**
 * 前のセッションが残した証跡 (質問票と HTML) を置きます。
 */
function leaveEvidence(files: Map<string, string>) {
  files.set(FORM_PATH, `${JSON.stringify(Fixtures.FORM, null, 2)}\n`)
  files.set(HTML_PATH, '<!doctype html><title>spec-auth-01</title>')
}

describe('未回答の引き継ぎ', () => {
  test('待機を始めると記録が書かれ、回答が届くと消える', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    const record = world.store.get(KEY) as PendingRecord
    expect(record).toMatchObject({
      kind: 'form',
      label: 'spec-auth-01',
      documentId: 'spec-auth-01',
      revision: 1,
      port: Fixtures.RECEIVER_PORT,
      pid: Fixtures.RECEIVER_PID,
      startedAtMs: Date.UTC(2026, 8, 22, 12, 0, 0),
    })
    expect(url).toContain(`t=${record.token}`)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted).toHaveLength(1)
    expect(world.store.has(KEY), '届いたら記録を消す').toBe(false)
  })

  test('[取り消す] でも記録が消える', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    expect(world.store.has(KEY)).toBe(true)

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

    expect(world.store.has(KEY)).toBe(false)
  })

  test('-p と SDK では、届いていた回答を起動時に .md に書いて prompt.submit で届ける', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(HEADLESS)
    await world.clock.settle()

    expect(world.files.get(MD_PATH)).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REPLY_FULL])
    expect(world.suggested).toEqual([])
    expect(world.store.has(KEY)).toBe(false)
    expect(world.receiverRuns(), '受信サーバは起動しない').toEqual([])
  })

  test('人がいる surface では勝手に届けず、知らせて /doc-desk を候補に出し、/doc-desk で 1 回だけ送る', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.files.get(MD_PATH)).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.submitted, 'turn を勝手に始めない').toEqual([])
    expect(world.logged).toContain(STRINGS.unsentOf('spec-auth-01'))
    expect(world.toasts).toEqual([STRINGS.unsentOf('spec-auth-01')])
    expect(world.suggested).toEqual(['/doc-desk'])
    expect(world.store.has(KEY), '送るまで記録は残す').toBe(true)

    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.sentUnsentOf('spec-auth-01') })
    await world.clock.settle()
    expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REPLY_FULL])
    expect(world.store.has(KEY)).toBe(false)

    expect(await $.command.run(Fixtures.DESK_COMMAND), '2 回目は送らない').toEqual({ text: STRINGS.nothingPending })
    expect(world.submitted).toHaveLength(1)
  })

  test('受信サーバが生きていれば起動し直さず監視を再開し、/doc-desk でペインとブラウザが開く', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD } })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.fetched.map(call => call.url)).toEqual([`http://127.0.0.1:50123/wait?t=feedc0de&timeout=0`])
    expect(world.receiverRuns(), '起動し直さない').toEqual([])
    expect(world.opened, 'ペインは開かない').toEqual([])
    expect(world.receiverCommandRuns('open'), 'ブラウザは開かない').toEqual([])
    expect(world.statuses.at(-1)).toBe(STRINGS.carriedOverOf('spec-auth-01'))

    const url = 'http://127.0.0.1:50123/?t=feedc0de'
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf(url) })
    await world.clock.settle()
    expect(world.opened.map(pane => pane.id)).toEqual([PANE_ID])
    expect(world.runs.filter(argv => argv.includes(url))).toHaveLength(1)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted.map(submit => submit.text), '監視が届ける').toEqual([Fixtures.REPLY_FULL])
    expect(world.store.has(KEY)).toBe(false)
  })

  test('受信サーバが死んでいれば、同じ port と token で起動し直す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD }, waitReply: () => 'error' })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    const argv = world.receiverRuns()[0] ?? []
    expect(world.receiverRuns()).toHaveLength(1)
    expect(argv.slice(argv.indexOf('--token'), argv.indexOf('--token') + 2)).toEqual(['--token', 'feedc0de'])
    expect(argv.slice(argv.indexOf('--port'), argv.indexOf('--port') + 2)).toEqual(['--port', '50123'])
    expect(world.receiverCommandRuns('clean'), '回答ファイルは消さない').toEqual([])

    // 模した受信サーバは別の port (47321) を返したので、URL が変わったことを伝える
    const url = `http://127.0.0.1:${Fixtures.RECEIVER_PORT}/?t=feedc0de`
    expect(world.logged).toContain(STRINGS.portChangedOf('spec-auth-01', url))
    expect(world.store.get(KEY)).toMatchObject({ port: Fixtures.RECEIVER_PORT, pid: Fixtures.RECEIVER_PID, token: 'feedc0de' })
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf(url) })
  })

  test('HTML が消えていれば書き直してから起動し直す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD }, waitReply: () => 'error' })
    leaveEvidence(world.files)
    world.files.delete(HTML_PATH)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.files.get(HTML_PATH)).toContain('id="di-form"')
    expect(world.receiverRuns()).toHaveLength(1)
  })

  test('doc-desk/<label>.json が無ければ記録を消し、何も起動しない', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: RECORD } })

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(KEY)).toBe(false)
    expect(world.fetched).toEqual([])
    expect(world.receiverRuns()).toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('7 日より古い記録は起動し直さずに消し、その旨を出す', async ($, on) => {
    const old = { ...RECORD, startedAtMs: Date.UTC(2026, 8, 14, 12, 0, 0) }
    const world = Fixtures.world(on, { store: { [KEY]: old }, waitReply: () => 'error' })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(KEY)).toBe(false)
    expect(world.receiverRuns()).toEqual([])
    expect(world.logged).toContain(STRINGS.staleRecordOf('spec-auth-01'))
  })

  test('形の違う記録は消す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [KEY]: { kind: 'form', label: 'x' } } })

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(KEY)).toBe(false)
    expect(world.receiverRuns()).toEqual([])
  })
})
