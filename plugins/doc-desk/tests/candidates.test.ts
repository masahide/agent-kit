import { describe, expect, test, tier } from 'claude-code/testing'

import { FULL_REVIEW_TOOL_NAME } from '../hooks/names'
import { candidatePrompt, MAX_CANDIDATES, parseCandidates, wantsSelfReview } from '../hooks/review/candidates'
import { numberedBlocks } from '../hooks/review/document'
import { parseReviewAnswer } from '../hooks/review/answer'
import { CANDIDATE_MARK, formatReviewReply } from '../hooks/review/format'
import { STRINGS } from '../hooks/views/strings'
import Fixtures from './fixtures'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

tier('user')

const CANDIDATES_PATH = '/work/doc-desk/spec-auth-01-review.candidates.json'
const HTML_PATH = '/work/doc-desk/spec-auth-01-review.html'
const REVIEW_ANSWER_PATH = '/work/doc-desk/spec-auth-01-review.answer.json'

const THREE = [
  { block: 2, chip: '根拠が要る', quote: 'OIDC に統一', text: 'なぜ OIDC かを足す' },
  { block: 3, chip: '短くする', quote: '', text: '1 文にまとめる' },
  { block: 1, chip: '言い換える', quote: '', text: '見出しを名詞句にする' },
]

const embeddedOf = (html: string) => {
  const json = /<script type="application\/json" id="di-review">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}'
  return JSON.parse(json) as { candidates?: unknown }
}

