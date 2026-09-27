# agentctl 利用者ガイド

作成日: 2026-09-27 / 対象: agentctl 0.1.0、Claude Code 2.1.283、Codex CLI 0.157.1

agentctl は、動いている Claude Code と Codex のセッションを 1 つの CLI から一覧し、読み、仕事を送り、待ち、止め、片付けるための道具です。主な利用者は agent (Claude Code や Codex 自身) で、全コマンドが `--json` を出します。設計は [plan.md](plan.md) にあります。

## 1. 入れ方

### 1.1 CLI

Go 1.24 以降で入れます。

```bash
go install github.com/masahide/agent-kit/tools/agentctl@latest
agentctl --json doctor
```

`doctor` は、claude と codex が見つかるか、Claude のセッション記録が読めるか、Mod が載っているセッションがいくつあるか、Codex の daemon につながるかを返します。何も入っていなくても終了コード 0 で、足りないものを `problems` に並べます。

### 1.2 Claude 側 (Mod)

Claude のセッションに `send` するには、そのセッションに agentctl Mod が載っている必要があります。一覧、会話の読み取り、terminal のセッションの停止は、Mod が無くてもできます。

1. Claude Code を起動する環境に `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` を足します (シェルの設定か `~/.claude/settings.json` の `env`)。
2. plugin を読み込みます。試すだけなら `claude --plugin-dir <このリポジトリ>/plugins/agentctl`、ふだん使うなら marketplace から入れて有効にします。
3. セッションを起動し直して、`agentctl --json doctor` の `modSessions` が増えることを確かめます。

Claude Desktop のセッションで Mod が動くかは未確認です (plan.md 7 章 C4)。動かない場合も、Desktop のセッションの一覧と会話の読み取りはできます。

### 1.3 Codex 側

codex CLI を入れておけば、agentctl が初回に `codex app-server daemon start` で共有の daemon を起動します。Codex の TUI も既定でこの daemon を使います (`codex --no-daemon` で起動したものは見えません)。

## 2. 使い方

```bash
agentctl sessions list                 # 動いているセッション (--all で止まっているものも)
agentctl sessions resolve ~/src/api    # フォルダや題名から id を探す
agentctl sessions get <id>             # 1 件の詳細
agentctl sessions messages <id> --last 3
agentctl sessions send <id> --text "テストをもう一度流して"
agentctl sessions wait <id> --until idle --timeout 1800
agentctl sessions stop <id> [--turn]
agentctl sessions archive <id>
agentctl sessions delete <id> --yes
```

`<id>` は id の先頭の一部で足ります (docker と同じ)。両方の provider で重なるときは `claude:<prefix>` / `codex:<prefix>` か `--provider` で絞ります。最初の構想の短い名前 (`ps`, `info`, `new`, `send`, `stop`, `archive`, `delete`) も使えます。

どのコマンドも `--help` (`-h`、`agentctl help <command>`) で書式、フラグ、例、JSON の形、終了コードが出ます。引数を間違えると、エラーと一緒にそのコマンドのヘルプが出ます。

### 2.1 新しく始める

```bash
agentctl sessions create codex ~/src/api --prompt-file task.md
agentctl sessions create claude ~/src/api --wait 600
```

- Codex は daemon に新しい thread を作ります。
- Claude は agentctl が起動しません。そのフォルダで動いている Claude のセッションがあればそれを使い (`reused: true`)、無ければ終了コード 5 (`user_action_required`) で、Desktop / terminal / VS Code それぞれの起動の手順を返します。`--wait SEC` を付けると、人が起動するまで待ってから続けます。`--new` を付けると、既に動いていたセッションは使いません。

### 2.2 送る

- idle のセッションには新しい turn として届きます (`delivery: turn_started` / `submitted`)。
- 実行中のセッションには、Codex は実行中の turn に割り込んで渡し (`steered`)、Claude は今の turn の直後に次の turn として届けます (`queued`)。
- Claude の受け取りは Mod が 0.5 秒ごとに受信箱を見て行います。10 秒待っても Mod が答えなければ `timeout` になります (権限の確認などでセッションが止まっているときに起きます)。

### 2.3 止める

| セッション | `stop --turn` | `stop` |
|---|---|---|
| Claude (terminal / tmux) | turn を止める (Mod が要る) | turn を止めてからプロセスに SIGTERM |
| Claude (Desktop / VS Code) | turn を止める (Mod が要る) | turn だけ止める。プロセスはアプリで閉じてもらう (`processStopped: false`) |
| Codex | 実行中の turn を止める | 同じ。thread は daemon に残る |

Claude の `archive` と `delete` は、セッションが動いていれば先に止めます。Desktop と VS Code のものは止められないので、人に閉じてもらうよう `user_action_required` を返します。`delete` は transcript (`~/.claude/projects/*/<id>.jsonl`) を消します。

## 3. 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功 (一覧が空でも 0) |
| 1 | 実行時の失敗 (`provider_error`, `timeout`) |
| 2 | 引数の誤り (`invalid_argument`, `confirmation_required`) |
| 3 | セッションが見つからない / 曖昧 (`not_found`, `ambiguous_id`) |
| 4 | provider が使えない / 対応していない (`provider_unavailable`, `unsupported`) |
| 5 | 人の操作が要る (`user_action_required`) |

`--json` のときは、失敗も stdout に `{"error": {"code", "message", "hint", ...}}` で出ます。

## 4. 困ったとき

| 症状 | 見るところ |
|---|---|
| Claude のセッションが一覧に出ない | Claude Code 本体がセッション記録を書いているか (`ls ~/.claude/sessions`)。`agentctl doctor` の `problems` |
| `send` が `unsupported` | そのセッションに Mod が載っていない。1.2 の手順で入れてセッションを起動し直す |
| `send` が `timeout` | セッションが権限の確認やダイアログで止まっている。そのセッションの画面で答える |
| Codex が `provider_unavailable` | codex が PATH に無いか、daemon が起動できない。`codex app-server daemon start` を手で試す |
| Claude のセッションが強制終了後も残って見える | 記録の pid と起動時刻 (`procStart`) を照合しているので、ふつうは出ません。Linux 以外では pid だけで見ています |

環境変数: `AGENTCTL_HOME` (共有ディレクトリ、既定 `~/.agentctl`)、`CLAUDE_CONFIG_DIR` (既定 `~/.claude`)、`CODEX_HOME` (既定 `~/.codex`)、`AGENTCTL_CODEX_SOCKET` (daemon の socket を直に指す。daemon の自動起動は切れる)。
