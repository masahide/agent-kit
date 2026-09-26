# doc-desk ライブ表示の設計 (案 8: 文書を書きながら見せる)

作成日: 2026-09-25 / 更新: 2026-09-26 (コマンド名を main の #20 に合わせて `/doc-desk-resume` にした。9 章の 4 つの決定を記録し、ライブ指摘を設計に組み込んだ。残った受信サーバの片付けを「受信サーバ自身が終わる」形に変えた: 3 章と 5.5) / 状態: 設計確定、未着手。[lifecycle-plan.md](lifecycle-plan.md) の段階 0〜5 が merge されている前提で書いています。段階 1 (受信サーバの引き継ぎ)、段階 4 (質問票の `source`)、段階 5 (`open_review` の候補) の仕組みを使います。

## 要点

- Claude が文書を書いている間、その文がブラウザに流れて読めるようにします。書き終わって `open_review` が呼ばれたら、同じタブが指摘の画面へ移ります。
- 読みながら気づいたことは「ライブ指摘」としてその場で Claude に届けます。届け方は 2 つで、[書き終わったら直す] は Write が終わった瞬間に Tool result の `context` として差し込み、Claude が同じ turn の中で直します。[今すぐ止めて直す] は `$.turn.abort` で turn を止め、指摘を新しい user turn として投入して書き直させます。まだ届けていない指摘は、指摘の画面に「ライブ表示で付けた指摘」として並べます。
- 文は `turn.step` の `input` チャンク (Write ツールの引数 JSON の断片) から取ります。`file_path` が質問票の `source` と一致する Write だけを対象にし、`content` の文字列を JSON の逃がしを解きながら逐次取り出します。Edit で直したときは、ツールの完了後に全文を読み直して流します。
- 受信サーバに 3 つの口を足します。ブラウザ向けの `GET /events` (SSE) と `POST /comments` (ライブ指摘)、Mod 向けの `POST /document` です。Mod は文を流すたびに `/document` を叩くので、その応答に貯まった指摘と「止めて」の印を載せて Mod に返します。ライブ表示の受信サーバは回答を受けず、完成時に指摘の画面の URL を SSE で流してタブを移し、自分は終了します。既存の「1 画面、1 受信サーバ、1 回答」の状態機械は変えません。
- 開始は新しいツール `open_live` を Claude が呼ぶ形にします (自動では開きません)。宣言の判定は指摘モードと同じく Claude 側に置きます。
- 手間は段階 1 と同じ規模です。最も不確かなのは「テストキットで `turn.step` の stream を模せるか」と「`input` チャンクが十分細かく届くか」で、着手時に先に確かめます。

## 1. 人から見た動き

```
1. 質問票の回答が届く (段階 1〜2 のとおり)
2. Claude が open_live を呼ぶ → ブラウザにライブ表示のタブが開く (左に文書、右に状態)
3. Claude が Write で文書を書く → 文が数十文字ずつ流れ、最下部に追従する
4. 人が読みながら気づく → 文字列を選んで (選ばなくてもよい) 指摘を書き、[書き終わったら直す] か [今すぐ止めて直す] を押す
   - [書き終わったら直す]: 今の Write が終わった瞬間に指摘が Claude に届き、Claude は Edit で直してから先へ進む
   - [今すぐ止めて直す]: Claude の turn がその場で止まり、指摘を読んで書き直す
5. Claude が Edit で直す → 「直しています」と出て、直した全文に置き換わる
6. Claude が文書を HTML にして open_review を呼ぶ → タブが指摘の画面へ移る (段落番号、チップ、Claude の候補、まだ届けていないライブ指摘)
7. 以後は段階 5 までの指摘モードと同じ
```

`open_review` を呼ばずに turn が終わったときは、ライブ表示に「書き終わりました」と出して残します。次の `open_form` / `open_review` / 取り消しで片付けます。人が途中でタブを閉じても Claude の作業は止まりません (`/doc-desk-resume` で開き直せます)。

ライブ指摘は段落番号に結びつけません。書いている途中は番号が動き続けるからです。代わりに、選んだ文字列 (`quote`) とコメントを Claude に渡し、Claude が文書の中から該当箇所を探して直します。指摘の画面の指摘 (番号付き) とは別物で、届け先はモデルです。

ライブ指摘の使いどころは 3 つです。方針のずれ (例: 「セッションは 30 日」と書き始めたが 90 日を選んだはず) は [今すぐ止めて直す]、語句や例の直し (例: 「この例は古い API」) は [書き終わったら直す]、段落に結びつかない感想 (例: 「導入が長い」) はどちらでもよく、届け先は同じです。

## 2. 文をどこから取るか

### 2.1 `turn.step` の `input` チャンク

`turn.step` は 1 回のモデル要求を stream として流すイベントで、フックは `async function*` で書きます。チャンクの種類は `text` (本文)、`thinking`、`tool` (ツール呼び出しの始まり: `index`、`id`、`name`)、`input` (同じ `index` のツール引数 JSON の断片)、`stop`、`engine` です。Write ツールの引数は `{"file_path":"...","content":"..."}` の JSON がこの `input` チャンクとして断片で届きます。

フックは次のように動きます。

- ライブ表示が開いていなければ `yield* next(e)` で素通しします。費用はほぼゼロです。
- 開いていれば `for await` でチャンクを 1 つずつ下流へ `yield` しながら見ます。チャンクを書き換えず、遅らせもしません (下の 2.4)。
- `tool` チャンクで `name === 'Write'` の `index` を覚えます。以後、同じ `index` の `input` チャンクの `json` を連結し、`file_path` と `content` を逐次読みます (2.2)。
- `file_path` が `open_live` で渡された `source` と一致する Write だけを流します。照合は段階 4 の `hooks/guard/paths.ts` の正規化をそのまま使います。一致しない Write (別ファイル、`doc-desk/<label>.doc.html` など) は無視します。
- `stop` チャンクで、その要求の分を締めます。

`e.agentId` が付いた step (subagent) は無視します。文書は main の turn で書く約束です。

### 2.2 部分 JSON から `content` を取り出す

引数 JSON は途中で切れた断片で届き、`content` の中の改行や引用符は `\n` や `\"` に逃がされています。全部届いてから `JSON.parse` するのでは「書きながら」になりません。そこで小さな状態機械 `hooks/live/json-stream.ts` を書きます。

- 入力: JSON 断片の列。出力: `file_path` (確定したとき) と、`content` の追記文字列。
- 状態: `キーを探している` → `"file_path"` の値の中 → `"content"` の値の中 → 終わり。文字列の値の中では `\\`、`\"`、`\n`、`\t`、`\uXXXX` (サロゲートペアは 2 つ揃うまで待つ) を解きます。断片の切れ目が逃がしの途中に来たら、次の断片まで持ち越します。
- `file_path` と `content` の順序は決め打ちしません。`content` が先に来た場合は `file_path` が確定するまで貯め、一致したらまとめて流し、一致しなければ捨てます。
- `content` 以外のキー (将来増えても) は読み飛ばします。ネストした値は使わないので、深さは追いません。

この関数は純粋関数にして、断片の切り方を変えたテスト (1 文字ずつ、逃がしの途中、`\u` の途中、サロゲートの途中) をゴールデンで固定します。

### 2.3 Edit と、`turn.step` で拾えなかった場合の保険

- `Edit` の引数 (`old_string`、`new_string`) は差分で、途中の状態を組み立てるのは割に合いません。`tool` チャンクで `name === 'Edit'` かつ `file_path` が `source` なら「直しています」の合図だけを流し、`tool.call` の `Edit` (段階 4 で既に hook している) が `next(e)` から戻った後に `$.fs.read(source)` で全文を読み、`replace` で流します。
- `Write` も、`tool.call` の完了後に同じく全文を読み直して `replace` で流します。`turn.step` で流した文と最終の文がずれていても (逃がしの読み違い、断片の欠け)、完了時に必ず正しい全文に揃います。これが保険です。
- `Bash` の heredoc やリダイレクトでの書き込みは拾いません (段階 4 と同じ限界)。SKILL.md で「文書は Write と Edit で書く」と決めます。

### 2.4 予算と下流の遅れ

- `turn.step` のフックの予算は「自分のコードが動いている時間」だけです。`$.http.fetch` の保留は数えられません。ただし `yield` の前に `await fetch` すると、下流 (transcript の描画) がその分遅れます。そこで送信は待たずに投げます (`void engine.fetch(...)`)。順序は `seq` (通し番号) で受信サーバが守ります。失敗は無視し、次の `replace` で追いつきます。
- チャンクごとに 1 回送ると多すぎるので、改行が来たとき、または貯めた文字が 200 文字を超えたときに送ります。`stop` チャンクで残りを流します。タイマーは使いません (generator の中で `$.clock` の待ちは予算に数えられます)。

## 3. 受信サーバの改造

`scripts/receiver.py` に `serve --live` を足します。既存の `serve` (質問票と指摘の画面用) は変えません。ライブ用は回答を受けない代わりに、次の口を持ちます。すべて `?t=<token>` が要ります。

| 経路 | 誰が | 中身 |
|---|---|---|
| `GET /` | ブラウザ | ライブ表示の HTML (自己完結) |
| `GET /events` | ブラウザ | SSE (`text/event-stream`)。接続時に `snapshot` (全文、状態、指摘の一覧) を 1 つ送り、以後は `append` / `replace` / `status` / `comments` / `redirect` を流す。15 秒ごとに `: ping`。`status` は文言と種類 (`phase`) を持ち、画面は種類で振る舞いを決める。Mod が送る種類は `waiting` / `writing` / `fixing` / `done` / `stopped` / `aborted` / `ended`、受信サーバだけが流す種類は `moving` (`/finish` の 1 段目の後) と `closed` (終了の直前)。全文が上限を超えたときは `status` でなく `truncated` イベントを 1 回流し、`snapshot` にも `truncated` を載せる |
| `POST /document` | Mod | `{ "seq": n, "kind": "replace" \| "append" \| "status", "text": "..." }`。受信サーバは最新の全文と `seq` を保持し、`seq` が古いものは捨てる。応答は `{ "ok": true, "comments": [まだ Mod に渡していない指摘], "stop": true \| false }` で、渡した指摘は「渡し済み」に変わる |
| `POST /comments` | ブラウザ | `{ "id": "c1", "quote": "選んだ文字列 (無ければ空)", "text": "コメント", "mode": "after" \| "now", "at": "その時点の文書の文字数" }`。`mode: "now"` は `stop` の印も立てる。受信サーバは付けた順に貯める。`/finish` の 1 段目の後は 409 で断り、画面は「指摘の画面で付けてください」と出して書いた文を欄に残す |
| `POST /finish` | Mod | 2 段。1 段目 `{}` は「まだ Mod に渡していない指摘」を応答に載せ、以後の `/comments` を 409 にし、`status` (`phase: moving`) を流す。2 段目 `{ "url": "http://127.0.0.1:<port>/?t=..." }` は指摘を取らず、SSE で `redirect` を流して 1 秒後に終了する |
| `GET /wait` | Mod | 生存確認用に残す (段階 1 の引き継ぎと同じ判定を使えるように)。`{"answered": false}` を返すだけ |

- `ThreadingHTTPServer` なので SSE の接続は 1 本ずつスレッドになります。`server_close` は全スレッドの終了を待つので、終了時は `release` の Event で SSE のループを抜けさせてから閉じます (今の `/wait` と同じ作りです)。
- 全文は受信サーバのメモリに持ちます。上限は指摘の画面と同じ 10 万文字とし、超えたら受信サーバの保持分を末尾だけにし、`truncated` イベントを 1 回流します。超えた後も `append` はそのまま流します (全文の `replace` を毎回流さない)。本文の上限は 4 MiB、指摘は 200 件までで、超えると 400 / 429 を返します。
- ブラウザの JS は `EventSource` で受け、`replace` は全文を描き直し、`append` は末尾に足します。描き直しは 100 ms ごとにまとめます (requestAnimationFrame)。
- ライブ用の受信サーバは、次の 2 つのどちらかで自分で終わります。監視は 2 秒ごとのスレッド 1 本で行い、終了の直前に SSE で `status` (`phase: closed`) を流し、画面はそれを受けて再接続をやめます。
  - 配っている HTML (`--html` のパス) が消えたか、mtime が起動時と違う (同じ label で開き直された、`clean` で消された)。`status: 新しい画面に置き換わりました`。
  - Mod からの接触 (`/document`、`/finish`、`/wait`) が 10 分 (`LIVE_CONTACT_TIMEOUT_SECONDS`) 途絶えた (セッションが死んだ)。`status: セッションが終わりました`。
  ブラウザからの `/events` や `/comments` は接触に数えません。人がタブを開いたままでも、Mod がいなければ終わります。Mod はライブ表示を開いている間、60 秒ごとに `GET /wait` を投げて接触を保ちます (5.5)。既存の `serve` (質問票と指摘の画面) にある「起動から 3600 秒」の上限は、ライブ用には付けません。keepalive があるとセッションが生きている間に 1 時間で切れる制約になり、孤児の片付けは上の 2 条件で足りるからです。**決定 (2026-09-26)**: 実装に残っている「起動から 1 時間」は外します。

Mod からの push は `$.http.fetch(POST)` です。`hooks/receiver/index.ts` に `documentUrlOf` と `finishUrlOf` を足します。

## 4. 画面

`hooks/sheet/render-live.ts` に自己完結の HTML を書きます。段階 5 までの画面と CSS (`sheet/common.ts`) を共有します。

- 左: 文書。原本は Markdown が多いので、見出し (`#`〜`####`)、段落、箇条書き、番号付き、コードフェンス、引用、水平線、太字とコードの印だけを描く小さな描画器を JS で埋めます。表は等幅のまま出します。外部ライブラリは使いません。完成時に指摘の画面へ移るので、ライブ表示の描画は「読める」で足ります。
- 右上: 状態 (書いています / 直しています / 書き終わりました / 指摘の画面へ移ります / 止めて書き直しを頼みました)、経過秒数、文字数、`/doc-desk-resume` の案内。
- 右下: ライブ指摘。文書の文字列を選ぶと `quote` 欄に入ります (選ばなくても書けます)。コメント欄と、[書き終わったら直す] [今すぐ止めて直す] の 2 つのボタン。送った指摘は下に一覧で並び、「届けました (Write の後)」「止めました」「指摘の画面へ持ち越し」の状態が付きます。状態は SSE の `comments` イベント (一覧全体) で受信サーバから更新します。`/finish` の 1 段目の後は送れなくなり、「指摘の画面で付けてください」と出ます。
- 最下部に追従します。人が上へスクロールしたら追従を止め、[最新へ] のボタンを出します。文字列を選んでいる間も追従を止めます (選択が流れて消えないように)。
- 描画は `textContent` と `createElement` だけで行い、`innerHTML` は使いません (Claude が書いた文を実行しない方針は段階 5 と同じ)。書きかけの指摘は `localStorage` に残し、再読み込みで戻します。
- [今すぐ止めて直す] は押した後 10 秒ほど無効にし、二重に止めないようにします。Claude の書き直しが始まると (次の `document` イベント) 有効に戻ります。

見送ったもの (v2 の候補):

- 段落番号に結びつくライブ指摘。Markdown の段落と完成した HTML の段落を文字列で照合する必要があり、Claude が途中で段落を書き直すと結びつきが切れます。v1 では `quote` を Claude が探す形にします。

## 5. Mod 側の状態機械

### 5.1 ツール `open_live`

```json
{ "live": { "documentId": "spec-auth-01", "label": "spec-auth-01-live", "source": "docs/spec-auth.md", "title": "認証方式の仕様" } }
```

- `source` は必須です (質問票の `source` と同じ値を渡します)。`label` は証跡の名前で、質問票や指摘の画面と別にします。
- 検証が通ったら、`doc-desk/<label>.json` に入力を、`.html` にライブ表示の HTML を書き、`receiver.py start --live` で起動し、ブラウザを開き、ペインを開きます。結果は `{ status: "opened", url, files }` です。回答を待たないので `waitSeconds` はありません。
- すでに質問票か指摘の画面が待機中 (`pending`) なら `{ status: "invalid", errors: ["回答待ちの画面があります"] }` を返します。回答が届く前に文書を書くことは段階 4 で止めているので、ライブ表示もその前には開きません。
- `live` の状態は `{ sheet, source (正規化済み), receiver, url, seq, buffer, writing: { index, decoder } | null, turnId, comments: LiveComment[], isStopRequested }` です。`pending` とは別の変数にします (同時に持ち得るのは、ライブ表示中に `open_review` を呼んだ瞬間だけです)。`turnId` は `turn.start` のフックで覚えます (main の turn だけ)。

### 5.2 ライブ指摘の届け方

受信サーバからの指摘は `POST /document` の応答で Mod に届きます (2.4 のとおり送信は投げっぱなしですが、応答は `.then` で受けて `live.comments` に足します)。文が流れていない間 (Claude が考えている、別のツールを使っている) は応答が来ないので、`turn.step` の `tool` チャンク (次のツール呼び出しが始まる) と `stop` チャンクでも 1 回 `POST /document { kind: "status" }` を送って取りに行きます。

**[書き終わったら直す] (`mode: "after"`)**

- `source` への Write または Edit の `tool.call` が `next(e)` から戻ったとき、`live.comments` に未届の指摘があれば、結果に `context` を 1 つ足します。文はこの形です。

  ```
  【doc-desk ライブ指摘】人がライブ表示で、書いている途中の文書に次の指摘を付けました。
  先へ進む前に反映してください (該当箇所は「引用」で探し、Edit で直します)。
  1. 引用: 「セッションは 30 日」 / 指摘: 90 日を選んだはず
  2. 引用: (無し) / 指摘: 導入が長い
  ```

- 届けた指摘は「届け済み」にし、受信サーバに `POST /document { kind: "status" }` の一部として `delivered: ["c1", "c2"]` を返して画面の状態を更新します。
- `context` はモデルだけが読み、transcript には残りません。証跡として `doc-desk/<label>.comments.json` に指摘と届けた時刻を書きます。

**[今すぐ止めて直す] (`mode: "now"`)**

- 応答の `stop` が true になったら、`live.isStopRequested` を立て、`$.turn.abort({ turnId: live.turnId })` を呼びます。型定義によれば、実行中のツールも止まり、中断の印は付きません。書きかけの Write はまだ実行されていないので、ファイルには何も残りません (直前までに完了した Write と Edit は残ります)。
- `abort` が返ったら `$.prompt.submit` で新しい user turn を投入します。文はこの形です。

  ```
  【doc-desk ライブ指摘】文書 docs/spec-auth.md を書いている途中で、人がライブ表示で次の指摘を付けたので中断しました。
  指摘を反映して書き直してください。書き終わったら今までどおり指摘の画面 (open_review) に進みます。
  1. 引用: 「セッションは 30 日」 / 指摘: 90 日を選んだはず
  ```

- `$.prompt.submit` は「idle になってから turn を始める」ので、abort の完了を待ってから呼びます。同期待ち中の `open_review` などが無いことは、`live` が `pending` と同時に存在しない設計で保証されています。
- `abort` の呼び出しは `turn.step` の generator の中からになります。型定義は「a hook may end its own turn」と書いていますが、実機で確かめます (8 章)。
- `turnId` が無い (`turn.start` を見ていない、subagent の turn) ときは止めず、`mode: "after"` と同じ扱いにして `$.ui.log` で伝えます。

**まだ届けていない指摘**

- `open_review` が呼ばれたとき、`/finish` の応答で受け取った未届の指摘を、指摘の画面の HTML に「ライブ表示で付けた指摘」として埋めます。段階 5 の候補 (`candidates`) と同じ描き方で、`source: "live"` を付けます。人は採用か却下を押し、採用したものは普通の指摘として届きます。`quote` が段落に無ければ全体へのコメントの候補になります (段階 5 と同じ保険)。
- `open_review` を呼ばずに turn が終わったとき (5.4) は、`turn.complete` で未届の指摘があれば `$.ui.log` に件数を出すだけにします。次に Write か `open_review` があればそこで届きます。

### 5.3 `open_review` との連結

- `open_review` が呼ばれ、`live` があり、`review.documentId` が同じなら: ライブ用へ `POST /finish` を送って未届の指摘を受け取り、指摘の画面の HTML に埋め、新しい受信サーバを段階 5 までのとおりに起動し、`/finish` の応答後に SSE で流す URL を渡します。`/finish` は 2 段になります。1 段目 `POST /finish { }` が指摘を返し、2 段目 `POST /finish { url }` が `redirect` を流して終了します。`live` を閉じます。ブラウザは開き直しません (タブが移るため)。`isBrowserWanted` の既定を、この場合だけ `false` にします。
- `documentId` が違えば、ライブ表示は片付け (finish 無しで `stop`)、`open_review` は通常どおりブラウザを開きます。未届の指摘は `.comments.json` に残るだけで、届けません (別の文書なので)。

### 5.4 終わり方

| きっかけ | ライブ表示 |
|---|---|
| `open_review` (同じ documentId) | `/finish` (2 段) でタブを移し、受信サーバは終了 |
| `turn.complete` (main、`reason: 'answer'`) で `open_review` が呼ばれていない | `status: 書き終わりました` を流して残す。未届の指摘があれば件数を `$.ui.log` に出す |
| [今すぐ止めて直す] による `$.turn.abort` | `status: 止めて書き直しを頼みました` を流して残す。続く user turn で Claude が書き直すと、また文が流れる |
| `open_form` / `open_review` (別の documentId) / ペインの [取り消す] | `stop` で終了、ペインを閉じる |
| 中断 (Esc、`turn.step` の signal abort) | generator を抜ける。`status: 中断しました` を流して残す |
| セッション終了 | 残す (受信サーバは切り離し起動)。`session.end` で `status: セッションが終わりました` を投げっぱなしにする。段階 1 の記録には載せず、pid と token も残さない。受信サーバは Mod からの接触が 10 分途絶えると自分で終わる (5.5)。次の起動では `/doc-desk-resume` から開き直せない |

`/doc-desk-resume` は、`pending` が無く `live` があればライブ表示の URL を開き直します。

### 5.5 引き継ぎとの関係

段階 1 の記録 (`$.store`) はライブ表示には使いません。書いている途中でセッションが終わると、次のセッションは文書の続きを書く文脈を持たないので、引き継ぐものがありません。port、pid、token もどこにも保存しません。

残った受信サーバは、次のセッションが止めるのではなく、受信サーバ自身が次の 2 つの条件で終わります (3 章)。

- 自分が配っている HTML (`doc-desk/<label>.html`) が消えたか書き換わったとき。次のセッションが同じ label で `open_live` を呼ぶと、Mod は受信サーバを起動する前に HTML を書き直すので、古いサーバは数秒で終わります。`clean` で HTML を消しても同じです。
- Mod からの接触 (`/document`、`/finish`、`/wait`) が 10 分途絶えたとき。セッションが死んで孤児になったサーバは、人が読み終わるころに自分で消えます。

セッションが生きている間は、Mod がライブ表示を開いている限り 60 秒ごとに `GET /wait?t=<token>&timeout=0` を投げて接触を保ちます (keepalive)。これが無いと、`turn.complete` の後に人が 10 分以上読んでいるだけで受信サーバが「セッションが終わりました」で終わり、その後の Write が黙って失敗します (最初の実装で抜けていた点)。keepalive が 3 回続けて失敗したら、受信サーバは死んだとみなして `live` を閉じ、`$.ui.log` で「ライブ表示の受信サーバが終わっていました。`open_live` で開き直せます」と伝えます。放置すると `/doc-desk-resume` が死んだ URL を開き続けるためです。

`session.start` では何もしません。`session.end` では `POST /document { kind: "status", text: "セッションが終わりました" }` を投げっぱなしにするだけにします (待たないので終了の bound に収まります。失敗しても 10 分の期限で消えます)。

この形にしたのは、次のセッションが古いサーバを止めるには pid と token を残す必要があり (pid だけでは使い回しで別のプロセスを止めかねない)、それを `$.store` に書く案 (実装のセッションで検討した案 A) は動くものの、store のキーと本人確認と掃除の分岐が Mod 側に増えるからです。受信サーバに監視スレッドを 1 本足す方が小さく、「引き継がない」の趣旨にも合います。証跡ファイルに token を書く案は、git に入るおそれがあるので採りません。

## 6. 変更するファイル

| ファイル | 変更 |
|---|---|
| `scripts/receiver.py` | `serve --live`: `/events` (SSE)、`/document` (応答に指摘と `stop`)、`/comments`、`/finish` (2 段)。全文、`seq`、指摘の一覧と届け済みの印の保持。自分で終わる監視スレッド (HTML の消失と mtime の変化、Mod からの接触の途絶)。終了時の SSE スレッドの解放 |
| `hooks/live/json-stream.ts` (新規) | 部分 JSON から `file_path` と `content` を逐次取り出す状態機械 |
| `hooks/live/live-v1.ts` (新規) | `live` の入力と `LiveComment` の型と検証 (受信サーバから来る指摘も形を検査する) |
| `hooks/live/comments.ts` (新規) | 指摘から `context` の文と、`abort` 後に投入する prompt の文を作る。証跡 `.comments.json` の書き方 |
| `hooks/sheet/render-live.ts` (新規) | ライブ表示の HTML (簡易 Markdown 描画、SSE、追従、ライブ指摘の欄と一覧) |
| `hooks/sheet/render-review.ts` | 候補に `source: "live"` を足し、「ライブ表示で付けた指摘」として描く |
| `hooks/receiver/index.ts` | `--live` の argv、`documentUrlOf`、`finishUrlOf` |
| `hooks/register.ts` | ツール `open_live`、`turn.start` で `turnId`、`turn.step` フック (generator)、`tool.call` の Write / Edit 完了後の全文送信と `context` の差し込み、`stop` での `$.turn.abort` と `$.prompt.submit`、`open_review` との連結 (2 段の `/finish`)、`turn.complete` の「書き終わり」、`session.end` の `status` の投げっぱなし (段階 1 の `session.end` フックに足す)、`/doc-desk-resume` の開き直し、ペイン |
| `hooks/host/index.ts` | `abortTurn` を足す (`$.turn.abort`) |
| `hooks/form/schema.ts` | `open_live` の JSON Schema |
| `hooks/views/strings.ts` | 状態の文言 |
| `.claude-plugin/plugin.json` | `userConfig.liveView` (boolean、既定 true)。false なら `open_live` は `{ status: "disabled" }` を返す |
| `skills/doc-desk/SKILL.md`、`references/review-mode.md` | 手順 6 の冒頭で `open_live` を呼ぶ (宣言があるとき)。文書は Write と Edit で書く。`open_review` の前に `open_live` を閉じない |
| `tests/live.test.ts`、`tests/json-stream.test.ts` (新規) | 下のテスト |
| `README.md`、`docs/doc-desk/usage.md` | hooks / calls の印字、流れの図、証跡の表 (`doc-desk/<label>.json`、`.html`) |

## 7. テスト

- `json-stream.ts`: 断片の切り方 (1 文字ずつ、`\"` と `\\` の途中、`\u` の途中、サロゲートの途中)、`content` が先に来る JSON、`file_path` が一致しない JSON、`content` 以外のキー。
- `open_live`: 検証、受信サーバの起動 (`--live` 付き)、`pending` 中は `invalid`、`liveView: false` で `disabled`。
- `turn.step`: テストキットで stream を起こせる場合、`tool` (Write) → `input` 断片 → `stop` の列で `POST /document` が改行ごとに `append` で送られ、別ファイルの Write は送られないこと。起こせない場合は 8 章。
- `tool.call` の Write / Edit 完了後に全文が `replace` で送られること。
- `open_review` (同じ documentId) で `/finish` が 2 段で送られ、1 段目の応答の未届の指摘が指摘の画面の HTML に `source: "live"` で埋まり、ブラウザを開き直さず、`live` が閉じること。別の documentId では `stop` されること。
- `turn.complete` で「書き終わりました」が流れること。取り消しと `/doc-desk-resume` の開き直し。
- ライブ指摘 (`mode: "after"`): `/document` の応答に指摘が載ると、次の `source` への Write の `tool.call` の結果に `context` が 1 つ付き、文がゴールデンと一致すること。別ファイルの Write には付かないこと。届けた指摘は 2 回届かないこと。`.comments.json` が書かれること。
- ライブ指摘 (`mode: "now"`): 応答の `stop` が true になると `$.turn.abort` が `turn.start` の `turnId` で 1 回呼ばれ、その後に `$.prompt.submit` が指摘入りの文で 1 回呼ばれること。`turnId` が無ければ `abort` は呼ばれず `mode: "after"` と同じ扱いになること。
- `comments.ts`: `context` と prompt の文のゴールデン (引用あり / 無し、複数件、引用に改行や `"` を含む)。受信サーバから来た指摘の形が違えば捨てること。
- 受信サーバ単体 (手動): `curl -N "http://127.0.0.1:<port>/events?t=..."` で SSE を受けながら `POST /document` を叩き、`append` / `replace` / `redirect` が届くこと。`POST /comments` の後の `POST /document` の応答に指摘が 1 回だけ載り、`mode: "now"` で `stop` が true になること。終了時に SSE の接続が閉じること。
- 受信サーバの自己終了 (手動、`LIVE_CONTACT_TIMEOUT_SECONDS` を環境変数か引数で短くして): 配っている HTML を書き換えると数秒で `status` を流して終わること。HTML を消しても同じこと。Mod からの接触が無いまま期限を過ぎると終わること。ブラウザの `/events` だけを張り続けても期限で終わること。`/document` を叩き続ければ終わらないこと。
- `session.end` で `POST /document { kind: "status" }` が 1 回投げられ、その完了を待たずに `next(e)` が返ること。`live` が無ければ何も投げないこと。

## 8. 着手時に先に確かめること

| 確かめること | 確かめ方 |
|---|---|
| テストキットが `turn.step` の stream (async generator のフック) を起こせるか。`$.turn.step` に相当する口があるか | `claude-code/testing` の型と `.claude/types/claude-code.d.ts` |
| `input` チャンクが Write の引数で数十文字単位で届くか (API の `input_json_delta` の粒度) | 最小の plugin で `$.ui.log` に長さを出す |
| `turn.step` のフックで `yield` の前に `void fetch` を投げたとき、transcript の描画が遅れないか。generator の 1 チャンクあたりの予算に収まるか | 同上 |
| Desktop と `-p` でも main の `turn.step` が来るか | 同上 |
| `ThreadingHTTPServer` で SSE を長く保持したまま `shutdown` → `server_close` が戻るか (Event で抜ける作り) | receiver.py 単体 |
| Windows の既定ブラウザで `EventSource` が 127.0.0.1 の受信サーバに繋がり、`: ping` で切れないか | 実機 |
| `turn.step` の generator の中から `$.turn.abort` を呼べるか (型定義は「a hook may end its own turn」)。abort 後に `$.prompt.submit` が次の turn を始めるか。書きかけの Write がファイルに残らないか | 最小の plugin で実機 |
| Desktop と `-p` でも `$.turn.abort` が効くか | 同上 |
| `tool.call` の結果に足した `context` を、モデルが同じ turn の次の step で読んで Edit に進むか (段階 5 の `context` と同じ仕組みなので通るはず) | 実機 |
| テストキットで `$.turn.abort` と `turn.start` を模せるか | `claude-code/testing` の型 |

## 9. 決めてほしいこと

推奨を先に書きます。違う選択でも設計は成り立ちます。

1. **開き方**: `open_live` を Claude が明示的に呼ぶ。**決定 (2026-09-25): 採用。** 代案は「回答が届いたら自動で開く」と「`source` への最初の Write を検知して開く」でしたが、どちらも Mod が宣言を判定できず、意図しないタブが開くので採りませんでした。`open_live` を呼ばずに `source` への Write が始まったときに「`open_live` で開けます」と 1 行出す折衷は v2 の候補です。
2. **描画**: 簡易 Markdown 描画。**決定 (2026-09-25): 採用。** 見出し、段落、箇条書きと番号付き、コードフェンス、引用、水平線、行の中の太字とコードだけを描き、表は記法のまま等幅で出します。書きかけの文書は、閉じていないコードフェンスや途中の箇条書きを「開いたまま」として行単位で描き直します。代案の素のテキスト (`pre`) は構成が掴みにくく、Mod 側で HTML に変換する案は変換の責任が Claude と二重になるので採りませんでした。
3. **完成時の遷移**: 別の受信サーバへ `redirect`。**決定 (2026-09-25): 採用。** `open_review` は今までどおり新しい受信サーバを立て、ライブ用へ `POST /finish { url }` を送り、ライブ用は SSE で `redirect` を流して 1 秒後に終了します。既存の状態機械 (`pending`、同期待ち、監視、引き継ぎ) は触りません。代案の「同じ受信サーバで画面を差し替える」は受信サーバに 3 状態が増えて段階 1 の引き継ぎにも分岐が要り、「1 つのページに統合する」は段階 5 で確かめた指摘の画面を作り直すことになるので採りませんでした。port が変わるため `localStorage` は指摘の画面へ渡りません。渡すものができたら `/finish` の応答で Mod へ返し、指摘の画面の HTML に埋めます。
4. **読みながらの指摘**: ライブ指摘を v1 に入れる。**決定 (2026-09-26): 採用。** 当初の案は「メモ欄を置き、指摘の画面の全体コメントに引き継ぐ」でしたが、人が読んでいる途中で気づく典型 (方針のずれ) は「その場で直してほしい」ものだと分かり、Claude にその場で届ける形に変えました。届け方は [書き終わったら直す] (Write の完了時に Tool result の `context` で届ける) と [今すぐ止めて直す] (`$.turn.abort` で止め、`$.prompt.submit` で書き直しを頼む) の 2 つで、どちらも v1 に入れます。前者が土台で、後者はボタンと `abort` の呼び出しを足すだけなので分ける理由がありません。まだ届けていない指摘は、指摘の画面に `source: "live"` の候補として並べます (段階 5 の仕組みの流用)。段落番号に結びつくライブ指摘は v2 の候補です。

## 10. 手間の見積もり

段階 1 (未回答の引き継ぎ) より少し大きい規模です。内訳は、受信サーバの SSE と口 (小)、部分 JSON の状態機械とテスト (小)、ライブ表示の HTML と簡易描画と指摘の欄 (中)、ライブ指摘の届け方 (`context`、`abort` と `submit`、指摘の画面への持ち越し) (小〜中)、`register.ts` の結線 (中)、8 章の確認 (中) です。8 章の 1 つ目 (テストキットで stream を起こせるか) が否なら、`turn.step` の部分は実機での確認だけになり、テストは `tool.call` の完了後の全文送信までになります。
