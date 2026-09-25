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
    expect(odd?.edits).toHaveLength(4)
  })

  test('parseReviewAnswer: 形の違う添削は捨て、edits が無ければ空にする', async () => {
    const answer = parseReviewAnswer(
      JSON.stringify({
        ...Fixtures.REVIEW_ANSWER,
        edits: [
          { kind: 'rewrite', block: 1, text: ' ' },
          { kind: 'move', block: 2, to: 2 },
          { kind: 'move', block: 2, to: 0 },
          { kind: 'add', block: 0, text: 'a' },
          { kind: 'rename', block: 1 },
          { kind: 'delete', block: 4 },
          { kind: 'add', block: 4, text: '足す' },
          { kind: 'rewrite', block: 5, text: '直す', mode: 'guide' },
          { kind: 'rewrite', block: 6, text: '直す', mode: 'other' },
        ],
      }),
      Fixtures.REVIEW,
    )
    expect(answer?.edits, '使い方が無いか知らない値なら、そのまま使う').toEqual([
      { kind: 'delete', block: 4 },
      { kind: 'add', block: 4, text: '足す', mode: 'exact' },
      { kind: 'rewrite', block: 5, text: '直す', mode: 'guide' },
      { kind: 'rewrite', block: 6, text: '直す', mode: 'exact' },
    ])
    const { edits: _, ...withoutEdits } = Fixtures.REVIEW_ANSWER
    expect(parseReviewAnswer(JSON.stringify(withoutEdits), Fixtures.REVIEW)?.edits).toEqual([])
  })

  test('formatReviewReply: 添削だけで指摘が無ければ (指摘なし) の後に書き換えの節を出す', async () => {
    const reply = formatReviewReply(Fixtures.REVIEW, {
      ...Fixtures.REVIEW_ANSWER_EMPTY,
      edits: [
        { kind: 'add', block: 2, text: '足す', mode: 'guide' },
        { kind: 'rewrite', block: 2, text: '後', mode: 'exact' },
      ],
      blocks: { '2': '前' },
    })
    expect(reply.split('\n').slice(2, 9)).toEqual(['## 指摘', '(指摘なし)', '## 書き換え', '#2 書き換え (そのまま)', '前: 前', '後: 後', '#2 の後に追加 (参考にして直す)'])
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
    expect(reply.split('\n')[1]).toBe('対象: doc-desk/spec-auth-01-review.doc.html (2/3)')
    expect(reply).toContain(`#7 ${'い'.repeat(MAX_BLOCK_EXCERPT)}…`)
  })

  test('renderReviewHtml: 文書は HTML として差し込まず、JSON で渡して許可リストで組み直す', async () => {
    const html = renderReviewHtml({ review: Fixtures.REVIEW, html: Fixtures.DOC_HTML, date: DATE })
    const json = /<script type="application\/json" id="di-review">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(JSON.parse(json)).toEqual({ review: Fixtures.REVIEW, html: Fixtures.DOC_HTML, candidates: [] })
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
    expect(html).toContain('<!-- doc-desk-format: review-v1 -->')
    expect(html).toContain('<span class="mark">REVIEW</span><span class="doc-id">spec-auth-01</span><span class="rev">rev 1</span><span class="rev">2/3</span>')
    expect(html).toContain('<p class="eyebrow"><span>書き上げた文書</span><span>docs/spec-auth.md</span><span>2 / 3 回目</span></p>')
    expect(html).toContain('<h1>認証方式の仕様</h1>')
    expect(countOf(html, ' data-chip="')).toBe(REVIEW_CHIPS.length)
    expect(html).toContain('<button type="button" class="chip keep" data-chip="ここは良い" aria-pressed="false">ここは良い</button>')
    expect(html).toContain('<section class="panel" data-panel="overview">')
    expect(html).toContain('<section class="panel" data-panel="block" hidden>')
    expect(countOf(html, ' data-edit="')).toBe(4)
    expect(html, '選んだ文字列と、指摘を付けた文字列に色を付ける').toContain('.doc-body mark.sel{')
    expect(html).toContain('.doc-body mark.q{')
    expect(html, '文書の外でマウスを離しても選択を読む').toContain("document.addEventListener('mouseup'")
    expect(html).toContain('<textarea id="di-editor-text"></textarea>')
    expect(html).toContain('<input type="radio" name="edit-mode" value="exact" checked>')
    expect(html).toContain('<input type="radio" name="edit-mode" value="guide">')
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

  test('validateReview: source は 1〜1024 文字', () => {
    expect(validateReview({ ...Fixtures.REVIEW, source: 'a'.repeat(1024) }).ok).toBe(true)
    expect(validateReview({ ...Fixtures.REVIEW, source: 'a'.repeat(1025) })).toEqual({
      ok: false,
      errors: ['source: 省略するか、1〜1024 文字の空でない文字列 (元の文書のパス) にしてください'],
    })
  })

  test('renderReviewHtml: 候補の文に </script> があっても script を抜け出さない', () => {
    const html = renderReviewHtml({
      review: Fixtures.REVIEW,
      html: Fixtures.DOC_HTML,
      date: DATE,
      candidates: [{ block: 1, chip: '削る', quote: '</script><script>alert(1)</script>', text: '</script>x' }],
    })
    const json = /<script type="application\/json" id="di-review">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(json).not.toContain('</')
    expect(JSON.parse(json).candidates[0].text).toBe('</script>x')
    expect(countOf(html, '<script'), 'script 要素は埋め込みの JSON と画面の JS の 2 つだけ').toBe(2)
  })
})
