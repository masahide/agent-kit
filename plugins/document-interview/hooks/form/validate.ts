import type { FormV1 } from './form-v1'

/**
 * 検証の結果。通れば `form`、落ちれば `errors` (全部) を返します。
 */
export type Validation =
  | { ok: true; form: FormV1 }
  | { ok: false; errors: string[] }

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MIN_QUESTIONS = 2
const MAX_QUESTIONS = 5
const MAX_COLUMNS = 6
const MAX_ROWS = 20

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/**
 * 質問票 JSON を検証します (mvp-design.md 5 章の規則)。
 *
 * エラーは最初の 1 つで止めず、見つかった分を全部返します。
 * パスは `themes[0].questions[1].cite` の形です。
 *
 * @param input ツールに渡された `form`
 * @returns 通れば `{ ok: true, form }`、落ちれば `{ ok: false, errors }`
 */
export function validateForm(input: unknown): Validation {
  const errors: string[] = []
  const fail = (path: string, message: string) => {
    errors.push(`${path}: ${message}`)
  }

  if (!isRecord(input)) {
    return { ok: false, errors: ['form: オブジェクトにしてください'] }
  }

  if (input.schemaVersion !== 1) {
    fail('schemaVersion', '1 にしてください')
  }

  for (const key of ['documentId', 'label'] as const) {
    const value = input[key]
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      fail(key, '1〜64 文字の英数字と - と _ にしてください')
    }
  }

  if (!Number.isInteger(input.revision) || (input.revision as number) < 1) {
    fail('revision', '1 以上の整数にしてください')
  }

  for (const key of ['title', 'conclusion'] as const) {
    if (!isFilled(input[key])) {
      fail(key, '空でない文字列にしてください')
    }
  }

  if (input.glossary !== undefined) {
    if (!Array.isArray(input.glossary)) {
      fail('glossary', '配列にしてください')
    } else {
      input.glossary.forEach((entry, index) => {
        const at = `glossary[${index}]`
        if (!isRecord(entry)) {
          fail(at, 'オブジェクトにしてください')
          return
        }
        if (!isFilled(entry.term)) fail(`${at}.term`, '空でない文字列にしてください')
        if (!isFilled(entry.definition)) fail(`${at}.definition`, '空でない文字列にしてください')
      })
    }
  }

  const questionIds = new Set<string>()
  const themeIds = new Set<string>()
  let questionCount = 0

  if (!Array.isArray(input.themes) || input.themes.length === 0) {
    fail('themes', 'テーマを 1 つ以上にしてください')
  } else {
    input.themes.forEach((theme, themeIndex) => {
      const themeAt = `themes[${themeIndex}]`
      if (!isRecord(theme)) {
        fail(themeAt, 'オブジェクトにしてください')
        return
      }
      if (!isFilled(theme.id)) {
        fail(`${themeAt}.id`, '空でない文字列にしてください')
      } else if (themeIds.has(theme.id)) {
        fail(`${themeAt}.id`, `テーマ ID "${theme.id}" が重複しています`)
      } else {
        themeIds.add(theme.id)
      }
      if (!isFilled(theme.name)) fail(`${themeAt}.name`, '空でない文字列にしてください')

      if (!Array.isArray(theme.questions)) {
        fail(`${themeAt}.questions`, '配列にしてください')
        return
      }

      theme.questions.forEach((question, questionIndex) => {
        questionCount += 1
        const at = `${themeAt}.questions[${questionIndex}]`
        if (!isRecord(question)) {
          fail(at, 'オブジェクトにしてください')
          return
        }
        if (!isFilled(question.id)) {
          fail(`${at}.id`, '空でない文字列にしてください')
        } else if (questionIds.has(question.id)) {
          fail(`${at}.id`, `問い ID "${question.id}" が重複しています`)
        } else {
          questionIds.add(question.id)
        }
        if (!isFilled(question.title)) fail(`${at}.title`, '空でない文字列にしてください')
        if (!isFilled(question.cite)) {
          fail(`${at}.cite`, '根拠 (file:line か実行結果の引用) を書いてください。空は不可です')
        }
        if (question.note !== undefined) {
          if (!isRecord(question.note)) {
            fail(`${at}.note`, 'オブジェクトにしてください')
          } else if (
            question.note.placeholder !== undefined &&
            typeof question.note.placeholder !== 'string'
          ) {
            fail(`${at}.note.placeholder`, '文字列にしてください')
          }
        }

        if (!Array.isArray(question.options) || question.options.length < 2) {
          fail(`${at}.options`, '選択肢を 2 つ以上にしてください')
          return
        }

        const optionIds = new Set<string>()
        let recommendedCount = 0
        question.options.forEach((option, optionIndex) => {
          const optionAt = `${at}.options[${optionIndex}]`
          if (!isRecord(option)) {
            fail(optionAt, 'オブジェクトにしてください')
            return
          }
          if (!isFilled(option.id)) {
            fail(`${optionAt}.id`, '空でない文字列にしてください')
          } else if (optionIds.has(option.id)) {
            fail(`${optionAt}.id`, `選択肢 ID "${option.id}" が重複しています`)
          } else {
            optionIds.add(option.id)
          }
          if (!isFilled(option.label)) fail(`${optionAt}.label`, '空でない文字列にしてください')
          if (!isFilled(option.pros)) fail(`${optionAt}.pros`, '利点 (選ぶ理由) を 1 行書いてください')
          if (!isFilled(option.cons)) fail(`${optionAt}.cons`, '代償を 1 行書いてください')
          if (option.recommended !== undefined && typeof option.recommended !== 'boolean') {
            fail(`${optionAt}.recommended`, 'true か false にしてください')
          }
          if (option.recommended === true) recommendedCount += 1
        })
        if (recommendedCount > 1) {
          fail(`${at}.options`, 'recommended: true は 1 問に 1 つまでにしてください')
        }
      })
    })

    if (questionCount < MIN_QUESTIONS) {
      fail('themes', `問いは全テーマ合わせて ${MIN_QUESTIONS}〜${MAX_QUESTIONS} 問にしてください (今は ${questionCount} 問)。決定だけを問う形に整理してください`)
    } else if (questionCount > MAX_QUESTIONS) {
      fail('themes', `問いは全テーマ合わせて ${MIN_QUESTIONS}〜${MAX_QUESTIONS} 問にしてください (今は ${questionCount} 問)。圧縮してください`)
    }
  }

  if (input.tables !== undefined) {
    if (!Array.isArray(input.tables)) {
      fail('tables', '配列にしてください')
    } else {
      const tableIds = new Set<string>()
      input.tables.forEach((table, tableIndex) => {
        const at = `tables[${tableIndex}]`
        if (!isRecord(table)) {
          fail(at, 'オブジェクトにしてください')
          return
        }
        if (!isFilled(table.id)) {
          fail(`${at}.id`, '空でない文字列にしてください')
        } else if (tableIds.has(table.id)) {
          fail(`${at}.id`, `表 ID "${table.id}" が重複しています`)
        } else {
          tableIds.add(table.id)
        }
        if (!isFilled(table.title)) fail(`${at}.title`, '空でない文字列にしてください')

        const columns = table.columns
        if (!Array.isArray(columns) || columns.length < 1 || columns.length > MAX_COLUMNS) {
          fail(`${at}.columns`, `列名を 1〜${MAX_COLUMNS} 個にしてください`)
          return
        }
        columns.forEach((column, columnIndex) => {
          if (typeof column !== 'string') fail(`${at}.columns[${columnIndex}]`, '文字列にしてください')
        })

        if (!Array.isArray(table.rows) || table.rows.length > MAX_ROWS) {
          fail(`${at}.rows`, `行を 0〜${MAX_ROWS} 行にしてください`)
        } else {
          table.rows.forEach((row, rowIndex) => {
            if (!Array.isArray(row) || row.length !== columns.length) {
              fail(`${at}.rows[${rowIndex}]`, `列数 (${columns.length}) と同じ長さの配列にしてください`)
              return
            }
            row.forEach((cell, cellIndex) => {
              if (typeof cell !== 'string') fail(`${at}.rows[${rowIndex}][${cellIndex}]`, '文字列にしてください')
            })
          })
        }

        if (table.editable !== undefined) {
          const editable = table.editable
          if (
            !Array.isArray(editable) ||
            editable.length !== columns.length ||
            !editable.every(flag => typeof flag === 'boolean')
          ) {
            fail(`${at}.editable`, `列数 (${columns.length}) と同じ長さの boolean 配列にしてください`)
          }
        }
      })
    }
  }

  if (input.globalNote !== undefined) {
    if (!isRecord(input.globalNote)) {
      fail('globalNote', 'オブジェクトにしてください')
    } else if (input.globalNote.label !== undefined && typeof input.globalNote.label !== 'string') {
      fail('globalNote.label', '文字列にしてください')
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, form: input as unknown as FormV1 }
}
