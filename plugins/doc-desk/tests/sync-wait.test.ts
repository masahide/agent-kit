import type { HttpResponse } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import { parseAnswer } from '../hooks/form/answer'
import type { AnswerV1 } from '../hooks/form/form-v1'
import { clampWaitSeconds, waitForAnswer, type WaitDeps, type WaitTarget } from '../hooks/wait/sync-wait'
import Fixtures from './fixtures'

tier('user')

const ANSWER_PATH = '/work/doc-desk/spec-auth-01.answer.json'
const TARGET: WaitTarget<AnswerV1> = {
  read: text => parseAnswer(text, Fixtures.FORM),
  answerPath: ANSWER_PATH, port: 47321, token: 'tk' }

const ok = (text: string): HttpResponse => ({ status: 200, ok: true, headers: {}, text })

/**
 * ファイルは Map、`/wait` は台本で答える最小の Host。
 */
function deps(files: Map<string, string>, onWait: (url: string, count: number) => Promise<HttpResponse>) {
  const urls: string[] = []
  const host: WaitDeps = {
    exists: async path => files.has(path),
    readFile: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    fetch: url => {
      urls.push(url)
      return onWait(url, urls.length)
    },
  }
  return { host, urls }
}

describe('sync-wait', () => {
  test('clampWaitSeconds: 既定 300、0〜1800 に丸め、数でなければ既定', async () => {
    expect(clampWaitSeconds(undefined)).toBe(300)
    expect(clampWaitSeconds('10')).toBe(300)
    expect(clampWaitSeconds(Number.NaN)).toBe(300)
    expect(clampWaitSeconds(0)).toBe(0)
    expect(clampWaitSeconds(-5)).toBe(0)
    expect(clampWaitSeconds(12.9)).toBe(12)
    expect(clampWaitSeconds(99999)).toBe(1800)
  })

  test('next.signal が abort すると次の周回で pending (abort) を返し、/wait を呼び直さない', async () => {
    const files = new Map<string, string>()
    const controller = new AbortController()
    const { host, urls } = deps(files, async () => {
      // 保留中に人が Esc を押した (fetch 自体は timeout まで戻らない)
      controller.abort()
      return ok('{"answered":false}')
    })

    const end = await waitForAnswer(host, TARGET, {
      waitSeconds: 300,
      signal: controller.signal,
      isStillPending: () => true,
    })

    expect(end).toEqual({ kind: 'pending', endedBy: 'abort', waitedSeconds: 4 })
    expect(urls).toEqual(['http://127.0.0.1:47321/wait?t=tk&timeout=4'])
  })

  test('/wait が失敗しても、回答ファイルが書けていれば answered', async () => {
    const files = new Map<string, string>()
    const { host } = deps(files, async () => {
      // 受信サーバは回答を書いて終了し、fetch は接続を失った
      files.set(ANSWER_PATH, JSON.stringify(Fixtures.ANSWER_BARE))
      throw new Error('ECONNRESET')
    })

    const end = await waitForAnswer(host, TARGET, {
      waitSeconds: 300,
      signal: new AbortController().signal,
      isStillPending: () => true,
    })

    expect(end).toEqual({ kind: 'answered', answer: Fixtures.ANSWER_BARE })
  })

  test('/wait が answered:true なのに一致する回答が無ければ空回りせず打ち切る', async () => {
    const files = new Map<string, string>()
    files.set(ANSWER_PATH, JSON.stringify({ ...Fixtures.ANSWER_BARE, revision: 9 }))
    const { host, urls } = deps(files, async () => ok('{"answered":true}'))

    const end = await waitForAnswer(host, TARGET, {
      waitSeconds: 300,
      signal: new AbortController().signal,
      isStillPending: () => true,
    })

    expect(end).toEqual({ kind: 'pending', endedBy: 'receiverLost', waitedSeconds: 4 })
    expect(urls).toHaveLength(1)
  })

  test('待機が差し替わると dropped', async () => {
    const files = new Map<string, string>()
    let isStillPending = true
    const { host } = deps(files, async () => {
      isStillPending = false
      return ok('{"answered":false}')
    })

    const end = await waitForAnswer(host, TARGET, {
      waitSeconds: 300,
      signal: new AbortController().signal,
      isStillPending: () => isStillPending,
    })

    expect(end).toEqual({ kind: 'dropped' })
  })
})
