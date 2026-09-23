# doc-desk

使い方 (読み込み方、フォームの使い方、困ったとき) は [利用者ガイド](../../docs/doc-desk/usage.md) にあります。

doc-desk Mod (MVP)。Claude が文書を書く前に、文書の構成案と決定してほしい論点を
質問票 JSON としてツール `open_form` に渡すと、この Mod が自己完結の HTML シートを
`./doc-desk/` に書き、Python 3 の受信サーバをローカルに立ててブラウザで開きます。
人がブラウザで答えて [送信] を押すと、受信サーバが回答 JSON をファイルに書いて終了し、
Mod がそれを回答固定形 (`【doc-desk 回答】` で始まる文) にして Claude に届けます。

届け方は 2 経路です。`open_form` はツール呼び出しの中で `waitSeconds` (既定 300 秒) まで回答を待ち、
届けば固定形を Tool result (`status: "answered"`, `reply`) で返します (同期経路)。
上限に達した、人が Esc で中断した、受信サーバに届かなくなった、`waitSeconds: 0` のときは
`status: "pending"` を返してターンを終えてもらい、以後は `clock.every` の監視が回答を検知して
`$.prompt.submit` で user turn として届けます (非同期経路)。

指摘モード: Claude が書き上げた文書を HTML にして `doc-desk/<label>.doc.html` に書き出し、
ツール `open_review` を呼ぶと、この Mod がそのファイルを検査して指摘の画面を出します。
人は段落や文字列にチップ (短くする、根拠が要る、ここは良い など 9 種) とコメントで指摘を付け、段落をその場で書き換え、消し、足し、動かせます (添削)。
受信サーバ、同期待ち、監視、ペインは `open_form` と同じで、指摘は同じ `【doc-desk 回答】` の固定形の
`## 指摘` と `## 書き換え` の節で届きます。

背景と決定の記録は [docs/doc-desk/plan.md](../../docs/doc-desk/plan.md) にあります。
対象は Claude Code 2.1.278 の Claude Mods (function hooks、早期アクセス) です。

## 流れ

```mermaid
sequenceDiagram
    participant U as 人
    participant C as Claude
    participant M as Mod
    participant R as 受信サーバ (Python 3)
    participant B as ブラウザ
    C->>M: tool.call open_form(質問票 JSON)
    M->>M: 検証 → ./doc-desk/<label>.json と .html を書く
    M->>R: $.process.run([python, receiver.py, start, ...]) (シェルは使わない)
    M->>M: port-file を最大 3 秒ポーリングして port と pid を得る
    M->>B: $.process.run([python, receiver.py, open, <url>])
    M->>M: $.ui.open(pane) で URL と状態を表示
    Note over M: $.clock.every(500ms) で回答ファイルを監視 (同期待ち中は経過秒数の更新だけ)
    loop 同期待ち (waitSeconds まで、既定 300 秒)
        M->>R: $.http.fetch(GET /wait?t=<token>&timeout=4)
        R-->>M: 回答の POST か 4 秒で {"answered": true|false}
    end
    U->>B: 答えて [送信]
    B->>R: POST /answer?t=<token> (JSON)
    R->>R: <label>.answer.json を書き、保留中の /wait に応答して自動終了
    alt waitSeconds 以内 (同期経路)
        M->>M: 回答を読み (documentId と revision を照合)、固定形を作り、<label>.md を書き、ペインを閉じる
        M-->>C: { result: {status:"answered", reply, files}, context }
    else 上限到達・Esc で中断・受信サーバ喪失・waitSeconds が 0 (非同期経路)
        M-->>C: { result: {status:"pending", url, files, wait}, context }
        M->>M: 監視タイマーが回答を読み、固定形を作り、<label>.md を書く
        M->>C: $.prompt.submit({ text: 回答固定形 })
    end
```

同期経路があるのは、人が数分で答えるふつうの場合に、Claude のターンを切らずに回答を渡すためです。
`pending` だけだと Claude のターンが一度終わり、回答は別の user turn として届きます。

## ファイル

