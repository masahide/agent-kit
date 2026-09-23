/**
 * この Mod が使う固定の名前。plugin.json の name と一致させます。
 */
export const PLUGIN_NAME = 'doc-desk'

/**
 * `$.tool.register` に渡す短い名前。モデルからは `mcp__<plugin>__<name>` で見えます。
 */
export const TOOL_NAME = 'open_form'

/**
 * `tool.call` の絞り込みに使う、モデルから見た完全なツール名。
 */
export const FULL_TOOL_NAME = `mcp__${PLUGIN_NAME}__${TOOL_NAME}`

/**
 * 指摘の画面を出すツールの短い名前。
 */
export const REVIEW_TOOL_NAME = 'open_review'

/**
 * `tool.call` の絞り込みに使う、指摘の画面のツールの完全な名前。
 */
export const FULL_REVIEW_TOOL_NAME = `mcp__${PLUGIN_NAME}__${REVIEW_TOOL_NAME}`

/**
 * `/doc-desk` コマンドの名前。
 */
export const COMMAND_NAME = 'doc-desk'

/**
 * `$.ui.open` に渡すペインの id。`ui.render` の `requestId` と一致します。
 */
export const PANE_ID = 'doc-desk'

/**
 * 証跡ファイルを置くディレクトリ (セッションの cwd 基準)。
 */
export const EVIDENCE_DIR = 'doc-desk'

/**
 * 回答固定形の先頭に置く見出し語。
 */
export const REPLY_HEADING = '【doc-desk 回答】'

