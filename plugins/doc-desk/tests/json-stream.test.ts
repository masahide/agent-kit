import { describe, expect, test, tier } from 'claude-code/testing'

import { feedJson, initialJsonStream } from '../hooks/live/json-stream'

tier('user')

/**
 * 断片の列を順に読み、確定した `file_path` と `content` の全部を返します。
 */
function readAll(pieces: readonly string[]): { filePath: string | null; content: string; paths: number } {
  let state = initialJsonStream()
  let filePath: string | null = null
  let content = ''
  let paths = 0
  for (const piece of pieces) {
    const out = feedJson(state, piece)
    state = out.state
    if (out.filePath !== null) {
      filePath = out.filePath
      paths += 1
    }
    content += out.content
  }
  return { filePath, content, paths }
}

/** 文字列を n 文字ずつに切ります (サロゲートの途中でも切る) */
const chunked = (text: string, size: number): string[] => {
  const pieces: string[] = []
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size))
  return pieces
}

const CONTENT = '# 認証\n\n"OIDC" に統一します\\ 😀\tタブ\u00e9'
const JSON_TEXT = JSON.stringify({ file_path: 'C:\\work\\docs\\spec.md', content: CONTENT })

describe('json-stream', () => {
  test('一度に渡しても、1 文字ずつでも、同じ file_path と content になる', () => {
    const whole = readAll([JSON_TEXT])
    expect(whole).toEqual({ filePath: 'C:\\work\\docs\\spec.md', content: CONTENT, paths: 1 })
    expect(readAll(chunked(JSON_TEXT, 1))).toEqual(whole)
    for (const size of [2, 3, 5, 7, 13]) {
      expect(readAll(chunked(JSON_TEXT, size)), `${size} 文字ずつ`).toEqual(whole)
    }
  })

  test('\\" と \\\\ の途中、\\u の途中、サロゲートの途中で切れても解ける', () => {
    const escaped = JSON.stringify({ file_path: 'a.md', content: 'x"y\\z\u00e9😀' })
    // \u00e9 を ASCII の逃がしにした JSON (API はこの形で送ることがある)
    const ascii = escaped.replace('é', '\\u00e9').replace('😀', '\\ud83d\\ude00')
    expect(ascii).toContain('\\ud83d\\ude00')
    const at = (needle: string, offset: number) => ascii.indexOf(needle) + offset
    const cuts = [at('\\"', 1), at('\\\\', 1), at('\\u00e9', 3), at('\\ud83d', 6), at('\\ude00', 2)]
    const pieces: string[] = []
    let from = 0
    for (const cut of cuts) {
      pieces.push(ascii.slice(from, cut))
      from = cut
    }
    pieces.push(ascii.slice(from))
    expect(readAll(pieces)).toEqual({ filePath: 'a.md', content: 'x"y\\z\u00e9😀', paths: 1 })
    expect(readAll(chunked(ascii, 1)).content).toBe('x"y\\z\u00e9😀')
  })

  test('content が先に来たら file_path が確定するまで貯め、確定した回にまとめて出す', () => {
    const text = JSON.stringify({ content: 'abc\ndef', file_path: 'b.md' })
    let state = initialJsonStream()
    const outputs: { filePath: string | null; content: string }[] = []
    for (const piece of chunked(text, 4)) {
      const out = feedJson(state, piece)
      state = out.state
      outputs.push({ filePath: out.filePath, content: out.content })
    }
    const before = outputs.slice(0, outputs.findIndex(out => out.filePath !== null))
    expect(before.every(out => out.content === ''), 'file_path の前は何も出さない').toBe(true)
    expect(outputs.find(out => out.filePath !== null)).toEqual({ filePath: 'b.md', content: 'abc\ndef' })
  })

  test('content 以外のキー (文字列、数、入れ子) は読み飛ばす', () => {
    const text = JSON.stringify({
      note: 'content は "ここ" ではない',
      depth: 3,
      nested: { content: 'x', list: [1, '}', { a: ']' }] },
      flag: true,
      file_path: 'c.md',
      content: '本文',
      tail: null,
    })
    expect(readAll(chunked(text, 3))).toEqual({ filePath: 'c.md', content: '本文', paths: 1 })
  })

  test('空白と改行の入った JSON も読む。file_path の無い JSON は何も出さない', () => {
    expect(readAll(['{ "file_path" :\n "d.md" ,\n  "content" : "x" }'])).toEqual({ filePath: 'd.md', content: 'x', paths: 1 })
    expect(readAll(['{"content":"x"}'])).toEqual({ filePath: null, content: '', paths: 0 })
  })

  test('Edit の引数 (content が無い) からも file_path を取り出す', () => {
    const text = JSON.stringify({ file_path: 'e.md', old_string: 'a', new_string: 'b' })
    expect(readAll(chunked(text, 2))).toEqual({ filePath: 'e.md', content: '', paths: 1 })
  })
})