| パス | 役割 |
| --- | --- |
| `hooks/register.ts` | フックの登録と状態機械 (idle → waiting → submitting → idle) |
| `hooks/host/index.ts` | `session.start` で `$` を束ねた関数群の型 |
| `hooks/names.ts` | plugin 名、ツール名、コマンド名、ペイン id、見出し語 |
| `hooks/form/form-v1.ts` | 質問票 JSON スキーマ v1 と回答 JSON の型 |
| `hooks/form/validate.ts` | 質問票の検証 (エラーを全部返す) |
| `hooks/form/outline.ts` | 構成案の HTML で使える要素と属性 (検証と画面で共有)、構成案の検査 (使えない要素、印の過不足) |
| `hooks/form/answer.ts` | 回答 JSON の読み取り (`documentId` と `revision` が質問票と違えば無視) |
| `hooks/form/schema.ts` | `$.tool.register` に渡す JSON Schema |
| `hooks/sheet/render-html.ts` | 質問票 → 自己完結 HTML (素の JS を文字列で埋める)。左に構成案、右に選んだものの詳細 (全体の進み具合と次に見る項目 / 決定 / 表の説明)、下に進捗と送信。構成案の HTML はブラウザで DOMParser にかけ、許可した要素と属性だけで組み直す |
| `hooks/sheet/common.ts` | 2 つの画面が共有する CSS と、HTML と JSON の逃がし |
| `hooks/sheet/render-review.ts` | 指摘の画面 → 自己完結 HTML。左に文書 (DOMParser で解析し、許可した要素と属性だけで組み直す)、段落に上から番号を振る。右に全体 (指摘と書き換えの数と一覧、全体へのコメント) か、選んだ段落の操作 (チップ、コメント、この段落の指摘、書き換え・削除・移動・追加)。書き換えた段落は左に書き換えた後の文を出す |
| `hooks/reply/format.ts` | 回答 JSON + 質問票 → 回答固定形 v1 |
| `hooks/review/review-v1.ts` | 指摘の画面 (`review`) と指摘の回答 JSON の型 (指摘と添削)、チップ 9 種 |
| `hooks/review/validate-review.ts` | `review` の検証 (エラーを全部返す) |
| `hooks/review/document.ts` | 文書の HTML の検査 (構成案と同じ要素、属性は表の colspan と rowspan だけ、10 万文字まで、段落が 1 つ以上) と、段落番号を振る要素 |
| `hooks/review/answer.ts` | 指摘の回答 JSON の読み取り (`kind`、`documentId`、`revision` が違えば無視、形の違う指摘と添削は捨てる) |
| `hooks/review/format.ts` | 指摘の回答 JSON → 回答固定形 (`## 指摘`、`## 指摘した段落`、`## 書き換え`) |
| `hooks/receiver/index.ts` | Python 3 の候補 (`python3`、`python`、`py -3`)、`receiver.py` のサブコマンドの argv (`start`、`clean`、`open`、`stop`)、port-file の読み取り、URL (`/`, `/wait`, `Link` 用の localhost) |
| `hooks/wait/sync-wait.ts` | 同期待ち: `tool.call` の中で `/wait` のロングポーリングを繰り返し、回答ファイルを読む (読み方は画面ごとに渡す) |
| `hooks/views/pane-view.ts` | 待機中のペイン (Box / Text / Button / Link) |
| `hooks/views/strings.ts` | 固定文言 |
| `hooks/tool-input.d.ts` | `McpToolInputs` にツールの入力を足す宣言 (型付けのみ) |
| `scripts/receiver.py` | ローカル受信サーバ (Python 3 の標準ライブラリのみ、127.0.0.1、`/wait` のロングポーリング付き) と、OS ごとに違う操作のサブコマンド (`start` で切り離して起動、`open` でブラウザ、`clean` で削除、`stop` で停止) |
| `skills/doc-desk/` | Claude 側の手順 (SKILL.md) と references (下の「スキル」) |
| `tests/` | `claude plugin test` のテストと fixtures |

