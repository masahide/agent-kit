import type { Host } from '../host'
import { waitUrlOf } from '../receiver'

/**
 * 同期待ちの既定と上限 (秒)。ツール入力 `waitSeconds` の既定は 300、0 で同期待ちしない。
 */
export const WAIT_SECONDS_DEFAULT = 300
export const WAIT_SECONDS_MAX = 1800

/**
 * `GET /wait` 1 回の保留時間 (秒)。中断 (Esc) で `next.signal` が abort したあとフックが
 * 動けるのは 5 秒 (HookBudget.lingerMs) なので、それに収まる 4 秒にします。
 */
export const WAIT_ROUND_SECONDS = 4

/**
 * 同期待ちが使う Host の関数。
 */
export type WaitDeps = Pick<Host, 'exists' | 'readFile' | 'fetch'>

/**
 * 何を待つか。`T` は回答の型 (質問票なら AnswerV1、指摘の画面なら ReviewAnswerV1)。
 */
export type WaitTarget<T> = {
  /** 回答ファイルの中身を、待っている画面の回答として読む。別の画面の回答や形の違うものは null */
  read: (text: string) => T | null
  /** `interview/<label>.answer.json` */
  answerPath: string
  port: number
  token: string
}

/**
 * 同期待ちの制御。
 */
export type WaitOptions = {
  /** 待つ上限 (秒)。0 なら待たない */
  waitSeconds: number
  /** `next.signal`。abort したら待ちをやめる */
  signal: AbortSignal
  /** 待っている質問票がまだ待機中か (取り消しや差し替えで false) */
  isStillPending: () => boolean
}

/**
 * 同期待ちがどう終わったか。
 *
 * - `answered`: 回答ファイルを読めた
 * - `dropped`: 待っている間に待機が取り消されたか差し替わった
 * - それ以外: 回答は届いていない。`endedBy` が理由、`waitedSeconds` が要求した待ち秒数の合計
 *   (`skipped` = waitSeconds が 0、`timeout` = 上限到達、`abort` = 中断、
 *   `receiverLost` = 受信サーバに届かない)
 */
export type WaitEnd<T> =
  | { kind: 'answered'; answer: T }
  | { kind: 'dropped' }
  | { kind: 'pending'; endedBy: 'skipped' | 'timeout' | 'abort' | 'receiverLost'; waitedSeconds: number }

/**
 * ツール入力 `waitSeconds` を 0〜WAIT_SECONDS_MAX の整数に丸めます。数でなければ既定。
 */
export function clampWaitSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return WAIT_SECONDS_DEFAULT
  }
  return Math.min(WAIT_SECONDS_MAX, Math.max(0, Math.floor(value)))
}

/**
 * 回答ファイルがあり、待っている画面の回答として読めれば返します。
 */
export async function readAnswer<T>(deps: WaitDeps, target: WaitTarget<T>): Promise<T | null> {
  if (!(await deps.exists(target.answerPath))) {
    return null
  }
  const text = await deps.readFile(target.answerPath).catch(() => '')
  return target.read(text)
}

/**
 * `GET /wait` の応答を読みます。`answered` が boolean でなければ null。
 */
function parseWaitReply(text: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const { answered } = parsed as { answered?: unknown }
      if (typeof answered === 'boolean') {
        return answered
      }
    }
  } catch {
    // JSON でなければ null
  }
  return null
}

/**
 * `tool.call` の中で回答を待ちます (README の「流れ」の同期経路)。
 *
 * 各周回: 待機中か → 回答ファイル → `signal.aborted` → 残り秒数 → `GET /wait?timeout=<4 秒以下>`。
 * フック予算 (10 秒) は `$` 呼び出しの待ち中は止まるので、`$.http.fetch` の保留は予算に
 * 数えられません。`$.clock` の待ちは予算に数えられるため、ここでは時計を使わず、
 * 要求した `timeout` の合計を経過秒数として数えます (受信サーバは要求より長くは保留しません)。
 *
 * `/wait` が失敗したとき (受信サーバが死んだ、届かない) は回答ファイルをもう一度見て、
 * 無ければ `receiverLost` で打ち切ります。以後は監視タイマーの非同期経路が回答を届けます。
 *
 * @param deps Host の `exists`, `readFile`, `fetch`
 * @param target 回答の読み方、回答ファイル、受信サーバ
 * @param options 上限、`next.signal`、待機中の判定
 * @returns どう終わったか
 */
export async function waitForAnswer<T>(
  deps: WaitDeps,
  target: WaitTarget<T>,
  options: WaitOptions,
): Promise<WaitEnd<T>> {
  if (options.waitSeconds <= 0) {
    return { kind: 'pending', endedBy: 'skipped', waitedSeconds: 0 }
  }

  let waitedSeconds = 0
  for (;;) {
    if (!options.isStillPending()) {
      return { kind: 'dropped' }
    }
    const answer = await readAnswer(deps, target)
    if (answer) {
      return { kind: 'answered', answer }
    }
    if (options.signal.aborted) {
      return { kind: 'pending', endedBy: 'abort', waitedSeconds }
    }
    const remaining = options.waitSeconds - waitedSeconds
    if (remaining <= 0) {
      return { kind: 'pending', endedBy: 'timeout', waitedSeconds }
    }

    const round = Math.min(WAIT_ROUND_SECONDS, remaining)
    const answered = await deps
      .fetch(waitUrlOf(target.port, target.token, round))
      .then(reply => (reply.ok ? parseWaitReply(reply.text) : null))
      .catch(() => null)
    waitedSeconds += round

    if (answered === false) {
      continue
    }
    // 回答済み (受信サーバはファイルを書いてから応答する) か、失敗 (受信サーバが死んだ、届かない、
    // 応答の形が違う)。どちらもファイルを見て、無ければ打ち切る (回答済みなのにファイルが無い場合に
    // 空回りしないため)。以後は監視タイマーが届ける
    const late = await readAnswer(deps, target)
    if (late) {
      return { kind: 'answered', answer: late }
    }
    return { kind: 'pending', endedBy: 'receiverLost', waitedSeconds }
  }
}
