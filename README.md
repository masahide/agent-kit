# agent-kit

Claude Code と Codex を使う作業を支える CLI と、Claude Code の文書作成を支援する Mod をまとめたリポジトリです。

| 道具 | できること | 導入・使い方 |
|---|---|---|
| **agentctl** | Claude Code / Codex のセッションを一覧・参照し、メッセージの送信、状態の待機、turn の中断、アーカイブ・削除を行う CLI。JSON 出力に対応 | [agentctl 利用者ガイド](docs/agentctl/usage.md) |
| **doc-desk** | 文書を書く前の質問票、書き上げた文書への指摘・添削、執筆中のライブ表示をブラウザで提供し、回答を Claude に届ける Mod | [doc-desk 利用者ガイド](docs/doc-desk/usage.md) |

Mod は Claude Code の function hooks を使う拡張です。Claude Mods は早期アクセスの機能で、Claude Code のバージョン変更により動作が変わる可能性があります。

## agentctl を使う

CLI のインストール方法は [利用者ガイドの「入れ方」](docs/agentctl/usage.md#1-入れ方) を参照してください。macOS / Linux 向けと Windows PowerShell 向けのインストーラがあり、GitHub Releases のバイナリをチェックサムで検証して配置します。リリース用ワークフローのビルド対象は linux / darwin / windows × amd64 / arm64 です。ビルド対象であることと、各環境での実機確認は別です。

ソースから入れる場合は Go 1.24 以上を用意し、リポジトリ内で実行します。

```sh
cd tools/agentctl
go install .
```

インストール先を PATH に追加したら、接続状態とセッションを確認します。

```sh
agentctl --version
agentctl --json doctor
agentctl --json sessions list
agentctl sessions send --help
```

`doctor` は不足があっても終了コード 0 を返すため、出力の `problems` を確認してください。Codex への接続時には、必要に応じて `codex app-server daemon start` が実行されます。

一覧で対象を確かめ、`<id>` をそのセッションの ID に置き換えます。以下の `send` は対象の会話へ実際にメッセージを送ります。

```sh
agentctl sessions messages <id> --last 3
agentctl sessions send <id> --text "テストをもう一度流して"
agentctl sessions wait <id> --until idle --timeout 1800
```

- **Claude Code:** 送信・turn の中断には、対象セッションへの `plugins/agentctl` の読み込みと `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` が必要です。[Mod の導入手順](docs/agentctl/usage.md#12-claude-側-mod)に従い、セッションを起動し直してください。一覧や会話の読み取りには Mod は不要です。
- **Codex:** CLI の共有 app-server daemon に接続します。`--no-daemon` で起動した TUI は対象外です。
- コマンドの引数・出力・終了コードは `agentctl <command> --help` で確認できます。設計と検証記録は [agentctl の計画書](docs/agentctl/plan.md) にあります。

## doc-desk を使う

Claude Code、Python 3、ブラウザと、手元に取得したこのリポジトリが必要です。Python の受信サーバは標準ライブラリを使います。

macOS / Linux のシェルでは、リポジトリ直下から次のように読み込めます。

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir plugins/doc-desk
```

起動した Claude Code に文書作成を依頼します。

```text
/doc-desk:doc-desk docs/api.md に認証の仕様書を書きたい
```

ブラウザの質問票に回答すると、Claude が回答を反映して文書を作成します。この Mod を使うと宣言したセッションでは、ライブ表示と完成後の指摘画面も使います。閉じた画面は `/doc-desk-resume` で開き直せます。質問票や回答などは作業ディレクトリの `doc-desk/` に保存されます。

Windows / Claude Desktop の設定、フォーム・指摘画面の操作は [利用者ガイド](docs/doc-desk/usage.md)、内部構造・テスト方法・未検証事項は [doc-desk README](plugins/doc-desk/README.md) を参照してください。

## 対応状況と制限

以下はリポジトリに残る検証記録と現行コードに基づく整理です。この README の整備時にインストール、テスト、Desktop / TUI での実機確認を再実行したものではありません。

| 対象 | 記録・制限 |
|---|---|
| agentctl → Claude Desktop | [計画書の「Windows での確認」](docs/agentctl/plan.md#7-未確認点と段階-0-の結果)に、2026-09-27 の Mod 読み込み・送信・会話取得の確認記録があります（C4）。対象は Windows、Desktop 内の Claude Code 2.1.281、agentctl 0.1.1 |
| agentctl → Codex TUI | 同記録に、Windows / Codex CLI 0.157.1 の daemon 接続と、人が起動した TUI の thread への送信・会話取得の確認記録があります（C5） |
| agentctl → ChatGPT Desktop | 外部 CLI から任意の既存会話へ直接送信できることは確認していません。Codex app-server の thread 操作や、Claude Desktop の確認記録とは区別してください |
| doc-desk → Claude Desktop | [doc-desk README](plugins/doc-desk/README.md)に、2026-09-23 のフォーム起動から回答受信までの確認記録があります。Desktop 内のペインは表示されず、ブラウザと Tool result の URL を使います。ライブ表示などには実機未検証項目が残っています |

agentctl の利用者ガイドと計画書の表には、Windows 接続や C4/C5 を「未確認」とする初期の記述が一部残っています。上表は、計画書の後続の Windows 確認記録に基づきます。

主な制限:

- agentctl は Claude Code のプロセスを新規起動しません。`sessions create claude` / `resume` は、人による起動・再開が必要な場合に `user_action_required` を返します。
- Windows、および Claude Desktop / VS Code のセッションでは、agentctl は Claude のプロセスを終了しません。実行中セッションのアーカイブ・削除には、人による終了が必要な場合があります。
- 現行の [Codex RPC クライアント](tools/agentctl/internal/codex/rpc.go)はサーバからの要求に応答しません。権限確認などへの応答を agentctl に任せることはできません。[Claude Mod](plugins/agentctl/hooks/register.ts)も複数の prompt を直列送信する実装ではなく、連続送信の FIFO は保証しません。
- doc-desk の回答待ちの書き込み抑止は `Write` / `Edit` / `NotebookEdit` が対象です。Bash のリダイレクトなどは対象外です。詳細は [doc-desk README](plugins/doc-desk/README.md) を参照してください。

## 構成

- `tools/agentctl/`: Go 製 CLI とインストーラ
- `plugins/agentctl/`: Claude Code 側で受信箱を監視する Mod
- `plugins/doc-desk/`: 文書作成支援の Mod、スキル、ブラウザ画面、Python 受信サーバ
- `docs/agentctl/`、`docs/doc-desk/`: 利用者ガイド、設計、検証記録
