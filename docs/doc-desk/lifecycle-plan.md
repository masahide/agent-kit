# doc-desk ライフサイクル拡張の実装計画

作成日: 2026-09-24 / 状態: 段階 4 まで実装済み。各段階の記録は [plan.md](plan.md) 5 章にあります。背景と決定の記録は [plan.md](plan.md)、使い方は [usage.md](usage.md)、実装の説明は [plugins/doc-desk/README.md](../../plugins/doc-desk/README.md) にあります。

## 要点

- doc-desk Mod は今、Claude Mods のイベントのうち `session.start`、`tool.call`、`command.run`、`ui.render`、`ui.close` の 5 つしか使っていません。残りのイベントと、Mod がすでに持つ状態 (待機中の画面 `pending`、証跡ファイル、回答固定形) を組み合わせて、人から見た操作感を良くします。
- 順番は 6 段階です。先に受信サーバの起動を単純にし (段階 0)、次に「いつ答えても届く」「答えた直後の画面が読める」を作り (段階 1、2)、「決めたことが守られる」を作り (段階 3、4)、最後に指摘の画面を楽にします (段階 5)。
- 各段階は独立した PR にし、`claude plugin validate`、`claude plugin test`、`tsc` が通ることと、README の「What it hooks / What it calls on `$`」を validate の印字に合わせることを完了の条件にします。
- 型定義 [.claude/types/claude-code.d.ts](../../.claude/types/claude-code.d.ts) (Claude Code 2.1.278) で存在を確認したイベントと `$` の関数だけを使います。実機で確かめていない前提は 8 章にまとめ、着手時に先に確かめます。

## 1. 順番と理由

操作感を軸にしたので、人が触れる場面で効く段階を先にし、見えない改善 (信頼の土台) を後にしました。段階 0 だけは例外で、段階 1 が受信サーバの起動部分を作り直すため、その前に構造を単純にしておきます。

| 段階 | 元の案 | 使うイベントと `$` | 人から見て変わること |
|---|---|---|---|
| 0 | 案 9 | `$.process.run` (既存) | 変わらない。port-file とその polling が消え、以後の段階の土台が単純になる |
| 1 | 案 3 | `session.start`、`$.store`、`$.prompt.suggest` | セッションを閉じても質問票が死なない。いつ答えても次の起動で届く |
| 2 | 案 7 | `ui.render` (UserMessage)、`turn.complete`、`$.ui.toast` | 届いた回答が 1 行に畳まれる。回答先の URL が答えの下に出る。届いたら通知が出る |
| 3 | 案 2 | `session.compact` | 会話が圧縮されても、人が決めたことが原文のまま残る |
| 4 | 案 1 | `tool.check` | 回答が届く前に Claude が対象の文書を書けなくなる |
| 5 | 案 5 | `$.model.fork` (`open_review` の中) | 指摘の画面に Claude の指摘候補が先に出て、人は採用か却下を押すだけになる |

ブランチ名は `feat/lifecycle-0-receiver-stdout` のように `feat/lifecycle-<段階>-<内容>` にします。

## 2. 段階 0: 受信サーバの起動を単純にする (案 9)

### 目的

今の起動は 3 手です。`receiver.py start` で子を切り離して起動し、子が `doc-desk/<label>.port.json` を書くのを Mod が 250 ms 間隔で最大 3 秒 polling し、読めた port と pid で URL を組みます。これを「`start` が port と pid を stdout に 1 行印字して終わる」形にし、port-file と polling を無くします。

### 採らなかった形とその理由

案 9 は当初「受信サーバを `$.process.spawn` で起動し、stdout を stream で読む」案でした。型定義の説明で、spawn した子は「ループを抜ける、`next.signal` が abort する、モジュールが unload される」と殺されると分かりました。受信サーバが Claude の終了やホットリロードと運命を共にすると、段階 1 の「Claude を閉じている間に答える」が成り立ちません。また同期待ち (`tool.call` の中で回答を待つ) は、フック予算に数えられない待ち方が `$` 呼び出しの保留しか無いため、spawn にしても `GET /wait` のロングポーリングは残ります。spawn で消せるのは port-file と 500 ms の回答ファイル監視だけで、失うものの方が大きいので、切り離し起動は残し、port の受け渡しだけを stdout に変えます。

