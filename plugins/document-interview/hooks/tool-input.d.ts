// ツール `open_form` の入力を `McpToolInputs` に足す宣言。
// `.claude/types/claude-code-mcp.d.ts` (`/plugin-types` が生成) と同じ仕組みで、
// `tool.call` の `e.tool === "mcp__document-interview__open_form"` を絞ったとき
// `e.form`, `e.openBrowser`, `e.waitSeconds` が型付くようにします。実行時には読まれません。
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** 質問票 JSON をブラウザのフォームとして出し、人の回答を待つ */
    'mcp__document-interview__open_form': {
      form: unknown
      openBrowser?: boolean
      /** 呼び出しの中で回答を待つ上限 (秒)。既定 300、0 で待たない、上限 1800 */
      waitSeconds?: number
    }
  }
}
