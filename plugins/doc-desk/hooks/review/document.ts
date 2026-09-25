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
 * 段落の「自分の文字」に数える子の要素 (画面の JS の `INLINE` と同じ)。
 */
const INLINE_TAGS: ReadonlySet<string> = new Set(['strong', 'em', 'code', 'span', 'br'])

/**
 * 開くと、開いている `<p>` を閉じる要素 (HTML の構文解析の規則のうち、許可リストにあるもの)。
 */
const CLOSES_P: ReadonlySet<string> = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'dl', 'pre', 'table', 'blockquote', 'hr', 'div'])

/**
 * 開くと、同じ種類の開いている要素を閉じる要素と、その閉じ方の境目。
 * 例: `<li>` は、`<ul>` か `<ol>` の手前までにある開いた `<li>` を閉じます。
 */
const CLOSES_SIBLING: Readonly<Record<string, { siblings: readonly string[]; boundary: readonly string[] }>> = {
  li: { siblings: ['li'], boundary: ['ul', 'ol'] },
  dt: { siblings: ['dt', 'dd'], boundary: ['dl'] },
  dd: { siblings: ['dt', 'dd'], boundary: ['dl'] },
  tr: { siblings: ['tr'], boundary: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { siblings: ['td', 'th'], boundary: ['tr', 'table'] },
  th: { siblings: ['td', 'th'], boundary: ['tr', 'table'] },
}

const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'wbr'])

type DocNode = { kind: 'text'; text: string } | { kind: 'element'; name: string; children: DocNode[] }

/**
 * 名前付きの文字参照のうち、文書に出やすいもの。ここに無い名前はそのまま残します
 * (ブラウザは復号するので、その段落の文字列は画面とずれますが、段落番号はずれません)。
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '\u00ab',
  raquo: '\u00bb',
  middot: '\u00b7',
  bull: '\u2022',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  deg: '\u00b0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  yen: '\u00a5',
  euro: '\u20ac',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  rArr: '\u21d2',
  hArr: '\u21d4',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
}

/**
 * 数値の文字参照を文字にします。0、サロゲート、範囲外 (0x10FFFF 超) はブラウザと同じく U+FFFD にします
 * (`String.fromCodePoint` が投げてフック全体が落ちないように)。
 */
const codePointOf = (value: number): string =>
  Number.isFinite(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '\ufffd'

const decodeEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointOf(Number.parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) {
      return codePointOf(Number.parseInt(body.slice(1), 10))
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole
  })

/**
 * 文書の HTML を木にします。ブラウザの DOMParser と同じ段落の並びになるよう、許可リストの要素に
 * 効く暗黙の閉じ (`<p>`、`<li>`、`<dt>`/`<dd>`、`<tr>`、`<td>`/`<th>`) だけを真似ます。
 * 許可リストに無い要素は、画面と同じく中身ごと捨てます。
 */
function parseDocument(html: string): DocNode[] {
  const root: DocNode & { kind: 'element' } = { kind: 'element', name: '#root', children: [] }
  const stack: (DocNode & { kind: 'element' })[] = [root]
  let skipDepth = 0
  const top = () => stack[stack.length - 1]!
  const closeUpTo = (index: number) => {
    stack.length = index
  }
  const findOpen = (names: readonly string[], boundary: readonly string[]): number => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const name = stack[index]!.name
      if (names.includes(name)) {
        return index
      }
      if (boundary.includes(name)) {
        return -1
      }
    }
    return -1
  }

  const source = html.replace(/<!--[\s\S]*?-->/g, '')
  const TOKEN = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>|([^<]+|<)/g
  for (const match of source.matchAll(TOKEN)) {
    const text = match[4]
    if (text !== undefined) {
      if (skipDepth === 0) {
        const parent = top()
        // <pre> の直後の改行 1 つは HTML の規則で捨てる
        const value = decodeEntities(parent.name === 'pre' && parent.children.length === 0 ? text.replace(/^\r?\n/, '') : text)
        if (value !== '') {
          parent.children.push({ kind: 'text', text: value })
        }
      }
      continue
    }
    const isClosing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    const isSelfClosing = /\/\s*$/.test(match[3] ?? '')

    if (!ALLOWED_TAGS.has(name)) {
      if (!VOID_TAGS.has(name) && !isSelfClosing) {
        skipDepth = Math.max(0, skipDepth + (isClosing ? -1 : 1))
      }
      continue
    }
    if (skipDepth > 0) {
      continue
    }

    if (isClosing) {
      const index = findOpen([name], [])
      if (index > 0) {
        closeUpTo(index)
      }
      continue
    }

    if (CLOSES_P.has(name)) {
      const index = findOpen(['p'], ['table', 'td', 'th', 'li', 'dd', 'dt'])
      if (index > 0) {
        closeUpTo(index)
      }
    }
    const rule = CLOSES_SIBLING[name]
    if (rule) {
      const index = findOpen(rule.siblings, rule.boundary)
      if (index > 0) {
        closeUpTo(index)
      }
    }
    const element: DocNode & { kind: 'element' } = { kind: 'element', name, children: [] }
    top().children.push(element)
    if (!VOID_TAGS.has(name) && !isSelfClosing) {
      stack.push(element)
    }
  }
  return root.children
}

const textContentOf = (node: DocNode): string =>
  node.kind === 'text' ? node.text : node.children.map(textContentOf).join('')

/** 直下の文字と、直下の強調やコードの文字 (画面の JS の `ownText`) */
const ownTextOf = (element: DocNode & { kind: 'element' }): string =>
  element.children
    .map(child =>
      child.kind === 'text' ? child.text : INLINE_TAGS.has(child.name) ? (child.name === 'br' ? ' ' : textContentOf(child)) : '',
    )
    .join('')

/**
 * 段落番号と段落の文字列。画面 (`sheet/render-review.ts` の JS) が振る番号と同じ規則で振ります:
 * `BLOCK_TAGS` の要素を上から順に、自分の文字を持つもの (`pre` と `tr` は常に) だけ数えます。
 * 表の行は各セルの文字を ` | ` でつなぎ、`pre` は文字をそのまま、それ以外は空白を 1 つに畳みます。
 *
 * @param html `doc-desk/<label>.doc.html` の中身 (検査済み)
 * @returns 段落 (番号は 1 から)
 */
export function numberedBlocks(html: string): { n: number; text: string }[] {
  const blocks: { n: number; text: string }[] = []
  const visit = (nodes: readonly DocNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'element') {
        continue
      }
      if (BLOCKS.has(node.name)) {
        const isAlways = node.name === 'pre' || node.name === 'tr'
        const own = ownTextOf(node)
        if (isAlways || own.trim() !== '') {
          const text =
            node.name === 'tr'
              ? node.children
                  .filter(child => child.kind === 'element')
                  .map(cell => textContentOf(cell).trim())
                  .join(' | ')
              : node.name === 'pre'
                ? textContentOf(node)
                : own.replace(/\s+/g, ' ').trim()
          if (text.trim() !== '') {
            blocks.push({ n: blocks.length + 1, text })
          }
        }
      }
      visit(node.children)
    }
  }
  visit(parseDocument(html))
  return blocks
}

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
