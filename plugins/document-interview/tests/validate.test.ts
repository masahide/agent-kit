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
    expect(errorsOf(form => (form.themes = []))).toEqual([expect.stringContaining('themes:')])
  })

  test('問いは全テーマ合わせて 2〜5 問', async () => {
    expect(errorsOf(form => form.themes.splice(1))).toEqual([expect.stringContaining('今は 1 問')])

    const six = errorsOf(form => {
      const theme = form.themes[0]!
      for (let index = 0; index < 4; index += 1) {
        theme.questions.push({ ...Fixtures.cloneForm(theme.questions[0]!), id: `x${index}` })
      }
    })
    expect(six).toEqual([expect.stringContaining('圧縮してください')])

    const five = errorsOf(form => {
      const theme = form.themes[0]!
      for (let index = 0; index < 3; index += 1) {
        theme.questions.push({ ...Fixtures.cloneForm(theme.questions[0]!), id: `x${index}` })
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
    expect(errorsOf(form => (form.themes[1]!.questions[0]!.id = 'q1'))).toEqual([
      expect.stringContaining('問い ID "q1" が重複'),
    ])
    expect(errorsOf(form => (form.themes[1]!.id = 't1'))).toEqual([expect.stringContaining('テーマ ID "t1" が重複')])
    expect(
      errorsOf(form => form.tables!.push({ ...Fixtures.cloneForm(form.tables![0]!) })),
    ).toEqual([expect.stringContaining('表 ID "tb1" が重複')])
    expect(errorsOf(form => (form.themes[0]!.questions[0]!.options[1]!.id = 'A'))).toEqual([
      expect.stringContaining('選択肢 ID "A" が重複'),
    ])
  })

  test('tables は省略でき、列は 1〜6、行は 0〜20、行の長さは列数と同じ', async () => {
    expect(errorsOf(form => delete form.tables)).toEqual([])
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

  test('エラーは最初の 1 つで止めず全部返す', async () => {
    const errors = errorsOf(form => {
      form.title = ''
      form.themes[0]!.questions[0]!.cite = ''
      form.themes[1]!.questions[0]!.options[0]!.cons = ''
    })
    expect(errors).toHaveLength(3)
  })
})
