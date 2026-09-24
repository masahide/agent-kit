import { describe, expect, test, tier } from 'claude-code/testing'

import { parseStartOutput, receiverArgv } from '../hooks/receiver'

tier('user')

describe('receiver', () => {
  test('parseStartOutput: 最初の空でない行の {"port", "pid"} を読む。CRLF も読む', () => {
    expect(parseStartOutput('{"port": 50123, "pid": 42}\n')).toEqual({ port: 50123, pid: 42 })
    expect(parseStartOutput('\r\n{"port": 50123, "pid": 42}\r\n')).toEqual({ port: 50123, pid: 42 })
  })

  test('parseStartOutput: 空、JSON でない、欄が欠ける、0 以下、整数でないなら null', () => {
    expect(parseStartOutput('')).toBeNull()
    expect(parseStartOutput('started\n')).toBeNull()
    expect(parseStartOutput('{"port": 50123')).toBeNull()
    expect(parseStartOutput('{"port": 50123}')).toBeNull()
    expect(parseStartOutput('{"port": 0, "pid": 42}')).toBeNull()
    expect(parseStartOutput('{"port": 1.5, "pid": 42}')).toBeNull()
    expect(parseStartOutput('[50123, 42]')).toBeNull()
  })

  test('receiverArgv: --port は使いたい port があるときだけ付ける。--port-file は付けない', () => {
    const paths = { pluginRoot: '/p', html: '/w/a.html', out: '/w/a.answer.json' }
    const plain = receiverArgv(['python3'], paths, 'tok')
    expect(plain).toEqual(['python3', '/p/scripts/receiver.py', 'start', '--token', 'tok', '--html', '/w/a.html', '--out', '/w/a.answer.json'])
    expect(receiverArgv(['py', '-3'], paths, 'tok', 50123).slice(-2)).toEqual(['--port', '50123'])
  })
})
