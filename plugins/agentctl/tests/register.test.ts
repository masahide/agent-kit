import type { Args, On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { inboxInterrupt, inboxPrompt } from './fixtures/protocol'

tier('user')

const HOME = '/home/u'
const SESSION_ID = 'afa924ff-7fba-43b4-9122-4e9a06fc2f09'
const DIR = `${HOME}/.agentctl/claude/${SESSION_ID}`

/**
 * Mod の下の世界: ファイルは Map、時計は mock.clock、$.prompt.submit は gate が開くまで返らない
 * (turn の実行中に投入すると、その turn が終わるまで返らないのを模す)。
 */
function world(on: On, options: { windows?: boolean } = {}) {
  const files = new Map<string, string>()
  const submitted: Args<'prompt.submit'>[] = []
  const aborted: string[] = []
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const clock = mock.clock(on, { now: Date.UTC(2026, 8, 27, 12, 0, 0) })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('env.get', ($, e) => ({ value: e.name === (options.windows ? 'USERPROFILE' : 'HOME') ? HOME : undefined }))
  on('process.run', () =>
    options.windows
      ? { value: { exitCode: 1, stdout: '', stderr: "'sh' is not recognized" } }
      : { value: { exitCode: 0, stdout: '4242\n', stderr: '' } },
  )
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = [...files.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length))
    if (names.length === 0) {
      return { deny: `ENOENT: ${e.path}` }
    }
    return { value: names.map(name => ({ name, kind: 'file', size: 1, isLink: false })) }
  })
  on('prompt.submit', async ($, e) => {
    submitted.push(e)
    await gate
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })

  return {
    files,
    submitted,
    aborted,
    clock,
    /** 以後の $.prompt.submit を、release() まで返さない */
    hold() {
      gate = new Promise(resolve => {
        open = resolve
      })
    },
    release() {
      open()
    },
    post(message: { id: string }) {
      files.set(`${DIR}/inbox/${message.id}.json`, JSON.stringify(message))
    },
    ack(id: string) {
      const text = files.get(`${DIR}/acks/${id}.json`)
      return text === undefined ? undefined : (JSON.parse(text) as { status: string; detail?: string })
    },
  }
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

describe('register', () => {
  test('session.start で mod.json に sessionId と claude の pid を書く', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    expect(JSON.parse(w.files.get(`${DIR}/mod.json`) ?? '{}')).toEqual({
      v: 1,
      sessionId: SESSION_ID,
      pid: 4242,
      modVersion: '0.1.0',
      startedAt: Date.UTC(2026, 8, 27, 12, 0, 0),
    })
  })

  test('sh が無い Windows では USERPROFILE の下に pid 0 の mod.json を書く', async ($, on) => {
    const w = world(on, { windows: true })
    await $.session.start(START)

    const mod = JSON.parse(w.files.get(`${DIR}/mod.json`) ?? '{}')
    expect(mod.pid).toBe(0)
    expect(mod.sessionId).toBe(SESSION_ID)
  })

  test('idle のときの prompt は $.prompt.submit で届け、submitted の ack を書く', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    w.post(inboxPrompt)
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.submitted.map(s => s.text)).toEqual([inboxPrompt.text])
    expect(w.ack(inboxPrompt.id)?.status).toBe('submitted')

    await w.clock.advance(500)
    expect(w.submitted, '同じメッセージを 2 回は届けない').toHaveLength(1)
  })

  test('turn の実行中の prompt は先に queued を書き、turn が始まったら submitted に書き換える', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: '作業', turnId: 't1' })
    w.hold()
    w.post(inboxPrompt)
    await w.clock.advance(500)

    expect(w.ack(inboxPrompt.id)?.status).toBe('queued')
    expect(w.submitted).toHaveLength(1)

    w.release()
    await w.clock.settle()
    expect(w.ack(inboxPrompt.id)?.status).toBe('submitted')
  })

  test('interrupt は実行中の main の turn を止めて aborted、turn が無ければ no_turn', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: '作業', turnId: 't1' })
    w.post(inboxInterrupt)
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.aborted).toEqual(['t1'])
    expect(w.ack(inboxInterrupt.id)?.status).toBe('aborted')

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
    const second = { ...inboxInterrupt, id: '1790498064999-99999999' }
    w.post(second)
    await w.clock.advance(500)
    await w.clock.settle()
    expect(w.aborted, 'turn が無いので止めない').toEqual(['t1'])
    expect(w.ack(second.id)?.status).toBe('no_turn')
  })

  test('ack が既にあるメッセージは届けず、読めないメッセージには error の ack を書く', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    w.post(inboxPrompt)
    w.files.set(`${DIR}/acks/${inboxPrompt.id}.json`, JSON.stringify({ v: 1, id: inboxPrompt.id, status: 'submitted', at: 1 }))
    w.files.set(`${DIR}/inbox/1790498070000-bad.json`, '{')
    await w.clock.advance(500)
    await w.clock.settle()

    expect(w.submitted).toEqual([])
    expect(w.ack('1790498070000-bad')?.status).toBe('error')
  })
})
