/**
 * 構成案 (`form.outline`) の HTML の規則。
 *
 * 検証 (`validate.ts`) はここの許可リストで Claude の HTML を検査し、違反をエラーで返します。
 * 画面 (`sheet/render-html.ts`) は同じ許可リストをブラウザの JS に渡し、DOMParser で解析した
 * HTML を許可した要素と属性だけで組み直して描きます。検証は Claude に直させるため、
 * 組み直しは人の画面を守るためのもので、どちらか一方には頼りません。
 */

/** 構成案に使える要素 */
export const OUTLINE_TAGS = [
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'strong',
  'em',
  'code',
  'pre',
  'blockquote',
  'br',
  'hr',
  'span',
  'div',
] as const

/** 要素ごとに使える属性。ここに無い要素は属性を持てません */
export const OUTLINE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  span: ['data-q'],
  div: ['data-table'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
}

/** 構成案の文字数の上限 */
export const MAX_OUTLINE_LENGTH = 20000

/**
 * 構成案の中の 1 つのタグ (開始タグか終了タグ)。
 */
export type OutlineTag = {
  name: string
  closing: boolean
  attributes: { name: string; value: string }[]
}

const COMMENT = /<!--[\s\S]*?-->/g
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/**
 * 構成案のタグを出てきた順に拾います。検証のための簡易な走査で、HTML として厳密に
 * 解析するものではありません (画面では DOMParser で解析し直します)。
 *
 * @param html 構成案の HTML
 * @returns タグの並び (コメントの中は除く)
 */
export function scanOutline(html: string): OutlineTag[] {
  return [...html.replace(COMMENT, '').matchAll(TAG)].map(match => ({
    name: (match[2] ?? '').toLowerCase(),
    closing: match[1] === '/',
    attributes:
      match[1] === '/'
        ? []
        : [...(match[3] ?? '').matchAll(ATTRIBUTE)].map(attribute => ({
            name: (attribute[1] ?? '').toLowerCase(),
            value: attribute[2] ?? attribute[3] ?? attribute[4] ?? '',
          })),
  }))
}

const ALLOWED_TAGS: ReadonlySet<string> = new Set(OUTLINE_TAGS)

/**
 * 構成案を検査し、直し方を書いたエラー文を返します (パスは付けません)。
 *
 * - 使える要素と属性だけか
 * - 印 (`data-q`, `data-table`) の ID が質問票にあるか
 * - 問いはどれも 1 回以上、表はどれもちょうど 1 回、印が置かれているか
 *
 * @param outline 構成案の HTML
 * @param questionIds 質問票の問い ID
 * @param tableIds 質問票の表 ID
 * @returns エラー文。問題が無ければ空
 */
export function outlineErrors(
  outline: string,
  questionIds: readonly string[],
  tableIds: readonly string[],
): string[] {
  const errors: string[] = []
  if (outline.length > MAX_OUTLINE_LENGTH) {
    errors.push(`${MAX_OUTLINE_LENGTH} 文字以内にしてください (今は ${outline.length} 文字)。本文ではなく見出しと各節の要旨だけを書きます`)
  }

  const badTags = new Set<string>()
  const badAttributes = new Set<string>()
  const unknownQuestions = new Set<string>()
  const unknownTables = new Set<string>()
  const questionAnchors = new Map<string, number>()
  const tableAnchors = new Map<string, number>()

  for (const tag of scanOutline(outline)) {
    if (!ALLOWED_TAGS.has(tag.name)) {
      badTags.add(tag.name)
      continue
    }
    const allowed = OUTLINE_ATTRIBUTES[tag.name] ?? []
    for (const attribute of tag.attributes) {
      if (!allowed.includes(attribute.name)) {
        badAttributes.add(`<${tag.name}> の ${attribute.name}`)
      } else if (attribute.name === 'data-q') {
        if (questionIds.includes(attribute.value)) {
          questionAnchors.set(attribute.value, (questionAnchors.get(attribute.value) ?? 0) + 1)
        } else {
          unknownQuestions.add(attribute.value)
        }
      } else if (attribute.name === 'data-table') {
        if (tableIds.includes(attribute.value)) {
          tableAnchors.set(attribute.value, (tableAnchors.get(attribute.value) ?? 0) + 1)
        } else {
          unknownTables.add(attribute.value)
        }
      }
    }
  }

  if (badTags.size > 0) {
    const names = [...badTags].map(name => `<${name}>`).join(', ')
    errors.push(`使えない要素 ${names} があります。使えるのは ${OUTLINE_TAGS.join(', ')} です`)
  }
  if (badAttributes.size > 0) {
    errors.push(
      `使えない属性があります (${[...badAttributes].join(', ')})。` +
        '使えるのは span の data-q、div の data-table、th と td の colspan と rowspan だけです',
    )
  }
  for (const id of unknownQuestions) {
    errors.push(`data-q="${id}" の問いがありません。印の ID は問いの id と同じにしてください`)
  }
  for (const id of questionIds) {
    if (!questionAnchors.has(id)) {
      errors.push(`問い "${id}" の印 <span data-q="${id}"></span> がありません。未確定事項は、構成案の中のその決定で文が変わる箇所に置いてください`)
    }
  }
  for (const id of unknownTables) {
    errors.push(`data-table="${id}" の表がありません。印の ID は表の id と同じにしてください`)
  }
  for (const id of tableIds) {
    const count = tableAnchors.get(id) ?? 0
    if (count === 0) {
      errors.push(`表 "${id}" の印 <div data-table="${id}"></div> がありません。表を置く節に 1 つ置いてください`)
    } else if (count > 1) {
      errors.push(`表 "${id}" の印が ${count} 個あります。1 つにしてください`)
    }
  }
  return errors
}
