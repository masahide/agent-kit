import type { On } from 'claude-code'

type Results = Record<string, unknown>

/**
 * 検証項目
 *  V1 タイマーの中で 15 秒の $.process.run (フック予算 10 秒を超える) が完走するか
 *  V2 切り離した子 (nohup ... &) で $.process.run がすぐ戻るか
 *  V3 tool.call の中で 20 秒待ってからツール結果を返せるか (同期型)
 *  V4 受信サーバを起動し、フォームを GET、回答を POST、回答ファイルを検知できるか
 *  V5 回答検知後に $.prompt.submit で user turn を投入できるか
 */
export function register(on: On) {
  const results: Results = {}
  const OUT = 'spikes/mods-spike/results.json'
  let writeFile: ((text: string) => Promise<void>) | null = null

  const note = async (key: string, value: unknown) => {
    results[key] = value
    try {
      await writeFile?.(JSON.stringify(results, null, 2))
    } catch {
      // 書けない場合は無視
    }
  }

  on('session.start', async ($, e, next) => {
    writeFile = text => $.fs.write(OUT, text)
    results.startedAt = await $.clock.now()
    results.surface = e.surface
    results.isInteractive = e.isInteractive
    results.pluginRoot = $.plugin.root
    await note('init', true)

    try {
      const reg = await $.tool.register({
        name: 'wait',
        description: 'Spike V3: waits 20 seconds inside the plugin and returns { elapsedMs }. Takes no arguments.',
        inputSchema: { type: 'object', properties: {} },
      })
      await note('toolRegister', reg)
    } catch (err) {
      await note('toolRegister', { error: String(err) })
    }

    // V1
    $.clock.after(200, async () => {
      const t0 = await $.clock.now()
      try {
        const r = await $.process.run(['sleep', '15'], { timeoutMs: 60000 })
        await note('v1_timer_long_run', { ok: true, exitCode: r.exitCode, elapsedMs: (await $.clock.now()) - t0 })
      } catch (err) {
        await note('v1_timer_long_run', { ok: false, error: String(err), elapsedMs: (await $.clock.now()) - t0 })
      }
    })

    // V2
    $.clock.after(300, async () => {
      const t0 = await $.clock.now()
      try {
        const r = await $.process.run(
          ['sh', '-c', 'nohup sleep 60 >/dev/null 2>&1 & echo started'],
          { timeoutMs: 20000 },
        )
        await note('v2_detached', { ok: true, exitCode: r.exitCode, stdout: r.stdout.trim(), elapsedMs: (await $.clock.now()) - t0 })
      } catch (err) {
        await note('v2_detached', { ok: false, error: String(err), elapsedMs: (await $.clock.now()) - t0 })
      }
    })

    // V4 + V5
    $.clock.after(400, async () => {
      const port = 47321
      const token = 'spike-token'
      const answerPath = 'spikes/mods-spike/answer.json'
      const root = $.plugin.root
      const t0 = await $.clock.now()
      try {
        const cmd =
          `nohup python3 "${root}/scripts/receiver.py" --port ${port} --token ${token} ` +
          `--form "${root}/scripts/form.html" --out "${answerPath}" >/dev/null 2>&1 & echo started`
        const start = await $.process.run(['sh', '-c', cmd], { timeoutMs: 20000 })
        await note('v4_receiver_start', { exitCode: start.exitCode, stdout: start.stdout.trim(), elapsedMs: (await $.clock.now()) - t0 })
        await $.clock.sleep(1500)

        const get = await $.http.fetch(`http://127.0.0.1:${port}/?t=${token}`)
        await note('v4_get_form', { status: get.status, ok: get.ok, length: get.text.length })

        const post = await $.http.fetch(`http://127.0.0.1:${port}/answer?t=${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answers: { q1: 'A' }, note: 'posted by the mod through $.http.fetch' }),
        })
        await note('v4_post', { status: post.status, ok: post.ok, text: post.text.slice(0, 200) })

        let found = false
        for (let i = 0; i < 20; i++) {
          if (await $.fs.exists(answerPath)) { found = true; break }
          await $.clock.sleep(250)
        }
        const body = found ? await $.fs.read(answerPath) : null
        await note('v4_answer_file', { found, body, elapsedMs: (await $.clock.now()) - t0 })

        if (found) {
          try {
            const res = await $.prompt.submit({
              text: '【スパイク回答】answer.json を受け取りました。これは plugin が $.prompt.submit で投入した user turn です。「受信確認」とだけ返答してください。',
            })
            await note('v5_prompt_submit', res)
          } catch (err) {
            await note('v5_prompt_submit', { error: String(err) })
          }
        }
      } catch (err) {
        await note('v4_error', { error: String(err), elapsedMs: (await $.clock.now()) - t0 })
      }
    })

    return next(e)
  })

  // V3
  on('tool.call', { tool: 'mcp__spike__wait' }, async ($, e) => {
    const t0 = await $.clock.now()
    try {
      const r = await $.process.run(['sleep', '20'], { timeoutMs: 60000 })
      const elapsedMs = (await $.clock.now()) - t0
      await note('v3_tool_sync_wait', { ok: true, exitCode: r.exitCode, elapsedMs })
      return { result: { elapsedMs, note: 'waited inside tool.call' } }
    } catch (err) {
      const elapsedMs = (await $.clock.now()) - t0
      await note('v3_tool_sync_wait', { ok: false, error: String(err), elapsedMs })
      return { result: { error: String(err), elapsedMs } }
    }
  })
}