## What it hooks

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugins/doc-desk` の印字:

```
❯ ./register.ts hooks: session.start, tool.call{tool=mcp__doc-desk__open_form}, tool.call{tool=mcp__doc-desk__open_review}, command.run{command=doc-desk}, ui.render{component=Pane}, ui.close{id=doc-desk}
```

| event | what the hook does |
| --- | --- |
| `session.start` | `$` を host に束ね、ツール `open_form` と `open_review` と `/doc-desk` を登録し、Python 3 を `python3`、`python`、`py -3` の順に 1 回だけ探して結果を保持する。`e.cwd` を証跡の置き場の基準にする |
| `tool.call` of `mcp__doc-desk__open_form` | 質問票を検証し (不正なら `{ status: "invalid", errors }`)、`doc-desk/<label>.json` と `.html` を書き、同じ label の前回の `.answer.json` と `.port.json` を `receiver.py clean` で消し、受信サーバを `receiver.py start` で切り離して起動して port-file を最大 3 秒待ち、ブラウザを開き (`openBrowser: false` なら開かない)、ペインを開き、`clock.every(500)` で回答ファイルの監視を始める。続けて `waitSeconds` (既定 300、0 で待たない、上限 1800) まで `GET /wait?timeout=4` のロングポーリングで回答を待ち、届けば `{ status: "answered", reply, files }` と context 1 件を返す (user turn は投入しない)。上限到達・中断 (`next.signal`)・受信サーバ喪失・`waitSeconds: 0` なら `{ status: "pending", url, files, wait: { seconds, endedBy } }` と context 1 件を返し、以後は監視が届ける。待っている間に [取り消す] が押されれば `{ status: "cancelled", reason }`。受信サーバが起動できなければ `{ status: "failed", reason, files }` |
| `tool.call` of `mcp__doc-desk__open_review` | `review` を検証し、`doc-desk/<label>.doc.html` を読んで検査する (無い、読めない、許可リストに無い要素や属性、10 万文字超、段落なし、のどれかなら `{ status: "invalid", errors }`)。`doc-desk/<label>.json` に `review` を、`.html` に指摘の画面を書き、あとは `open_form` と同じ (受信サーバ、同期待ち、監視、ペイン)。結果の `files` は `{ doc, review, html }` (`answered` では `answer` と `md` を足す) |
| `command.run` of `doc-desk` | 待機中ならペインを focus 付きで開き直し、ブラウザも開き直す。待機中でなければ「待機中の質問票も指摘の画面もありません」 |
| `ui.render` of `Pane` (requestId `doc-desk`) | 見出し (`インタビュー: <label>  (rev n)`、指摘の画面では `指摘: <label>  (rev n)`)、URL (127.0.0.1 の文字)、`Link` (href は `http://localhost:<port>/?t=…`。`Link` の href は `https:` か `http://localhost` しか通らない)、経過秒数、[ブラウザで開く (o)] と [取り消す] を描く |
| `ui.close` of `doc-desk` | 人が閉じても監視は続け、状態行に「/doc-desk で開き直せます」を出す |

監視タイマーは同期待ちの間 (`Pending.isSyncWaiting`) は回答を届けず、経過秒数の更新だけ行います。同期待ちを抜けたときにフラグを下ろすので、同じ回答が Tool result と user turn の両方で届くことはありません。

回答 JSON は user turn の隠し context には添えません。Claude Code 2.1.278 では plugin 自身の `prompt.submit` フックがその plugin の `$.prompt.submit` を見ないため (実測、plan.md 4 章 V7)、回答 JSON は `doc-desk/<label>.answer.json` を読んで照合します。

## What it calls on `$`

validate の印字:

```
❯ ./register.ts calls: $.clock.after, $.clock.every, $.clock.now, $.command.register, $.fs.exists, $.fs.read, $.fs.write, $.http.fetch, $.process.run, $.prompt.submit, $.tool.register, $.ui.close, $.ui.invalidate, $.ui.log, $.ui.open, $.ui.resolve, $.ui.status
```

`clock.after` (port-file の待ち), `clock.every` (回答の監視), `clock.now`,
`command.register`, `fs.exists`, `fs.read`, `fs.write`,
`http.fetch` (同期待ちの `GET /wait?t=…&timeout=4`。127.0.0.1 の受信サーバへ),
`process.run` (`<python> --version`、`<python> receiver.py` の `clean` / `start` / `open` / `stop`。シェルは使わない),
`prompt.submit`, `tool.register`, `ui.close`, `ui.invalidate`, `ui.log`, `ui.open`, `ui.resolve`, `ui.status`。
`$.plugin.root` も読みます (呼び出しではないので印字されません)。`model`, `store` は使いません。

