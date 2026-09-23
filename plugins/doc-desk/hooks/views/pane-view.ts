import type { Elements, RenderElement } from 'claude-code'

import { STRINGS } from './strings'

/**
 * ペインを描くのに要る要素。`Box`, `Text`, `Button`, `Link` だけ使います
 * (4 つの surface すべてにあります)。
 */
export type PaneKit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

/**
 * ペインが表示する状態。
 */
export type PaneModel = {
  /** 1 行目 (`インタビュー: <label>  (rev <revision>)` か `指摘: <label>  (rev <revision>)`) */
  heading: string
  /** 127.0.0.1 の URL (文字で出す。コピー用) */
  url: string
  /** `Link` に置く localhost の URL (`Link` の href は https: か http://localhost のみ) */
  linkUrl: string
  /** 待ち始めてからの秒数 */
  elapsedSeconds: number
}

/**
 * ボタンが押されたときの動作。
 */
export type PaneActions = {
  openBrowser: () => void
  cancel: () => void
}

/**
 * 待機中のペイン。8 行以内です。
 *
 * ```
 * インタビュー: <label>  (rev <revision>)   ← 指摘の画面では 指摘: <label>  (rev <revision>)
 * ブラウザで回答してください:
 * http://127.0.0.1:<port>/?t=<token>
 * リンクで開く (localhost)              ← Link (terminal は OSC 8、desktop はアンカー)
 * 状態: 回答を待っています (n 秒経過)
 * [ブラウザで開く (o)]  [取り消す]
 * ```
 */
export function paneView(kit: PaneKit, model: PaneModel, actions: PaneActions): RenderElement {
  const { Box, Text, Button, Link } = kit

  return Box({
    flexDirection: 'column',
    paddingLeft: 1,
    paddingRight: 1,
    children: [
      Text({ bold: true, children: model.heading }),
      Text({ children: STRINGS.answerInBrowser }),
      Text({ wrap: 'wrap', children: model.url }),
      Link({ href: model.linkUrl, label: STRINGS.openLink }),
      Text({ dimColor: true, children: STRINGS.waitingOf(model.elapsedSeconds) }),
      Box({
        flexDirection: 'row',
        gap: 2,
        marginTop: 1,
        children: [
          Button({
            key: 'open-browser',
            label: STRINGS.openBrowser,
            hotkey: 'o',
            autoFocus: true,
            onPress: actions.openBrowser,
          }),
          Button({ key: 'cancel', label: STRINGS.cancel, onPress: actions.cancel }),
        ],
      }),
    ],
  })
}
