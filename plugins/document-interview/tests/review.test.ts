import { describe, expect, test, tier } from 'claude-code/testing'

import { parseReviewAnswer } from '../hooks/review/answer'
import { DOCUMENT_ATTRIBUTES, DOCUMENT_TAGS, documentErrors, MAX_DOCUMENT_LENGTH } from '../hooks/review/document'
import { formatReviewReply, MAX_BLOCK_EXCERPT } from '../hooks/review/format'
import { REVIEW_CHIPS } from '../hooks/review/review-v1'
import { validateReview } from '../hooks/review/validate-review'
import { renderReviewHtml } from '../hooks/sheet/render-review'
import Fixtures from './fixtures'

tier('user')

const DATE = '2026-09-23'

const countOf = (html: string, needle: string): number => html.split(needle).length - 1

describe('review', () => {
  test('validateReview: 正しい画面は通り、不正な欄は全部まとめて返す', async () => {
    expect(validateReview(Fixtures.REVIEW)).toEqual({ ok: true, review: Fixtures.REVIEW })
    expect(validateReview({ ...Fixtures.REVIEW, part: { index: 2, total: 3 } }).ok).toBe(true)

    const result = validateReview({
      schemaVersion: 2,
      documentId: 'a b',
      revision: 0,
      label: '',
      title: ' ',
      source: '',
      part: { index: 4, total: 3 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map(error => error.split(':')[0])).toEqual([
      'schemaVersion',
      'documentId',
      'label',
      'revision',
      'title',
      'source',
      'part',
    ])
    expect(validateReview('x')).toEqual({ ok: false, errors: ['review: オブジェクトにしてください'] })
  })

  test('documentErrors: 許可リストの要素と、表の colspan と rowspan だけを通す', async () => {
    expect(documentErrors(Fixtures.DOC_HTML)).toEqual([])
    expect(documentErrors('<table><tr><td colspan="2">a</td></tr></table>')).toEqual([])

    const errors = documentErrors('<h1>題</h1><p class="x" onclick="y()">a</p><script>z()</script><span data-q="q1"></span>')
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('使えない要素 <h1>, <script>')
    expect(errors[1]).toContain('<p> の class, <p> の onclick, <span> の data-q')
  })

  test('documentErrors: 10 万文字を超えると分けるよう返し、段落が無ければそう返す', async () => {
    const long = `<p>${'あ'.repeat(MAX_DOCUMENT_LENGTH)}</p>`
    expect(documentErrors(long)[0]).toContain(`${MAX_DOCUMENT_LENGTH} 文字以内にしてください (今は ${long.length} 文字、タグを含む)`)
    expect(documentErrors(long)[0]).toContain('part を付けて')
    expect(documentErrors('<div>本文</div>')).toEqual([expect.stringContaining('段落がありません')])
  })

  test('parseReviewAnswer: documentId、revision、kind が違えば null。形の違う指摘は捨てる', async () => {
    const text = JSON.stringify(Fixtures.REVIEW_ANSWER)
    const answer = parseReviewAnswer(text, Fixtures.REVIEW)
    expect(answer?.comments).toHaveLength(3)
    expect(answer?.globalNote).toBe('全体に短く')

    expect(parseReviewAnswer(JSON.stringify({ ...Fixtures.REVIEW_ANSWER, revision: 2 }), Fixtures.REVIEW)).toBeNull()
    expect(parseReviewAnswer(JSON.stringify({ ...Fixtures.REVIEW_ANSWER, documentId: 'x' }), Fixtures.REVIEW)).toBeNull()
    expect(parseReviewAnswer(JSON.stringify(Fixtures.ANSWER_FULL), Fixtures.REVIEW), '質問票の回答は読まない').toBeNull()
    expect(parseReviewAnswer('{', Fixtures.REVIEW)).toBeNull()

    const odd = parseReviewAnswer(
      JSON.stringify({ ...Fixtures.REVIEW_ANSWER, comments: [{ block: 0, chip: 'a' }, { block: 1.5, chip: 'a' }, 'x', { block: 3, chip: '削る' }] }),
      Fixtures.REVIEW,
    )
    expect(odd?.comments).toEqual([{ block: 3, chip: '削る', quote: '', text: '' }])
  })

  test('formatReviewReply: 段落番号の順に指摘を並べ、指摘した段落の文字列を添える', async () => {
    const answer = parseReviewAnswer(JSON.stringify(Fixtures.REVIEW_ANSWER), Fixtures.REVIEW)
    expect(answer).not.toBeNull()
    if (!answer) return
    expect(formatReviewReply(Fixtures.REVIEW, answer)).toBe(Fixtures.REVIEW_REPLY)
    expect(formatReviewReply(Fixtures.REVIEW, Fixtures.REVIEW_ANSWER_EMPTY)).toBe(Fixtures.REVIEW_REPLY_EMPTY)
  })

  test('formatReviewReply: 分けて出した画面は対象に何回目かを書き、長い段落は切る', async () => {
    const review = { ...Fixtures.REVIEW, part: { index: 2, total: 3 } }
    const long = 'い'.repeat(MAX_BLOCK_EXCERPT + 10)
    const reply = formatReviewReply(review, {
      ...Fixtures.REVIEW_ANSWER_EMPTY,
      comments: [{ block: 7, chip: '短くする', quote: '', text: '' }],
      blocks: { '7': long },
    })
    expect(reply.split('\n')[1]).toBe('対象: interview/spec-auth-01-review.doc.html (2/3)')
    expect(reply).toContain(`#7 ${'い'.repeat(MAX_BLOCK_EXCERPT)}…`)
  })

  test('renderReviewHtml: 文書は HTML として差し込まず、JSON で渡して許可リストで組み直す', async () => {
    const html = renderReviewHtml({ review: Fixtures.REVIEW, html: Fixtures.DOC_HTML, date: DATE })
    const json = /<script type="application\/json" id="di-review">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(JSON.parse(json)).toEqual({ review: Fixtures.REVIEW, html: Fixtures.DOC_HTML })
    expect(json).not.toContain('<')
    expect(html).not.toContain('<h2>認証方式</h2>')
    expect(html).toContain('<div class="outline doc-body" id="di-doc"></div>')
    expect(html).toContain(`var TAGS = ${JSON.stringify(DOCUMENT_TAGS)};`)
    expect(html).toContain(`var ATTRIBUTES = ${JSON.stringify(DOCUMENT_ATTRIBUTES)};`)
    expect(html).toContain("new DOMParser().parseFromString(data.html, 'text/html')")
    expect(html).toContain("fetch('/answer?t=' + encodeURIComponent(token)")
    expect(html).not.toContain('<link ')
    expect(html).not.toContain('src="http')
  })

  test('renderReviewHtml: 骨格とチップ 9 種', async () => {
    const html = renderReviewHtml({ review: { ...Fixtures.REVIEW, part: { index: 2, total: 3 } }, html: Fixtures.DOC_HTML, date: DATE })
    expect(html).toContain('<!-- document-interview-format: review-v1 -->')
    expect(html).toContain('<span class="mark">REVIEW</span><span class="doc-id">spec-auth-01</span><span class="rev">rev 1</span><span class="rev">2/3</span>')
    expect(html).toContain('<p class="eyebrow"><span>書き上げた文書</span><span>docs/spec-auth.md</span><span>2 / 3 回目</span></p>')
    expect(html).toContain('<h1>認証方式の仕様</h1>')
    expect(countOf(html, ' data-chip="')).toBe(REVIEW_CHIPS.length)
    expect(html).toContain('<button type="button" class="chip keep" data-chip="ここは良い" aria-pressed="false">ここは良い</button>')
    expect(html).toContain('<section class="panel" data-panel="overview">')
    expect(html).toContain('<section class="panel" data-panel="block" hidden>')
    expect(html).toContain('<button type="submit" class="btn primary" id="di-submit">送信</button>')
  })

  test('renderReviewHtml: 題名と元の文書のパスを逃がす', async () => {
    const html = renderReviewHtml({
      review: { ...Fixtures.REVIEW, title: '<b>"題"</b>', source: 'a&b.md' },
      html: Fixtures.DOC_HTML,
      date: DATE,
    })
    expect(html).toContain('<h1>&lt;b&gt;&quot;題&quot;&lt;/b&gt;</h1>')
    expect(html).toContain('<span>a&amp;b.md</span>')
  })
})
