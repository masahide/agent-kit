import { describe, expect, test, tier } from 'claude-code/testing'

import type { FormV1 } from '../hooks/form/form-v1'
import { validateForm } from '../hooks/form/validate'
import Fixtures from './fixtures'

tier('user')

/**
 * fixture を壊してから検証し、エラーだけを返します。
 */
function errorsOf(mutate: (form: FormV1) => void): string[] {
  const form = Fixtures.cloneForm(Fixtures.FORM)
  mutate(form)
  const result = validateForm(form)
  return result.ok ? [] : result.errors
}

describe('validate', () => {
  test('fixture の質問票は通る', async () => {
    const result = validateForm(Fixtures.FORM)
    expect(result.ok).toBe(true)
    expect(validateForm(Fixtures.FORM_NO_TABLES).ok).toBe(true)
  })

  test('オブジェクトでなければ 1 件で落ちる', async () => {
    expect(validateForm('x')).toEqual({ ok: false, errors: ['form: オブジェクトにしてください'] })
  })

  test('source は省略でき、あれば 1〜1024 文字の空でない文字列', async () => {
    expect(errorsOf(form => (form.source = 'docs/auth.md'))).toEqual([])
    expect(errorsOf(form => (form.source = ' '))).toEqual([expect.stringContaining('source:')])
    expect(errorsOf(form => (form.source = 'a'.repeat(1025)))).toEqual([expect.stringContaining('source:')])
    expect(errorsOf(form => ((form as { source: unknown }).source = 1))).toEqual([expect.stringContaining('source:')])
  })

  test('schemaVersion は 1', async () => {
    expect(errorsOf(form => ((form as { schemaVersion: number }).schemaVersion = 2))).toEqual([
      'schemaVersion: 1 にしてください',
    ])
  })

  test('documentId と label は英数字と - と _ の 1〜64 文字', async () => {
    expect(errorsOf(form => (form.documentId = 'spec auth'))).toEqual([
      expect.stringContaining('documentId:'),
    ])
    expect(errorsOf(form => (form.label = 'a'.repeat(65)))).toEqual([expect.stringContaining('label:')])
    expect(errorsOf(form => (form.label = 'ok_label-1'))).toEqual([])
  })

  test('revision は 1 以上の整数', async () => {
    expect(errorsOf(form => (form.revision = 0))).toEqual([expect.stringContaining('revision:')])
    expect(errorsOf(form => (form.revision = 1.5))).toEqual([expect.stringContaining('revision:')])
  })

  test('title と conclusion は空でない', async () => {
    expect(errorsOf(form => (form.title = '  '))).toEqual([expect.stringContaining('title:')])
    expect(errorsOf(form => (form.conclusion = ''))).toEqual([expect.stringContaining('conclusion:')])
  })

  test('glossary は省略できるが、あれば term と definition が要る', async () => {
    expect(errorsOf(form => delete form.glossary)).toEqual([])
    expect(errorsOf(form => (form.glossary = [{ term: 'OIDC', definition: '' }]))).toEqual([
      expect.stringContaining('glossary[0].definition'),
    ])
  })

  test('themes は 1 つ以上', async () => {
    expect(
      errorsOf(form => {
        form.themes = []
        form.outline = '<h2>前提</h2><div data-table="tb1"></div>'
      }),
    ).toEqual([expect.stringContaining('themes:')])
  })

  test('問いは全テーマ合わせて 2〜5 問', async () => {
    expect(
      errorsOf(form => {
        form.themes.splice(1)
        form.outline = form.outline.replace('<span data-q="q2"></span>', '')
      }),
    ).toEqual([expect.stringContaining('今は 1 問')])

    const six = errorsOf(form => {
      const theme = form.themes[0]!
      for (let index = 0; index < 4; index += 1) {
        theme.questions.push({ ...Fixtures.cloneForm(theme.questions[0]!), id: `x${index}` })
        form.outline += `<p><span data-q="x${index}"></span></p>`
      }
    })
    expect(six).toEqual([expect.stringContaining('圧縮してください')])

    const five = errorsOf(form => {
      const theme = form.themes[0]!
      for (let index = 0; index < 3; index += 1) {
        theme.questions.push({ ...Fixtures.cloneForm(theme.questions[0]!), id: `x${index}` })
        form.outline += `<p><span data-q="x${index}"></span></p>`
      }
    })
    expect(five).toEqual([])
  })

  test('cite は空を落とす', async () => {
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.cite = ' '))).toEqual([
      expect.stringContaining('themes[0].questions[0].cite'),
    ])
  })

  test('選択肢は 2 つ以上', async () => {
    expect(errorsOf(form => form.themes[0]!.questions[0]!.options.splice(1))).toEqual([
      expect.stringContaining('themes[0].questions[0].options: 選択肢を 2 つ以上'),
    ])
  })

  test('pros と cons は空を落とす', async () => {
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[1]!.pros = ''))).toEqual([
      expect.stringContaining('options[1].pros'),
    ])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[1]!.cons = ''))).toEqual([
      expect.stringContaining('options[1].cons'),
    ])
  })

  test('recommended は 1 問に高々 1 つ', async () => {
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[1]!.recommended = true))).toEqual([
      expect.stringContaining('recommended: true は 1 問に 1 つまで'),
    ])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[0]!.recommended = false))).toEqual([])
  })

  test('note.placeholder は省略できる', async () => {
    expect(errorsOf(form => delete form.themes[0]!.questions[0]!.note)).toEqual([])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.note = { placeholder: 1 as unknown as string }))).toEqual([
      expect.stringContaining('note.placeholder'),
    ])
  })

  test('ID は問い、テーマ、表それぞれで一意', async () => {
    expect(
      errorsOf(form => {
        form.themes[1]!.questions[0]!.id = 'q1'
        form.outline = form.outline.replace('data-q="q2"', 'data-q="q1"')
      }),
    ).toEqual([expect.stringContaining('問い ID "q1" が重複')])
    expect(errorsOf(form => (form.themes[1]!.id = 't1'))).toEqual([expect.stringContaining('テーマ ID "t1" が重複')])
    expect(
      errorsOf(form => form.tables!.push({ ...Fixtures.cloneForm(form.tables![0]!) })),
    ).toEqual([expect.stringContaining('表 ID "tb1" が重複')])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[1]!.id = 'A'))).toEqual([
      expect.stringContaining('選択肢 ID "A" が重複'),
    ])
  })

  test('tables は省略でき、列は 1〜6、行は 0〜20、行の長さは列数と同じ', async () => {
    expect(
      errorsOf(form => {
        delete form.tables
        form.outline = form.outline.replace('<div data-table="tb1"></div>', '')
      }),
    ).toEqual([])
    expect(errorsOf(form => (form.tables![0]!.columns = []))).toEqual([expect.stringContaining('tables[0].columns')])
    expect(errorsOf(form => (form.tables![0]!.columns = ['1', '2', '3', '4', '5', '6', '7']))).toEqual([
      expect.stringContaining('tables[0].columns'),
    ])
    expect(errorsOf(form => (form.tables![0]!.rows = Array.from({ length: 21 }, () => ['a', 'b', 'c'])))).toEqual([
      expect.stringContaining('tables[0].rows: 行を 0〜20 行'),
    ])
    expect(errorsOf(form => (form.tables![0]!.rows = []))).toEqual([])
    expect(errorsOf(form => (form.tables![0]!.rows[1] = ['短い']))).toEqual([
      expect.stringContaining('tables[0].rows[1]: 列数 (3)'),
    ])
  })

  test('editable は列数と同じ長さの boolean 配列で、省略できる', async () => {
    expect(errorsOf(form => delete form.tables![0]!.editable)).toEqual([])
    expect(errorsOf(form => (form.tables![0]!.editable = [true]))).toEqual([expect.stringContaining('tables[0].editable')])
  })

  test('outline (構成案) は必須で、空は落とす', async () => {
    expect(errorsOf(form => delete (form as { outline?: string }).outline)).toEqual([
      expect.stringContaining('outline: 構成案'),
    ])
    expect(errorsOf(form => (form.outline = ' '))).toEqual([expect.stringContaining('outline: 構成案')])
  })

  test('outline は使える要素と属性だけ (コメントの中は検査しない)', async () => {
    const errors = errorsOf(form => {
      form.outline += '<script>alert(1)</script><p class="x" onclick="y">z</p><a href="#">a</a>'
    })
    expect(errors).toEqual([
      expect.stringContaining('outline: 使えない要素 <script>, <a> があります'),
      expect.stringContaining('outline: 使えない属性があります (<p> の class, <p> の onclick)'),
    ])
    expect(errorsOf(form => (form.outline += '<table><tr><td colspan="2">a</td></tr></table><br/>'))).toEqual([])
    expect(errorsOf(form => (form.outline += '<!-- <script> --><p>ok</p>'))).toEqual([])
  })

  test('印の ID は質問票にあり、問いはどれも 1 回以上、表はどれもちょうど 1 回置く', async () => {
    expect(errorsOf(form => (form.outline = form.outline.replace('<span data-q="q2"></span>', '')))).toEqual([
      expect.stringContaining('outline: 問い "q2" の印 <span data-q="q2"></span> がありません'),
    ])
    expect(errorsOf(form => (form.outline += '<p><span data-q="q9"></span></p>'))).toEqual([
      expect.stringContaining('outline: data-q="q9" の問いがありません'),
    ])
    expect(errorsOf(form => (form.outline += '<p><span data-q="q1"></span></p>')), '問いの印は 2 回でもよい').toEqual([])
    expect(errorsOf(form => (form.outline = form.outline.replace('<div data-table="tb1"></div>', '')))).toEqual([
      expect.stringContaining('outline: 表 "tb1" の印 <div data-table="tb1"></div> がありません'),
    ])
    expect(errorsOf(form => (form.outline += '<div data-table="tb1"></div>'))).toEqual([
      expect.stringContaining('outline: 表 "tb1" の印が 2 個あります'),
    ])
    expect(errorsOf(form => (form.outline += '<div data-table="tb9"></div>'))).toEqual([
      expect.stringContaining('outline: data-table="tb9" の表がありません'),
    ])
  })

  test('outline は 20000 文字まで', async () => {
    expect(errorsOf(form => (form.outline += `<p>${'あ'.repeat(20000)}</p>`))).toEqual([
      expect.stringContaining('outline: 20000 文字以内'),
    ])
  })

  test('preview は省略でき、あれば 200 文字以内の空でない文字列', async () => {
    expect(errorsOf(form => delete form.themes[0]!.questions[0]!.options[0]!.preview)).toEqual([])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[0]!.preview = ' '))).toEqual([
      expect.stringContaining('themes[0].questions[0].options[0].preview'),
    ])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[0]!.preview = 'あ'.repeat(201)))).toEqual([
      expect.stringContaining('themes[0].questions[0].options[0].preview'),
    ])
  })

  test('エラーは最初の 1 つで止めず全部返す', async () => {
    const errors = errorsOf(form => {
      form.title = ''
      form.themes[0]!.questions[0]!.cite = ''
      form.themes[1]!.questions[0]!.options[0]!.cons = ''
    })
    expect(errors).toHaveLength(3)
  })
})
