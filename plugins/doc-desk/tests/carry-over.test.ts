import { describe, expect, test, tier } from 'claude-code/testing'

import { FULL_TOOL_NAME, PANE_ID, PLUGIN_NAME } from '../hooks/names'
import { isOwnedByOther, LEASE_MS, recordKeyOf, recordPrefixOf, type PendingRecord } from '../hooks/store/pending-record'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

tier('user')

/** 前のセッション (止まっている) の記録のキー */
const BEFORE = recordKeyOf('/work', 'session-before')
/** このセッション (テストの `$.session.id()` は session-now) の記録のキー */
const MINE = recordKeyOf('/work', 'session-now')
/** 同じフォルダで今も動いている別のセッションの記録のキー */
const OTHER = recordKeyOf('/work', 'session-other')
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
  sessionId: 'session-before',
  // 前のセッションは 10 分前に止まった (lease は切れている)
  heartbeatAtMs: Date.UTC(2026, 8, 22, 11, 50, 0),
}

const NOW_MS = Date.UTC(2026, 8, 22, 12, 0, 0)

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

    const record = world.store.get(MINE) as PendingRecord
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
    expect(world.store.has(MINE), '届いたら記録を消す').toBe(false)
  })

  test('[取り消す] でも記録が消える', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    expect(world.store.has(MINE)).toBe(true)

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

    expect(world.store.has(MINE)).toBe(false)
  })

  test('-p と SDK では、届いていた回答を起動時に .md に書いて prompt.submit で届ける', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(HEADLESS)
    await world.clock.settle()

    expect(world.files.get(MD_PATH)).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REPLY_FULL])
    expect(world.suggested).toEqual([])
    expect(world.store.has(MINE)).toBe(false)
    expect(world.receiverRuns(), '受信サーバは起動しない').toEqual([])
  })

  test('人がいる surface では勝手に届けず、知らせて /doc-desk を候補に出し、/doc-desk で 1 回だけ送る', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.files.get(MD_PATH)).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.submitted, 'turn を勝手に始めない').toEqual([])
    expect(world.logged).toContain(STRINGS.unsentOf('form', 'spec-auth-01'))
    expect(world.toasts).toEqual([STRINGS.unsentOf('form', 'spec-auth-01')])
    expect(world.suggested).toEqual(['/doc-desk'])
    expect(world.store.has(MINE), '送るまで記録は残す (このセッションのキーに移す)').toBe(true)
    expect(world.store.has(BEFORE)).toBe(false)

    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.sentUnsentOf('form', 'spec-auth-01') })
    await world.clock.settle()
    expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REPLY_FULL])
    expect(world.store.has(MINE)).toBe(false)

    expect(await $.command.run(Fixtures.DESK_COMMAND), '2 回目は送らない').toEqual({ text: STRINGS.nothingPending })
    expect(world.submitted).toHaveLength(1)
  })

  test('/doc-desk で送れなかったら未送に戻し、記録も残す。もう一度 /doc-desk で送れる', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, refuseSubmits: 1 })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    await $.command.run(Fixtures.DESK_COMMAND)
    await world.clock.settle()
    expect(world.submitted).toEqual([])
    expect(world.logged).toContain(STRINGS.unsentFailedOf('form', 'spec-auth-01'))
    expect(world.store.has(MINE)).toBe(true)

    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.sentUnsentOf('form', 'spec-auth-01') })
    await world.clock.settle()
    expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REPLY_FULL])
    expect(world.store.has(MINE)).toBe(false)
  })

  test('-p と SDK で投入が受け付けられなければ、記録を残す (次の起動でまた届ける)', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, refuseSubmits: 1 })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(HEADLESS)
    await world.clock.settle()

    expect(world.submitted).toEqual([])
    expect(world.store.has(MINE)).toBe(true)
  })

  test('受信サーバが生きていれば起動し直さず監視を再開し、/doc-desk でペインとブラウザが開く', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD } })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.fetched.map(call => call.url)).toEqual([`http://127.0.0.1:50123/wait?t=feedc0de&timeout=0`])
    expect(world.receiverRuns(), '起動し直さない').toEqual([])
    expect(world.opened, 'ペインは開かない').toEqual([])
    expect(world.receiverCommandRuns('open'), 'ブラウザは開かない').toEqual([])
    expect(world.statuses.at(-1)).toBe(STRINGS.carriedOverOf('form', 'spec-auth-01'))

    const url = 'http://127.0.0.1:50123/?t=feedc0de'
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf(url) })
    await world.clock.settle()
    expect(world.opened.map(pane => pane.id)).toEqual([PANE_ID])
    expect(world.runs.filter(argv => argv.includes(url))).toHaveLength(1)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted.map(submit => submit.text), '監視が届ける').toEqual([Fixtures.REPLY_FULL])
    expect(world.store.has(MINE)).toBe(false)
  })

  test('受信サーバが死んでいれば、同じ port と token で起動し直す。URL は変わらない', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, waitReply: () => 'error' })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    const argv = world.receiverRuns()[0] ?? []
    expect(world.receiverRuns()).toHaveLength(1)
    expect(argv.slice(argv.indexOf('--token'), argv.indexOf('--token') + 2)).toEqual(['--token', 'feedc0de'])
    expect(argv.slice(argv.indexOf('--port'), argv.indexOf('--port') + 2)).toEqual(['--port', '50123'])
    expect(world.receiverCommandRuns('clean'), '回答ファイルは消さない').toEqual([])
    expect(world.receiverCommandRuns('stop'), '古い pid は止めない (使い回されているかもしれない)').toEqual([])

    const url = 'http://127.0.0.1:50123/?t=feedc0de'
    expect(world.logged.some(line => line.includes('URL が変わりました')), 'URL は変わっていない').toBe(false)
    expect(world.store.get(MINE)).toMatchObject({ port: 50123, pid: Fixtures.RECEIVER_PID, token: 'feedc0de', sessionId: 'session-now' })
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf(url) })
  })

  test('同じ port が使用中で、古い受信サーバも死んでいれば、新しい URL を伝える', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, waitReply: () => 'error', busyPorts: [50123] })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    const url = `http://127.0.0.1:${Fixtures.RECEIVER_PORT}/?t=feedc0de`
    expect(world.logged).toContain(STRINGS.portChangedOf('form', 'spec-auth-01', url))
    expect(world.store.get(MINE)).toMatchObject({ port: Fixtures.RECEIVER_PORT, pid: Fixtures.RECEIVER_PID })
    expect(world.receiverCommandRuns('stop')).toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf(url) })
  })

  test('生死の確認が一時的に失敗しただけで古い受信サーバが生きていれば、起動し直した方を止めて古い方を使う', async ($, on) => {
    const world = Fixtures.world(on, {
      store: { [BEFORE]: RECORD },
      // 1 回目の確認は失敗、起動し直した後の 2 回目は生きている
      waitReply: call => (call.count === 1 ? 'error' : { answered: false }),
      busyPorts: [50123],
    })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.receiverRuns()).toHaveLength(1)
    expect(world.receiverCommandRuns('stop').map(run => run.slice(2))).toEqual([['stop', String(Fixtures.RECEIVER_PID)]])
    expect(world.logged.some(line => line.includes('URL が変わりました'))).toBe(false)
    expect(world.store.get(MINE)).toMatchObject({ port: 50123, pid: 777 })
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.reopenedOf('http://127.0.0.1:50123/?t=feedc0de') })
  })

  test('同じフォルダの別のセッションが今も持っている記録は引き継がず、消しも上書きもしない', async ($, on) => {
    const live = { ...RECORD, sessionId: 'session-other', heartbeatAtMs: NOW_MS - 10 * 1000 }
    const world = Fixtures.world(on, { store: { [OTHER]: live } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.logged).toContain(STRINGS.ownedByOtherOf('form', 'spec-auth-01'))
    expect(world.fetched).toEqual([])
    expect(world.receiverRuns()).toEqual([])
    expect(world.suggested, '回答は持ち主のセッションが届ける').toEqual([])
    expect(world.store.get(OTHER)).toEqual(live)
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })

    // このセッションの待機は自分のキーに書き、相手の記録には触らない
    await $.tool.call({ tool: FULL_TOOL_NAME, form: { ...Fixtures.FORM, label: 'other-label' }, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    expect(world.store.get(OTHER)).toEqual(live)
    expect(world.store.get(MINE)).toMatchObject({ label: 'other-label', sessionId: 'session-now' })
  })

  test('lease が切れた記録は、別のセッションのものでも引き継ぐ。同じセッション (resume) なら lease の中でも引き継ぐ', async ($, on) => {
    const resumed = { ...RECORD, sessionId: 'session-now', heartbeatAtMs: NOW_MS - 1000 }
    const world = Fixtures.world(on, { store: { [MINE]: resumed } })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.statuses.at(-1)).toBe(STRINGS.carriedOverOf('form', 'spec-auth-01'))
    expect(LEASE_MS).toBeGreaterThan(30 * 1000)
  })

  test('持っている記録は heartbeat で時刻を進め、別のセッションに引き継がれていたら手を引く', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const first = (world.store.get(MINE) as PendingRecord).heartbeatAtMs

    await world.clock.advance(30 * 1000)
    expect((world.store.get(MINE) as PendingRecord).heartbeatAtMs).toBeGreaterThan(first)

    // このセッションが止まっている間に lease が切れ、別のセッションが自分のキーへ移した
    const moved = world.store.get(MINE) as PendingRecord
    world.store.delete(MINE)
    world.store.set(OTHER, { ...moved, sessionId: 'session-other', heartbeatAtMs: NOW_MS + 60 * 1000 })
    await world.clock.advance(30 * 1000)
    expect(world.logged).toContain(STRINGS.ownedByOtherOf('form', 'spec-auth-01'))
    expect(world.receiverCommandRuns('stop'), '相手が使っている受信サーバは止めない').toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('指摘の画面の記録では、案内の文言が「指摘の画面」になる', async ($, on) => {
    const review = {
      ...RECORD,
      kind: 'review' as const,
      label: 'spec-auth-01-review',
    }
    const world = Fixtures.world(on, { store: { [BEFORE]: review } })
    world.files.set('/work/doc-desk/spec-auth-01-review.json', `${JSON.stringify(Fixtures.REVIEW, null, 2)}\n`)
    world.files.set('/work/doc-desk/spec-auth-01-review.html', '<!doctype html>')
    world.files.set('/work/doc-desk/spec-auth-01-review.answer.json', JSON.stringify(Fixtures.REVIEW_ANSWER_EMPTY))

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.logged).toContain(STRINGS.unsentOf('review', 'spec-auth-01-review'))
    expect(STRINGS.unsentOf('review', 'x')).toContain('指摘の画面 x')
  })

  test('recordPrefixOf: 区切り、末尾の区切り、Windows の大文字小文字をそろえる。キーはセッションごと', () => {
    expect(recordPrefixOf('/work/')).toBe(recordPrefixOf('/work'))
    expect(recordPrefixOf('C:\\Users\\Me\\Repo\\')).toBe(recordPrefixOf('c:/users/me/repo'))
    expect(recordPrefixOf('/Work'), 'POSIX は大文字小文字を区別する').not.toBe(recordPrefixOf('/work'))
    expect(recordKeyOf('/work', 's1')).toBe('pending:/work:s1')
    expect(recordPrefixOf('/work/sub').startsWith(recordPrefixOf('/work')), '子のフォルダは頭が違う').toBe(false)
  })

  test('HTML が消えていれば書き直してから起動し直す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, waitReply: () => 'error' })
    leaveEvidence(world.files)
    world.files.delete(HTML_PATH)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.files.get(HTML_PATH)).toContain('id="di-form"')
    expect(world.receiverRuns()).toHaveLength(1)
  })

  test('doc-desk/<label>.json が無ければ記録を消し、何も起動しない', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD } })

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(BEFORE)).toBe(false)
    expect(world.fetched).toEqual([])
    expect(world.receiverRuns()).toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('7 日より古い記録は起動し直さずに消し、その旨を出す', async ($, on) => {
    const old = { ...RECORD, startedAtMs: Date.UTC(2026, 8, 14, 12, 0, 0) }
    const world = Fixtures.world(on, { store: { [BEFORE]: old }, waitReply: () => 'error' })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(BEFORE)).toBe(false)
    expect(world.receiverRuns()).toEqual([])
    expect(world.logged).toContain(STRINGS.staleRecordOf('form', 'spec-auth-01'))
  })

  test('形の違う記録は消す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: { kind: 'form', label: 'x' } } })

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.store.has(BEFORE)).toBe(false)
    expect(world.receiverRuns()).toEqual([])
  })

  test('正常に終わるセッションは lease を手放し (heartbeat を 0 に)、次のセッションはすぐ引き継げる', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    expect((world.store.get(MINE) as PendingRecord).heartbeatAtMs).toBe(NOW_MS)

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-now', resume: { id: 'session-now' } })

    const released = world.store.get(MINE) as PendingRecord
    expect(released.heartbeatAtMs).toBe(0)
    expect(isOwnedByOther(released, 'session-next', NOW_MS + 5000), '5 秒後に起動した別のセッションが引き継げる').toBe(false)
  })

  test('別のセッションが持っている記録は、lease が切れる頃にもう一度見て、持ち主が止まっていれば引き継ぐ', async ($, on) => {
    // 持ち主は 10 秒前まで生きていたが、その後クラッシュした (session.end が来ず、heartbeat も進まない)
    const crashed = { ...RECORD, sessionId: 'session-other', heartbeatAtMs: NOW_MS - 10 * 1000 }
    const world = Fixtures.world(on, { store: { [OTHER]: crashed } })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()
    expect(world.logged).toContain(STRINGS.ownedByOtherOf('form', 'spec-auth-01'))
    expect(world.statuses).not.toContain(STRINGS.carriedOverOf('form', 'spec-auth-01'))

    await world.clock.advance(LEASE_MS)
    expect(world.statuses.at(-1)).toBe(STRINGS.carriedOverOf('form', 'spec-auth-01'))
    expect(world.store.has(OTHER)).toBe(false)
    expect(world.store.get(MINE)).toMatchObject({ token: 'feedc0de', sessionId: 'session-now' })
    expect(
      world.logged.filter(line => line === STRINGS.ownedByOtherOf('form', 'spec-auth-01')),
      '案内は 1 回だけ',
    ).toHaveLength(1)
  })

  test('持ち主が生きていれば (heartbeat が進めば)、lease が切れる頃に見ても引き継がない', async ($, on) => {
    const live = { ...RECORD, sessionId: 'session-other', heartbeatAtMs: NOW_MS - 10 * 1000 }
    const world = Fixtures.world(on, { store: { [OTHER]: live } })
    leaveEvidence(world.files)
    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    // 相手のセッションが heartbeat を進めた
    world.store.set(OTHER, { ...live, heartbeatAtMs: NOW_MS + 60 * 1000 })
    await world.clock.advance(LEASE_MS)
    expect(world.store.has(MINE)).toBe(false)
    expect(world.statuses).not.toContain(STRINGS.carriedOverOf('form', 'spec-auth-01'))
  })

  test('自分の記録が消えていても、別のセッションが引き継いでいなければ (書き込みの失敗など) 書き直して待ち続ける', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    world.store.delete(MINE)
    await world.clock.advance(30 * 1000)

    expect(world.store.get(MINE)).toMatchObject({ label: 'spec-auth-01', sessionId: 'session-now' })
    expect(world.logged.some(line => line.includes('別のセッション'))).toBe(false)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted.map(submit => submit.text), '回答は届く').toEqual([Fixtures.REPLY_FULL])
  })

  test('投入が { drop } で断られたら受け付けられていないとみなし、記録を残す (-p と SDK)', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD }, dropSubmits: true })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    await $.session.start(HEADLESS)
    await world.clock.settle()

    expect(world.store.has(MINE)).toBe(true)
    expect(world.logged).toContain(STRINGS.unsentFailedOf('form', 'spec-auth-01'))
  })

  test('監視が届けた回答の投入が断られたら、未送に戻して記録も書き直す', async ($, on) => {
    const world = Fixtures.world(on, { dropSubmits: true })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)

    expect(world.logged).toContain(STRINGS.unsentFailedOf('form', 'spec-auth-01'))
    expect(world.store.get(MINE)).toMatchObject({ label: 'spec-auth-01' })
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.sentUnsentOf('form', 'spec-auth-01') })
  })

  test('持ち主のいない記録が複数あれば、新しいものだけ引き継ぎ、古いものは片付けて伝える', async ($, on) => {
    const older = { ...RECORD, label: 'old-label', token: 'oldtoken', startedAtMs: RECORD.startedAtMs - 60 * 1000 }
    const olderKey = recordKeyOf('/work', 'session-older')
    const world = Fixtures.world(on, { store: { [olderKey]: older, [BEFORE]: RECORD } })
    leaveEvidence(world.files)

    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    expect(world.statuses.at(-1)).toBe(STRINGS.carriedOverOf('form', 'spec-auth-01'))
    expect(world.store.has(olderKey)).toBe(false)
    expect(world.logged).toContain(STRINGS.supersededOf('form', 'old-label'))
  })

  test('起動時に見つけた未送の回答は、同じ label を出し直すと捨てる', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: RECORD } })
    leaveEvidence(world.files)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()

    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const url = `http://127.0.0.1:${Fixtures.RECEIVER_PORT}/?t=`
    const reopened = await $.command.run(Fixtures.DESK_COMMAND)
    expect(reopened.text, '/doc-desk は古い回答を送らず、新しい待機を開き直す').toContain(url)
    await world.clock.settle()
    expect(world.submitted).toEqual([])
  })

  test('port が 65535 を超える記録は形が違うものとして消す', async ($, on) => {
    const world = Fixtures.world(on, { store: { [BEFORE]: { ...RECORD, port: 70000 } } })
    leaveEvidence(world.files)
    await $.session.start(Fixtures.SESSION)
    await world.clock.settle()
    expect(world.store.has(BEFORE)).toBe(false)
    expect(world.receiverRuns()).toEqual([])
  })
})
