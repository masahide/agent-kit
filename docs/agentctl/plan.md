# agentctl 実装計画書 (MVP)

作成日: 2026-09-27 / 更新: 2026-09-27 (Claude の一覧を Claude Code 本体の `~/.claude/sessions/<pid>.json` から読む形に変え、Mod を受信箱専用にした。引数の誤りでヘルプを出し、コマンドごとのヘルプを持たせた (3.2)。Claude のプロセスは agentctl が起動せず、人が起動した terminal / Claude Desktop / VS Code のセッションを使う形にし、tmux をやめた (2.3)。開発原則 (YAGNI) を足した。CLI の実装言語を Go にした (4 章)。CLI を agent が使いやすい形 ([agent-cli-patterns](https://github.com/openai/skills/blob/main/skills/.curated/cli-creator/references/agent-cli-patterns.md)) に作り直した) / 状態: 計画 (未着手)。7 章の未確認点を段階 0 で確かめてから段階 1 に入ります

## 要点

- 稼働中の Claude Code と Codex のセッションを、1 つの CLI `agentctl` から一覧、確認、起動、送信、待機、停止、アーカイブ、削除できるようにします。
- 主な利用者は人ではなく agent (Claude Code や Codex 自身) です。コマンドは「名詞 + 動詞」(`agentctl sessions list`) にそろえ、全コマンドで `--json` を出し、`doctor` と `resolve` と `raw` を持たせ、使い方を教える短いスキルを添えます (3 章)。
- Claude の一覧と状態は、Claude Code 本体が稼働中のセッションごとに書く `~/.claude/sessions/<pid>.json` から読みます。Mod (`plugins/agentctl`) の仕事は、CLI が置いた受信箱のメッセージを `$.prompt.submit` で投入することと、実行中の turn を `$.turn.abort` で止めることだけです。Channels は使いません。
- Claude のプロセスは agentctl が起動しません。人が terminal、Claude Desktop、VS Code で起動したセッションをそのまま使います。対象のセッションが動いていなければ、どこで何を起動すればよいかを返し、人に起動してもらいます (2.3)。
- Codex は、Codex の共有 app-server daemon に `codex app-server proxy` 経由でつなぎ、JSON-RPC (`thread/*`, `turn/*`) を呼びます。Codex の TUI も既定でこの daemon を使うので、人が起動した TUI のセッションも操作できます。
- 両者の差は `Adapter` という 1 つの interface で吸収します。
- CLI は Go で書き、単一のバイナリにします。外部のパッケージは使わず、標準ライブラリだけで作ります。Mod は TypeScript です (Mod は TypeScript でしか書けないため)。常駐の agentctl daemon は作りません。

## 開発原則

YAGNI (You Aren't Gonna Need It) の原則に従って実装します。いま必要なものだけを作り、「いずれ要りそう」なものは、実際に要るまで作りません。

- 作るのは 3 章に書いたコマンドとフラグだけです。8 章 (MVP でやらないこと) と 9 章 (将来の候補) は、実際に必要になってから計画を直して作ります。
- 抽象化は、使う場所が 2 つ以上あるときだけにします。`Adapter` は Claude と Codex の 2 つが使うので置きますが、その中身や設定の項目、差し替えの口を先回りして増やしません。
- 設定ファイル、プラグイン機構、キャッシュ、再試行の仕組みは、必要が確かめられるまで作りません。
- 7 章の確認で要らないと分かったものは、書きかけでも消します。この文書も、実装に合わせて削ります。

## 用語

| 語 | 意味 |
|---|---|
| provider | `claude` か `codex`。セッションを動かしている側です |
| セッション | Claude では session (`sessionId`)、Codex では thread (`threadId`) です。agentctl では両方を「セッション」と呼び、ID は元の ID をそのまま使います |
| adapter | provider ごとの差を吸収する実装です。`internal/claude` と `internal/codex` の 2 つです |
| セッション記録 | Claude Code 本体が稼働中のセッションごとに書く `~/.claude/sessions/<pid>.json` です。公開された形式ではありません |
| 共有ディレクトリ | `${AGENTCTL_HOME:-~/.agentctl}`。Claude の Mod と CLI がファイルでやり取りする場所と、agentctl が付けた名前やアーカイブの印を置きます |
| 起動元 (surface) | Claude のセッションがどこで動いているか。`desktop` (Claude Desktop)、`vscode`、`tmux`、`terminal` の 4 つで、本体がセッション記録の `entrypoint` と `tmux` から決めるのと同じ分け方です |
| 受信箱 (inbox) | CLI が Claude のセッションに届けたいメッセージを 1 件 1 ファイルで置くディレクトリです |
| ack | Mod が受信箱のメッセージを処理した結果を書くファイルです。CLI はこれを見て送信の成否を知ります |
| daemon (Codex) | `codex app-server daemon start` で動く共有の app-server です。control socket で待ち受けます |
| 付属スキル | agent に agentctl の使い方を教える短い SKILL.md です (3.9) |

## 1. 既存 API と Mod で実現できる範囲 (調査結果)

### 1.1 Claude Code (2.1.283)

このリポジトリの doc-desk Mod の実装と検証 (docs/doc-desk/plan.md 4 章)、バイナリに入っている engine の API 一覧、実機の `~/.claude/sessions/` を確かめました。

| やりたいこと | 使うもの | 判定 |
|---|---|---|
| 稼働中のセッションを列挙する | Mod の API には無い (`$.session.*` は自分のセッションのことしか返さず、他のセッションを列挙する API は無い)。代わりに本体のセッション記録 `~/.claude/sessions/<pid>.json` を読む | 可。記録には `pid`, `sessionId`, `cwd`, `name`, `kind`, `status` (`busy` / `idle` など), `waitingFor`, `startedAt`, `updatedAt`, `statusUpdatedAt`, `procStart`, `version` がある。値の種類は未確認 → C1 |
| 保存済み (止まっている) セッションを列挙する | transcript `~/.claude/projects/<cwd を変換した名前>/<sessionId>.jsonl` | 可 |
| プロセスが生きているか、PID が使い回されていないか | セッション記録の `pid` と `procStart` を `/proc/<pid>/stat` と照合する | 可の見込み → C1 |
| CLI からのメッセージを受ける | Mod の `$.clock.every` + `$.fs.list` + `$.fs.read` | 可の見込み。共有ディレクトリ (cwd の外) を読めるかは未確認 → C2 |
| Claude に投入する | Mod の `$.prompt.submit({ text })` | 可 (doc-desk の V5, V7)。`{ drop }` で断られることがある。busy 中の振る舞いは未確認 → C3 |
| 実行中の turn を止める | Mod の `$.turn.abort({ turnId })` (`turn.start` の `turnId`) | 可 (live-view で設計済み) |
| 起動元を知る | セッション記録の `entrypoint` (`claude-desktop` / `claude-desktop-3p` / `local-agent` は Desktop、`claude-vscode` は VS Code) と `tmux` | 可。本体も同じ規則で `desktop` / `vscode` / `tmux` / `terminal` に分けている (バイナリで確認) |
| プロセスを終わらせる | Mod からは不可 (終了 API が無い) | terminal と tmux のセッションだけ、CLI がセッション記録の `pid` に SIGTERM を送る。Desktop と VS Code のセッションは、それぞれのアプリが子プロセスを管理しているので送らない |
| 新規起動 / resume | agentctl からは行わない | 人に起動してもらう (2.3)。Claude Desktop を外から開く `claude://` / `claude-cli://` のリンクは本体にあるが、形式が公開されていないので MVP では使わない (9 章) |
| 会話の中身を読む | transcript の jsonl | 可 |
| アーカイブ / 削除 | Claude Code に API は無い | agentctl 側で模す (アーカイブは印を付けて一覧から隠す、削除は transcript の jsonl を消す) |

使わないもの:

- セッション記録の `messagingSocketPath` は、セッション同士のメッセージのやり取り (`SendMessage`) の socket です。Channels を使わない方針から外れるので使いません。
- Mod の `session.send` / `session.receive` / `session.attach` は bridge (Channels / Remote Control) 経由の配送なので使いません。
- Mod の `$.process.spawn` で常駐の子を持ち、push 型で受ける案は、寿命の扱いが未確認なので MVP では採りません (9 章)。

### 1.2 Codex (openai/codex main、2026-09-27 時点)

`codex-rs/app-server-protocol` と `codex-rs/cli` のソースで確かめました。

| やりたいこと | 使うもの | 判定 |
|---|---|---|
| 共有サーバにつなぐ | `codex app-server daemon start` (起動済みなら何もしない) と `codex app-server proxy` (stdio を control socket へ中継) | 可。agentctl は socket の場所を知らなくてよい |
| 人が起動した TUI を操作する | TUI は既定で共有 daemon を使う (`--no-daemon` で外れる) | 可の見込み → C5 |
| 一覧 | `thread/loaded/list` (daemon に読み込み済み) と `thread/list` (保存済み。`cursor`, `limit`, `archived`, `cwd` で絞れる) | 可 |
| 詳細と会話の中身 | `thread/read`、`thread/turns/list`、`thread/items/list` | 可 |
| 状態 | `Thread.status`: `notLoaded` / `idle` / `active { activeFlags: [waitingOnApproval, waitingOnUserInput] }` / `systemError`。変化は `thread/status/changed` 通知 | 可 |
| 新規 | `thread/start { cwd }` → 必要なら `turn/start` | 可 |
| resume | `thread/resume` | 可 |
| 送信 | idle なら `turn/start`、active なら `turn/steer { threadId, input, expectedTurnId }` | 可。`expectedTurnId` が必須なので、実行中の turn の ID を先に取る → C6 |
| 停止 | `turn/interrupt { threadId, turnId }`、`thread/unsubscribe` | 可。unsubscribe で daemon から降ろせるかは未確認 → C7 |
| アーカイブ / 削除 | `thread/archive` / `thread/delete` (`thread/unarchive` もある) | 可。live な内部 worker は `-32600` で拒まれる |

## 2. アーキテクチャ

```mermaid
flowchart LR
    A[agent / 人] --> CLI[agentctl CLI]
    CLI --> CA[ClaudeAdapter]
    CLI --> XA[CodexAdapter]
    subgraph Claude
      CA -- "一覧・状態を読む" --> S[(~/.claude/sessions/&lt;pid&gt;.json)]
      CA -- "会話を読む" --> J[(~/.claude/projects/*/&lt;id&gt;.jsonl)]
      CA -- "inbox/*.json を置く、ack を読む" --> D[(~/.agentctl/claude/&lt;id&gt;/)]
      CA -- "stop (terminal のみ)" --> SIG[SIGTERM]
      SIG --> CC
      H[人] -- "起動 / resume" --> CC[claude プロセス<br>terminal / Desktop / VS Code]
      CC -- 書く --> S
      M[agentctl Mod] -- "inbox を読む、ack を書く" --> D
      CC --- M
      M -- "$.prompt.submit / $.turn.abort" --> CC
    end
    subgraph Codex
      XA -- "JSON-RPC (stdio)" --> P[codex app-server proxy]
      P -- control socket --> DM[codex app-server daemon]
      TUI[codex TUI] --- DM
    end
```

- CLI は 1 コマンドごとに起動して終わる短命のプロセスです。常駐するのは Claude のプロセスと Codex の daemon だけで、どちらも既存のものです。
- Claude の一覧は本体のセッション記録から作るので、Mod を入れていないセッションも `sessions list` に出ます。`send` と `stop --turn` だけは Mod が要ります。Mod が載っているかは、Mod が起動時に書く `mod.json` で判断し、`capabilities.send` として出します。
- Claude のプロセスは人が起動します。agentctl は起動済みのプロセスを見つけて使い、見つからなければ人に起動を頼みます (2.3)。権限の確認や信頼ダイアログには、人がふだん使っている画面 (Desktop や terminal) でそのまま答えます。

### 2.1 Claude: 共有ディレクトリのファイル形式

```
~/.agentctl/
  claude/<sessionId>/
    mod.json            Mod だけが書く (起動時に 1 回)
    meta.json           CLI だけが書く (名前を付けたとき、アーカイブしたとき)
    inbox/<msgId>.json  CLI が書く (一時名で書いて rename)
    acks/<msgId>.json   Mod が書く
```

書き手をファイルごとに 1 人に決め、ロックを持ちません。

- `mod.json`: `{ v: 1, sessionId, pid, modVersion, startedAt }`。`/clear` で `sessionId` が変わったら、新しい ID のディレクトリにも書きます。
- `meta.json`: `{ v: 1, name, archived: false, updatedAt }`。
- `inbox/<msgId>.json`: `{ v: 1, id, kind: "prompt"|"interrupt", text?, createdAt }`。`msgId` は時刻順に並ぶ ID (`<epochms>-<rand>`) です。
- `acks/<msgId>.json`: `{ v: 1, id, status: "submitted"|"dropped"|"aborted"|"error", detail?, at }`。

Mod の受信箱の処理:

1. `$.clock.every(500ms)` で `inbox/` を `$.fs.list` し、`.json` だけを名前順に見ます。
2. `acks/<msgId>.json` が既にある、またはメモリ上で処理済みのものは飛ばします (Mod はファイルを消せないため)。
3. `prompt` は `$.prompt.submit({ text })`、`interrupt` は `$.turn.abort({ turnId })` (`turn.start` で覚えた main の turn) を呼び、結果を ack に書きます。
4. 処理済みの `inbox` と `acks` のファイルは CLI が消します (ack を読んだ直後と、`sessions list` のついで)。

heartbeat は持ちません。生存はセッション記録の `pid` と `procStart` で判断します。

### 2.2 共通の型と Adapter

```go
type Provider string // "claude" | "codex"
type State string    // "running" | "waiting" | "idle" | "stopped" | "archived" | "error"

type Session struct {
	ID           string       `json:"id"`
	Provider     Provider     `json:"provider"`
	State        State        `json:"state"`
	Cwd          string       `json:"cwd"`
	Title        *string      `json:"title"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt"`
	Capabilities Capabilities `json:"capabilities"` // send, interrupt, stop
	WaitingFor   *string      `json:"waitingFor"`   // 権限の確認待ちなど
	Surface      *string      `json:"surface"`      // desktop | vscode | tmux | terminal | codex-daemon。止まっていれば null
	Process      Process      `json:"process"`      // pid (無ければ null)
}

type Message struct {
	ID   string    `json:"id"`
	Role string    `json:"role"` // user | assistant | tool
	Text string    `json:"text"`
	At   time.Time `json:"at"`
}

type Adapter interface {
	Provider() Provider
	List(ctx context.Context, q ListQuery) (items []Session, nextCursor *string, err error)
	Get(ctx context.Context, id string) (Detail, error) // Session + raw (provider の元データ)
	Messages(ctx context.Context, id string, last int) ([]Message, error)
	// Claude は起動せず、人への依頼 (*StartRequest を包んだ error) を返す。Codex は Session を返す
	Create(ctx context.Context, dir string, o CreateOptions) (Session, error)
	Resume(ctx context.Context, id string) (Session, error)
	Send(ctx context.Context, id, text string) (Delivery, error) // turn_started | steered | submitted | queued
	Stop(ctx context.Context, id string, turnOnly bool) (stopped bool, err error)
	Archive(ctx context.Context, id string) error
	Delete(ctx context.Context, id string) error
	Raw(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)
}
```

`StartRequest` は `{ provider, dir, sessionId, instructions: { desktop, terminal, vscode }, detect: { cwd, sessionId, after } }` で、人に見せる手順と、起動を見つけるための条件です (2.3)。adapter はこれを `error` として返し、CLI 本体が `user_action_required` の出力と `--wait` に変えます。

`wait` は adapter に持たせず、CLI 本体が `get` を 1 秒ごとに呼んで状態を見ます (provider ごとの実装が要らない)。

状態の対応:

| agentctl | Claude (セッション記録) | Codex (`Thread.status`) |
|---|---|---|
| `running` | `status: busy` | `active` (フラグ無し) |
| `waiting` | `waitingFor` がある (値の種類は C1) | `active` + `waitingOnApproval` / `waitingOnUserInput` |
| `idle` | `status: idle` | `idle` |
| `stopped` | 記録が無い、または `pid` が死んでいる / 別のプロセスになっている。transcript だけある | `notLoaded` |
| `archived` | `meta.json` の `archived: true` | `thread/list { archived: true }` に出るもの |
| `error` | — | `systemError` |

### 2.3 Claude のプロセスは人が起動する

agentctl は Claude のプロセスを起動しません。tmux も使いません。人が terminal、Claude Desktop、VS Code で起動したセッションは、どれも本体のセッション記録に載るので、agentctl はそれを見つけて使います。

起動済みのプロセスを探す順:

1. `<id>` を指定されたら、その `sessionId` のセッション記録を探し、`pid` が生きていれば使います。
2. `sessions create claude <dir>` では、`cwd` が `<dir>` の稼働中のセッションを探します。あれば新しく起動せずにそれを返し、`reused: true` を付けます (`--new` を付けたときは探さない)。
3. 見つからなければ、人への依頼を返します。

人への依頼の中身 (`--json` では `error.code: "user_action_required"`、終了コード 5):

```json
{ "error": { "code": "user_action_required",
    "message": "No running Claude session in /home/u/src/api. Ask the user to start one.",
    "action": { "kind": "start_claude", "dir": "/home/u/src/api", "sessionId": null,
      "instructions": {
        "desktop":  "Claude Desktop > Code > New session > choose folder /home/u/src/api",
        "terminal": "cd /home/u/src/api && claude",
        "vscode":   "Open /home/u/src/api in VS Code and start Claude Code" } },
    "next": ["agentctl --json sessions create claude /home/u/src/api --wait 600"] } }
```

- `resume` では `terminal` の手順が `claude --resume <id>`、Desktop の手順が「Code の履歴から <title> を開く」になります。
- `--json` が無いときは、同じ内容を人が読める文で stderr に出します。
- `--wait SEC` を付けると、依頼を stderr に出したまま、条件に合うセッション記録が現れるまで待ちます (`cwd` が一致し、`startedAt` が依頼より後。`resume` は `sessionId` が一致)。現れたら普通の成功として返し、時間切れなら `user_action_required` を返します。agent は依頼を人に伝えてから `--wait` 付きで打ち直せばよく、人が起動した時点で続きに進めます。
- 見つかったセッションに Mod が載っていない (`mod.json` が無い) ときは、`send` が `unsupported` になり、`hint` に「Mod を有効にしてセッションを開き直す」手順を出します。

`--prompt` の扱い: 見つけた (または人が起動した) セッションに、続けて `send` と同じ経路で送ります。

`stop` の扱い:

| 起動元 | `stop --turn` | `stop` |
|---|---|---|
| `terminal` / `tmux` | Mod で turn を止める | turn を止めてから `pid` に SIGTERM (`procStart` が合うときだけ) |
| `desktop` / `vscode` | Mod で turn を止める | turn だけ止め、プロセスは残す。`hint` に「アプリでセッションを閉じる」と出す (`stopped: false` を返す) |

Desktop と VS Code の子プロセスをシグナルで殺すと、アプリ側が異常終了として扱うおそれがあるためです。

## 3. CLI 仕様 (agent 向け)

[agent-cli-patterns](https://github.com/openai/skills/blob/main/skills/.curated/cli-creator/references/agent-cli-patterns.md) に従い、次の方針で作ります。

- 名詞 + 動詞にそろえます。名詞は `sessions` だけで、`doctor` と `raw` を加えます。
- 発見 (`list`) → 解決 (`resolve`) → 読む (`get`) → 文脈 (`messages`) の順に、小さな読み取りのコマンドを揃えます。安定した ID が手元にあれば、agent が検索し直さなくてよいようにします。
- `--json` を全コマンドに付けます。stdout には JSON だけを出し、進捗と診断は stderr に出します。
- 書き込み (`send`, `stop`, `archive`, `delete`, `raw` の書き込み系) は、実際に効く操作として扱い、`--help` にもそう書きます。
- 対話の確認はしません。TTY が無い agent が止まってしまうからです。消す操作は `--yes` が無ければエラーで返します。

### 3.1 コマンド一覧 (`agentctl --help` にそのまま載せる)

```
Discover
  agentctl doctor                                   使える provider と足りないもの
  agentctl sessions list [--provider P] [--cwd DIR] [--state S] [--all] [--limit N] [--cursor C]

Resolve
  agentctl sessions resolve <id-prefix | name | directory>

Read
  agentctl sessions get <id>
  agentctl sessions messages <id> [--last N]        直近の会話 (既定 10 件)

Wait
  agentctl sessions wait <id> [--until idle|stopped|waiting] [--timeout SEC]

Write (実際に効きます)
  agentctl sessions create <provider> <directory> [--prompt TEXT | --prompt-file F] [--name NAME] [--new] [--wait SEC] [-- <codex の引数>]
  agentctl sessions resume <id> [--wait SEC]
  agentctl sessions send <id> (--text TEXT | --text-file F | --text-file -)
  agentctl sessions stop <id> [--turn]
  agentctl sessions archive <id>
  agentctl sessions delete <id> --yes

Raw (修理用。書き込み系も実際に効きます)
  agentctl raw codex <json-rpc-method> [--params-json JSON]
  agentctl raw claude record <id>                   セッション記録と mod.json をそのまま出す

Global
  --json       stdout に JSON だけを出す
  --provider   claude | codex (ID の解決を片方に限る)
```

人向けに、最初の構想の短い名前を別名として残します: `ps` = `sessions list`, `info` = `sessions get`, `new` = `sessions create`, `send` / `stop` / `archive` / `delete` = `sessions <同名>`。`--help` では正式な形だけを見せ、別名は末尾に 1 行で書きます。

### 3.2 ヘルプと引数の誤り

ヘルプは各階層で出せるようにし、引数を間違えたときは、そのコマンドのヘルプを添えて返します。agent は `--help` を読んで打ち直すので、エラーの 1 行だけでは次の手が分かりません。

出し方 (どれも同じ文を stdout に出し、終了コード 0):

```
agentctl --help                    全体: 名詞の一覧、Global フラグ、最初に打つコマンド
agentctl sessions --help           sessions の動詞の一覧と、それぞれの 1 行説明
agentctl sessions send --help      send の書式、引数、フラグ、例、JSON の形、終了コード
agentctl help sessions send        上と同じ (-h も同じ)
agentctl                           引数無しは agentctl --help と同じ
agentctl sessions                  動詞無しは agentctl sessions --help と同じ
```

各コマンドのヘルプに載せるもの:

```
Usage: agentctl sessions send <id> (--text TEXT | --text-file F | --text-file -) [--json]

Send a message to a session. Starts a turn if idle; steers the running turn (codex)
or submits it to the prompt (claude) if busy.
This is a live write.

Arguments:
  <id>                session id or unique id prefix (see: agentctl sessions resolve)

Flags:
  --text TEXT         message body
  --text-file F       read the body from F ("-" for stdin)
  --json              print JSON only on stdout

Examples:
  agentctl --json sessions send 0199a1c2 --text "run the tests again"
  echo "..." | agentctl --json sessions send 0199a1c2 --text-file -

Output (--json):
  { "session": Session, "delivery": "turn_started"|"steered"|"submitted"|"queued", "next": [string] }

Exit codes: 0 ok, 2 bad arguments, 3 not found/ambiguous, 4 unsupported (no Mod), 1 other
```

引数を間違えたとき (終了コード 2):

| 誤り | 出すもの |
|---|---|
| 知らない名詞・動詞 (`agentctl sesions list`, `agentctl sessions lsit`) | エラー 1 行、近い候補 (`did you mean: sessions list?`、編集距離 2 以内)、1 つ上の階層のヘルプ (動詞の一覧) |
| 知らないフラグ、値の無いフラグ、必須の引数が無い、同時に使えないフラグ | エラー 1 行と、そのコマンドのヘルプ全文 |
| 値の形が違う (`--limit abc`, `--until done`) | エラー 1 行 (取れる値を並べる) と、そのコマンドのヘルプ全文 |
| `delete` に `--yes` が無い | `confirmation_required` と、そのコマンドのヘルプ全文 |

- `--json` が無いときは、エラーとヘルプを stderr に出します (stdout は空)。
- `--json` のときは、stdout を JSON だけに保つため、ヘルプを `error` の中に入れます。stderr にも同じヘルプを出します。

```json
{ "error": { "code": "invalid_argument", "message": "unknown flag: --txt",
             "suggestions": ["--text"],
             "usage": "Usage: agentctl sessions send <id> (--text TEXT | ...)\n...",
             "help": "agentctl sessions send --help" } }
```

- `agentctl --json help sessions send` は、ヘルプを JSON (`{ command, usage, description, args, flags, examples, output, exitCodes, isWrite }`) で返します。agent が書式を機械的に確かめたいとき用です。
- 実行時の失敗 (`not_found`, `provider_error` など) ではヘルプを出しません。引数は正しいので、ヘルプを出すと本当の原因が埋もれるからです。代わりに `hint` で次のコマンドを示します。

作り方: コマンドの定義 (名前、説明、引数、フラグ、例、出力の形、書き込みかどうか) を `internal/cli/commands.go` に 1 つの表 (構造体のスライス) として持ち、引数解析、検査、ヘルプの文、`help --json` をすべてこの表から作ります。ヘルプと実際の挙動がずれないようにするためです。

### 3.3 ID と解決

- 各コマンドの `<id>` は、完全な ID か、ID の前方一致 (docker と同じ) です。両 provider の ID をまとめて照合し、1 件に決まらなければ `ambiguous` エラーで候補を返します。
- `sessions resolve` は、ID の前方一致、`--name` で付けた名前、ディレクトリ (その cwd で動いているセッション) を受け取り、候補を返します。人の言葉 (「api のほうの Codex」) を ID に変える入口です。
- 出力の `id` は常に完全な ID です。agent は以後それを使います。

### 3.4 各コマンドの provider ごとの中身

| コマンド | Claude | Codex |
|---|---|---|
| `doctor` | `claude --version`、`~/.claude/sessions/` が読めるか、Mod が有効か (稼働中のセッションの `mod.json` の有無) | `codex --version`、daemon につながるか (`initialize` が返るか) |
| `sessions list` | セッション記録 (稼働中)。`--all` で transcript と `meta.json` から止まっているものも | `thread/loaded/list`。`--all` で `thread/list` (`cursor` をそのまま `nextCursor` に) |
| `sessions get` | セッション記録、`mod.json`、`meta.json`、transcript のパス | `thread/read` |
| `sessions messages` | transcript の jsonl の末尾から user / assistant の行を N 件 | `thread/turns/list` か `thread/items/list` の末尾 N 件 |
| `sessions wait` | `get` の繰り返し | `get` の繰り返し |
| `sessions create` | `<dir>` の稼働中のセッションを返す。無ければ人への依頼 (2.3)。`--wait` で現れるまで待つ | `daemon start` → `thread/start { cwd }` → `--prompt` があれば `turn/start` |
| `sessions resume` | 動いていればそのまま返す。止まっていれば人への依頼 (2.3) | `thread/resume` |
| `sessions send` | `inbox/` に置き、`acks/` を最大 10 秒待つ | idle なら `turn/start`、active なら `turn/steer` |
| `sessions stop` | 2.3 の表のとおり (terminal / tmux だけ SIGTERM) | `turn/interrupt` → `thread/unsubscribe` |
| `sessions stop --turn` | `interrupt` を送るだけ | `turn/interrupt` だけ |
| `sessions archive` | 止めてから `meta.json` に `archived: true` | `thread/archive` |
| `sessions delete` | 止めてから共有ディレクトリと transcript の jsonl を消す | `thread/delete` |

`send` の意味の揃え方: Codex は active 中の送信を `turn/steer` にします。Claude は `$.prompt.submit` に任せ、実際にどうなったかを `delivery` (`submitted` / `queued`) で返します。busy 中の振る舞いは C3 で確かめます。

### 3.5 JSON の形

成功 (stdout、終了コード 0。結果が空でも 0):

```jsonc
// sessions list
{ "items": [ { "id": "3f746262-1811-5237-9497-992c2b8dd58a", "provider": "claude", "state": "running",
               "cwd": "/home/u/src/agent-kit", "title": "agent-kit-1f",
               "createdAt": "...", "updatedAt": "...", "waitingFor": null,
               "capabilities": { "send": true, "interrupt": true, "stop": true },
               "surface": "desktop", "process": { "pid": 103 } } ],
  "nextCursor": null }

// sessions create / send / stop など、書き込みの結果には次に打つコマンドを添える
{ "session": { ... }, "delivery": "turn_started",
  "next": ["agentctl --json sessions wait 0199a1c2-... --until idle",
           "agentctl --json sessions messages 0199a1c2-... --last 1"] }
```

失敗 (stdout、終了コード 0 以外):

```json
{ "error": { "code": "ambiguous_id", "message": "3f7 matches 2 sessions",
             "candidates": [ { "id": "...", "provider": "claude" }, { "id": "...", "provider": "codex" } ],
             "hint": "use a longer prefix or --provider" } }
```

`error.code` の一覧: `invalid_argument` (3.2 のとおり `usage` と `suggestions` を付ける), `not_found`, `ambiguous_id`, `confirmation_required`, `unsupported` (例: Mod の無いセッションへの `send`), `provider_unavailable` (claude / codex / daemon が無い), `user_action_required` (人に Claude を起動してもらう必要がある。`action` と `next` を付ける。2.3), `timeout` (`wait` と `send` の ack), `provider_error` (Codex の JSON-RPC エラーをそのまま `detail` に)。

`--json` が無いときは人向けの表と文を stdout に出し、エラーは stderr に 1 行で出します。

JSON には、transcript の本文や token などの余計な中身は入れません。`messages` の本文は各 2,000 文字で切り、切ったことを `truncated: true` で示します。

### 3.6 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功 (一覧が空でも 0) |
| 1 | 実行時の失敗 (`provider_error`, `timeout`) |
| 2 | 引数の誤り (`invalid_argument`, `confirmation_required`) |
| 3 | セッションが見つからない / 曖昧 (`not_found`, `ambiguous_id`) |
| 4 | provider が使えない / その操作に対応していない (`provider_unavailable`, `unsupported`) |
| 5 | 人の操作が要る (`user_action_required`)。agent は `action` を人に伝えてから `next` を打つ |

`doctor --json` は、何も入っていない環境でも終了コード 0 で、足りないものを項目ごとに返します。

### 3.7 広さの調整

- `sessions list` は既定で稼働中だけ、最大 20 件です。`--all` で止まっているものとアーカイブも含めます。
- `--limit` と `--cursor` を持ち、`nextCursor` を返します。Codex は `thread/list` の cursor を、Claude は transcript の更新時刻順の位置を cursor にします。
- `sessions messages` は既定で直近 10 件です。

### 3.8 raw

- `raw codex <method>` は、agentctl がつないだ daemon に JSON-RPC をそのまま投げ、結果をそのまま返します。`thread/delete` などの書き込みも通るので、`--help` に「実際に効きます」と書きます。
- `raw claude record <id>` は、セッション記録と `mod.json` と `meta.json` をまとめて返します。読み取りだけです。

### 3.9 付属スキル

`plugins/agentctl/skills/agentctl/SKILL.md` に置きます。README より短く、道順だけを書きます。Codex でも使えるよう、Claude 固有の記法は使いません (`~/.codex/skills/` に写せば使える)。

```md
Start with:

agentctl --json doctor
agentctl --json sessions list

To hand work to another agent:

agentctl --json sessions create codex <dir> --prompt-file task.md
agentctl --json sessions wait <id> --until idle --timeout 1800
agentctl --json sessions messages <id> --last 1

To steer a running session:

agentctl --json sessions resolve <dir or name>
agentctl --json sessions send <id> --text-file -

Rules:

- Use --json when reading output. Use the full id from the output.
- Do not stop, archive or delete sessions the user did not ask about.
- delete needs --yes; ask the user first.
- If you get user_action_required, show error.action.instructions to the user,
  then run the command in error.next (it waits until the session appears).
- Use raw only when a sessions command is missing.
```

## 4. ディレクトリ構成

```
plugins/agentctl/                 Claude Mod (受信箱) と付属スキル
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts               session.start (mod.json)、turn.start (turnId)、受信箱の監視
  hooks/protocol.ts               共有ディレクトリのファイル形式と定数 (CLI の protocol.go と同じ形)
  hooks/inbox.ts                  受信箱の処理 (純関数。テストしやすくする)
  skills/agentctl/SKILL.md        付属スキル (3.9)
  tests/register.test.ts          claude plugin test
  tests/fixtures/protocol/*.json  共有ディレクトリのファイルの見本 (CLI の Go のテストも読む)
  README.md
tools/agentctl/                   CLI (Go、module は github.com/masahide/agent-kit/tools/agentctl)
  go.mod                          標準ライブラリだけ。require は持たない
  main.go                         cli.Run(os.Args, stdout, stderr) を呼んで終了コードを返すだけ
  internal/cli/commands.go        コマンドの定義の表 (引数解析、検査、ヘルプの元。3.2)
  internal/cli/parse.go           表から flag.FlagSet を組む、引数の検査
  internal/cli/help.go            各階層のヘルプの文、help --json、近い候補 (編集距離)
  internal/cli/output.go          JSON / 表の出し分け、エラーの形、終了コード
  internal/cli/run.go             コマンドの振り分け、ID の解決、sessions wait
  internal/session/session.go     共通の型と Adapter interface
  internal/claude/adapter.go
  internal/claude/records.go      ~/.claude/sessions と transcript の読み取り、生存判定
  internal/claude/inbox.go        共有ディレクトリの読み書き (atomic write、掃除)
  internal/claude/protocol.go     共有ディレクトリのファイル形式 (Mod の protocol.ts と同じ形)
  internal/claude/start.go        人への依頼 (手順の文と、起動を見つける条件)
  internal/codex/adapter.go
  internal/codex/rpc.go           `codex app-server proxy` 越しの JSON-RPC クライアント
  internal/*/..._test.go          go test
docs/agentctl/plan.md             この文書
docs/agentctl/usage.md            利用者ガイド (段階 6)
```

- CLI は Go 1.24 以降で書き、`go build` で単一のバイナリにします。引数の解析は標準の `flag` を使い、cobra などの外部パッケージは使いません (YAGNI)。
- 配るのは `go install github.com/masahide/agent-kit/tools/agentctl@latest` だけにします。リリース用のバイナリの配布は、必要になってから考えます。
- 共有ディレクトリのファイル形式は、Mod の `hooks/protocol.ts` と CLI の `internal/claude/protocol.go` に 2 回書くことになります。ずれを防ぐため、見本の JSON を Mod 側の `plugins/agentctl/tests/fixtures/protocol/` に置き、Mod のテストと Go のテスト (リポジトリの相対パスで読む) の両方がそれを読んで、自分の型で読み書きできることを確かめます。Mod のテストが plugin の外を読めるとは限らないので、置き場を Mod 側にします。形を変えるときは見本から直します。
- 共有ディレクトリのファイル形式に `v: 1` を持たせ、読み手は知らない `v` を読まずにエラーにします。

## 5. 実装手順

各段階を 1 PR にします。段階ごとに動くものが増えるように並べました。

### 段階 0: 未確認点の確認 (スパイク)

7 章の C1〜C7 を、最小の Mod と手打ちの JSON-RPC で確かめます。結果で設計が変わるものがあれば、この文書を直してから段階 1 に入ります。

### 段階 1: CLI の骨組み

- `go.mod` と `main.go`、`internal/cli` (定義の表、表から組む `flag.FlagSet`、各階層のヘルプと近い候補と `help --json`、JSON とエラーの形と終了コード、ID の解決、`sessions wait`)、`internal/session` (型と Adapter)。
- 偽の adapter で `sessions list` / `get` / `resolve` / `wait`、エラーの形と終了コードをテストします。
- ヘルプは、全コマンドで `--help` / `-h` / `help <...>` が同じ文を返すこと、引数の誤りの 4 種類 (3.2 の表) でヘルプが付いて終了コード 2 になること、`--json` のとき stdout が JSON だけで `error.usage` が入ることをテストします。

### 段階 2: Claude の読み取り

- `records.go`: セッション記録の読み取りと生存判定、transcript の列挙と末尾の読み取り。
- `doctor`、`sessions list` / `get` / `messages` / `resolve`、`raw claude record` を Claude につなぎます。Mod はまだ要りません。

### 段階 3: Claude Mod と送信

- Mod: `session.start` で `mod.json`、`turn.start` で `turnId`、受信箱の監視と ack。
- CLI: `sessions send` (inbox に置く → ack を待つ → 両方消す) と `sessions stop --turn`。
- 付属スキルもここで置きます。

### 段階 4: Claude の lifecycle

- `start.go` と `sessions create` / `resume` (起動済みの再利用、人への依頼、`--wait`)、`stop` (起動元ごとの扱い)、`archive` / `delete`。
- Desktop と terminal の両方で、人が起動したセッションを `--wait` が拾うことを実機で確かめます。

### 段階 5: Codex adapter

- `rpc.go`: `codex app-server proxy` を `os/exec` で子として起動し、`initialize` → `initialized` → 要求 → 終了。行区切りの JSON で、ID の対応と通知の読み捨てだけを持つ小さなクライアントにします。つながらなければ `codex app-server daemon start` を 1 回呼んで再試行します。
- `doctor` から `raw codex` まで、全コマンドを 1 つずつ。
- テストは、JSON-RPC を返す偽の proxy を `AGENTCTL_CODEX_PROXY` で差し替えて行います。偽の proxy はテストのバイナリ自身を別の役で起動する形 (`os.Args[0]` と環境変数で切り替える、Go の標準のやり方) にし、スクリプトを別に持ちません。

### 段階 6: 仕上げ

- `docs/agentctl/usage.md` (Mod の入れ方、Desktop と terminal での使い方、困ったとき)。
- 実機での通し確認: 両 provider で `doctor` → `create` → `list` → `send` → `wait` → `messages` → `stop` → `resume` → `archive` → `delete`。
- agent に使わせる確認: 付属スキルだけを持たせた Claude と Codex に「別の agent に作業を頼み、終わったら結果を要約して」と頼み、`--help` と付属スキルだけで迷わず通るかを見ます。詰まったところは help か付属スキルを直します。

### テストの方針

- Mod: `claude plugin test` (doc-desk と同じ `claude-code/testing`)。受信箱の処理は純関数に切り出して単体で試します。
- CLI: `go test ./...`。`HOME` を `t.TempDir()` にして、セッション記録と transcript と Mod が書くファイルを fixture で置きます。シグナルは薄い関数に閉じ込めて差し替えます。`--wait` は、待っている間に fixture のセッション記録を足して確かめます。
- 全コマンドについて、`--json` の stdout が JSON として読めること、stderr に JSON が混ざらないことを確かめます。
- 静的検査: CLI は `gofmt -l` (差分なし) と `go vet ./...`。Mod は `npx -y -p typescript tsc --noEmit`。
- 共有ディレクトリの見本 (`plugins/agentctl/tests/fixtures/protocol/*.json`) を、Go のテストと Mod のテストの両方で読みます (4 章)。

## 6. セッション記録を使う危うさと対策

`~/.claude/sessions/<pid>.json` は公開された形式ではないので、Claude Code の更新で形が変わるおそれがあります。

- 読むのは `records.go` の 1 か所だけにし、必須の項目は `pid` と `sessionId` と `cwd` に絞ります。ほかの項目は無ければ `null` にします。
- 読めない記録は飛ばし、`doctor` に「読めない記録が N 件ある (Claude Code <version>)」と出します。
- `kind` が `interactive` 以外 (subagent や背景の job など) の扱いは C1 で確かめ、MVP では一覧から外します。

## 7. 未確認点 (段階 0 で確かめる)

| 番号 | 確かめること | 影響 | 確かめ方 |
|---|---|---|---|
| C1 | セッション記録の `status` と `waitingFor` と `kind` が取る値。`procStart` が `/proc/<pid>/stat` の何と対応するか。プロセスが落ちたとき記録が残るか | `state` の対応表、生存判定、一覧に出す範囲 | 対話と `-p` で起動し、権限の確認を出し、kill して記録を見る |
| C2 | Mod の `$.fs.list` / `$.fs.read` / `$.fs.write` が cwd の外 (`~/.agentctl`) に届くか | 届かなければ、共有ディレクトリを `$.process.run` の小さなスクリプト経由で読み書きする | 最小の Mod |
| C3 | 対話モード (terminal と Desktop) で、idle と busy のそれぞれで `$.prompt.submit` がどうなるか (即時 turn / キュー / `drop`) | `send` の `delivery` の値 | 最小の Mod + 手で送信 |
| C4 | Claude Desktop の Code セッションで、(a) セッション記録が書かれ `entrypoint` が `claude-desktop` になるか、(b) user の plugin (Mod) と function hooks が読み込まれるか (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` を Desktop にどう渡すか)、(c) `$.prompt.submit` で投入した文が Desktop の画面に出て turn が始まるか、(d) 信頼ダイアログの前にセッション記録が書かれるか | Desktop 対応が成り立つか。(b) が無理なら Desktop のセッションは一覧と読み取りだけにする | Desktop で起動して最小の Mod |
| C5 | 人が起動した `codex` TUI の thread が `thread/loaded/list` に出て、`turn/steer` が TUI に反映されるか | Codex の「稼働中セッションの操作」が成り立つか | 手で起動 + proxy |
| C6 | 実行中の turn の ID を `thread/read` か `thread/turns/list` のどちらで取るのが確実か | `send` (steer) と `stop` | proxy |
| C7 | `thread/unsubscribe` の後、他に購読者がいなければ thread が `notLoaded` に戻るか。TUI が購読中ならどうなるか | Codex の `stop` の意味 | proxy |

## 8. MVP でやらないこと

- 出力のストリーミング (`messages --follow`)、`attach` コマンド。
- agentctl による Claude のプロセスの起動 (tmux、headless の `claude -p` とも)。人に起動してもらう (2.3)。
- `--jq` や `--json <fields>` による項目の選択 (パターン文書でも「要るときだけ」としている。`jq` で足りる)。
- 複数マシン、リモートの daemon。Windows は、`/proc` を使う生存判定の代わりが要るので後回しにする。
- アーカイブの取り消し (`unarchive`)、名前の変更。

## 9. 将来の候補

- Claude Desktop を `claude://` のリンクで開き、指定のフォルダで新しいセッションを始める (リンクの形式が分かり、安定したら)。人への依頼が 1 手減る。

- Mod の受信を `$.process.spawn` の常駐の子 (unix socket で待ち、届いたら stdout に 1 行出す) に替え、500 ms のポーリングを無くす。
- `sessions messages --follow` (Claude は transcript の追記、Codex は通知の購読)。
- `sessions wait` を Codex では `thread/status/changed` 通知で待つ (ポーリングを無くす)。
