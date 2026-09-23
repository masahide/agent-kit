import { describe, expect, test, tier } from 'claude-code/testing'

import { questionsOf } from '../hooks/form/form-v1'
import { OUTLINE_ATTRIBUTES, OUTLINE_TAGS } from '../hooks/form/outline'
import { renderHtml } from '../hooks/sheet/render-html'
import Fixtures from './fixtures'

tier('user')

const DATE = '2026-09-22'

/**
 * `<script type="application/json" id="di-form">` の中身を読みます。
 */
function embeddedFormOf(html: string): unknown {
  const match = /<script type="application\/json" id="di-form">([\s\S]*?)<\/script>/.exec(html)
  if (!match?.[1]) {
    throw new Error('id="di-form" の JSON がありません')
  }
  return JSON.parse(match[1])
}

const countOf = (html: string, needle: string): number => html.split(needle).length - 1

describe('render-html', () => {
  test('id="di-form" の JSON は入力と等しい', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(embeddedFormOf(html)).toEqual(Fixtures.FORM)
  })

  test('構成案は HTML として差し込まず、JSON で渡して許可リストで組み直す', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<div class="outline" id="di-outline"></div>')
    expect(html, '構成案の印がそのまま HTML に出ていない').not.toContain('<span data-q="q1"></span>')
    expect(html).not.toContain('<h2>移行</h2>')
    expect(html).toContain(`var TAGS = ${JSON.stringify(OUTLINE_TAGS)};`)
    expect(html).toContain(`var ATTRIBUTES = ${JSON.stringify(OUTLINE_ATTRIBUTES)};`)
    expect(html).toContain("new DOMParser().parseFromString(form.outline, 'text/html')")
  })

  test('問いの数だけ右に決定があり、選択肢の数だけ radio がある。開いた直後は全体を出す', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    const questions = questionsOf(Fixtures.FORM)
    expect(questions).toHaveLength(2)
    for (const question of questions) {
      expect(countOf(html, `<input type="radio" name="q-${question.id}"`)).toBe(question.options.length)
      expect(html).toContain(`name="note-${question.id}"`)
    }
    expect(countOf(html, '<input type="radio"')).toBe(4)
    expect(countOf(html, 'data-role="panel" data-state="pending" hidden>')).toBe(2)
    expect(countOf(html, '<span class="ai-rec">AI の推奨</span>'), 'AI の推奨の印は推奨案の数だけ').toBe(2)
    expect(html).toContain('<section class="panel" data-panel="overview">')
    expect(html).toContain('<button type="button" class="crumb" data-action="overview" aria-pressed="true">全体</button>')
    expect(html).toContain('<div class="next" id="di-next"></div>')
  })

  test('決定には根拠、選択肢 (利点、代償、構成案に入る文)、AI の推奨と理由、補足がある', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<span class="badge">1</span><span class="p-eyebrow">方式</span>')
    expect(html).toContain('<p class="p-title">既存ユーザーの移行をどう扱いますか</p>')
    expect(html).toContain('<p class="cite">src/auth/session.ts:40-88 に自前セッションの発行があります</p>')
    expect(html).toContain('<span class="k">利点</span><span>利用者の操作が増えません</span>')
    expect(html).toContain('<span class="k">代償</span><span>移行失敗時の切り分けが難しくなります</span>')
    expect(html).toContain('<span class="k">構成案</span><span>既存ユーザーは、初回ログイン時に自動で移行します。</span>')
    expect(html).toContain('<p class="ai-pick">A. 初回ログイン時に自動移行</p>')
    expect(html).toContain('<span class="k">理由</span><span>利用者の操作が増えません</span>')
    expect(html).toContain('何も選ばなければ A で進みます。')
    expect(html).toContain('変更しなければこの案で進みます。')
    expect(html).toContain('placeholder="補足があれば 1 行で"')
    expect(countOf(html, 'data-action="next">次の未確認へ</button>')).toBe(3)
  })

  test('推奨案の無い問いは、選ばなければ AI が選ぶと示す', async () => {
    const form = Fixtures.cloneForm(Fixtures.FORM)
    for (const option of form.themes[0]!.questions[0]!.options) delete option.recommended
    const html = renderHtml({ form, date: DATE })
    const phrase = '推奨案はありません。選ばなければ AI が選びます。'
    const base = countOf(renderHtml({ form: Fixtures.FORM, date: DATE }), phrase)
    expect(countOf(html, phrase) - base, '選択肢の下と AI の推奨の欄の 2 か所').toBe(2)
    expect(countOf(html, '<span class="ai-rec">AI の推奨</span>')).toBe(1)
  })

  test('__TOKEN__ は残っておらず、トークンは URL の ?t= から読む', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).not.toContain('__TOKEN__')
    expect(html).toContain("new URLSearchParams(location.search).get('t')")
    expect(html).toContain("fetch('/answer?t=' + encodeURIComponent(token)")
  })

  test('送信に失敗したときの案内は JSON を貼ることだけ (/interview は案内しない)', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('下の JSON をそのまま Claude Code のチャットに貼ってください')
    expect(html).not.toContain('/interview')
  })

  test('骨格: 規約コメント、上部バー、構成案の見出し、結論、用語欄、全体の進み具合、下部バー', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<!-- document-interview-format: v1 -->')
    expect(html).toContain('<span class="mark">INTERVIEW</span><span class="doc-id">spec-auth-01</span><span class="rev">rev 1</span>')
    expect(html).toContain('<span class="date">2026-09-22</span>')
    expect(html).toContain('<p class="eyebrow"><span>構成案</span><span>未確定事項 2</span><span>表 1</span></p>')
    expect(html).toContain('<h1>認証方式は OIDC に統一する</h1>')
    expect(html).toContain('<div class="concl">結論: 認証は OIDC に統一します。')
    expect(html).toContain('<dt>OIDC</dt><dd>OpenID Connect。')
    expect(html).toContain('<div data-stat="pending"><dt>未確認</dt><dd>2</dd></div>')
    expect(html).toContain('<div data-stat="blank"><dt>表の空欄</dt><dd>4</dd></div>')
    expect(html).toContain('<p class="bar-msg" id="di-status">未確認の問いは AI の推奨で進みます。</p>')
    expect(html).toContain('<span class="count" data-count="pending"><i></i><span class="lbl">未確認</span><b>2</b></span>')
    expect(html).toContain('<button type="submit" class="btn primary" id="di-submit">送信</button>')
    expect(html).not.toContain('<link ')
    expect(html).not.toContain('src="http')
  })

  test('表はサーバで描いて隠しておき、editable の列だけ input、それ以外は固定表示', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<div class="tbl-holder" id="di-tables" hidden><div class="tbl" data-t="tb1" data-role="table">')
    expect(html).toContain('<caption>画面ごとの認証要否</caption>')
    expect(html).toContain('<td>トップ</td>')
    expect(html).toContain('name="cell-tb1-0-1"')
    expect(html).toContain('name="cell-tb1-1-2"')
    expect(html).not.toContain('name="cell-tb1-0-0"')
    expect(html).toContain('<section class="panel" data-t="tb1" data-role="table-panel" hidden>')
    expect(html).toContain('<p class="t-blank" data-t="tb1" data-role="blank">空欄が 4 か所あります。</p>')

    const noTables = renderHtml({ form: Fixtures.FORM_NO_TABLES, date: DATE })
    expect(noTables).toContain('<div class="tbl-holder" id="di-tables" hidden></div>')
    expect(noTables).not.toContain('data-role="table-panel"')
    expect(noTables).not.toContain('data-stat="blank"')
    expect(noTables).toContain('<p class="eyebrow"><span>構成案</span><span>未確定事項 2</span></p>')
  })

  test('HTML の文字と JSON の < を逃がす', async () => {
    const form = Fixtures.cloneForm(Fixtures.FORM)
    form.title = '<script>alert("x")</script> & 会社'
    form.themes[0]!.questions[0]!.options[0]!.label = 'a < b'
    form.themes[0]!.questions[0]!.id = 'q"1'

    const html = renderHtml({ form, date: DATE })
    expect(html).toContain('<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 会社</h1>')
    expect(html).toContain('a &lt; b')
    expect(html).toContain('<input type="radio" name="q-q&quot;1"')
    expect(html).toContain('<section class="panel" data-q="q&quot;1" data-role="panel"')
    expect(embeddedFormOf(html)).toEqual(form)

    const json = /<script type="application\/json" id="di-form">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(json).not.toContain('<')
    expect(json).toContain('\\u003c')
  })
})
