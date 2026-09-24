/**
 * Mod が描く固定文言。ja-text-communication の規範に沿って一文一義で書きます。
 */
/**
 * 画面の種類。`form` は質問票 (`open_form`)、`review` は指摘の画面 (`open_review`)。
 */
export type SheetKind = 'form' | 'review'

/** 画面の種類の呼び名 */
export const sheetNameOf = (kind: SheetKind): string => (kind === 'form' ? '質問票' : '指摘の画面')

export const STRINGS = {
  /** ペインのタイトル */
  paneTitle: 'doc-desk',
  /** ペイン 1 行目: `インタビュー: <label>  (rev <revision>)` */
  headerOf: (label: string, revision: number) => `インタビュー: ${label}  (rev ${revision})`,
  /** 指摘の画面のペイン 1 行目: `指摘: <label>  (rev <revision>)` */
  reviewHeaderOf: (label: string, revision: number) => `指摘: ${label}  (rev ${revision})`,
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
  /** 待機中の画面が無いときの `/doc-desk` の返答 */
  nothingPending: '待機中の質問票も指摘の画面もありません',
  /** 待機中に `/doc-desk` を実行したときの返答 */
  reopenedOf: (url: string) => `インタビューのペインとブラウザを開き直しました: ${url}`,
  /** 起動時に、前のセッションの回答が届いていたとき (トランスクリプト行と通知) */
  unsentOf: (kind: SheetKind, label: string) => `${sheetNameOf(kind)} ${label} の回答が届いています。/doc-desk で Claude に送れます`,
  /** 未送の回答を `/doc-desk` で送ったときの返答 */
  sentUnsentOf: (kind: SheetKind, label: string) => `${sheetNameOf(kind)} ${label} の回答を Claude に送ります`,
  /** 未送の回答を送れなかったとき */
  unsentFailedOf: (kind: SheetKind, label: string) =>
    `${sheetNameOf(kind)} ${label} の回答を送れませんでした。/doc-desk でもう一度送れます`,
  /** 起動時に、前のセッションの待機を引き継いだときの状態行 */
  carriedOverOf: (kind: SheetKind, label: string) => `前回の${sheetNameOf(kind)} ${label} が未回答です。/doc-desk で開き直せます`,
  /** 引き継いで受信サーバを起動し直したら port が変わったとき */
  portChangedOf: (kind: SheetKind, label: string, url: string) => `${sheetNameOf(kind)} ${label} の URL が変わりました: ${url}`,
  /** 引き継いで受信サーバを起動し直せなかったとき */
  restartFailedOf: (kind: SheetKind, label: string) => `前回の${sheetNameOf(kind)} ${label} の受信サーバを起動し直せませんでした`,
  /** 7 日より古い記録を捨てたとき */
  staleRecordOf: (kind: SheetKind, label: string) =>
    `前回の${sheetNameOf(kind)} ${label} は 7 日より前のものなので、引き継ぎませんでした`,
  /** 同じフォルダの別のセッションが待機を持っているとき */
  ownedByOtherOf: (kind: SheetKind, label: string) =>
    `${sheetNameOf(kind)} ${label} は同じフォルダの別のセッションが回答を待っているので、このセッションでは引き継ぎません`,
  /** 人がペインを閉じたときの状態行 */
  closedHint: '/doc-desk で開き直せます',
  /** [取り消す] のあとのトランスクリプト行 */
  cancelled: 'インタビューを取り消しました',
  /** 回答を受け取ったあとのトランスクリプト行 */
  receivedOf: (mdPath: string) => `インタビューの回答を受け取りました。固定形は ${mdPath} に保存しました`,
  /** `pending` の結果に添える context */
  toolContext:
    '質問票をブラウザに出しました。回答は後で【doc-desk 回答】で始まる user turn として届きます。' +
    'それまで文書を書かず、このターンを終えてください。',
  /** `answered` の結果に添える context */
  answeredContext:
    'reply が人の回答 (【doc-desk 回答】で始まる固定形) です。user turn は届きません。' +
    'reply を回答として読み、文書の作成に進んでください。',
  /** 指摘の画面の `pending` の結果に添える context */
  reviewPendingContext:
    '指摘の画面をブラウザに出しました。指摘は後で【doc-desk 回答】で始まる user turn として届きます。' +
    'それまで文書を直さず、完了報告もせず、このターンを終えてください。',
  /** 指摘の画面の `answered` の結果に添える context */
  reviewAnsweredContext:
    'reply が人の指摘 (【doc-desk 回答】で始まる固定形) です。user turn は届きません。' +
    '指摘を反映して文書を直し、完了報告で指摘ごとに直した箇所か直さなかった理由を添えてください。',
  /** `cancelled` の理由 */
  cancelledByPerson: '人が [取り消す] を押しました',
  replacedByAnother: '別の open_form か open_review で差し替えられました',
  /** ツールの説明 (モデル向け) */
  toolDescription:
    '文書を書く前に、決定してほしい論点を質問票 JSON (schemaVersion 1) として渡すと、' +
    'ブラウザに一枚のフォームを出して人に答えてもらいます。問いは 2〜5 問、各問に cite (根拠) と 2 つ以上の選択肢 (pros と cons 付き) が必要です。' +
    '結果は JSON 文字列で、status で分岐します。' +
    '"answered": waitSeconds (既定 300 秒) のうちに回答が届きました。reply が回答固定形です。それを読んで文書を書いてください。' +
    '"pending": まだ回答がありません (上限到達、中断、waitSeconds が 0)。回答は後で【doc-desk 回答】で始まる user turn として届くので、文書を書かずにターンを終えてください。' +
    '"cancelled": 人が取り消しました。何も届きません。' +
    '"invalid": errors を直して再送してください。"failed": reason の代替導線を人に案内してください。',
  /** ツール open_review の説明 (モデル向け) */
  reviewToolDescription:
    '書き上げた文書を人に見せ、段落や文字列への指摘を返してもらいます (指摘モード)。' +
    '先に文書を HTML (h2〜h4、p、ul、ol、li、table などの許可リストの要素だけ、属性は th と td の colspan と rowspan だけ、10 万文字まで) にして ' +
    'doc-desk/<label>.doc.html に書き出し、review に schemaVersion 1、documentId、revision、label、title を渡します。' +
    '結果の status は open_form と同じです。"answered" なら reply の ## 指摘 を反映して文書を直してください。' +
    '"pending" なら指摘は後で【doc-desk 回答】で始まる user turn として届くので、文書を直さずにターンを終えてください。',
  /** コマンドの説明 */
  commandDescription: '待機中の質問票か指摘の画面を開き直す。前回の回答が未送なら Claude に送る',
  /** 文書の HTML ファイルが無いとき */
  noDocument: 'ファイルがありません。書き上げた文書を HTML にして、この場所に書き出してから呼んでください',
  /** 文書の HTML ファイルを読めないとき */
  unreadableDocument: 'ファイルを読めませんでした。4 MiB を超えているなら、節の切れ目で分けて part を付けてください',
  /** Python 3 が無いときの理由 */
  noPython: 'Python 3 (python3、python、py -3 のどれか) が見つからないため受信サーバを起動できませんでした',
  /** 受信サーバの起動 (receiver.py start) が port を返さなかったときの理由 */
  noPort: '受信サーバが port を返しませんでした',
  /** 代替導線 */
  fallbackOf: (htmlPath: string) =>
    `HTML は ${htmlPath} に書いてあります。人に file:// で開いて回答してもらい、[送信] で出る JSON をチャットに貼ってもらってください。`,
} as const