### 変更

| ファイル | 変更 |
|---|---|
| `scripts/receiver.py` | `serve` は listen した直後に `{"port": n, "pid": n}` を stdout に 1 行書いて stdout を閉じる (以後は何も書かない)。`start` は子の stdout を pipe で受け、その 1 行を読んで自分の stdout に印字して終わる。`--port-file` 引数を消す。`serve --port <n>` を足し、指定の port が空いていればそれを使い、塞がっていれば OS に選ばせる (段階 1 で使う) |
| `hooks/receiver/index.ts` | `parsePortFile` を `parseStartOutput` (stdout の 1 行を読む) に置き換える。`receiverArgv` から `portFile` を消し、`preferredPort?` を足す。`cleanupArgv` は回答ファイルだけ消す |
| `hooks/register.ts` | `readPortFile`、`wait`、`PORT_FILE_POLL_MS`、`PORT_FILE_POLL_COUNT` を消す。`serveSheet` は `engine.run(startArgv)` の `stdout` を読むだけにする。`Paths.portFile` を消す |
| `hooks/host/index.ts` | `after` を消す (port-file の待ちにしか使っていない) |
| `tests/fixtures/world.ts` | `isReceiverUp` の模し方を「`start` が stdout に 1 行返す / 空を返す」に変える |
| `tests/register.test.ts` | 「port-file を 3 秒以内に書かなければ failed」を「`start` が port を返さなければ failed」に書き直す |
| `README.md`、`usage.md` 6 章 | `doc-desk/<label>.port.json` の行を消す。「流れ」の図から polling の段を消す |

### 設計の要点

- `start` が子の stdout を読む間、子は切り離されたままです。子は 1 行書いたら `sys.stdout.close()` するので、親が先に終わっても子は SIGPIPE を受けません。Windows では `DETACHED_PROCESS` に `stdout=PIPE` を渡せることを 8 章で確かめます。
- `start` の読み取りには 3 秒の上限を付け、超えたら子を止めて空のまま終わります。Mod はこれを `failed` (受信サーバが起動できない) にします。今の `STRINGS.noPortFile` の文言は「受信サーバが port を返しませんでした」に変えます。
- 500 ms の回答ファイル監視 (`clock.every`) は残します。回答ファイルは段階 1 の「Claude が閉じている間の回答」を運ぶ唯一の経路なので、消せません。

### 受け入れ条件

- `claude plugin validate` の calls から `$.clock.after` が消え、他は変わらない。
- 既存のテストが port-file 無しで通り、`doc-desk/` に `.port.json` が作られない。
- `receiver.py start ...` を手で叩くと `{"port": n, "pid": n}` が 1 行返り、`curl` で `GET /?t=` が 200 を返す。

## 3. 段階 1: 未回答の引き継ぎ (案 3)

### 目的

今は待機中の状態 `pending` がメモリにしか無く、セッションを閉じると質問票は死にます (受信サーバは切り離されているので最長 1 時間は生きますが、届いた回答を読む相手がいません)。待機の記録を `$.store` に残し、次の `session.start` で「届いていれば渡す、届いていなければ待ちを再開する」ようにします。

### 動き

```
待機を始めるとき        $.store.set("pending:<cwd>", 記録) を書く
回答が届いた / 取り消し  $.store.delete("pending:<cwd>")
session.start           記録があれば:
                          .answer.json がある     → 固定形を作り .md に書き、届ける (下の「届け方」)
                          受信サーバが生きている   → pending を組み直し、監視を再開 (ブラウザは開かない)
                          受信サーバが死んでいる   → 同じ port と token で受信サーバを起動し直し、監視を再開
                          .json が無い            → 記録を消す (証跡が消されている)
```

当初の案は `session.end` で記録を書く形でしたが、待機を始めた時点で書く方が単純で、Claude が落ちた場合も拾えるので、`session.end` は使いません。

