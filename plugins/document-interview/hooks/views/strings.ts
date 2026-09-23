/**
 * Mod が描く固定文言。ja-text-communication の規範に沿って一文一義で書きます。
 */
export const STRINGS = {
  /** ペインのタイトル */
  paneTitle: 'インタビュー',
  /** ペイン 1 行目: `インタビュー: <label>  (rev <revision>)` */
  headerOf: (label: string, revision: number) => `インタビュー: ${label}  (rev ${revision})`,
  /** ペイン 2 行目 */
  answerInBrowser: 'ブラウザで回答してください:',
  /** ペインの `Link` の文字 (href は localhost の URL) */
  openLink: 'リンクで開く (localhost)',
  /** ペインの状態行 */
  waitingOf: (seconds: number) => `状態: 回答を待っています (${seconds} 秒経過)`,
  /** [ブラウザで開く] ボタン */
  openBrowser: 'ブラウザで開く',
  /** [取り消す] ボタン */
  cancel: '取り消す',
  /** 待機中の質問票が無いときの `/interview` の返答 */
  nothingPending: '待機中の質問票はありません',
  /** 待機中に `/interview` を実行したときの返答 */
  reopenedOf: (url: string) => `インタビューのペインとブラウザを開き直しました: ${url}`,
  /** 人がペインを閉じたときの状態行 */
  closedHint: '/interview で開き直せます',
  /** [取り消す] のあとのトランスクリプト行 */
  cancelled: 'インタビューを取り消しました',
  /** 回答を受け取ったあとのトランスクリプト行 */
  receivedOf: (mdPath: string) => `インタビューの回答を受け取りました。固定形は ${mdPath} に保存しました`,
  /** `pending` の結果に添える context */
  toolContext:
    '質問票をブラウザに出しました。回答は後で【インタビュー回答】で始まる user turn として届きます。' +
    'それまで文書を書かず、このターンを終えてください。',
  /** `answered` の結果に添える context */
  answeredContext:
    'reply が人の回答 (【インタビュー回答】で始まる固定形) です。user turn は届きません。' +
    'reply を回答として読み、文書の作成に進んでください。',
  /** `cancelled` の理由 */
  cancelledByPerson: '人が [取り消す] を押しました',
  replacedByAnother: '別の質問票の open_form で差し替えられました',
  /** ツールの説明 (モデル向け) */
  toolDescription:
    '文書を書く前に、決定してほしい論点を質問票 JSON (schemaVersion 1) として渡すと、' +
    'ブラウザに一枚のフォームを出して人に答えてもらいます。問いは 2〜5 問、各問に cite (根拠) と 2 つ以上の選択肢 (pros と cons 付き) が必要です。' +
    '結果は JSON 文字列で、status で分岐します。' +
    '"answered": waitSeconds (既定 300 秒) のうちに回答が届きました。reply が回答固定形です。それを読んで文書を書いてください。' +
    '"pending": まだ回答がありません (上限到達、中断、waitSeconds が 0)。回答は後で【インタビュー回答】で始まる user turn として届くので、文書を書かずにターンを終えてください。' +
    '"cancelled": 人が取り消しました。何も届きません。' +
    '"invalid": errors を直して再送してください。"failed": reason の代替導線を人に案内してください。',
  /** コマンドの説明 */
  commandDescription: '待機中のインタビューのペインとブラウザを開き直す',
  /** Python 3 が無いときの理由 */
  noPython: 'Python 3 (python3、python、py -3 のどれか) が見つからないため受信サーバを起動できませんでした',
  /** 受信サーバが port-file を書かなかったときの理由 */
  noPortFile: '受信サーバが 3 秒以内に起動しませんでした',
  /** 代替導線 */
  fallbackOf: (htmlPath: string) =>
    `HTML は ${htmlPath} に書いてあります。人に file:// で開いて回答してもらい、[送信] で出る JSON をチャットに貼ってもらってください。`,
} as const
