import { REVIEW_CHIPS } from './review-v1'

/**
 * Claude が自分の文書に付けた指摘の候補 1 件。指摘の画面に出し、人が採用か却下を選びます。
 */
export type ReviewCandidate = {
  /** 段落番号 (1 から。0 は段落が分からない)。画面は `quote` をまずこの段落で探し、無ければ全段落で探します */
  block: number
  /** チップ (`REVIEW_CHIPS` のどれか。ライブ指摘は空) */
  chip: string
  /** 段落の中の直したい文字列。無ければ段落全体への候補 */
  quote: string
  /** 何をどう直すか (Claude の候補は 200 文字以内) */
  text: string
  /** `live` = ライブ表示で人が付け、まだ Claude に届けていなかった指摘。Claude の候補には無い */
  source?: 'live'
}

/**
 * ライブ表示で付けてまだ届けていない指摘を、指摘の画面の候補にします (段落は画面が `quote` で探す)。
 */
export const liveCandidatesOf = (comments: readonly { quote: string; text: string }[]): ReviewCandidate[] =>
  comments.map(comment => ({ block: 0, chip: '', quote: comment.quote.trim(), text: comment.text.trim(), source: 'live' as const }))

/**
 * 候補を作るか。plugin の設定 (`userConfig.selfReview`) とツールの入力 (`selfReview`) のどちらかが false なら作りません。
 *
 * @param options `register(on, options)` の options
 * @param input ツール `open_review` の入力の `selfReview`
 */
export const wantsSelfReview = (options: { selfReview?: unknown }, input: unknown): boolean =>
  options.selfReview !== false && input !== false

/** 候補の上限 */
export const MAX_CANDIDATES = 5
/** 候補の `text` と `quote` の上限 (文字) */
export const MAX_CANDIDATE_TEXT = 200

/** fork に渡す段落の文字の上限。長い段落は切って渡します */
const MAX_BLOCK_IN_PROMPT = 600

/**
 * document-lint.md (references/document-lint.md) の検査の要約。候補を探す観点として fork に渡します。
 */
const LINT_SUMMARY = [
  '- 決定: 結論を避けない、全方位肯定をしない、根拠のない強い評価を書かない、ヘッジを重ねない (S1〜S5)',
  '- 主体: モノに人の動作をさせない、翻訳調の分析動詞を使わない、一般論で済ませない (S6〜S8)',
  '- 構造: 見出しは名詞句、定型の書き出しと締めと予告を書かない、対比や否定で演出しない、事実の後に意義を付け足さない、並べる数は実際の数、書式を増やしすぎない (S9〜S14)',
  '- 語彙: 生成 AI が好む抽象語、比喩の定型、カタカナ語、冗長な文末、強調の副詞、接続詞の重ね、論文調の自称を避ける (S15〜S21)',
  '- 記号: ダッシュを使わない、かぎ括弧は画面の文言と引用だけ、中黒で 3 つ以上を並べない (S22〜S24)',
  '- ja-text-communication: 一文一義、主語を省かない、用語は初出で定義する、数値に単位と範囲を添える、推測と事実を分ける',
].join('\n')

/**
 * `$.model.fork` に渡す 1 問を組みます。fork は main の会話 (Claude が書いたばかりの文書を含む) の後ろに
 * この問いを足して答えるので、文書の全文は段落番号付きの一覧として渡します。
 *
 * @param blocks `numberedBlocks` の結果
 * @param title 文書の題名
 */
export function candidatePrompt(blocks: readonly { n: number; text: string }[], title: string): string {
  const numbered = blocks
    .map(({ n, text }) => {
      const flat = text.replace(/\s+/g, ' ').trim()
      return `#${n} ${flat.length > MAX_BLOCK_IN_PROMPT ? `${flat.slice(0, MAX_BLOCK_IN_PROMPT)}…` : flat}`
    })
    .join('\n')
  const chips = REVIEW_CHIPS.filter(chip => chip !== 'ここは良い').join('、')
  return [
    `あなたが書いた文書「${title}」を、人に見せる前に自分で見直します。下の段落一覧から、次の検査に反する段落を最大 ${MAX_CANDIDATES} 件選んでください。`,
    '',
    '検査:',
    LINT_SUMMARY,
    '',
    `チップ (種類) は次のどれか 1 つ: ${chips}`,
    '',
    '段落一覧 (#番号 本文):',
    numbered,
    '',
    '答えは JSON の配列だけにしてください。前置きも説明も書きません。各要素は次の形です。',
    `{"block": 段落番号, "chip": "チップ", "quote": "段落の中の直したい文字列 (段落全体なら空文字)", "text": "何をどう直すか (${MAX_CANDIDATE_TEXT} 文字以内)"}`,
    '直すところが無ければ [] と答えてください。',
  ].join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const CHIPS: ReadonlySet<string> = new Set(REVIEW_CHIPS)

const FENCE = /```(?:json)?\s*\n([\s\S]*?)```/g

/**
 * 候補の配列として読めるか: JSON の配列で、要素がすべてオブジェクト (空の配列は「候補なし」として読む)。
 * 前置きの `[1, 2]` や `["S3"]` のような配列は候補の配列とみなさない。
 */
const parseArray = (text: string): unknown[] | null => {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
      ? value
      : null
  } catch {
    return null
  }
}

/**
 * 返答の文から JSON の配列を探します。コードフェンスの中を先に試し、無ければ `[` の位置ごとに、
 * 後ろの `]` までを長い順に試します (前置きに `[S3]` のような括弧があっても、本体の配列を拾うため)。
 */
function jsonArrayOf(reply: string): unknown[] | null {
  for (const match of reply.matchAll(FENCE)) {
    const found = parseArray((match[1] ?? '').trim())
    if (found) {
      return found
    }
  }
  const closes: number[] = []
  for (let index = reply.indexOf(']'); index >= 0; index = reply.indexOf(']', index + 1)) {
    closes.push(index)
  }
  for (let start = reply.indexOf('['); start >= 0; start = reply.indexOf('[', start + 1)) {
    for (let at = closes.length - 1; at >= 0 && closes[at]! > start; at -= 1) {
      const found = parseArray(reply.slice(start, closes[at]! + 1))
      if (found) {
        return found
      }
    }
  }
  return null
}

/**
 * fork の返答から候補を取り出します。JSON の配列は `jsonArrayOf` で探し、
 * 形の合う候補だけを残します (段落番号が範囲外、知らないチップ、長すぎる文字、空の `text` は捨てる)。
 * 読めなければ空です。
 *
 * @param reply fork の返答の文
 * @param blockCount 段落の数
 */
export function parseCandidates(reply: string, blockCount: number): ReviewCandidate[] {
  const parsed = jsonArrayOf(reply)
  if (!parsed) {
    return []
  }
  const candidates: ReviewCandidate[] = []
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue
    }
    const { block, chip, quote, text } = item
    if (!Number.isInteger(block) || (block as number) < 1 || (block as number) > blockCount) {
      continue
    }
    if (typeof chip !== 'string' || !CHIPS.has(chip)) {
      continue
    }
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_CANDIDATE_TEXT) {
      continue
    }
    const quoted = typeof quote === 'string' ? quote.trim() : ''
    if (quoted.length > MAX_CANDIDATE_TEXT) {
      continue
    }
    candidates.push({ block: block as number, chip, quote: quoted, text: text.trim() })
    if (candidates.length === MAX_CANDIDATES) {
      break
    }
  }
  return candidates
}