記録の中身は `{ kind: "form" | "review", label, documentId, revision, token, port, pid, startedAtMs }` です。画面の情報 (`Sheet`) は `doc-desk/<label>.json` から組み直せるので記録には入れません。キーに `cwd` を含めるのは、`$.store` が plugin ごとに 1 つで、プロジェクトをまたいで共有されるからです。

### 届け方

回答が届いていたときの届け方は、人が何をしに Claude を開いたか分からないので、勝手に turn を始めません。

- 人がいる surface (`e.surface` が null でない) では、`$.ui.log` で「質問票 <label> の回答が届いています」と 1 行出し、`$.ui.toast` で知らせ、`$.prompt.suggest` で `/doc-desk` を薄い候補に出します。人が Tab と Enter を押すと `/doc-desk` が回答固定形を `$.prompt.submit` します。
- `e.surface` が null (`-p` や SDK) では、`$.prompt.submit` でそのまま届けます。

`/doc-desk` の役目はこれで 2 つになります。待機中なら開き直し、届いた回答が未送なら送る。どちらでもなければ今までどおり「待機中の質問票も指摘の画面もありません」と返します。

### 受信サーバの生死と起動し直し

- 生死は `GET /wait?t=<token>&timeout=0` で見ます。200 で `{"answered": false}` なら生きています。`{"answered": true}` なら回答ファイルがあるはずなので、ファイルの有無を優先します。失敗なら死んでいます。
- 起動し直すときは、記録の port と token をそのまま使います (`serve --port <n>`、段階 0)。人がブラウザのタブを開いたままなら、URL も `localStorage` の下書き (origin は port を含む) もそのまま生きます。port が塞がっていれば OS に選ばせ、URL が変わったことを `$.ui.log` で伝えます。
- 起動し直してもブラウザは開きません。`$.ui.status` に「前回の質問票 <label> が未回答です。/doc-desk で開き直せます」を出します。
- 記録が 7 日より古ければ、起動し直さずに記録を消し、`$.ui.log` で伝えます。

### 変更

| ファイル | 変更 |
|---|---|
| `hooks/register.ts` | `Sheet` を作る部分を `sheetOfForm(form, paths)` と `sheetOfReview(review, html, paths)` に切り出す (今は 2 つの `tool.call` の中に埋まっている)。`serveSheet` を「受信サーバを起動する」と「待機を組む (`Pending`、監視、ペイン)」に分け、後者を `session.start` からも呼ぶ。`settle` と `dropPending` で記録を消す。`session.start` に上の分岐を足す。`/doc-desk` に「未送の回答を送る」を足す |
| `hooks/host/index.ts` | `storeGet`、`storeSet`、`storeDelete`、`toast`、`suggest` を足す |
| `hooks/store/pending-record.ts` (新規) | 記録の型、読み取り (形が違えば null)、古さの判定 |
| `hooks/views/strings.ts` | 上の文言 |
| `tests/register.test.ts` | 下のテスト |
| `usage.md` 4.3〜4.5 章、5 章 | 「閉じても届く」「次の起動で /doc-desk」を書く |
| `SKILL.md` 手順 5 | `pending` のときの案内に「セッションを閉じても、次の起動で届きます」を足す |

### テスト

- 待機を始めると記録が書かれ、`answered` と取り消しで消える。
- 記録と `.answer.json` がある状態で `session.start` すると、`.md` が書かれ、surface が null なら `prompt.submit` が 1 回呼ばれ、terminal なら呼ばれずに log と suggest が出る。その後 `/doc-desk` で `prompt.submit` が 1 回呼ばれる。
- 記録があり受信サーバが生きている (`/wait` が 200) 状態で `session.start` すると、`start` は呼ばれず、監視が再開され、`/doc-desk` でペインとブラウザが開く。
- 受信サーバが死んでいる (`/wait` が失敗) と、同じ port と token で `start` が呼ばれる。
- `doc-desk/<label>.json` が無いと記録が消え、何も起動しない。

## 4. 段階 2: 回答行を畳む、回答先を添える、届いたら知らせる (案 7)

### 目的

