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
 * 人がその場で直した 1 件 (添削)。段落番号は画面が振った番号です。
 *
 * - `rewrite`: 段落の文字を `text` に書き換える (書式なしの文)
 * - `delete`: 段落を消す
 * - `move`: 段落を、段落 `to` の後へ動かす
 * - `add`: 段落の下に、`text` の段落を足す
 *
 * `rewrite` と `add` の `mode` は、`text` の使い方です。`exact` は一字一句そのまま使い、
 * `guide` は人の意図の見本として、Claude が前後の文に合わせて直します。
 */
export type ReviewEdit =
  | { kind: 'rewrite'; block: number; text: string; mode: EditMode }
  | { kind: 'delete'; block: number }
  | { kind: 'move'; block: number; to: number }
  | { kind: 'add'; block: number; text: string; mode: EditMode }

/**
 * 書き換えた文と足した文の使い方。`exact` = そのまま使う (既定)、`guide` = 参考にして直す。
 */
export type EditMode = 'exact' | 'guide'

/**
 * 回答に書く、使い方の名前。
 */
export const EDIT_MODE_LABELS: Readonly<Record<EditMode, string>> = {
  exact: 'そのまま',
  guide: '参考にして直す',
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
  /** 人がその場で直したもの (添削)。画面で付けた順 */
  edits: ReviewEdit[]
  /** 指摘か添削を付けた段落の文字列。キーは段落番号 */
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
