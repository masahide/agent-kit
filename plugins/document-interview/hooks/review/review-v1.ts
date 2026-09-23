/**
 * 指摘モード (skills/document-interview/references/review-mode.md) のデータの形。
 *
 * Claude は書き上げた文書を HTML にして `interview/<label>.doc.html` に書き出し、
 * `open_review` ツールにこの形の `review` を渡します。Mod はそのファイルを読んで検査し、
 * 指摘の画面を出します。検証は `validate-review.ts` が行います。
 */
export type ReviewV1 = {
  /** 常に 1 */
  schemaVersion: 1
  /** 文書の識別子。`^[A-Za-z0-9_-]{1,64}$`。質問票と同じ documentId を使えます */
  documentId: string
  /** 同じ文書の何回目の指摘の画面か。1 以上の整数 */
  revision: number
  /** 画面の名前。証跡ファイルの名前に使い、文書の HTML は `interview/<label>.doc.html` から読みます */
  label: string
  /** 画面の上に出す文書の題名 */
  title: string
  /** 元の文書のパス (人に見せるだけ)。省略可 */
  source?: string
  /** 長い文書を分けて出すときの、何回目か (index) と全部で何回か (total)。省略可 */
  part?: { index: number; total: number }
}

/**
 * 人が付けた指摘 1 件。
 */
export type ReviewComment = {
  /** 段落番号 (1 から) */
  block: number
  /** チップ。付けなければ null */
  chip: string | null
  /** 段落の中で選んだ文字列。段落全体への指摘なら空 */
  quote: string
  /** コメント。無ければ空 */
  text: string
}

/**
 * ブラウザが POST する指摘の回答 JSON。
 */
export type ReviewAnswerV1 = {
  schemaVersion: 1
  kind: 'review'
  documentId: string
  revision: number
  /** 画面で付けた順 */
  comments: ReviewComment[]
  /** 指摘を付けた段落の文字列。キーは段落番号 */
  blocks: Record<string, string>
  globalNote?: string
  submittedAt?: string
}

/**
 * 指摘のチップ。docs/document-interview-mod/plan.md の「指摘モードの設計」で決めた 9 種です。
 */
export const REVIEW_CHIPS = [
  '短くする',
  '言い換える',
  '分かりやすく',
  '具体例を足す',
  '根拠が要る',
  '削る',
  '順序を入れ替える',
  '図を直す',
  'ここは良い',
] as const

/**
 * 直さずに残す指摘のチップ。
 */
export const KEEP_CHIP = 'ここは良い'
