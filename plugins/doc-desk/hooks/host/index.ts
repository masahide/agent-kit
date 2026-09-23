import type {
  HttpInit,
  HttpResponse,
  PaneCloseArgs,
  PaneOpenArgs,
  ProcessRunInit,
  ProcessRunResult,
  PromptSubmitArgs,
  PromptSubmitResult,
  TimerCall,
} from 'claude-code'

/**
 * `session.start` の中で `$` を束ねた関数群。
 *
 * `$` を変数に入れたり引数に渡したりすると `claude plugin validate` が拒否するため、
 * 各メンバーは `session.start` の中で `(...) => $.名詞.イベント(...)` の閉包として作り、
 * 後続のフック、タイマー、ボタンの押下からはこの Host を通して呼びます。
 */
export type Host = {
  /** `$.clock.now` */
  now: () => Promise<number>
  /** `$.clock.after` */
  after: TimerCall
  /** `$.clock.every` */
  every: TimerCall
  /** `$.process.run` */
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** `$.fs.write` (親ディレクトリも作られます) */
  writeFile: (path: string, text: string) => Promise<void>
  /** `$.fs.read` (テキスト) */
  readFile: (path: string) => Promise<string>
  /** `$.fs.exists` */
  exists: (path: string) => Promise<boolean>
  /** `$.http.fetch` (受信サーバの `/wait` のロングポーリング) */
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  /** `$.ui.open` */
  openPane: (pane: PaneOpenArgs) => Promise<unknown>
  /** `$.ui.close` */
  closePane: (pane: PaneCloseArgs) => Promise<void>
  /** `$.ui.invalidate("ui.render")` */
  invalidate: () => void
  /** `$.ui.log` (トランスクリプトに 1 行) */
  uiLog: (text: string) => void
  /** `$.ui.status` (プロンプト下の固定行) */
  status: (text: string | undefined) => void
  /** `$.prompt.submit` */
  submitPrompt: (input: PromptSubmitArgs) => Promise<PromptSubmitResult>
  /** `$.plugin.root` (plugin.json のあるディレクトリ、絶対パス) */
  pluginRoot: string
}
