import type { On } from 'claude-code'

export function register(on: On) {
  const results: Record<string, unknown> = {}
  let writeFile: ((text: string) => Promise<void>) | null = null
  const note = async (key: string, value: unknown) => {
    results[key] = value
    try { await writeFile?.(JSON.stringify(results, null, 2)) } catch {}
  }

  on('session.start', async ($, e, next) => {
    writeFile = text => $.fs.write('spikes/mods-spike-v3/results-v3.json', text)
    for (const name of ['wait_string', 'wait_blocks', 'wait_content']) {
      try {
        await $.tool.register({ name, description: `Spike V3 (${name}): waits 3 seconds and returns a result. No arguments.`, inputSchema: { type: 'object', properties: {} } })
        await note(`register_${name}`, 'ok')
      } catch (err) {
        await note(`register_${name}`, String(err))
      }
    }
    return next(e)
  })

  const payload = (name: string, elapsedMs: number) => JSON.stringify({ tool: name, elapsedMs, answers: { q1: 'A' } })

  on('tool.call', { tool: 'mcp__spike3__wait_string' }, async ($, e) => {
    const t0 = await $.clock.now()
    await $.process.run(['sleep', '3'], { timeoutMs: 30000 })
    const elapsedMs = (await $.clock.now()) - t0
    await note('call_wait_string', { elapsedMs })
    return { result: payload('wait_string', elapsedMs) }
  })

  on('tool.call', { tool: 'mcp__spike3__wait_blocks' }, async ($, e) => {
    const t0 = await $.clock.now()
    await $.process.run(['sleep', '3'], { timeoutMs: 30000 })
    const elapsedMs = (await $.clock.now()) - t0
    await note('call_wait_blocks', { elapsedMs })
    return { result: [{ type: 'text', text: payload('wait_blocks', elapsedMs) }] }
  })

  on('tool.call', { tool: 'mcp__spike3__wait_content' }, async ($, e) => {
    const t0 = await $.clock.now()
    await $.process.run(['sleep', '3'], { timeoutMs: 30000 })
    const elapsedMs = (await $.clock.now()) - t0
    await note('call_wait_content', { elapsedMs })
    return { result: { content: [{ type: 'text', text: payload('wait_content', elapsedMs) }] } }
  })
}