非同期経路の回答は、長い回答固定形がそのまま user turn として transcript に出ます。答えた直後の画面がいちばん読みにくいので、1 行に畳みます。あわせて、フォームを開いた turn の答えの下に回答先の URL を 1 行添え、回答が届いたら通知を出します。Desktop ではペインが描かれない (README) ので、この 1 行と通知が Desktop での主な手がかりになります。

### 動き

- `ui.render` の `UserMessage` で、`e.props.origin.kind` が `plugin` かつ `e.props.text` が `【doc-desk 回答】` で始まる行だけを描き換えます。他の plugin の投入は `next(e)` で素通しします。`e.props.isExpanded` (ctrl+o) のときも `next(e)` にして全文を出します。
- 畳んだ行の中身は、質問票なら `【doc-desk 回答】<label>  Q1=B  Q2=お任せ  Q3=A  補足 1 件`、指摘の画面なら `【doc-desk 回答】<label>  指摘 3 件  書き換え 2 件` と、固定形を保存した `.md` のパスです。
- `turn.complete` で、`pending` があり、`e.agentId` が無く (main の turn)、`e.reason` が `answer` で、まだその待機で出していなければ、`{ text: "回答先: <url>  (/doc-desk で開き直せます)" }` を返します。1 つの待機につき 1 回だけにします。
- 回答が届いたとき (`settle`) に `$.ui.toast("回答を受け取りました: <label>")` を出します。

### 変更

| ファイル | 変更 |
|---|---|
| `hooks/reply/summary.ts` (新規) | 回答固定形の文字列から畳んだ 1 行を作る。固定形は Mod 自身の形式なので、`reply-format-v1.md` の規則で読む。読めなければ null (描き換えない) |
| `hooks/views/reply-row.ts` (新規) | 畳んだ行の木 (Box と Text。terminal と desktop で同じ) |
| `hooks/register.ts` | `ui.render` の `UserMessage` フック、`turn.complete` フック、`Pending.isUrlShown`、`settle` の toast |
| `hooks/host/index.ts` | `toast` (段階 1 で足していればそのまま) |
| `tests/register.test.ts`、`tests/summary.test.ts` (新規) | 下のテスト |
| `README.md` | hooks の表に 2 行足す |

### 設計の要点

- 描き換えは行の見え方だけで、モデルが読む文は変わりません (型定義の `UserMessage` の説明どおり)。
- 同期経路 (`answered` を Tool result で返す) には user turn が無いので、この段階では畳みません。Tool result の JSON も長いので、余力があれば `ToolResult` の描き換えを足しますが、この計画の範囲には入れません。
- `turn.complete` の `{ text }` が「答えの下に出る」のか「答えを置き換える」のかは型定義の文だけでは読み切れないので、8 章で先に確かめます。

### テスト

- `UserMessage` を origin `plugin`、text を固定形のゴールデンで mount すると、畳んだ行に `Q1=B` と `.md` のパスがある。`isExpanded: true` なら `next` が呼ばれる。text が固定形でなければ `next` が呼ばれる。`['terminal', 'desktop']` の両方で回す。
- `turn.complete` は、待機中の最初の 1 回だけ URL の行を返し、2 回目と `agentId` 付きでは `next` の結果をそのまま返す。
- 回答が届くと toast が 1 回出る。

## 5. 段階 3: 圧縮で決定を残す (案 2)

### 目的

会話が圧縮 (`/compact`、しきい値、plugin) されると、人が答えた決定が要約で薄まります。Mod は回答固定形を `doc-desk/<label>.md` に持っているので、圧縮の結果に原文を差し戻します。

### 動き

`session.compact` で、`e.agentId` が無い (main の会話) ときだけ次をします。