`$.process.run` は型定義で「CLI only」とされています。ここでの CLI は、ローカルで動く Claude Code のプロセスを指すと
読んでいます。Claude Code Desktop もローカルの Claude Code を動かすので、受信サーバの起動、ブラウザを開く、停止、削除は
Desktop でも動きました (2026-09-23 確認、`answered` まで通過。フォームは既定のブラウザで開く)。
Mod はシェルを使わず、`receiver.py` のサブコマンドだけを呼ぶので、Windows でも同じ argv で動きます
(`sh`、`nohup`、`rm`、`kill`、`xdg-open` は Windows のプロセスからは見つかりません)。
Desktop では `~/.claude/settings.json` の `env` に `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` と
`CLAUDE_CODE_PLUGIN_DIRS=<このフォルダの絶対パス>` を書いて読み込ませます。
Desktop ではペイン (`$.ui.open`) が描かれませんでした。`/doc-desk` で人が求めて開いても出ません (2026-09-23 確認。
原因は未確定)。ブラウザは自動で開き、URL は Tool result にも載るので、Desktop ではペインに頼らずに使えます。
待機中に止めると、モデルには「ツールの実行が拒否された」と見え、`pending` は届きません。受信サーバと監視は
残るので、後から送った回答は user turn として届きます。

同期待ちとフック予算: フックの予算は 1 ディスパッチ 10 秒ですが、`$` 呼び出しの待ち中は時計が止まります
(`$.clock` の待ちは例外で、予算に数えられます)。そのため同期待ちは `$.clock.sleep` のポーリングではなく、
`$.http.fetch` で受信サーバの `/wait` を 4 秒ずつ保留させて待ちます。4 秒なのは、Esc で `next.signal` が
abort したあとフックが動けるのが 5 秒 (`lingerMs`) だからです。経過秒数は時計を読まず、要求した
`timeout` の合計で数えます。

## ファイルの置き場

セッションの cwd の下の `doc-desk/` に、質問票と指摘の画面の `label` ごとに書きます。

| ファイル | 中身 |
| --- | --- |
| `doc-desk/<label>.json` | 質問票 (検証済み)。指摘の画面では `review` (検証済み) |
| `doc-desk/<label>.doc.html` | 指摘の画面に出す文書の HTML (Claude が書き、Mod は読むだけで消さない) |
| `doc-desk/<label>.html` | HTML シート (トークンは埋めない。ブラウザの JS が URL の `?t=` から読む) |
| `doc-desk/<label>.port.json` | 受信サーバが書く `{"port": n, "pid": n}` |
| `doc-desk/<label>.answer.json` | ブラウザが POST した回答 JSON (`open_form` は同じ label の前回のものを起動前に消す) |
| `doc-desk/<label>.md` | 回答固定形 (Claude に送ったものと同じ) |

## スキル

`skills/doc-desk/SKILL.md` が Claude 側の手順です。設計書・仕様書・企画書・記事を書く (更新する) 依頼で発動し、現物把握 → 構成案を書き、論点を 3±1 問に圧縮して構成案に印で置く → 質問文と構成案の自己検査 → 文脈ゼロの subagent への試問 → `open_form` → 回答の反映と文書の検査 → (宣言があれば) 文書を HTML にして `open_review` → 指摘の反映、の順に進めます。Mod は描画と回収だけを担います。

