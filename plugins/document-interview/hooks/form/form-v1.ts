/**
 * 質問票 JSON スキーマ v1 (skills/document-interview/references/form-spec-v1.md)。
 *
 * Claude が `open_form` ツールに渡す形です。検証は `validate.ts` が行い、
 * 通ったものだけがこの型として扱われます。
 */
export type FormV1 = {
  /** 常に 1 */
  schemaVersion: 1
  /** 文書の識別子。`^[A-Za-z0-9_-]{1,64}$` */
  documentId: string
  /** 同じ文書の何枚目の質問票か。1 以上の整数 */
  revision: number
  /** 証跡ファイルの名前に使う。`^[A-Za-z0-9_-]{1,64}$` */
  label: string
  /** 主張のタイトル (内容の要約ではなく言い切り) */
  title: string
  /** 結論ボックスの本文。「結論:」で始まる 3 文以内 */
  conclusion: string
  /** 読者が知らない語だけ。省略可 */
  glossary?: GlossaryEntry[]
  /** テーマ (章)。1 つ以上 */
  themes: Theme[]
  /** 表。省略可 */
  tables?: Table[]
  /** 全体へのコメント欄のラベル。省略可 */
  globalNote?: { label?: string }
}

export type GlossaryEntry = {
  term: string
  definition: string
}

export type Theme = {
  id: string
  name: string
  questions: Question[]
}

export type Question = {
  id: string
  /** 問いの 1 文 */
  title: string
  /** 根拠。`file:line` か実行結果の引用。空は不可 */
  cite: string
  /** 選択肢。2 つ以上 */
  options: Option[]
  /** 補足入力欄の設定。省略可 */
  note?: { placeholder?: string }
}

export type Option = {
  id: string
  label: string
  /** 選ぶ理由 (利点)。空は不可 */
  pros: string
  /** 代償。空は不可 */
  cons: string
  /** 推奨案。1 問に高々 1 つ */
  recommended?: boolean
}

export type Table = {
  id: string
  title: string
  /** 列名。1〜6 */
  columns: string[]
  /** 行。0〜20 行。各行の長さは columns と同じ */
  rows: string[][]
  /** 編集できる列。columns と同じ長さ。省略時は全列 true */
  editable?: boolean[]
}

/**
 * ブラウザが POST する回答 JSON (references/reply-format-v1.md の「回答 JSON」)。
 */
export type AnswerV1 = {
  schemaVersion: 1
  documentId: string
  revision: number
  answers: Record<string, { choice: string | null; note: string }>
  tables?: Record<string, string[][]>
  globalNote?: string
  submittedAt?: string
}

/**
 * 質問票の全問を、テーマ順 → 問い順に平らに並べます。
 * 回答固定形の `Qn.` の通し番号はこの並びで振ります。
 */
export function questionsOf(form: FormV1): Question[] {
  return form.themes.flatMap(theme => theme.questions)
}
