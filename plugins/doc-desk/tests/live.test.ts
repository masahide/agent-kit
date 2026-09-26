import type { TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import { afterContextOf, commentLinesOf, stopPromptOf } from '../hooks/live/comments'
import { isLiveViewEnabled } from '../hooks/live/controller'
import { liveCommentOf, parseLiveReply, validateLive, type LiveComment } from '../hooks/live/live-v1'
import { FULL_LIVE_TOOL_NAME, FULL_REVIEW_TOOL_NAME, FULL_TOOL_NAME, PANE_ID, PLUGIN_NAME } from '../hooks/names'
import { parseReviewAnswer } from '../hooks/review/answer'
import { formatReviewReply, LIVE_MARK } from '../hooks/review/format'
import { renderLiveHtml } from '../hooks/sheet/render-live'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'
import type { LiveCall, LiveReply } from './fixtures'

tier('user')

const LIVE = { documentId: 'spec-auth-01', label: 'spec-auth-01-live', source: 'docs/spec-auth.md', title: '認証方式の仕様' }
const SOURCE_PATH = '/work/docs/spec-auth.md'
const LIVE_JSON = '/work/doc-desk/spec-auth-01-live.json'
const LIVE_HTML = '/work/doc-desk/spec-auth-01-live.html'
const LIVE_COMMENTS = '/work/doc-desk/spec-auth-01-live.comments.json'
const REVIEW_HTML = '/work/doc-desk/spec-auth-01-review.html'

const AFTER: LiveComment = { id: 'c1', quote: 'セッションは 30 日', text: '90 日を選んだはず', mode: 'after', at: 10 }
const NOW: LiveComment = { id: 'c2', quote: '', text: '導入が長い', mode: 'now', at: 12 }

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 }

const result = (e: TurnStepInput): TurnStepResult => ({
  turnId: e.turnId,
  index: e.index,
  answer: '',
  toolUses: [],
  stopReason: 'tool_use',
  usage: null,
})

/**
 * 受信サーバが指摘を 1 回だけ渡す答え (渡した後は空)。`stop` は同じ回に 1 回だけ立てる。
 */
function handOnce(comments: LiveComment[], stop = false): (call: LiveCall) => LiveReply {
  let isHanded = false
  return call => {
    if (isHanded || call.path !== '/document') {
      return {}
    }
    isHanded = true
    return { comments, stop }
  }
}

/**
 * `$.turn.step` の stream を最後まで読み、チャンクと下の結果 (return の値) を返します。
 */
async function readStep(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>) {
  const chunks: TurnStepChunk[] = []
  for (let step = await stream.next(); ; step = await stream.next()) {
    if (step.done) {
      return { chunks, result: step.value }
    }
    chunks.push(step.value)
  }
}

/** 送った `/document` の本文だけ */
const documents = (posts: readonly LiveCall[]) => posts.filter(post => post.path === '/document').map(post => post.body)

/** fire-and-forget の送信を片付ける */
async function drain(world: ReturnType<typeof Fixtures.world>) {
  for (let round = 0; round < 5; round += 1) {
    await world.clock.settle()
  }
}

