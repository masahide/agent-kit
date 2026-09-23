import { describe, expect, test, tier } from 'claude-code/testing'

import { questionsOf } from '../hooks/form/form-v1'
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

  test('問いの数だけ name="q-<id>" の radio 群があり、選択肢の数だけ radio がある', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    const questions = questionsOf(Fixtures.FORM)
    expect(questions).toHaveLength(2)
    for (const question of questions) {
      expect(countOf(html, `<input type="radio" name="q-${question.id}"`)).toBe(question.options.length)
      expect(html).toContain(`name="note-${question.id}"`)
    }
    expect(countOf(html, '<input type="radio"')).toBe(4)
    expect(countOf(html, '<span class="rec">推奨</span>'), '推奨バッジは推奨案の数だけ').toBe(2)
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

  test('骨格: 規約コメント、キッカー、タイトル、結論、用語欄、テーマ見出し、問い番号、表、フッター', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<!-- document-interview-format: v1 -->')
    expect(html).toContain('✎ INTERVIEW — 2026-09-22')
    expect(html).toContain('<h1>認証方式は OIDC に統一する</h1>')
    expect(html).toContain('<div class="concl">結論: 認証は OIDC に統一します。')
    expect(html).toContain('<b>OIDC</b> = OpenID Connect。')
    expect(html).toContain('<h2>方式</h2>')
    expect(html).toContain('<h2>運用</h2>')
    expect(html).toContain('<span class="qn">問 1.</span> 既存ユーザーの移行をどう扱いますか')
    expect(html).toContain('<span class="qn">問 2.</span> ログの保持期間')
    expect(html).toContain('根拠: src/auth/session.ts:40-88')
    expect(html).toContain('利点: 利用者の操作が増えません / 代償: 移行失敗時の切り分けが難しくなります')
    expect(html).toContain('placeholder="補足があれば 1 行で"')
    expect(html).toContain('未選択の問いはお任せ (推奨案) で進みます')
    expect(html).toContain('回答あり 0 / 2')
    expect(html).toContain('id="di-submit"')
    expect(html).not.toContain('<link ')
    expect(html).not.toContain('src="http')
  })

  test('表は editable の列だけ input、それ以外は固定表示', async () => {
    const html = renderHtml({ form: Fixtures.FORM, date: DATE })
    expect(html).toContain('<caption>画面ごとの認証要否</caption>')
    expect(html).toContain('<td>トップ</td>')
    expect(html).toContain('name="cell-tb1-0-1"')
    expect(html).toContain('name="cell-tb1-1-2"')
    expect(html).not.toContain('name="cell-tb1-0-0"')

    const noTables = renderHtml({ form: Fixtures.FORM_NO_TABLES, date: DATE })
    expect(noTables).not.toContain('<h2>表</h2>')
  })

  test('HTML の文字と JSON の < を逃がす', async () => {
    const form = Fixtures.cloneForm(Fixtures.FORM)
    form.title = '<script>alert("x")</script> & 会社'
    form.themes[0]!.questions[0]!.options[0]!.label = 'a < b'

    const html = renderHtml({ form, date: DATE })
    expect(html).toContain('<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 会社</h1>')
    expect(html).toContain('a &lt; b')
    expect(embeddedFormOf(html)).toEqual(form)

    const json = /<script type="application\/json" id="di-form">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    expect(json).not.toContain('<')
    expect(json).toContain('\\u003c')
  })
})