| ファイル | 中身 |
| --- | --- |
| `skills/doc-desk/SKILL.md` | 手順、禁則、`open_form` の結果 (`answered` / `pending` / `cancelled` / `invalid` / `failed`) ごとの動き、Mod が無いときの案内、証跡と完了報告 |
| `references/form-spec-v1.md` | 質問票 JSON の書き方 (`hooks/form/validate.ts` の全規則とエラー文、構成案の HTML の規則、完全な例) |
| `references/reply-format-v1.md` | 回答固定形 v1 の契約と読み方 (`hooks/reply/format.ts` のゴールデンと一致) |
| `references/question-lint.md` | ja-text-communication の規範番号順の自己検査表 |
| `references/document-lint.md` | 回答を反映して書く文書の検査表。ja-text-communication の規範と、stop-ai-slop-jp と humanizer-ja から選んだ AI 臭の検査 (S1〜S24)、採用しなかった規則と理由 |
| `references/preflight.md` | 試問の 5 問、質問票の Markdown の形、subagent のプロンプト雛形、打ち切り規則 |
| `references/review-mode.md` | 指摘モード。宣言の判定、文書の HTML の書き方、`open_review` の入力と結果、長い文書の分け方、指摘の回答 (`hooks/review/format.ts` と一致)、反映と完了報告 |

## Try it

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir plugins/doc-desk
```

対話モードで次のように頼みます。

> plugins/doc-desk/tests/fixtures/spec-auth-01.form.json を読んで、その JSON を form にして open_form ツールを呼んでください。回答が届くまで待ってください。

ブラウザが開くので、選択肢を選んで [送信] を押します。5 分 (`waitSeconds` の既定) 以内なら
ツールの結果 (`status: "answered"`) として Claude に届き、そのまま文書の作成に進みます。
5 分を過ぎるか Esc で中断すると `status: "pending"` でターンが終わり、あとで [送信] を押したときに
`【doc-desk 回答】spec-auth-01` で始まる user turn が届きます。
ブラウザを閉じてしまったら `/doc-desk` で開き直せます。

指摘の画面は、次のように頼んで試せます。

> 次の HTML を doc-desk/spec-auth-01-review.doc.html に書き出して、review に schemaVersion 1、documentId spec-auth-01、revision 1、label spec-auth-01-review、title 「認証方式の仕様」を渡して open_review ツールを呼んでください: `<h2>認証方式</h2><p>認証は OIDC に統一します。</p>`

## テストと検証

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugins/doc-desk
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/doc-desk
npx -y -p typescript tsc -p plugins/doc-desk --noEmit
```

`tsc` はリポジトリ直下の `.claude/types/` (`claude -p "/plugin-types"` が生成、git には入れない) を読みます。

Windows では、エンジンが `$.fs` に渡したパスを `C:\work\doc-desk\x.json` の形に直してフックへ渡します。
テストの偽装 (`tests/fixtures/world.ts`) は、パスを `/work/doc-desk/x.json` の形にそろえてから照合します。
`process.run` の argv は直されないので、そのまま照合します。

受信サーバ単体:

```sh
python3 plugins/doc-desk/scripts/receiver.py serve --port-file /tmp/x.port.json --token t \
  --html doc-desk/spec-auth-01.html --out /tmp/x.answer.json          # 前面で動かす (start なら切り離してすぐ戻る)
curl "http://127.0.0.1:<port>/?t=t"                       # HTML (トークン無しは 403)
curl "http://127.0.0.1:<port>/wait?t=t&timeout=4"          # 回答の POST か 4 秒まで保留 → {"answered":true|false}
curl -X POST -d '{"answers":{}}' "http://127.0.0.1:<port>/answer?t=t"   # 書いて、保留中の /wait に応答してから終了
python3 plugins/doc-desk/scripts/receiver.py stop <pid>        # 止める (もう無ければ何もしない)
python3 plugins/doc-desk/scripts/receiver.py clean /tmp/x.answer.json /tmp/x.port.json   # 消す
```

Windows で `python3` が Microsoft Store の案内に当たるときは、`python` か `py -3` に読み替えます (Mod もこの順に探します)。

`<port>` は `/tmp/x.port.json` の `port` です。

## 実機で確かめていないこと (2026-09-23 時点)

- Esc で中断したあと、保留中の `/wait` が戻ってから `pending` を返すまでが `lingerMs` (5 秒) に収まるか。
- ペインの `Link` (`http://localhost:<port>`) を押したとき、ブラウザが 127.0.0.1 の受信サーバに届くか (`::1` に解決されたときの切り替え。curl では届く)。
- `waitSeconds` の既定 300 秒の間、ツール呼び出しが進行中のままで、表示や他のフックに問題が出ないか。
