import { OUTLINE_TAGS, scanOutline } from '../form/outline'

/**
 * 指摘の画面に出す文書の HTML (`doc-desk/<label>.doc.html`) の規則。
 *
 * 要素は構成案と同じ許可リスト (`form/outline.ts`) です。属性は表の colspan と rowspan だけで、
 * 構成案の印 (`data-q`、`data-table`) は使えません。検証 (`documentErrors`) は Claude に直させるため、
 * 画面 (`sheet/render-review.ts`) の組み直しは人の画面を守るためのもので、どちらか一方には頼りません。
 */

/** 文書に使える要素 (構成案と同じ) */
export const DOCUMENT_TAGS = OUTLINE_TAGS

/** 要素ごとに使える属性。ここに無い要素は属性を持てません */
export const DOCUMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
}

/**
 * 1 回の指摘の画面に出せる文字数 (タグを含む HTML の文字数)。
 * これより長い文書は、Claude が節の切れ目で分けて何回かの画面に出します。
 */
export const MAX_DOCUMENT_LENGTH = 100000

/**
 * 段落番号を振る候補の要素。画面は、このうち自分の文字を持つもの (`pre` と `tr` は常に) に
 * 上から番号を振ります (`sheet/render-review.ts`)。
 */
export const BLOCK_TAGS = ['h2', 'h3', 'h4', 'p', 'li', 'dt', 'dd', 'pre', 'tr'] as const

const ALLOWED_TAGS: ReadonlySet<string> = new Set(DOCUMENT_TAGS)
const BLOCKS: ReadonlySet<string> = new Set(BLOCK_TAGS)

/**
 * 文書の HTML を検査し、直し方を書いたエラー文を返します (パスは付けません)。
 *
 * @param html `doc-desk/<label>.doc.html` の中身
 * @returns エラー文。問題が無ければ空
 */
export function documentErrors(html: string): string[] {
  const errors: string[] = []
  if (html.length > MAX_DOCUMENT_LENGTH) {
    errors.push(
      `${MAX_DOCUMENT_LENGTH} 文字以内にしてください (今は ${html.length} 文字、タグを含む)。` +
        '長い文書は節の切れ目で分け、part を付けて何回かの画面に分けて出します',
    )
  }

  const badTags = new Set<string>()
  const badAttributes = new Set<string>()
  let blockCount = 0

  for (const tag of scanOutline(html)) {
    if (!ALLOWED_TAGS.has(tag.name)) {
      badTags.add(tag.name)
      continue
    }
    if (!tag.closing && BLOCKS.has(tag.name)) {
      blockCount += 1
    }
    const allowed = DOCUMENT_ATTRIBUTES[tag.name] ?? []
    for (const attribute of tag.attributes) {
      if (!allowed.includes(attribute.name)) {
        badAttributes.add(`<${tag.name}> の ${attribute.name}`)
      }
    }
  }

  if (badTags.size > 0) {
    const names = [...badTags].map(name => `<${name}>`).join(', ')
    errors.push(`使えない要素 ${names} があります。使えるのは ${DOCUMENT_TAGS.join(', ')} です (文書の題名は title に書き、h1 は使いません)`)
  }
  if (badAttributes.size > 0) {
    errors.push(
      `使えない属性があります (${[...badAttributes].join(', ')})。` +
        '使えるのは th と td の colspan と rowspan だけです (class、style、id、href、data-* は使いません)',
    )
  }
  if (blockCount === 0) {
    errors.push(`段落がありません。本文は ${BLOCK_TAGS.join(', ')} のどれかで書きます`)
  }
  return errors
}
