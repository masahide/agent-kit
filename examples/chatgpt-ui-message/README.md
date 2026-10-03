# ChatGPT Plugin UI → ホスト会話の最小 PoC

対象の会話内で開いた Plugin UI から、そのホストへ `ui/message` を送り、応答を表示するサンプルです。**ChatGPT Desktop 実機では未検証です。** 本文は人が入力し、送信ボタンを押したときだけ送ります。一画面から一度だけ送信し、失敗時も自動再送しません。

外部 CLI から会話 ID を指定して任意の既存 Desktop 会話に送信する機能ではありません。会話一覧・ID・認証情報を取得しません。agentctl の Codex daemon 操作や、自前の app-server に対する `thread/resume` + `turn/start` とも別の経路です。

## 根拠と対象

2026-10-03 に以下の本文を確認しました。

- [OpenAI: Extensions](https://developers.openai.com/plugins/build/extensions): sidebar / conversation panel などへの入口を説明。本 PoC は通常の会話内 UI に限定し、追加の extension は宣言しません。
- [OpenAI: Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui): 新規 UI には `_meta.ui.resourceUri` と MCP Apps の JSON-RPC bridge を案内し、会話への送信は `ui/message`。
- [OpenAI: Plugin UI reference](https://developers.openai.com/plugins/reference): `window.openai.sendFollowUpMessage` は互換 API。本 PoC は標準の `ui/message` を使います。
- [MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) と [型定義](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/spec.types.ts): 初期化・capability・応答の形を確認。仕様本文の一部例では `content` が単一 object ですが、`McpUiMessageRequest` の型に合わせて **content block の配列**を送ります。`McpUiMessageResult.isError` も失敗として扱います。

これらは UI とホストの通信仕様です。特定の Desktop 版・アカウントでの対応、会話への表示、モデルの応答開始を保証するものではありません。

## ローカルで試す（外部送信なし）

Node.js 22 以上を使います。npm パッケージの導入や API key は不要です。リポジトリ直下から:

```sh
node --test examples/chatgpt-ui-message/bridge.test.mjs
node examples/chatgpt-ui-message/build.mjs
```

生成された `examples/chatgpt-ui-message/dist/mock.html` をブラウザで開きます。本文を入力してボタンを押すと、**ローカルの偽ホストだけ**に要求が届き、画面下に JSON が表示されます。成功・拒否・無応答を選べます。無応答は10秒で結果不明になり、再送しません。次の試行はページを再読み込みしてください。

`dist/widget.html` を単独で開いてもホスト会話はありません。iframe 外では送信できない旨を表示します。

## ファイル

| ファイル | 役割 |
|---|---|
| `bridge.mjs` | `ui/initialize` → capability 確認 → `ui/notifications/initialized` → 明示操作による `ui/message`。親 window の source と応答後の origin を照合し、IDで応答を対応付ける |
| `build.mjs` | 外部アセットのない HTML、ローカルmock、MCP tool / resource JSON を生成。既存 MCP サーバ向けの `tool` / `toolResult` / `resource()` も export |
| `bridge.test.mjs` | Node 標準テストと VM による bridge・生成フォームの検証 |
| `dist/` | 生成物（git 対象外） |

不透明な sandbox origin へは `postMessage` の targetOrigin に `*` を使いますが、宛先は `window.parent` のみです。受信元は必ず親 window と照合します。サーバ接続、会話 ID の探索、認証、永続ストレージ、外部リソース、追加の sandbox 権限は使いません。

## 後日の実機確認手順（今回未実施）

**プラグイン登録・公開・インストールと実際の会話への送信は、この変更の実行範囲に含みません。** 以下は、それらの操作が別途承認された検証環境で行うための手順です。

1. MCP Apps に対応した既存のテスト用 MCP サーバを用意する。このサンプルは HTTP / stdio サーバや認証を提供しない。
2. `tools/list` に `build.mjs` の `tool`（または `dist/tool.json`）を含める。`tools/call` の `open_message_poc` には `toolResult` を返す。ツール起動だけでメッセージは送らない。
3. `resources/list` に URI `ui://agent-kit/message-poc.html`、name `message-poc`、mimeType `text/html;profile=mcp-app` を載せる。同じ URI の `resources/read` に `{ contents: [resource()] }`（または `dist/resource.json`）を返す。既存サーバの MCP Apps capability negotiation も必要。`resource()` に含む CSP メタデータを維持する。
4. [公式の接続・テスト手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)に従う。登録・接続設定は環境担当者が別途行い、使い捨ての専用会話で tool を開く。Desktop 版、OS、ホスト名・版、日時を記録する。
5. 初期化応答が protocolVersion `2026-01-26` と `hostCapabilities.message.text` を返すことを確認する。対応しないホストでは送信ボタンを有効にしない。互換 API や別経路への自動切替は行わない。
6. 機密情報を含まない一意な試験文を入力する。表示中の対象会話を確認してボタンを一度押し、その会話だけに一度表示されるか、モデルが応答するかを記録する。ホストが承認を求める場合は人が判断する。
7. ホスト拒否・非対応・画面の破棄も確認する。`ui/message` の正常応答はホストによる受付であり、モデルの完了ではない。タイムアウト時は配送の成否が不明なので会話を確認し、無条件に再送しない。

## 検証済みと未検証

今回のローカル検証: Node.js 24.19.0、10テスト成功、HTML / JSON 生成成功。送信前の初期化、明示送信、二重送信抑止、source / origin / ID 照合、拒否（RPC error / `isError`）、非対応 capability / version、タイムアウト・遅延応答、teardown、空本文・長さ、生成コードの構文とフォームのイベントを確認しました。

未検証: 実ブラウザのレイアウト・sandbox挙動、実 MCP サーバとの結合、ChatGPT Desktop のプラグイン読み込み、ホストの承認 UI、実会話への配送、モデル応答。mock は配送可能性を証明しません。外部 CLI → 任意の既存 Desktop 会話への直接送信も未確認です。

このサンプルは限定的なプロトコル実装で、汎用 MCP Apps SDK の代替ではありません。対応メソッドは初期化・本文送信・ping・teardown に絞り、その他のホスト要求には `-32601` を返します。