describe('ライブ表示', () => {
  test('validateLive: 欄の誤りを全部返し、受信サーバから来た指摘は形を検査する', () => {
    expect(validateLive(LIVE)).toEqual({ ok: true, live: LIVE })
    const bad = validateLive({ documentId: 'a b', label: '', source: '', title: ' ' })
    expect(bad.ok).toBe(false)
    expect(bad.ok ? [] : bad.errors).toHaveLength(4)
    expect(validateLive('x')).toEqual({ ok: false, errors: ['live: オブジェクトにしてください'] })

    expect(liveCommentOf({ id: 'c1', quote: 'q', text: 't', mode: 'after', at: 3 })).toEqual({
      id: 'c1',
      quote: 'q',
      text: 't',
      mode: 'after',
      at: 3,
    })
    expect(liveCommentOf({ id: 'c1', text: 't', mode: 'later' }), 'mode が違う').toBeNull()
    expect(liveCommentOf({ id: 'c1', text: '  ', mode: 'now' }), 'コメントが空').toBeNull()
    expect(liveCommentOf({ id: '', text: 't', mode: 'now' }), 'id が空').toBeNull()
    expect(parseLiveReply('{"comments":[{"id":"c1","text":"t","mode":"now"},{"x":1}],"stop":true}')).toEqual({
      comments: [{ id: 'c1', quote: '', text: 't', mode: 'now', at: 0 }],
      stop: true,
    })
    expect(parseLiveReply('not json')).toEqual({ comments: [], stop: false })
  })

  test('comments: context と prompt の文 (引用あり / 無し、複数件、引用に改行と " を含む)', () => {
    const tricky: LiveComment = { id: 'c3', quote: '一行目\n  "二行目"', text: '言い換える\n丁寧に', mode: 'after', at: 0 }
    expect(commentLinesOf([AFTER, NOW, tricky])).toEqual([
      '1. 引用: 「セッションは 30 日」 / 指摘: 90 日を選んだはず',
      '2. 引用: (無し) / 指摘: 導入が長い',
      '3. 引用: 「一行目 "二行目"」 / 指摘: 言い換える 丁寧に',
    ])
    expect(afterContextOf([AFTER, NOW])).toBe(
      [
        '【doc-desk ライブ指摘】人がライブ表示で、書いている途中の文書に次の指摘を付けました。',
        '先へ進む前に反映してください (該当箇所は「引用」で探し、Edit で直します)。',
        '1. 引用: 「セッションは 30 日」 / 指摘: 90 日を選んだはず',
        '2. 引用: (無し) / 指摘: 導入が長い',
      ].join('\n'),
    )
    expect(stopPromptOf('docs/spec-auth.md', [AFTER])).toBe(
      [
        '【doc-desk ライブ指摘】文書 docs/spec-auth.md を書いている途中で、人がライブ表示で次の指摘を付けたので中断しました。',
        '指摘を反映して書き直してください。書き終わったら今までどおり指摘の画面 (open_review) に進みます。',
        '1. 引用: 「セッションは 30 日」 / 指摘: 90 日を選んだはず',
      ].join('\n'),
    )
  })

  test('renderLiveHtml: token を埋めず、innerHTML を使わず、題名と source を逃がして出す', () => {
    const html = renderLiveHtml({ live: { ...LIVE, title: '<b>題名</b>' }, date: '2026-09-26' })
    expect(html).toContain('<!-- doc-desk-format: live-v1 -->')
    expect(html).toContain('&lt;b&gt;題名&lt;/b&gt;')
    expect(html).toContain("new EventSource('/events' + query)")
    expect(html).not.toContain('innerHTML')
    expect(html).toContain('書き終わったら直す')
    expect(html).toContain('今すぐ止めて直す')
  })

  test('open_live: 証跡と HTML を書き、--live の受信サーバを起動し、opened と context を返す', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)

    const answered = await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE })
    await drain(world)
    const parsed = JSON.parse(answered.result as string)

    expect(parsed).toEqual({
      status: 'opened',
      documentId: 'spec-auth-01',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:47321\/\?t=[0-9a-f]+$/),
      files: { live: LIVE_JSON, html: LIVE_HTML },
    })
    expect(answered.context).toEqual([STRINGS.liveOpenedContext])
    expect(JSON.parse(world.files.get(LIVE_JSON) ?? '')).toEqual(LIVE)
    expect(world.files.get(LIVE_HTML)).toContain('doc-desk-format: live-v1')

    const argv = world.receiverRuns()[0] ?? []
    expect(argv.slice(2, 5)).toEqual(['start', '--live', '--token'])
    expect(argv, '回答を受けないので --out は無い').not.toContain('--out')
    expect(argv.slice(argv.indexOf('--html'), argv.indexOf('--html') + 2)).toEqual(['--html', LIVE_HTML])
    expect(world.receiverCommandRuns('open'), 'ブラウザを開く').toHaveLength(1)
    expect(world.opened.map(pane => pane.id)).toEqual([PANE_ID])
    expect(documents(world.livePosts)).toEqual([{ kind: 'status', text: STRINGS.liveWaiting, phase: 'waiting', seq: 0 }])
  })

  test('open_live: 欄の誤りは invalid、回答待ちの画面があれば invalid で、受信サーバを起動しない', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)

    const bad = JSON.parse((await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: { ...LIVE, source: '' } })).result as string)
    expect(bad.status).toBe('invalid')
    expect(bad.errors[0]).toContain('source')

    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()
    const runs = world.receiverRuns().length
    const busy = JSON.parse((await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE })).result as string)
    expect(busy).toEqual({ status: 'invalid', errors: [STRINGS.livePendingExists] })
    expect(world.receiverRuns()).toHaveLength(runs)
  })

  test('turn.step: source への Write の文を改行ごとに append で流し、チャンクは変えず、別ファイルの Write は流さない', async ($, on) => {
    const world = Fixtures.world(on)
    const content = '# 認証\n\n認証は "OIDC" に統一します。\n既存ユーザーは移行します。'
    const json = JSON.stringify({ file_path: SOURCE_PATH, content })
    const other = JSON.stringify({ file_path: '/work/notes.md', content: 'メモ\nです\n' })
    const chunks: TurnStepChunk[] = [
      { kind: 'text', index: 0, text: '書きます' },
      { kind: 'tool', index: 1, id: 'toolu_1', name: 'Write' },
      ...Array.from({ length: Math.ceil(json.length / 7) }, (_, n) => ({ kind: 'input' as const, index: 1, json: json.slice(n * 7, n * 7 + 7) })),
      { kind: 'tool', index: 2, id: 'toolu_2', name: 'Write' },
      { kind: 'input', index: 2, json: other },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ]
    on('turn.step', async function* ($, e) {
      for (const chunk of chunks) {
        yield chunk
      }
      return result(e)
    })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)
    world.livePosts.length = 0

    const { chunks: seen, result: stepResult } = await readStep($.turn.step(STEP))
    expect(stepResult, '下の結果をそのまま返す').toEqual(result(STEP))
    await drain(world)

    expect(seen, 'チャンクは下から来たまま').toEqual(chunks)
    const posts = documents(world.livePosts)
    expect(posts.filter(post => post.kind === 'status' && post.text !== undefined).map(post => post.text)).toEqual([STRINGS.liveWriting])
    const texts = posts.filter(post => post.kind !== 'status')
    expect(texts[0]).toEqual({ kind: 'replace', text: '', seq: 1 })
    expect(texts.slice(1).every(post => post.kind === 'append')).toBe(true)
    expect(texts.map(post => post.seq), '通し番号は 1 ずつ').toEqual(texts.map((_, n) => n + 1))
    expect(texts.slice(1).map(post => post.text).join('')).toBe(content)
    expect(
      texts.slice(1, -1).every(post => String(post.text).endsWith('\n')),
      '最後の 1 回 (stop で流す残り) を除き、改行が来たときに送る',
    ).toBe(true)
    expect(JSON.stringify(posts), '別ファイルの文は流さない').not.toContain('メモ')
    expect(posts.some(post => post.kind === 'status' && post.text === undefined), 'tool と stop で指摘を取りに行く').toBe(true)
  })

  test('turn.step: ライブ表示が開いていなければ何も送らない', async ($, on) => {
    const world = Fixtures.world(on)
    on('turn.step', async function* ($, e) {
      yield { kind: 'tool', index: 0, id: 'toolu_1', name: 'Write' }
      yield { kind: 'input', index: 0, json: JSON.stringify({ file_path: SOURCE_PATH, content: 'x\n' }) }
      return result(e)
    })
    await $.session.start(Fixtures.SESSION)
    expect((await readStep($.turn.step(STEP))).result).toEqual(result(STEP))
    await drain(world)
    expect(world.livePosts).toEqual([])
  })

  test('Write と Edit の完了後に全文を replace で送り、[書き終わったら直す] の指摘を context で 1 回だけ届ける', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([AFTER]) })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    const other = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'メモ', tool_use_id: 'toolu_0' })
    expect(other.context, '別ファイルの Write には付けない').toBeUndefined()

    const first = await $.tool.call({ tool: 'Write', file_path: 'docs/spec-auth.md', content: 'セッションは 30 日', tool_use_id: 'toolu_1' })
    expect(first.context).toEqual([afterContextOf([AFTER])])
    await drain(world)
    const posts = documents(world.livePosts)
    expect(posts).toContainEqual({ kind: 'replace', text: 'セッションは 30 日', seq: 1 })
    expect(posts).toContainEqual({ kind: 'status', delivered: ['c1'], seq: 1 })
    const records = JSON.parse(world.files.get(LIVE_COMMENTS) ?? '[]')
    expect(records).toEqual([{ ...AFTER, how: 'context', handledAt: expect.any(String) }])

    const second = await $.tool.call({
      tool: 'Edit',
      file_path: SOURCE_PATH,
      old_string: '30',
      new_string: '90',
      tool_use_id: 'toolu_2',
    })
    expect(second.context, '届けた指摘は 2 回届けない').toBeUndefined()
    expect(documents(world.livePosts)).toContainEqual({ kind: 'replace', text: 'セッションは 90 日', seq: 2 })
  })

  test('[今すぐ止めて直す]: turn.start の turnId で turn.abort を 1 回呼び、指摘入りの prompt を 1 回投入する', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([AFTER, NOW], true) })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    expect(world.aborted).toEqual(['t1'])
    expect(world.submitted.map(submit => submit.text)).toEqual([stopPromptOf('docs/spec-auth.md', [AFTER, NOW])])
    expect(documents(world.livePosts)).toContainEqual({ kind: 'status', text: STRINGS.liveStopped, phase: 'stopped', stopped: ['c1', 'c2'], seq: 0 })
    const records = JSON.parse(world.files.get(LIVE_COMMENTS) ?? '[]')
    expect(records.map((record: { how: string }) => record.how)).toEqual(['prompt', 'prompt'])

    const next = await $.tool.call({ tool: 'Write', file_path: SOURCE_PATH, content: 'x', tool_use_id: 'toolu_1' })
    expect(next.context, '止めて届けた指摘は context で繰り返さない').toBeUndefined()
  })

  test('[今すぐ止めて直す] が Write の完了時に届いたら、止めずにその Write の context で届ける (tool.call の中では投入できない)', async ($, on) => {
    let isArmed = false
    const world = Fixtures.world(on, {
      liveReply: call => (isArmed && call.path === '/document' && call.body.kind === 'replace' ? ((isArmed = false), { comments: [NOW], stop: true }) : {}),
    })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    isArmed = true
    const written = await $.tool.call({ tool: 'Write', file_path: SOURCE_PATH, content: 'x', tool_use_id: 'toolu_1' })
    await drain(world)

    expect(written.context).toEqual([afterContextOf([NOW])])
    expect(world.aborted, 'turn は止めない').toEqual([])
    expect(world.submitted, '投入もしない').toEqual([])
  })

  test('止める指摘が 1 件も無ければ、stop の印が来ても turn を止めない', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([], true) })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    expect(world.aborted).toEqual([])
    expect(world.submitted).toEqual([])
  })

  test('止めずに残った [今すぐ止めて直す] の指摘も、次の Write の後に context で届く', async ($, on) => {
    // 受信サーバが stop の印を別の応答で返し済みで、指摘だけが後の応答に載ったとき
    const world = Fixtures.world(on, { liveReply: handOnce([NOW], false) })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    const written = await $.tool.call({ tool: 'Write', file_path: SOURCE_PATH, content: 'x', tool_use_id: 'toolu_1' })
    expect(written.context).toEqual([afterContextOf([NOW])])
  })

  test('止めた turn の turn.complete (aborted) は「止めて書き直しを頼みました」を上書きしない', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([NOW], true) })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)
    expect(world.aborted).toEqual(['t1'])

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
    await drain(world)
    expect(documents(world.livePosts).some(post => post.phase === 'aborted')).toBe(false)
  })

  test('開いている間は 60 秒ごとに受信サーバへ /wait を投げ、生きていることを知らせる', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)
    const waits = () => world.fetched.filter(call => call.url.includes('/wait?')).length

    await world.clock.advance(55000)
    expect(waits()).toBe(0)
    await world.clock.advance(5000)
    expect(waits()).toBe(1)
    await world.clock.advance(60000)
    expect(waits()).toBe(2)

    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    const before = waits()
    await world.clock.advance(120000)
    expect(
      world.fetched.slice(before).filter(call => call.url.includes('/wait?') && call.timeoutSeconds === 0).length,
      '閉じた後は知らせない',
    ).toBe(0)
  })

  test('open_review で指摘の画面の受信サーバが起動しなければ、ライブ表示の受信サーバを閉じ、候補は HTML に残す', async ($, on) => {
    const world = Fixtures.world(on, {
      receiverStartsUp: 1,
      liveReply: call => (call.path === '/finish' ? { comments: [AFTER] } : {}),
    })
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, waitSeconds: 0, selfReview: false })
    expect(JSON.parse(answered.result as string).status).toBe('failed')
    expect(
      world.livePosts.filter(post => post.path === '/finish').map(post => post.body),
      '2 段目 (url) は送らず、close で閉じる',
    ).toEqual([{}, { close: true }])
    expect(world.receiverCommandRuns('stop'), 'close が届いたので pid では止めない').toEqual([])
    expect(world.files.get(REVIEW_HTML)).toContain('"source":"live"')
  })

  test('[今すぐ止めて直す]: turnId が分からなければ止めず、次の Write の後に届ける', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([NOW], true) })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    expect(world.aborted).toEqual([])
    expect(world.submitted).toEqual([])
    expect(world.logged).toContain(STRINGS.liveNoTurnToStop)
    const next = await $.tool.call({ tool: 'Write', file_path: SOURCE_PATH, content: 'x', tool_use_id: 'toolu_1' })
    expect(next.context).toEqual([afterContextOf([{ ...NOW, mode: 'after' }])])
  })

  test('turn.complete: 書き終わりましたを流し、まだ届けていない指摘の件数を出す。中断なら中断しましたを流す', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: handOnce([AFTER]) })
    await $.session.start(Fixtures.SESSION)
    await $.turn.start({ text: '書いて', turnId: 't1' })
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    await $.turn.complete({ answer: '書きました', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await drain(world)
    expect(documents(world.livePosts)).toContainEqual({ kind: 'status', text: STRINGS.liveDone, phase: 'done', seq: 0 })
    expect(world.logged).toContain(STRINGS.liveUndeliveredOf(1))

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
    await drain(world)
    expect(documents(world.livePosts)).toContainEqual({ kind: 'status', text: STRINGS.liveAborted, phase: 'aborted', seq: 0 })
  })

  test('open_review (同じ documentId): /finish を 2 段で送り、未届の指摘を候補に埋め、ブラウザは開き直さない', async ($, on) => {
    const untaken: LiveComment = { id: 'c9', quote: 'OIDC に統一', text: '理由を足す', mode: 'after', at: 20 }
    const world = Fixtures.world(on, {
      liveReply: call => (call.path === '/finish' && !('url' in call.body) ? { comments: [untaken] } : {}),
    })
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, waitSeconds: 0, selfReview: false })
    await drain(world)
    const parsed = JSON.parse(answered.result as string)
    expect(parsed.status).toBe('pending')

    const finishes = world.livePosts.filter(post => post.path === '/finish').map(post => post.body)
    expect(finishes).toEqual([{}, { url: parsed.url }])
    expect(world.receiverCommandRuns('open'), 'タブが移るのでブラウザは開かない').toEqual([])
    expect(world.receiverCommandRuns('stop'), 'ライブ表示の受信サーバは自分で終わる').toEqual([])
    const embedded = /<script type="application\/json" id="di-review">([\s\S]*?)<\/script>/.exec(world.files.get(REVIEW_HTML) ?? '')?.[1]
    expect(JSON.parse(embedded ?? '{}').candidates).toEqual([
      { block: 0, chip: '', quote: 'OIDC に統一', text: '理由を足す', source: 'live' },
    ])
    const records = JSON.parse(world.files.get(LIVE_COMMENTS) ?? '[]')
    expect(records.map((record: { id: string; how: string }) => [record.id, record.how])).toEqual([['c9', 'review']])

    expect(await $.command.run(Fixtures.DESK_COMMAND), 'ライブ表示は閉じ、指摘の画面を開き直す').toEqual({
      text: STRINGS.reopenedOf(parsed.url),
    })
  })

  test('open_review (別の documentId) と open_form はライブ表示を close で閉じ、タブは移さない', async ($, on) => {
    const world = Fixtures.world(on)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: { ...LIVE, documentId: 'other' }, openBrowser: false })
    await drain(world)

    await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, waitSeconds: 0, selfReview: false, openBrowser: false })
    expect(world.livePosts.filter(post => post.path === '/finish').map(post => post.body)).toEqual([{ close: true }])
    expect(world.receiverCommandRuns('stop')).toEqual([])

    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    expect(world.receiverCommandRuns('stop'), 'ライブ表示はもう無いので、止めるのは指摘の画面だけ').toHaveLength(1)
    expect(world.livePosts.filter(post => post.path === '/finish')).toHaveLength(1)
  })

  test('/doc-desk-resume で開き直し、ペインの [取り消す] で受信サーバを閉じる。session.end は状態を投げるだけ', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    const reopened = await $.command.run(Fixtures.DESK_COMMAND)
    expect(reopened.text).toMatch(/^ライブ表示のペインとブラウザを開き直しました: http:\/\/127\.0\.0\.1:47321\//)
    expect(world.receiverCommandRuns('open')).toHaveLength(1)

    await $.session.end({ reason: 'other', sessionId: 'session-now' } as never)
    await drain(world)
    expect(documents(world.livePosts)).toContainEqual({ kind: 'status', text: STRINGS.liveSessionEnded, phase: 'ended', seq: 0 })
    expect(world.receiverCommandRuns('stop'), 'セッションの終わりでは止めない').toEqual([])

    const ui = await $.ui.mount({
      plugin: PLUGIN_NAME,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE_ID,
      props: Fixtures.PANE.props,
    })
    expect(await ui.findAll({ text: /ライブ表示: spec-auth-01-live/ })).not.toEqual([])
    await ui.press({ key: 'cancel' })
    await drain(world)
    await ui.unmount()
    expect(world.livePosts.filter(post => post.path === '/finish').map(post => post.body)).toEqual([{ close: true }])
    expect(world.logged).toContain(STRINGS.liveCancelled)
    expect(await $.command.run(Fixtures.DESK_COMMAND)).toEqual({ text: STRINGS.nothingPending })
  })

  test('指摘の画面で採用したライブ指摘は (ライブ指摘) の印付きで届く', () => {
    const answer = parseReviewAnswer(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'review',
        documentId: 'spec-auth-01',
        revision: 1,
        comments: [{ block: 2, chip: null, quote: 'OIDC に統一', text: '理由を足す', source: 'live' }],
        edits: [],
        blocks: { '2': '認証は OIDC に統一します。' },
      }),
      Fixtures.REVIEW,
    )
    expect(answer?.comments[0]?.source).toBe('live')
    expect(formatReviewReply(Fixtures.REVIEW, answer!)).toContain(`#2 「OIDC に統一」 理由を足す ${LIVE_MARK}`)
  })

  test('閉じる印 (close) が受信サーバに届かなければ、pid で止める', async ($, on) => {
    const world = Fixtures.world(on, { liveReply: call => (call.body.close === true ? 'error' : {}) })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    await $.tool.call({ tool: FULL_TOOL_NAME, form: Fixtures.FORM, openBrowser: false, waitSeconds: 0 })
    expect(world.receiverCommandRuns('stop')).toHaveLength(1)
  })

  test('keepalive が 3 回続けて届かなければ、受信サーバには触らずにライブ表示を手放して伝える', async ($, on) => {
    let isDown = false
    const world = Fixtures.world(on, { waitReply: () => (isDown ? 'error' : { answered: false }) })
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)

    isDown = true
    await world.clock.advance(120000)
    await drain(world)
    expect(world.logged, '2 回ではまだ手放さない').not.toContain(STRINGS.liveReceiverGone)
    isDown = false
    await world.clock.advance(60000)
    await drain(world)
    isDown = true
    await world.clock.advance(120000)
    await drain(world)
    expect(world.logged, '成功をはさむと数え直す').not.toContain(STRINGS.liveReceiverGone)

    await world.clock.advance(60000)
    await drain(world)
    expect(world.logged).toContain(STRINGS.liveReceiverGone)
    expect(world.receiverCommandRuns('stop'), '死んだ受信サーバの pid は使い回されているかもしれないので止めない').toEqual([])
    expect(world.livePosts.filter(post => post.path === '/finish'), 'close も送らない').toEqual([])
    expect(await $.command.run(Fixtures.DESK_COMMAND), '死んだ URL は開かない').toEqual({ text: STRINGS.nothingPending })
  })

  test('open_live は証跡の指摘を空から始め、Write の後の replace は末尾 10 万文字に切る', async ($, on) => {
    const world = Fixtures.world(on)
    world.files.set(LIVE_COMMENTS, '[{"id":"old"}]')
    await $.session.start(Fixtures.SESSION)
    await $.tool.call({ tool: FULL_LIVE_TOOL_NAME, live: LIVE, openBrowser: false })
    await drain(world)
    expect(world.files.get(LIVE_COMMENTS)).toBe('[]\n')

    const long = `${'a'.repeat(5)}${'b'.repeat(100000)}`
    await $.tool.call({ tool: 'Write', file_path: SOURCE_PATH, content: long, tool_use_id: 'toolu_1' })
    const replaced = documents(world.livePosts).find(post => post.kind === 'replace')
    expect(String(replaced?.text)).toBe('b'.repeat(100000))
  })

  test('isLiveViewEnabled: 設定の liveView が false のときだけ開かない', () => {
    expect(isLiveViewEnabled({})).toBe(true)
    expect(isLiveViewEnabled({ liveView: true })).toBe(true)
    expect(isLiveViewEnabled({ liveView: false })).toBe(false)
  })
})
