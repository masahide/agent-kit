/**
 * Write ツールの引数 JSON を、断片のまま逐次読む状態機械 (docs/doc-desk/live-view-design.md の 2.2)。
 *
 * `turn.step` の `input` チャンクは `{"file_path":"...","content":"..."}` を途中で切った断片で届きます。
 * 全部届いてから `JSON.parse` するのでは「書きながら」見せられないので、1 文字ずつ読み、
 * `file_path` の値と `content` の追記分を取り出します。純粋関数で、状態は呼ぶ側が持ちます。
 */

/**
 * 読んでいる場所。
 *
 * - `start`: 最初の `{` を待つ
 * - `key`: キーの `"` か、`}` を待つ (`,` と空白は飛ばす)
 * - `colon`: キーの後の `:` を待つ
 * - `value`: 値の始まりを待つ
 * - `string`: 文字列 (キーか値) の中
 * - `skip`: 文字列でない値 (数、真偽、null、入れ子) を読み飛ばしている
 * - `after`: 値の後の `,` か `}` を待つ
 * - `done`: 閉じた (以後は読まない)
 */
type Phase = 'start' | 'key' | 'colon' | 'value' | 'string' | 'skip' | 'after' | 'done'

/**
 * 今読んでいる文字列が何か。`key` はキー、`file_path` と `content` は取り出す値、`other` は捨てる値。
 */
type Target = 'key' | 'file_path' | 'content' | 'other'

export type JsonStreamState = {
  readonly phase: Phase
  readonly target: Target
  /** 最後に読んだキー */
  readonly key: string
  /** 読みかけのキーか `file_path` の値 */
  readonly text: string
  /** 逃がしの途中: `\` の直後なら ''、`\u` の途中なら 'u' と読んだ 16 進 (0〜3 桁)、途中でなければ null */
  readonly escape: string | null
  /** `\uD800`〜`\uDBFF` を読み、対の下位を待っている上位サロゲート */
  readonly highSurrogate: string | null
  /** 読み飛ばしている値の入れ子の深さと、その中の文字列の状態 */
  readonly skipDepth: number
  readonly skipInString: boolean
  readonly skipEscaped: boolean
  /** 確定した `file_path`。まだなら null */
  readonly filePath: string | null
  /** `file_path` が確定する前に読んだ `content` */
  readonly heldContent: string
}

/**
 * 1 回の `feedJson` で読めたもの。
 */
export type JsonStreamOutput = {
  state: JsonStreamState
  /** この回に確定した `file_path`。確定しなかった回は null */
  filePath: string | null
  /** この回に読めた `content` の追記分 (`file_path` の確定前の分は、確定した回にまとめて出す) */
  content: string
}

export const initialJsonStream = (): JsonStreamState => ({
  phase: 'start',
  target: 'key',
  key: '',
  text: '',
  escape: null,
  highSurrogate: null,
  skipDepth: 0,
  skipInString: false,
  skipEscaped: false,
  filePath: null,
  heldContent: '',
})

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
const isSpace = (char: string): boolean => char === ' ' || char === '\n' || char === '\r' || char === '\t'

/**
 * JSON の断片を 1 つ読みます。
 *
 * `file_path` と `content` の順序は決め打ちしません。`content` が先に来たら `file_path` が確定するまで貯め、
 * 確定した回にまとめて出します (一致するかは呼ぶ側が決めます)。それ以外のキーは読み飛ばします。
 *
 * @param state 前の回の状態 (`initialJsonStream()` から始める)
 * @param piece `input` チャンクの `json`
 */
export function feedJson(state: JsonStreamState, piece: string): JsonStreamOutput {
  const s = { ...state }
  let content = ''
  let filePath: string | null = null

  const emit = (decoded: string) => {
    switch (s.target) {
      case 'content':
        if (s.filePath === null) {
          s.heldContent += decoded
        } else {
          content += decoded
        }
        return
      case 'key':
      case 'file_path':
        s.text += decoded
        return
      default:
        return
    }
  }

  // 上位サロゲートを持ったまま別の文字が来たら、上位をそのまま出してから続ける
  const put = (decoded: string) => {
    const code = decoded.charCodeAt(0)
    if (s.highSurrogate !== null) {
      const high = s.highSurrogate
      s.highSurrogate = null
      if (decoded.length === 1 && isLow(code)) {
        emit(high + decoded)
        return
      }
      emit(high)
    }
    if (decoded.length === 1 && isHigh(code)) {
      s.highSurrogate = decoded
      return
    }
    emit(decoded)
  }

  const endString = () => {
    if (s.highSurrogate !== null) {
      emit(s.highSurrogate)
      s.highSurrogate = null
    }
    if (s.target === 'key') {
      s.key = s.text
      s.phase = 'colon'
    } else {
      if (s.target === 'file_path' && s.filePath === null) {
        s.filePath = s.text
        filePath = s.text
        content += s.heldContent
        s.heldContent = ''
      }
      s.phase = 'after'
    }
    s.text = ''
  }

  for (let at = 0; at < piece.length; at += 1) {
    const char = piece[at]!
    switch (s.phase) {
      case 'start':
        if (char === '{') s.phase = 'key'
        break
      case 'key':
        if (char === '"') {
          s.phase = 'string'
          s.target = 'key'
          s.text = ''
        } else if (char === '}') {
          s.phase = 'done'
        }
        break
      case 'colon':
        if (char === ':') s.phase = 'value'
        break
      case 'value':
        if (isSpace(char)) break
        if (char === '"') {
          s.phase = 'string'
          s.target = s.key === 'file_path' ? 'file_path' : s.key === 'content' ? 'content' : 'other'
          s.text = ''
        } else {
          s.phase = 'skip'
          s.skipDepth = char === '{' || char === '[' ? 1 : 0
          s.skipInString = false
          s.skipEscaped = false
        }
        break
      case 'string':
        if (s.escape === null) {
          if (char === '\\') {
            s.escape = ''
          } else if (char === '"') {
            endString()
          } else {
            put(char)
          }
        } else if (s.escape === '') {
          if (char === 'u') {
            s.escape = 'u'
          } else {
            s.escape = null
            put(SIMPLE_ESCAPES[char] ?? char)
          }
        } else {
          // `\u` の 16 進 4 桁を集める (s.escape は 'u' と読んだ桁)
          const hex = s.escape.slice(1) + char
          if (hex.length < 4) {
            s.escape = `u${hex}`
          } else {
            s.escape = null
            const code = Number.parseInt(hex, 16)
            put(Number.isNaN(code) ? '' : String.fromCharCode(code))
          }
        }
        break
      case 'skip':
        if (s.skipInString) {
          if (s.skipEscaped) {
            s.skipEscaped = false
          } else if (char === '\\') {
            s.skipEscaped = true
          } else if (char === '"') {
            s.skipInString = false
          }
        } else if (char === '"') {
          s.skipInString = true
        } else if (char === '{' || char === '[') {
          s.skipDepth += 1
        } else if (char === '}' || char === ']') {
          if (s.skipDepth === 0) {
            // 数などの後に閉じた (この `}` は外側の閉じ)
            s.phase = char === '}' ? 'done' : 'skip'
          } else {
            s.skipDepth -= 1
            if (s.skipDepth === 0) s.phase = 'after'
          }
        } else if (char === ',' && s.skipDepth === 0) {
          s.phase = 'key'
        }
        break
      case 'after':
        if (char === ',') s.phase = 'key'
        else if (char === '}') s.phase = 'done'
        break
      case 'done':
        break
    }
  }
  return { state: s, filePath, content }
}
