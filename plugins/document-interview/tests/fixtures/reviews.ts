import { REVIEW_CLOSING } from '../../hooks/review/format'
import type { ReviewAnswerV1, ReviewV1 } from '../../hooks/review/review-v1'

/**
 * 指摘の画面に出す文書の HTML (`interview/spec-auth-01-review.doc.html`)。
 * 段落番号は 1: 見出し、2: 段落、3: 箇条書きの項目、4: 表の見出し行、5: 表の本文の行。
 */
export const DOC_HTML = [
  '<h2>認証方式</h2>',
  '<p>認証は <strong>OIDC</strong> に統一します。</p>',
  '<ul><li>既存ユーザーは初回ログイン時に移行します。</li></ul>',
  '<table><thead><tr><th>画面</th><th>認証</th></tr></thead><tbody><tr><td>設定</td><td>必要</td></tr></tbody></table>',
].join('\n')

/**
 * 文書の HTML のパス (セッションの cwd は /work)。
 */
export const DOC_PATH = '/work/interview/spec-auth-01-review.doc.html'

/**
 * 指摘の画面。
 */
export const REVIEW: ReviewV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  label: 'spec-auth-01-review',
  title: '認証方式の仕様',
  source: 'docs/spec-auth.md',
}

/**
 * 段落の指摘、文字列の指摘、チップの無い指摘、「ここは良い」、全体コメントがある回答。
 * 最後の 1 件はチップもコメントも無いので捨てられます。
 */
export const REVIEW_ANSWER: ReviewAnswerV1 = {
  schemaVersion: 1,
  kind: 'review',
  documentId: 'spec-auth-01',
  revision: 1,
  comments: [
    { block: 2, chip: '根拠が要る', quote: 'OIDC に統一', text: 'なぜ OIDC か\nを足して' },
    { block: 1, chip: 'ここは良い', quote: '', text: '' },
    { block: 2, chip: null, quote: '', text: '言い切りすぎ' },
    { block: 3, chip: null, quote: '', text: '  ' },
  ],
  blocks: { '1': '認証方式', '2': '認証は OIDC に統一します。', '3': '既存ユーザーは初回ログイン時に移行します。' },
  globalNote: '全体に短く',
  submittedAt: '2026-09-23T12:34:56.000Z',
}

/**
 * REVIEW_ANSWER から期待する固定形。
 */
export const REVIEW_REPLY = [
  '【インタビュー回答】spec-auth-01',
  '対象: interview/spec-auth-01-review.doc.html',
  '## 指摘',
  '#1 [ここは良い]',
  '#2 [根拠が要る] 「OIDC に統一」 なぜ OIDC か を足して',
  '#2 言い切りすぎ',
  '## 指摘した段落',
  '#1 認証方式',
  '#2 認証は OIDC に統一します。',
  '全体へのコメント: 全体に短く',
  '---',
  REVIEW_CLOSING,
].join('\n')

/**
 * 指摘が 1 つも無い回答と、その固定形。
 */
export const REVIEW_ANSWER_EMPTY: ReviewAnswerV1 = {
  schemaVersion: 1,
  kind: 'review',
  documentId: 'spec-auth-01',
  revision: 1,
  comments: [],
  blocks: {},
  globalNote: '',
}

export const REVIEW_REPLY_EMPTY = [
  '【インタビュー回答】spec-auth-01',
  '対象: interview/spec-auth-01-review.doc.html',
  '## 指摘',
  '(指摘なし)',
  '---',
  REVIEW_CLOSING,
].join('\n')