1. このセッションで届いた回答 (`settle` した label と、段階 1 で起動時に届けた label) の `.md` を読みます。
2. `next({ ...e, instructions })` で、要約に「doc-desk の決定は省略せず、決めた項目と選んだ案を残す」を足します。
3. 戻ってきた `messages` の末尾に、`{ role: "user", text: "【doc-desk 決定の記録】\n\n" + 各 .md の全文 }` を足して返します (`handle` を持たないので「組み立てた文」として読まれます)。
4. 待機中の画面があれば、同じ文に「質問票 <label> は回答待ち。届くまで対象の文書を書かない」を足します。
5. 全文が合計 20,000 文字を超えるときは、各 `.md` の `## 決定` の節だけにします。それでも超えれば新しいものから順に入れ、入らなかった label はパスだけ書きます。

`trigger` が `precompute` のときも同じにします (先に計算した要約がそのまま使われるため)。届いた回答が無ければ `next(e)` を返し、何も変えません。

### 変更

| ファイル | 変更 |
|---|---|
| `hooks/compact/record.ts` (新規) | 届いた回答の一覧から差し戻す文を作る (文字数の上限と切り詰め) |
| `hooks/register.ts` | `settled: string[]` (このセッションで届いた label)、`session.compact` フック |
| `hooks/host/index.ts` | 変更なし (`readFile` を使う) |
| `tests/compact.test.ts` (新規) | 下のテスト |
| `SKILL.md` 手順 6 | 「圧縮後も `【doc-desk 決定の記録】` が会話に残る。決定を読み直すときはそれと `doc-desk/<label>.md` を見る」を足す |

### テスト

- 届いた回答が 1 つある状態で `session.compact` を起こすと、結果の `messages` の末尾に固定形の全文があり、`instructions` に指示が足されている。
- `agentId` 付きでは何も足さない。届いた回答が無ければ `messages` が変わらない。
- 合計が上限を超えると `## 決定` の節だけになる。

## 6. 段階 4: 回答前の実装を止める (案 1)

### 目的

「回答が届く前に文書を書かない」は SKILL.md の禁則で、Claude の自制頼みです。`tool.check` で、待機中は対象の文書への書き込みを `deny` にして、規律をコードにします。

### 動き

- 質問票 v1 に任意の欄 `source` (これから書く、または更新する文書のパス) を足します。指摘の画面の `review.source` はすでにあります。
- `tool.check` を `Write`、`Edit`、`NotebookEdit` に掛けます。待機中で、`e.tool_use_id` があり (実際の呼び出し)、入力の `file_path` (または `notebook_path`) が次のどれかに一致すれば `{ decision: "deny", reason }` を返します。
  - 質問票の `source`
  - 指摘の画面の `review.source`
  - 指摘の画面の `doc-desk/<label>.doc.html` (指摘の証跡)
- `reason` は「doc-desk: <label> の回答待ちです。回答が届くまで <path> は書きません。/doc-desk で開き直せます」です。モデルはこの文を読んで止まります。
- それ以外の書き込みは `next(e)` で素通しします。人は回答を待つ間に別の作業を Claude に頼めます。
- `source` が無い質問票では止めません (今までどおり禁則だけ)。SKILL.md は `source` を常に書く手順に変えます。

`ask` ではなく `deny` にするのは、人に確認を求めると待たせることになり、止める理由はモデルに伝えれば足りるからです。

### パスの照合

