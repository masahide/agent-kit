import { describe, expect, test, tier } from 'claude-code/testing'

import { FULL_REVIEW_TOOL_NAME, FULL_TOOL_NAME, PANE_ID, PLUGIN_NAME } from '../hooks/names'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'
import type { WaitCall } from './fixtures'

tier('user')

const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'

describe('register', () => {
  test('session.start でツール open_form と open_review と /doc-desk が登録される', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)

    expect(world.registeredTools).toEqual(['open_form', 'open_review'])
    expect(world.registeredCommands).toEqual(['doc-desk'])
  })

  test('正しい質問票で open_form を呼ぶと、証跡を書き、受信サーバを起動し、waitSeconds: 0 なら待たずに pending を返す', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({
      tool: FULL_TOOL_NAME,
      form: Fixtures.FORM,
      openBrowser: false,
      waitSeconds: 0,
    })
    await world.clock.settle()

    expect(answered.deny).toBeUndefined()
    expect(typeof answered.result, 'ツールの結果は文字列').toBe('string')

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('pending')
    expect(result.wait, '同期待ちしなかった').toEqual({ seconds: 0, endedBy: 'skipped' })
    expect(world.fetched, '/wait は呼ばない').toEqual([])
    expect(result.documentId).toBe('spec-auth-01')
    expect(result.revision).toBe(1)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:47321\/\?t=[0-9a-f]+$/)
    expect(result.files).toEqual({
      form: '/work/doc-desk/spec-auth-01.json',
      html: '/work/doc-desk/spec-auth-01.html',
    })
    expect(answered.context, 'context が 1 件').toEqual([STRINGS.toolContext])

    expect(JSON.parse(world.files.get('/work/doc-desk/spec-auth-01.json') ?? '')).toEqual(Fixtures.FORM)
    expect(world.files.get('/work/doc-desk/spec-auth-01.html')).toContain('id="di-form"')

    const receiverRuns = world.receiverRuns()
    expect(receiverRuns).toHaveLength(1)
    const argv = receiverRuns[0] ?? []
    expect(argv[0], 'シェルを通さず python3 で receiver.py の start を呼ぶ').toBe('python3')
    expect(argv[1]).toMatch(/[\\/]scripts\/receiver\.py$/)
    expect(argv.slice(2, 4)).toEqual(['start', '--token'])
    expect(argv, 'port-file は使わない').not.toContain('--port-file')
    expect(argv.slice(argv.indexOf('--html'), argv.indexOf('--html') + 2)).toEqual([
      '--html',
      '/work/doc-desk/spec-auth-01.html',
    ])
    expect(argv.slice(argv.indexOf('--out'), argv.indexOf('--out') + 2)).toEqual([
      '--out',
      '/work/doc-desk/spec-auth-01.answer.json',
    ])
    expect(
      world.runs.some(run => run[0] === 'sh'),
      'sh は使わない (Windows には無い)',
    ).toBe(false)
    const cleanRuns = world.receiverCommandRuns('clean')
    expect(
      world.runs.indexOf(cleanRuns[0] ?? []),
      '前回の回答を消す clean は受信サーバの起動より前',
    ).toBeLessThan(world.runs.indexOf(argv))
    expect(cleanRuns.map(run => run.slice(2))).toEqual([['clean', '/work/doc-desk/spec-auth-01.answer.json']])
    expect(
      [...world.files.keys()].some(path => path.endsWith('.port.json')),
      'port-file は作らない',
    ).toBe(false)

    expect(world.receiverCommandRuns('open'), 'openBrowser: false ではブラウザを開かない').toEqual([])

    expect(world.opened.map(pane => pane.id), 'ペインが開く').toEqual([PANE_ID])
  })

  test('不正な質問票は invalid と全エラーを返し、受信サーバを起動しない', async ($, on) => {
    const world = Fixtures.world(on)
    const form = Fixtures.cloneForm(Fixtures.FORM)

    // 6 問にする
    const theme = form.themes[0]!
    for (let index = 0; index < 4; index += 1) {
      theme.questions.push({ ...Fixtures.cloneForm(theme.questions[0]!), id: `x${index}` })
    }
    // cite 空
    theme.questions[0]!.cite = ''
    // recommended が 2 つ
    theme.questions[0]!.options[1]!.recommended = true
    // pros 空
    form.themes[1]!.questions[0]!.options[0]!.pros = ''

    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form, openBrowser: false, waitSeconds: 0 })
    const result = JSON.parse(answered.result as string)

    expect(result.status).toBe('invalid')
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('themes[0].questions[0].cite'),
        expect.stringContaining('themes[0].questions[0].options: recommended'),
        expect.stringContaining('themes[1].questions[0].options[0].pros'),
        expect.stringContaining('圧縮してください'),
      ]),
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(4)

    expect(world.receiverRuns(), '受信サーバは起動しない').toEqual([])
    expect(world.files.size, 'ファイルも書かない').toBe(0)
    expect(world.opened).toEqual([])
  })

  test('回答ファイルを検知すると固定形を 1 回だけ prompt.submit し、.md を書き、ペインを閉じる', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    await world.clock.advance(500)
    expect(world.submitted, '回答が無いうちは何も送らない').toEqual([])

    const raw = JSON.stringify(Fixtures.ANSWER_FULL)
    world.files.set(ANSWER_PATH, raw)
    await world.clock.advance(500)

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(Fixtures.REPLY_FULL)
    // 回答 JSON は context に添えない (2.1.278 では plugin 自身の prompt.submit フックが自分の投入を見ないため。plan.md 4 章 V7)。
    expect(world.submitted[0]?.context).toBeUndefined()

    expect(world.files.get('/work/doc-desk/spec-auth-01.md')).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.closed.map(pane => pane.id)).toEqual([PANE_ID])
    expect(world.logged.at(-1)).toBe(STRINGS.receivedOf('/work/doc-desk/spec-auth-01.md'))

    await world.clock.advance(500)
    await world.clock.advance(5000)
    expect(world.submitted, '2 回目は送らない').toHaveLength(1)
    expect(world.closed).toHaveLength(1)

    expect(await $.command.run(Fixtures.DESK_COMMAND), '届けたあとは待機中ではない').toEqual({
      text: STRINGS.nothingPending,
    })
  })

  test('/doc-desk は待機中ならペインとブラウザを開き直し、待機中でなければその旨を返す', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)

    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
    expect(world.opened).toEqual([])

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    const reopened = await $.command.run(Fixtures.DESK_COMMAND)
    await world.clock.settle()

    expect(reopened).toEqual({ text: STRINGS.reopenedOf(url) })
    expect(world.opened.at(-1)).toEqual({ id: PANE_ID, title: STRINGS.paneTitle, focus: true })
    expect(
      world.runs.filter(argv => argv.includes(url)),
      '/doc-desk はブラウザを開き直す',
    ).toHaveLength(1)
  })

  test('ペインは 2 つのボタンを描き、[取り消す] で受信サーバを止めて idle に戻る', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    const ui = await $.ui.mount({
      plugin: PLUGIN_NAME,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE_ID,
      props: Fixtures.PANE.props,
    })

    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(button => button.props.label)).toEqual([STRINGS.openBrowser, STRINGS.cancel])
    expect(await ui.find({ type: 'Text', text: url })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'インタビュー: spec-auth-01  (rev 1)' })).toBeDefined()

    await ui.press({ key: 'open-browser' })
    await world.clock.settle()
    expect(world.runs.filter(argv => argv.includes(url)), '[ブラウザで開く] は open を再実行').toHaveLength(1)

    await ui.press({ key: 'cancel' })
    await world.clock.settle()
    await ui.unmount()

    expect(world.receiverCommandRuns('stop').map(run => run.slice(2))).toEqual([['stop', String(Fixtures.RECEIVER_PID)]])
    expect(world.closed.map(pane => pane.id)).toEqual([PANE_ID])
    expect(world.logged.at(-1)).toBe(STRINGS.cancelled)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(1000)
    expect(world.submitted, '取り消したあとは回答が来ても送らない').toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('別の質問票を開くと前の受信サーバを止めて新しい待機に入る', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM_NO_TABLES, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(world.receiverCommandRuns('stop').map(run => run.slice(2))).toEqual([['stop', String(Fixtures.RECEIVER_PID)]])
    expect(world.receiverRuns()).toHaveLength(2)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted, '前の質問票の回答ファイルは見ない').toEqual([])

    world.files.set('/work/doc-desk/spec-auth-01-nt.answer.json', JSON.stringify(Fixtures.ANSWER_BARE))
    await world.clock.advance(500)
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(Fixtures.REPLY_BARE)
  })

  test('同じ label の古い回答ファイルが残っていても、open_form が消すので拾わない', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(JSON.parse(answered.result as string).status).toBe('pending')
    expect(world.files.has(ANSWER_PATH), '古い回答ファイルは消えている').toBe(false)

    await world.clock.advance(1000)
    expect(world.submitted, '古い回答は届けない').toEqual([])
  })

  test('回答 JSON の documentId か revision が質問票と違えば無視する', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    world.files.set(ANSWER_PATH, JSON.stringify({ ...Fixtures.ANSWER_FULL, revision: 2 }))
    await world.clock.advance(1000)
    expect(world.submitted, 'revision 違いは無視').toEqual([])

    world.files.set(ANSWER_PATH, JSON.stringify({ ...Fixtures.ANSWER_FULL, documentId: 'other-doc' }))
    await world.clock.advance(1000)
    expect(world.submitted, 'documentId 違いは無視').toEqual([])

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted, '一致すれば届ける').toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(Fixtures.REPLY_FULL)
  })

  test('同期待ち中に回答が届くと answered と固定形を返し、prompt.submit は呼ばれない', async ($, on) => {
    const world = Fixtures.world(on, {
      waitReply: call => {
        if (call.count === 2) {
          // 2 回目の /wait の保留中に人が [送信] を押した: 受信サーバはファイルを書いてから応答する
          world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
          return { answered: true }
        }
        return { answered: false }
      },
    })

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 30 })
    await world.clock.settle()

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('answered')
    expect(result.documentId).toBe('spec-auth-01')
    expect(result.revision).toBe(1)
    expect(result.reply).toBe(Fixtures.REPLY_FULL)
    expect(result.files).toEqual({
      form: '/work/doc-desk/spec-auth-01.json',
      html: '/work/doc-desk/spec-auth-01.html',
      answer: ANSWER_PATH,
      md: '/work/doc-desk/spec-auth-01.md',
    })
    expect(answered.context).toEqual([STRINGS.answeredContext])

    expect(world.fetched.map(call => call.timeoutSeconds), '/wait は 4 秒ずつ').toEqual([4, 4])
    expect(world.fetched[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:47321\/wait\?t=[0-9a-f]+&timeout=4$/)
    expect(world.files.get('/work/doc-desk/spec-auth-01.md')).toBe(`${Fixtures.REPLY_FULL}\n`)
    expect(world.closed.map(pane => pane.id)).toEqual([PANE_ID])
    expect(world.logged.at(-1)).toBe(STRINGS.receivedOf('/work/doc-desk/spec-auth-01.md'))

    await world.clock.advance(5000)
    expect(world.submitted, '同期で返したので user turn は投入しない').toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('waitSeconds が過ぎると pending を返し、その後の回答は prompt.submit で 1 回だけ届く', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 6 })
    await world.clock.settle()

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('pending')
    expect(result.wait).toEqual({ seconds: 6, endedBy: 'timeout' })
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:47321\/\?t=[0-9a-f]+$/)
    expect(answered.context).toEqual([STRINGS.toolContext])
    expect(world.fetched.map(call => call.timeoutSeconds), '4 秒 + 残り 2 秒').toEqual([4, 2])
    expect(world.submitted).toEqual([])

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(Fixtures.REPLY_FULL)

    await world.clock.advance(5000)
    expect(world.submitted, '2 回目は送らない').toHaveLength(1)
  })

  test('同期待ち中に受信サーバに届かなくなると pending (receiverLost) を返し、監視は続く', async ($, on) => {
    const world = Fixtures.world(on, { waitReply: () => 'error' })

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 60 })
    await world.clock.settle()

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('pending')
    expect(result.wait.endedBy).toBe('receiverLost')
    expect(world.fetched, '失敗したら繰り返さない').toHaveLength(1)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(500)
    expect(world.submitted).toHaveLength(1)
  })

  test('同期待ち中に [取り消す] を押すと cancelled を返し、何も届かない', async ($, on) => {
    const cancelDuring = async (call: WaitCall) => {
      if (call.count !== 1) {
        return { answered: false }
      }
      // /wait の保留中にペインの [取り消す] が押された
      const ui = await $.ui.mount({
        plugin: PLUGIN_NAME,
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: Fixtures.PANE.props,
      })
      await ui.press({ key: 'cancel' })
      await ui.unmount()
      return { answered: false }
    }
    const world = Fixtures.world(on, { waitReply: cancelDuring })

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 60 })
    await world.clock.settle()

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('cancelled')
    expect(result.reason).toBe(STRINGS.cancelledByPerson)
    expect(answered.context).toBeUndefined()
    expect(world.fetched).toHaveLength(1)
    expect(world.receiverCommandRuns('stop')).toHaveLength(1)
    expect(world.logged.at(-1)).toBe(STRINGS.cancelled)

    world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
    await world.clock.advance(1000)
    expect(world.submitted).toEqual([])
  })

  test('desktop のペインは localhost の Link を描く', async ($, on) => {
    const world = Fixtures.world(on)

    await $.session.start(Fixtures.SESSION)
    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const { url } = JSON.parse(answered.result as string)

    const ui = await $.ui.mount({
      plugin: PLUGIN_NAME,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE_ID,
      props: Fixtures.PANE.props,
    })

    const link = await ui.find({ type: 'Link' })
    expect(link).toBeDefined()
    expect(link?.props.href).toBe(String(url).replace('127.0.0.1', 'localhost'))
    expect(link?.props.label).toBe(STRINGS.openLink)
    expect(await ui.find({ type: 'Text', text: url }), '127.0.0.1 の URL も文字で出す').toBeDefined()
    await ui.unmount()
  })

  test('receiver.py start が port を返さなければ failed を返す', async ($, on) => {
    const world = Fixtures.world(on, { isReceiverUp: false })

    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    const result = JSON.parse(answered.result as string)

    expect(result.status).toBe('failed')
    expect(result.reason).toContain(STRINGS.noPort)
    expect(result.reason).toContain('file://')
    expect(result.files.html).toBe('/work/doc-desk/spec-auth-01.html')
    expect(world.files.has('/work/doc-desk/spec-auth-01.html'), 'HTML は書いてある').toBe(true)
    expect(world.opened).toEqual([])
  })

  test('Python 3 がどの名前でも見つからなければ受信サーバを起動せず failed を返す', async ($, on) => {
    const world = Fixtures.world(on, { python: null })

    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    const result = JSON.parse(answered.result as string)

    expect(result.status).toBe('failed')
    expect(result.reason).toContain(STRINGS.noPython)
    expect(world.receiverRuns()).toEqual([])
    expect(
      world.runs.map(run => run.join(' ')),
      'python3、python、py -3 の順に 1 回ずつ確かめる (結果は覚えておく)',
    ).toEqual(['python3 --version', 'python --version', 'py -3 --version'])
  })

  for (const [python, expected] of [
    ['python', ['python']],
    ['py', ['py', '-3']],
  ] as const) {
    test(`python3 が Microsoft Store のスタブなら ${expected.join(' ')} で受信サーバを起動し、ブラウザも開く`, async ($, on) => {
      const world = Fixtures.world(on, { python })
      await $.session.start(Fixtures.SESSION)
      await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: true, waitSeconds: 0 })
      await world.clock.settle()

      expect(world.receiverRuns().map(run => run.slice(0, expected.length))).toEqual([[...expected]])
      expect(world.receiverCommandRuns('open').map(run => run.slice(0, expected.length))).toEqual([[...expected]])
    })
  }
  describe('open_review', () => {
    const REVIEW_ANSWER_PATH = '/work/doc-desk/spec-auth-01-review.answer.json'

    test('文書の HTML が無ければ invalid を返し、受信サーバを起動しない', async ($, on) => {
      const world = Fixtures.world(on)
      await $.session.start(Fixtures.SESSION)

      const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
      const result = JSON.parse(answered.result as string)

      expect(result.status).toBe('invalid')
      expect(result.errors).toEqual([`${Fixtures.DOC_PATH}: ${STRINGS.noDocument}`])
      expect(world.receiverRuns()).toEqual([])
      expect(world.opened).toEqual([])
    })

    test('許可リストに無い要素や、review の欄の誤りは invalid で全部返す', async ($, on) => {
      const world = Fixtures.world(on)
      await $.session.start(Fixtures.SESSION)
      world.files.set(Fixtures.DOC_PATH, '<p onclick="x()">a</p><script>y()</script>')

      const bad = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
      const errors = JSON.parse(bad.result as string).errors as string[]
      expect(errors).toHaveLength(2)
      expect(errors.every(error => error.startsWith(`${Fixtures.DOC_PATH}: `))).toBe(true)

      const wrong = await $.tool.call({
        tool: FULL_REVIEW_TOOL_NAME,
        review: { ...Fixtures.REVIEW, revision: 0 },
        openBrowser: false,
        waitSeconds: 0,
      })
      expect(JSON.parse(wrong.result as string)).toEqual({ status: 'invalid', errors: ['revision: 1 以上の整数にしてください'] })
      expect(world.receiverRuns()).toEqual([])
    })

    test('同期待ち中に指摘が届くと answered と固定形を返す。証跡は doc-desk/<label>.* に書く', async ($, on) => {
      const world = Fixtures.world(on, {
        waitReply: call => {
          if (call.count === 1) {
            world.files.set(REVIEW_ANSWER_PATH, JSON.stringify(Fixtures.REVIEW_ANSWER))
            return { answered: true }
          }
          return { answered: false }
        },
      })
      await $.session.start(Fixtures.SESSION)
      world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

      const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 30 })
      await world.clock.settle()
      const result = JSON.parse(answered.result as string)

      expect(result.status).toBe('answered')
      expect(result.reply).toBe(Fixtures.REVIEW_REPLY)
      expect(result.files).toEqual({
        doc: Fixtures.DOC_PATH,
        review: '/work/doc-desk/spec-auth-01-review.json',
        html: '/work/doc-desk/spec-auth-01-review.html',
        candidates: '/work/doc-desk/spec-auth-01-review.candidates.json',
        answer: REVIEW_ANSWER_PATH,
        md: '/work/doc-desk/spec-auth-01-review.md',
      })
      expect(answered.context).toEqual([STRINGS.reviewAnsweredContext])
      expect(JSON.parse(world.files.get('/work/doc-desk/spec-auth-01-review.json') ?? '')).toEqual(Fixtures.REVIEW)
      expect(world.files.get('/work/doc-desk/spec-auth-01-review.html')).toContain('id="di-review"')
      expect(world.files.get('/work/doc-desk/spec-auth-01-review.md')).toBe(`${Fixtures.REVIEW_REPLY}
`)
      expect(world.files.get(Fixtures.DOC_PATH), '文書の HTML は消さない').toBe(Fixtures.DOC_HTML)

      const argv = world.receiverRuns()[0] ?? []
      expect(argv.slice(argv.indexOf('--html'), argv.indexOf('--html') + 2)).toEqual(['--html', '/work/doc-desk/spec-auth-01-review.html'])
      expect(world.submitted).toEqual([])
    })

    test('waitSeconds: 0 なら pending を返し、指摘は prompt.submit で 1 回だけ届く。ペインの見出しは「指摘」', async ($, on) => {
      const world = Fixtures.world(on)
      await $.session.start(Fixtures.SESSION)
      world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

      const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
      await world.clock.settle()
      const result = JSON.parse(answered.result as string)
      expect(result.status).toBe('pending')
      expect(result.files).toEqual({
        doc: Fixtures.DOC_PATH,
        review: '/work/doc-desk/spec-auth-01-review.json',
        html: '/work/doc-desk/spec-auth-01-review.html',
        candidates: '/work/doc-desk/spec-auth-01-review.candidates.json',
      })
      expect(answered.context).toEqual([STRINGS.reviewPendingContext])

      const ui = await $.ui.mount({
        plugin: PLUGIN_NAME,
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: Fixtures.PANE.props,
      })
      expect(await ui.find({ type: 'Text', text: STRINGS.reviewHeaderOf('spec-auth-01-review', 1) })).toBeDefined()
      await ui.unmount()

      world.files.set(REVIEW_ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
      await world.clock.advance(500)
      expect(world.submitted, '質問票の形の回答は無視する').toEqual([])

      world.files.set(REVIEW_ANSWER_PATH, JSON.stringify(Fixtures.REVIEW_ANSWER_EMPTY))
      await world.clock.advance(500)
      expect(world.submitted.map(submit => submit.text)).toEqual([Fixtures.REVIEW_REPLY_EMPTY])

      await world.clock.advance(5000)
      expect(world.submitted).toHaveLength(1)
    })

    test('質問票の待機中に open_review を呼ぶと、前の受信サーバを止めて差し替える', async ($, on) => {
      const world = Fixtures.world(on)
      await $.session.start(Fixtures.SESSION)
      world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

      await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
      await world.clock.settle()
      await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
      await world.clock.settle()

      expect(world.receiverCommandRuns('stop')).toHaveLength(1)
      world.files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_FULL))
      await world.clock.advance(500)
      expect(world.submitted, '前の質問票の回答は届けない').toEqual([])
    })
  })
})
