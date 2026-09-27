import type { On, Timer } from 'claude-code'

import { idOf, makeAck, parseMessage, pendingNames, submitStatus } from './inbox'
import { MOD_VERSION, PROTOCOL_VERSION, type AckStatus, type InboxMessage, type ModFile } from './protocol'

/** 受信箱を見る間隔 (ms) */
const POLL_INTERVAL_MS = 500

/**
 * agentctl Mod。
 *
 * - session.start で ~/.agentctl/claude/<sessionId>/mod.json を書き、受信箱の監視を始めます。
 * - 受信箱の prompt は `$.prompt.submit` で Claude に届けます。turn の実行中なら先に `queued` の ack を書き、
 *   次の turn として始まったら `submitted` に書き換えます (`$.prompt.submit` の Promise は turn が始まるまで返らないため)。
 * - interrupt は、main の turn の実行中なら `$.turn.abort` で止めて `aborted`、そうでなければ `no_turn` を書きます。
 * - Mod はファイルを消しません。処理済みの受信箱と ack は CLI が消します。
 */
export function register(on: On) {
  /** 実行中の main の turn (subagent の turn は数えない) */
  let turnId: string | undefined
  let timer: Timer | undefined

  // subagent の実行は turn.start を出さない (型定義の説明) ので、ここに来るのは main の turn だけ
  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      turnId = undefined
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    const home = await $.env.get('HOME')
    const sessionId = await $.session.id()
    if (!home || !sessionId) {
      $.ui.log('agentctl: HOME かセッション id が分からないので、受信箱を開けません')
      return result
    }
    const base = (await $.env.get('AGENTCTL_HOME')) || `${home}/.agentctl`
    const dir = `${base}/claude/${sessionId}`

    const writeAck = (id: string, status: AckStatus, detail?: string) =>
      $.clock.now().then(now => $.fs.write(`${dir}/acks/${id}.json`, JSON.stringify(makeAck(id, status, now, detail))))

    // `sh` の親が claude のプロセスです。CLI はこの pid をセッション記録の pid と照合し、
    // 前のプロセスが残した mod.json を使わないようにします。
    let pid = 0
    try {
      const out = await $.process.run(['sh', '-c', 'echo $PPID'])
      pid = Number.parseInt(out.stdout.trim(), 10) || 0
    } catch {
      pid = 0
    }
    const mod: ModFile = {
      v: PROTOCOL_VERSION,
      sessionId,
      pid,
      modVersion: MOD_VERSION,
      startedAt: await $.clock.now(),
    }
    await $.fs.write(`${dir}/mod.json`, JSON.stringify(mod))

    const submit = async (message: InboxMessage) => {
      try {
        const res = await $.prompt.submit({ text: message.text ?? '' })
        const { status, detail } = submitStatus(res)
        await writeAck(message.id, status, detail)
      } catch (error) {
        await writeAck(message.id, 'error', String(error))
      }
    }

    const interrupt = async (message: InboxMessage) => {
      if (!turnId) {
        await writeAck(message.id, 'no_turn')
        return
      }
      try {
        await $.turn.abort({ turnId })
        await writeAck(message.id, 'aborted')
      } catch (error) {
        // 止める前に turn が終わっていた
        await writeAck(message.id, 'no_turn', String(error))
      }
    }

    // /clear や resume で session.start がまた来たら、前の監視を止めて新しいセッションの受信箱を見る
    timer?.cancel()
    const done = new Set<string>()
    let polling = false
    timer = $.clock.every(POLL_INTERVAL_MS, async () => {
      if (polling) {
        return
      }
      polling = true
      try {
        let entries: unknown
        try {
          entries = await $.fs.list(`${dir}/inbox`)
        } catch {
          return // 受信箱がまだ無い
        }
        for (const name of pendingNames(entries, done)) {
          done.add(name)
          if (await $.fs.exists(`${dir}/acks/${name}`)) {
            continue // 前のプロセスが処理済み
          }
          let message: InboxMessage | undefined
          try {
            message = parseMessage(await $.fs.read(`${dir}/inbox/${name}`))
          } catch {
            message = undefined
          }
          if (!message) {
            await writeAck(idOf(name), 'error', 'unreadable inbox message')
            continue
          }
          if (message.kind === 'interrupt') {
            await interrupt(message)
            continue
          }
          if (turnId) {
            await writeAck(message.id, 'queued')
          }
          // 実行中なら turn が終わるまで返らないので、監視を止めないよう待たない
          void submit(message)
        }
      } finally {
        polling = false
      }
    })

    return result
  })
}