- 両方をセッションの cwd 基準の絶対パスにし、`\` を `/` に、`..` を解決してから比べます。Windows では大文字小文字を無視します。
- ファイルがあれば `$.fs.stat(path, { resolve: true })` の `realPath` で比べます (シンボリックリンク越しの書き込みを拾う)。無ければ文字列で比べます。
- `Bash` の heredoc やリダイレクトは拾いません。README に限界として書きます。

### 変更

| ファイル | 変更 |
|---|---|
| `hooks/form/form-v1.ts`、`validate.ts`、`schema.ts` | `source?: string` (1〜1024 文字) |
| `hooks/guard/paths.ts` (新規) | パスの正規化と照合 |
| `hooks/register.ts` | `Pending.guardedPaths: string[]`、`tool.check` フック 3 つ |
| `hooks/host/index.ts` | `stat` を足す |
| `references/form-spec-v1.md` | `source` の欄 |
| `SKILL.md` 手順 2 と最重要禁則 | `source` を書く。「Mod も止める」ことを書く |
| `tests/guard.test.ts` (新規)、`tests/register.test.ts` | 下のテスト |
| `README.md` | hooks の表、限界 (Bash は拾わない) |

### テスト

- `source` 付きの質問票で待機中に、`Write` で `source` を書こうとすると `deny` と理由が返る。別のパスなら `next`。`answered` の後なら `next`。
- 指摘の画面で待機中に `Edit` で `review.source` と `.doc.html` を書こうとすると `deny`。
- `source` の無い質問票では常に `next`。
- パスの照合: 相対と絶対、`\` と `/`、`..`、Windows の大文字小文字。

## 7. 段階 5: 自己指摘の候補を先に出す (案 5)

### 目的

指摘の画面で、人がゼロから指摘を書く手間を減らします。`open_review` の中で、Mod が `$.model.fork` に「この文書で document-lint に反する段落は」と 1 問だけ投げ、返った候補を画面にチップの候補として出します。人は採用か却下を押すだけです。

`turn.complete` でなく `open_review` の中で行うのは、turn をまたぐ状態を持たずに済み、fork の transcript に Claude が書いたばかりの文書 (Write の呼び出し) が含まれているからです。fork は main の transcript をそのまま使うので、API の prompt cache が効き、費用は候補の出力分が主です。

### 動き

1. `open_review` の入力に `selfReview?: boolean` (既定 true) を足します。plugin.json の `userConfig` に `selfReview` (boolean、既定 true) を足し、config の画面から切れるようにします。
2. 文書の検査が通った後、Mod は段落番号付きの一覧 (番号と文) を作り、`$.model.fork({ prompt })` に渡します。prompt は、`references/document-lint.md` の検査 (S1〜S24) の要約と、チップ 9 種の名前、出力の形 (JSON の配列、最大 5 件、各 `{ block, chip, quote, text }`) です。
3. 返った文から JSON を取り出し、`block` が範囲内、`chip` が 9 種のどれか、`text` が 200 文字以内のものだけ残します。`isAnswered` が false (API エラー、空、中断) なら候補なしで進みます。
4. 候補を `doc-desk/<label>.candidates.json` に証跡として書き、指摘の画面の HTML に埋めます。
5. 画面では、候補のある段落に「Claude の候補」の帯を出し、各候補に [採用] [却下] を置きます。採用した候補は普通の指摘と同じ形 (`ReviewComment`) に `source: "claude"` を付けて回答に入ります。却下は送りません。
6. 回答固定形では `#2 [根拠が要る] 「OIDC に統一」 なぜ OIDC かを足して (Claude の候補)` のように末尾に印を付けます。

### 段落番号の一致

画面はブラウザの DOM で段落に番号を振ります。Mod 側で同じ番号を出すには、`hooks/review/document.ts` の「段落番号を振る要素」の規則を TypeScript で同じ順に辿る関数 `numberedBlocks(html)` が要ります。ずれたときの保険として、画面の JS は候補の `quote` をまず `block` の段落で探し、無ければ全段落で探し、それでも無ければ全体へのコメントの候補にします。

### 変更

| ファイル | 変更 |
|---|---|
| `.claude-plugin/plugin.json` | `userConfig.selfReview` |
| `hooks/register.ts` | `register(on, options)` で `options.selfReview` を読む。`open_review` に fork の呼び出しを足す |
| `hooks/host/index.ts` | `fork` を足す |
| `hooks/review/document.ts` | `numberedBlocks(html)` |
| `hooks/review/candidates.ts` (新規) | prompt の組み立て、返答の JSON の取り出しと検証 |
| `hooks/review/review-v1.ts`、`answer.ts`、`format.ts` | `ReviewComment.source?: "claude"`、固定形の印 |
| `hooks/sheet/render-review.ts` | 候補の帯と [採用] [却下] |
| `hooks/form/schema.ts` | `selfReview` |
| `references/review-mode.md`、`reply-format-v1.md` | 候補の説明と固定形の印 |
| `tests/review.test.ts`、`tests/candidates.test.ts` (新規) | 下のテスト |
| `README.md`、`usage.md` 4.5 章 | calls に `$.model.fork`、画面の説明 |

