/**
 * この Mod が使う固定の名前。plugin.json の name と一致させます。
 */
export const PLUGIN_NAME = 'document-interview'

/**
 * `$.tool.register` に渡す短い名前。モデルからは `mcp__<plugin>__<name>` で見えます。
 */
export const TOOL_NAME = 'open_form'

/**
 * `tool.call` の絞り込みに使う、モデルから見た完全なツール名。
 */
export const FULL_TOOL_NAME = `mcp__${PLUGIN_NAME}__${TOOL_NAME}`

/**
 * `/interview` コマンドの名前。
 */
export const COMMAND_NAME = 'interview'

/**
 * `$.ui.open` に渡すペインの id。`ui.render` の `requestId` と一致します。
 */
export const PANE_ID = 'interview'

/**
 * 証跡ファイルを置くディレクトリ (セッションの cwd 基準)。
 */
export const INTERVIEW_DIR = 'interview'

/**
 * 回答固定形の先頭に置く見出し語。
 */
export const REPLY_HEADING = '【インタビュー回答】'

