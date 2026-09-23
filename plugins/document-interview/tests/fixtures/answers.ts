import type { AnswerV1 } from '../../hooks/form/form-v1'
import { REPLY_CLOSING } from '../../hooks/reply/format'

/**
 * 表・補足・全体コメントがすべてある回答 (mvp-design.md 7 章の例)。
 */
export const ANSWER_FULL: AnswerV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  answers: {
    q1: { choice: 'A', note: '管理者だけ先行' },
    q2: { choice: null, note: '' },
  },
  tables: {
    tb1: [
      ['トップ', '不要', ''],
      ['設定', '必要', '二段階認証も'],
    ],
  },
  globalNote: '移行の告知文も欲しい',
  submittedAt: '2026-09-22T12:34:56.000Z',
}

/**
 * ANSWER_FULL から期待する固定形 (mvp-design.md 8 章のゴールデン)。
 */
export const REPLY_FULL = [
  '【インタビュー回答】spec-auth-01',
  'Q1. 既存ユーザーの移行をどう扱いますか: A — 初回ログイン時に自動移行 / 補足: 管理者だけ先行',
  'Q2. ログの保持期間: (未選択 = お任せ)',
  '## 表',
  '### 画面ごとの認証要否',
  '| 画面 | 認証 | 備考 |',
  '|---|---|---|',
  '| トップ | 不要 | |',
  '| 設定 | 必要 | 二段階認証も |',
  '全体へのコメント: 移行の告知文も欲しい',
  '---',
  REPLY_CLOSING,
].join('\n')

/**
 * 補足なし、表なし、全体コメントなし (表の無い質問票に対する回答)。
 */
export const ANSWER_BARE: AnswerV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  answers: {
    q1: { choice: 'B', note: '' },
    q2: { choice: 'A', note: '' },
  },
  tables: {},
  globalNote: '',
}

export const REPLY_BARE = [
  '【インタビュー回答】spec-auth-01',
  'Q1. 既存ユーザーの移行をどう扱いますか: B — 全員に再登録を求める',
  'Q2. ログの保持期間: A — 90 日',
  '---',
  REPLY_CLOSING,
].join('\n')

/**
 * 表はあるが補足なし。全体コメントは複数行。
 */
export const ANSWER_TABLE_ONLY: AnswerV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  answers: {
    q1: { choice: 'A', note: '' },
    q2: { choice: 'B', note: '' },
  },
  tables: {
    tb1: [
      ['トップ', '不要', 'a|b'],
      ['設定', '必要', ''],
    ],
  },
  globalNote: '1 行目\n2 行目',
}

export const REPLY_TABLE_ONLY = [
  '【インタビュー回答】spec-auth-01',
  'Q1. 既存ユーザーの移行をどう扱いますか: A — 初回ログイン時に自動移行',
  'Q2. ログの保持期間: B — 1 年',
  '## 表',
  '### 画面ごとの認証要否',
  '| 画面 | 認証 | 備考 |',
  '|---|---|---|',
  '| トップ | 不要 | a\\|b |',
  '| 設定 | 必要 | |',
  '全体へのコメント: 1 行目\n2 行目',
  '---',
  REPLY_CLOSING,
].join('\n')

/**
 * 全体コメント無し。未選択で補足だけの問い、質問票に無い ID、回答に無い問い、改行入りの補足。
 */
export const ANSWER_NO_GLOBAL: AnswerV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  answers: {
    q1: { choice: null, note: '決めかねて\nいます' },
    q9: { choice: 'A', note: '質問票に無い ID' },
  },
  tables: {
    tb1: [['トップ', '不要', '']],
    tb9: [['無い表']],
  },
  globalNote: '   ',
}

export const REPLY_NO_GLOBAL = [
  '【インタビュー回答】spec-auth-01',
  'Q1. 既存ユーザーの移行をどう扱いますか: (未選択 = お任せ) / 補足: 決めかねて います',
  'Q2. ログの保持期間: (未選択 = お任せ)',
  '## 表',
  '### 画面ごとの認証要否',
  '| 画面 | 認証 | 備考 |',
  '|---|---|---|',
  '| トップ | 不要 | |',
  '| 設定 | | |',
  '---',
  REPLY_CLOSING,
].join('\n')