### テスト

- fork が候補 3 件の JSON を返すと、HTML に 3 件が埋まり、`.candidates.json` が書かれる。
- fork が `isAnswered: false` を返しても `pending` または `answered` は今までどおり返る。
- 範囲外の `block`、知らないチップ、長すぎる `text` は落とされる。
- `selfReview: false` と `options.selfReview: false` では fork が呼ばれない。
- 採用した候補を含む回答 JSON が、固定形で `(Claude の候補)` 付きになる。
- `numberedBlocks` が、`render-review.ts` の JS と同じ番号を返す (同じ HTML の fixture で照合する)。

## 8. 着手時に先に確かめること

型定義で存在を確かめただけで、実機で動かしていないものです。各段階の最初の作業にします。

| 段階 | 確かめること | 確かめ方 |
|---|---|---|
| 0 | Windows で `DETACHED_PROCESS` の子に `stdout=PIPE` を渡して 1 行読めるか | `receiver.py start` を手で叩く |
| 1 | `$.prompt.suggest` が terminal と Desktop で薄い候補として出るか。`session.start` の中で `$.ui.toast` と `$.ui.log` が出るか | 最小の plugin で試す |
| 1 | `serve --port <n>` で同じ port を取り直せるか (TIME_WAIT のとき) | `SO_REUSEADDR` を付けて手で叩く |
| 2 | `UserMessage` の描き換えが plugin origin の行で呼ばれるか。呼ばれないとき、engine は plugin の投入をどう描くか | 最小の plugin で試す |
| 2 | `turn.complete` の `{ text }` が答えの下に出るのか、置き換えるのか | 同上 |
| 2 | matcher で `{ props: { origin: { kind: "plugin" } } }` の入れ子が効くか | validate と実機 |
| 3 | `session.compact` の結果に組み立てた message を足すと、次の turn がそれを読むか | `/compact` の後に尋ねる |
| 4 | `tool.check` の `deny` の `reason` がモデルにそのまま届くか | 実機 |
| 5 | テストキットの `mock` で `$.model.fork` を差し替えられるか。`ModelForkRequest` に `timeoutMs` があるか | `claude-code/testing` の型と `claude-code.d.ts` |
| 5 | `open_review` の `tool.call` の中で fork を待つ間、フック予算 (10 秒) に数えられないか | 実機 |

## 9. この計画で置いた仮定

人に確かめていない判断です。違っていれば、その段階の着手前に変えます。

- 段階 0: 受信サーバは切り離し起動のまま残す (`$.process.spawn` にしない)。理由は 2 章。
- 段階 1: 起動時に回答が届いていても、人がいる surface では勝手に turn を始めず `/doc-desk` を候補に出す。`-p` と SDK では直接届ける。
- 段階 1: 起動し直してもブラウザは開かない。7 日より古い記録は捨てる。
- 段階 3: 差し戻しは全文を基本にし、合計 20,000 文字を上限にする。
- 段階 4: `ask` でなく `deny`。`source` の無い質問票では止めない。`Bash` は拾わない。
- 段階 5: 候補は `open_review` の中で作る (既定で有効、config で切れる)。候補は最大 5 件。

## 10. 全段階に共通する作業

- 各段階の PR で、`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugins/doc-desk`、`claude plugin test plugins/doc-desk`、`npx -y -p typescript tsc -p plugins/doc-desk --noEmit` を通します。
- validate の印字 (hooks と calls) を README の「What it hooks / What it calls on `$`」に貼り直します。
- `$` は変数に入れず、`session.start` の中で `Host` の閉包にしてから使います (plan.md 4 章の規則)。新しく使う `$.store`、`$.ui.toast`、`$.prompt.suggest`、`$.fs.stat`、`$.model.fork` も同じです。
- 文言は `hooks/views/strings.ts` に集め、ja-text-communication の規範 (`references/question-lint.md`) に合わせます。
- usage.md と SKILL.md の該当節を同じ PR で直します。plan.md には、各段階を終えたときに決定の記録として 1 節ずつ足します。
