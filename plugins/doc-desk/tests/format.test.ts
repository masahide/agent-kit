import { describe, expect, test, tier } from 'claude-code/testing'

import { formatReply } from '../hooks/reply/format'
import Fixtures from './fixtures'

tier('user')

describe('format', () => {
  test('表・補足・全体コメントがある回答 (ゴールデン)', async () => {
    expect(formatReply(Fixtures.FORM, Fixtures.ANSWER_FULL)).toBe(Fixtures.REPLY_FULL)
  })

  test('表の無い質問票と補足の無い回答: ## 表 も 全体へのコメント も出ない', async () => {
    expect(formatReply(Fixtures.FORM_NO_TABLES, Fixtures.ANSWER_BARE)).toBe(Fixtures.REPLY_BARE)
  })

  test('表あり・補足なし・全体コメントは複数行のまま、セルの | は逃がす', async () => {
    expect(formatReply(Fixtures.FORM, Fixtures.ANSWER_TABLE_ONLY)).toBe(Fixtures.REPLY_TABLE_ONLY)
  })

  test('全体コメント無し、未選択で補足だけ、無い ID は無視、無い問いは未選択、補足の改行は空白に畳む', async () => {
    expect(formatReply(Fixtures.FORM, Fixtures.ANSWER_NO_GLOBAL)).toBe(Fixtures.REPLY_NO_GLOBAL)
  })

  test('回答に answers が無くても全問未選択として整形する', async () => {
    const text = formatReply(Fixtures.FORM_NO_TABLES, {
      schemaVersion: 1,
      documentId: 'spec-auth-01',
      revision: 1,
      answers: {},
    })
    expect(text.split('\n').slice(0, 3)).toEqual([
      '【doc-desk 回答】spec-auth-01',
      'Q1. 既存ユーザーの移行をどう扱いますか: (未選択 = お任せ)',
      'Q2. ログの保持期間: (未選択 = お任せ)',
    ])
    expect(text.endsWith('\n---\n上の回答を反映して文書を作成してください。お任せの項目は推奨案で確定してください。')).toBe(true)
  })

  test('質問票に無い選択肢 ID は未選択として扱う', async () => {
    const text = formatReply(Fixtures.FORM_NO_TABLES, {
      schemaVersion: 1,
      documentId: 'spec-auth-01',
      revision: 1,
      answers: { q1: { choice: 'Z', note: '' }, q2: { choice: 'B', note: '' } },
    })
    expect(text).toContain('Q1. 既存ユーザーの移行をどう扱いますか: (未選択 = お任せ)\n')
    expect(text).toContain('Q2. ログの保持期間: B — 1 年\n')
  })
})