describe('自己指摘の候補', () => {
  test('numberedBlocks: fixture の文書に画面と同じ番号を振る', () => {
    expect(numberedBlocks(Fixtures.DOC_HTML)).toEqual([
      { n: 1, text: '認証方式' },
      { n: 2, text: '認証は OIDC に統一します。' },
      { n: 3, text: '既存ユーザーは初回ログイン時に移行します。' },
      { n: 4, text: '画面 | 認証' },
      { n: 5, text: '設定 | 必要' },
    ])
  })

  test('numberedBlocks: 暗黙の閉じ、入れ子の箇条、pre、文字参照、自分の文字を持たない段落', () => {
    const html = [
      '<p>一つ目<p>二つ目 &amp; <code>x</code><br>続き',
      '<ul><li>親<ul><li>子 1<li>子 2</ul><li><ul><li>孫だけ</ul></ul>',
      '<pre>\nline1\n  line2</pre>',
      '<dl><dt>語<dd>定義</dl>',
      '<blockquote><p>引用</p></blockquote>',
      '<p>  </p><h3><span>見出し</span></h3>',
    ].join('\n')
    expect(numberedBlocks(html).map(block => block.text)).toEqual([
      '一つ目',
      '二つ目 & x 続き',
      '親',
      '子 1',
      '子 2',
      '孫だけ',
      'line1\n  line2',
      '語',
      '定義',
      '引用',
      '見出し',
    ])
  })

  test('numberedBlocks: 範囲外の数値文字参照で落ちず、よく使う名前付き文字参照を復号する', () => {
    expect(numberedBlocks('<p>a&#1114112;b&#0;c&#xD800;d</p>').map(block => block.text)).toEqual(['a\ufffdb\ufffdc\ufffdd'])
    expect(numberedBlocks('<p>A&mdash;B&hellip;&rarr;&copy;&unknown;</p>').map(block => block.text)).toEqual([
      'A\u2014B\u2026\u2192\u00a9&unknown;',
    ])
  })

  test('candidatePrompt: 段落番号付きの一覧とチップと出力の形を渡す', () => {
    const prompt = candidatePrompt(numberedBlocks(Fixtures.DOC_HTML), '認証方式の仕様')
    expect(prompt).toContain('「認証方式の仕様」')
    expect(prompt).toContain('#1 認証方式\n#2 認証は OIDC に統一します。')
    expect(prompt).toContain('根拠が要る')
    expect(prompt).not.toContain('ここは良い')
    expect(prompt).toContain(`最大 ${MAX_CANDIDATES} 件`)
  })

  test('parseCandidates: 範囲外の段落、知らないチップ、長すぎる文、空の文を捨て、最大 5 件', () => {
    const reply = [
      '候補です。',
      '```json',
      JSON.stringify([
        ...THREE,
        { block: 9, chip: '削る', quote: '', text: '範囲外' },
        { block: 1, chip: '雰囲気', quote: '', text: '知らないチップ' },
        { block: 1, chip: '削る', quote: '', text: 'x'.repeat(201) },
        { block: 1, chip: '削る', quote: '', text: '  ' },
        { block: 1, chip: '削る', text: 'quote なし' },
        { block: 2, chip: '削る', quote: '', text: '5 件目' },
        { block: 3, chip: '削る', quote: '', text: '6 件目は入らない' },
      ]),
      '```',
    ].join('\n')
    const candidates = parseCandidates(reply, 5)
    expect(candidates).toHaveLength(5)
    expect(candidates.slice(0, 3)).toEqual(THREE)
    expect(candidates[3]).toEqual({ block: 1, chip: '削る', quote: '', text: 'quote なし' })
    expect(candidates[4]?.text).toBe('5 件目')

    expect(parseCandidates('直すところはありません', 5)).toEqual([])
    expect(
      parseCandidates(`検査 [S3, S15] に当たる段落です。\n${JSON.stringify(THREE)}`, 5),
      '前置きに括弧があっても本体の配列を拾う',
    ).toEqual(THREE)
    expect(
      parseCandidates(`例: [1] と [2]\n\`\`\`json\n${JSON.stringify(THREE.slice(0, 1))}\n\`\`\`\n補足 [x]`, 5),
      'コードフェンスの中を先に読む',
    ).toEqual(THREE.slice(0, 1))
    expect(parseCandidates('[{"block": 1', 5)).toEqual([])
    expect(parseCandidates('[]', 5)).toEqual([])
  })

  test('wantsSelfReview: plugin の設定かツールの入力のどちらかが false なら作らない', () => {
    expect(wantsSelfReview({}, undefined)).toBe(true)
    expect(wantsSelfReview({ selfReview: true }, true)).toBe(true)
    expect(wantsSelfReview({ selfReview: false }, undefined)).toBe(false)
    expect(wantsSelfReview({}, false)).toBe(false)
  })

  test('fork が候補 3 件を返すと、画面に埋め、.candidates.json を書く', async ($, on) => {
    const world = Fixtures.world(on, {
      forkReply: {
        isAnswered: true,
        text: JSON.stringify(THREE),
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(JSON.parse(answered.result as string).status).toBe('pending')
    expect(world.forkPrompts).toHaveLength(1)
    expect(world.forkPrompts[0]).toContain('#5 設定 | 必要')
    expect(JSON.parse(world.files.get(CANDIDATES_PATH) ?? '')).toEqual(THREE)
    expect(embeddedOf(world.files.get(HTML_PATH) ?? '').candidates).toEqual(THREE)
  })

  test('fork が答えなくても (nothing-to-fork) 候補なしで pending を返す', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 0 })
    await world.clock.settle()

    expect(JSON.parse(answered.result as string).status).toBe('pending')
    expect(world.forkPrompts).toHaveLength(1)
    expect(JSON.parse(world.files.get(CANDIDATES_PATH) ?? '')).toEqual([])
    expect(embeddedOf(world.files.get(HTML_PATH) ?? '').candidates).toEqual([])
  })

  test('selfReview: false なら fork を呼ばず、前回の .candidates.json も消し、files にも載せない', async ($, on) => {
    const world = Fixtures.world(on)
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    world.files.set(CANDIDATES_PATH, JSON.stringify(THREE))

    const answered = await $.tool.call({
      tool: FULL_REVIEW_TOOL_NAME,
      review: Fixtures.REVIEW,
      openBrowser: false,
      waitSeconds: 0,
      selfReview: false,
    })
    await world.clock.settle()

    expect(world.forkPrompts).toEqual([])
    expect(world.files.has(CANDIDATES_PATH)).toBe(false)
    expect(JSON.parse(answered.result as string).files.candidates).toBeUndefined()
  })

  test('fork を待つ間に中断されたら、受信サーバもブラウザもペインも出さずに cancelled を返す', async ($, on) => {
    // fork の最中に人が Esc を押した: fork はその turn の中断で aborted を返す
    const world = Fixtures.world(on, { forkReply: { isAnswered: false, reason: 'aborted', usage: USAGE } })
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)

    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: true, waitSeconds: 30 })
    await world.clock.settle()

    const result = JSON.parse(answered.result as string)
    expect(result.status).toBe('cancelled')
    expect(result.reason).toBe(STRINGS.abortedDuringSelfReview)
    expect(world.receiverRuns()).toEqual([])
    expect(world.receiverCommandRuns('open')).toEqual([])
    expect(world.opened).toEqual([])
  })

  test('採用した候補を含む回答は、固定形で (Claude の候補) 付きになる', async ($, on) => {
    const answer = {
      schemaVersion: 1,
      kind: 'review',
      documentId: 'spec-auth-01',
      revision: 1,
      comments: [
        { block: 2, chip: '根拠が要る', quote: 'OIDC に統一', text: 'なぜ OIDC かを足す', source: 'claude' },
        { block: 3, chip: null, quote: '', text: '人の指摘', source: 'someone' },
      ],
      edits: [],
      blocks: { '2': '認証は OIDC に統一します。', '3': '既存ユーザーは初回ログイン時に移行します。' },
    }
    const parsed = parseReviewAnswer(JSON.stringify(answer), Fixtures.REVIEW)
    expect(parsed?.comments.map(comment => comment.source)).toEqual(['claude', undefined])

    const world = Fixtures.world(on, {
      waitReply: () => {
        world.files.set(REVIEW_ANSWER_PATH, JSON.stringify(answer))
        return { answered: true }
      },
    })
    await $.session.start(Fixtures.SESSION)
    world.files.set(Fixtures.DOC_PATH, Fixtures.DOC_HTML)
    const answered = await $.tool.call({ tool: FULL_REVIEW_TOOL_NAME, review: Fixtures.REVIEW, openBrowser: false, waitSeconds: 30 })
    await world.clock.settle()

    const reply = JSON.parse(answered.result as string).reply as string
    expect(reply).toContain(`#2 [根拠が要る] 「OIDC に統一」 なぜ OIDC かを足す ${CANDIDATE_MARK}`)
    expect(reply).toContain('#3 人の指摘\n')
    expect(reply).toBe(formatReviewReply(Fixtures.REVIEW, parsed!))
  })
})
