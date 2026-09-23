---
name: document-interview
description: 設計書・仕様書・企画書・記事を書く前、または既存の文書を更新する前に、人に決めてもらう論点を 2〜5 問の質問票にまとめ、ツール open_form でブラウザのフォームとして人に見せ、届いた回答を反映して文書を書く。「仕様書を書いて」「設計書を作りたい」「企画書をまとめて」「記事を書いて」「この文書を更新して」「書く前に確認して」「インタビューして」で発動する。事実で決まることは自分で調べ、好み・優先度・トレードオフの裁定だけを人に聞く。
---

# document-interview — 文書を書く前に、決定だけを一枚のフォームで聞く

文書を書く前に Claude が論点を整理し、質問票 JSON をツール `mcp__document-interview__open_form` に渡します。Mod (Claude Mods の plugin `document-interview`) がブラウザに一枚のフォームを出し、人が答えて [送信] を押すと、回答が `【インタビュー回答】` で始まる固定形で届きます。届き方は 2 つです。ツールは `waitSeconds` (既定 300 秒) まで呼び出しの中で回答を待ち、届けばツールの結果 (`status: "answered"` の `reply`) で返します。上限までに届かなければ `status: "pending"` で返り、あとで user turn として届きます。Claude はその回答を反映して文書を書きます。

**Input**: 文書作成・更新の依頼と、現物 (既存の文書、コード、実行結果)。
**Output**: 質問票 (`interview/<label>.json`)、人の回答 (`interview/<label>.md`)、それらを反映した文書。

## 最重要禁則 (先に読む)

- **回答が届く前に文書を書かない。** `open_form` が `pending` を返したら、そのターンを終えて待ちます。待つ間に文書の下書きを始めると、確認の意味が消えます。`answered` なら `reply` が回答なので、そのまま文書の作成に進みます。
- **事実を人に聞かない。** 各問に `cite` (`file:line` か実行結果の引用) を添えます。`cite` が書けない問いは、まだ調べ足りない問いです。自分で調べ、事実で答えが決まるなら問いごと消します。人に残すのは決定 (好み・優先度・トレードオフの裁定) だけです。
- **問いは 3±1 問 (2〜5 問)。** Mod は 6 問以上と 1 問以下を検証で落とします。人の判断コストが本体です。
- **非推奨の選択肢にも「選ぶ理由」を書く。** 各選択肢に `pros` (利点) と `cons` (代償) を 1 行ずつ書きます。利点が書けない選択肢しか無い問いは実質 1 択なので、問いを落として推奨案で進めます。
- **正解が一意で自己検証できることは聞かない。** 好みや曖昧な仕様が左右する判断だけに使います。
- **試問の結果を受け取る前に `open_form` を呼ばない。** 文脈ゼロの subagent に読ませて伝わるかを確かめてから人に見せます。

## 手順

1. **現物把握** — 既存の文書、コード、設定、実行結果から事実を集めます。各事実は `cite` に書ける形 (`src/auth/session.ts:40-88 に自前セッションの発行があります` のように、場所と内容) にしておきます。既存文書の更新なら、変えない部分と変える候補を分けます。
2. **論点の圧縮** — 決めてもらうことを 3±1 問に絞ります。事実で決まる問いは自分で調べて消します。残った各問に選択肢を 2 つ以上、それぞれ `pros` と `cons` を 1 行ずつ書き、推奨案 1 つに `recommended: true` を付けます。表で埋めてもらう情報 (画面ごとの要否など) があれば `tables` にします。質問票の書き方は `references/form-spec-v1.md` に従います。
3. **質問文の検査** — `references/question-lint.md` の表で自己検査します。読者が知らない語は `glossary` に入れます。Claude が作った ID や記号名 (`q1`, `tb1`, 変数名) を問いの文に出しません。
4. **試問 (preflight)** — `references/preflight.md` の手順で、`Agent` ツールで文脈ゼロの subagent を立て、質問票を Markdown に落として渡し、5 つの検査を出します。結果を受け取るまで次に進みません。落ちた問いは直して同じ subagent に差分だけを再試問し、計 2 巡で打ち切ります。
5. **`open_form` を呼び、結果で分岐する** — 下の「open_form の呼び方と結果」のとおりに呼びます。ツールは既定で 300 秒まで回答を待ちます。`answered` が返ったら `reply` が回答です。手順 6 へ進みます。`pending` が返ったら、人に「ブラウザのフォームで答えて [送信] を押してください。閉じてしまったら `/interview` で開き直せます」と伝えて応答を終えます。回答は `【インタビュー回答】<documentId>` で始まる user turn として届きます。届くまで文書を書きません。
6. **回答の反映** — 届いた固定形 (`answered` の `reply`、または user turn) を `references/reply-format-v1.md` の規則で読みます。お任せ (未選択) の問いは推奨案で確定します。補足と全体へのコメントは一字一句そのまま扱います。文書は ja-text-communication の規範 (要点先行、一文一義、用語の初出定義、英単語に助詞を直結しない) で書きます。文書の冒頭か末尾に「決定事項」として、各問の決定とお任せで確定した項目を書きます。
7. **2 枚目 (必要なら)** — 回答で設計が変わり、新しい論点が生まれたときだけ、同じ `documentId` で `revision` を進めた質問票を作ります。`label` は必ず変えます (例: `spec-auth-01` → `spec-auth-01-r2`)。同じ `label` を使うと前の質問票の証跡 `interview/<label>.*` が上書きされます (Mod は起動前に前回の `.answer.json` を消し、`documentId` と `revision` が違う回答を無視するので、古い回答を拾うことはありません)。捨てた案は文書に残します (「採用しなかった案」の節)。

## open_form の呼び方と結果

ツール名は `mcp__document-interview__open_form` です。入力は次の形です。

```json
{ "form": { "schemaVersion": 1, "documentId": "spec-auth-01", "revision": 1, "label": "spec-auth-01", "...": "..." }, "waitSeconds": 300 }
```

`waitSeconds` は呼び出しの中で回答を待つ上限 (秒) です。省略すると 300、上限は 1800、`0` なら待たずに `pending` を返します。ふつうは省略します。人がすぐには答えられないと分かっているときだけ `0` にします。

結果は JSON の文字列です。`status` で分岐します。

| `status` | 結果の中身 | Claude の動き |
|---|---|---|
| `answered` | `documentId`, `revision`, `reply` (回答固定形。`【インタビュー回答】<documentId>` で始まる), `files: { form, html, answer, md }`。context に「reply が人の回答です。user turn は届きません。reply を回答として読み、文書の作成に進んでください。」が付く | `reply` をそのまま回答として扱い、手順 6 へ進みます。user turn は届きません (待つ必要はありません) |
| `pending` | `documentId`, `revision`, `url`, `files: { form, html }`, `wait: { seconds, endedBy }` (`endedBy` は `timeout` = 上限到達、`abort` = 人が中断、`receiverLost` = 受信サーバに届かない、`skipped` = `waitSeconds: 0`)。context に「質問票をブラウザに出しました。回答は後で【インタビュー回答】で始まる user turn として届きます。それまで文書を書かず、このターンを終えてください。」が付く | ブラウザは Mod が開いています。人に「フォームで答えて [送信] を押してください」と伝え、**ターンを終えます**。回答は user turn として届きます。届いたら手順 6 へ |
| `cancelled` | `documentId`, `revision`, `reason` (「人が [取り消す] を押しました」か「別の質問票の open_form で差し替えられました」) | 何も届きません。人に取り消しを確認したことを伝え、次の指示を待ちます。質問票を直して出し直すかは人に聞きます |
| `invalid` | `errors: string[]`。各要素は `<パス>: <直し方>` (例: `themes[0].questions[1].cite: 根拠 (file:line か実行結果の引用) を書いてください。空は不可です`)。エラーは全部まとめて返る | `errors` を全部直して、同じツールをもう一度呼びます。人には見せません。問いの数のエラー (`圧縮してください`) は問いを減らして直します。3 回続けて `invalid` なら、質問票を人に Markdown で見せて相談します |
| `failed` | `reason`, `files: { form, html }`。`reason` は「python3 が見つからないため受信サーバを起動できませんでした」「受信サーバが 3 秒以内に起動しませんでした」「受信サーバを起動できませんでした (...)」のどれかに、「HTML は <絶対パス> に書いてあります。人に file:// で開いて回答してもらい、[送信] で出る JSON をチャットに貼ってもらってください。」が続く | `reason` の代替導線をそのまま人に案内し、ターンを終えます。人が貼った回答 JSON は `references/reply-format-v1.md` の「回答 JSON」の節の形です。Claude が自分で固定形の規則に当てはめて読み、手順 6 へ進みます。`session.start がまだ実行されていません` の `failed` (files 無し) は、セッションを開き直してもらいます |

注意:

- ツールが回答を待っている間、Claude のターンは進みません (ツールの結果を待っている状態です)。人が Esc で中断すると `pending` (`endedBy: "abort"`) で戻ります。回答はそのあとも受け付けられ、user turn として届きます。
- 待機中 (`pending` のあと) にもう一度 `open_form` を呼ぶと、Mod は前の質問票を取り消して (受信サーバを止めて) 新しい質問票に切り替えます。人が答えている最中に呼び直してはいけません。
- 人がペインを閉じても Mod は回答を待ち続けます。ブラウザを閉じてしまったときは `/interview` で開き直せます (人に伝える文言)。
- 人が [取り消す] を押すと、ツールが待っている間なら `cancelled` が返ります。`pending` のあとなら Claude には何も届きません。次のターンで人の指示を待ちます。

## Mod が読み込まれていないとき

使えるツールの一覧に `mcp__document-interview__open_form` が無ければ、Mod が読み込まれていません。質問票を出さずに止まり、人に「Document Interview Mod が読み込まれていません」と伝えて、利用者ガイド (agent-kit の `docs/document-interview-mod/usage.md`) の 4 章「Mod を読み込む」を案内します。

## 証跡ファイル

Mod はセッションの作業ディレクトリの下 `interview/` に、質問票の `label` ごとに書きます。

| ファイル | 中身 | 書く側 |
|---|---|---|
| `interview/<label>.json` | 検証済みの質問票 | Mod |
| `interview/<label>.html` | 自己完結の HTML シート (`file://` でも開ける) | Mod |
| `interview/<label>.port.json` | 受信サーバの `{"port", "pid"}` | 受信サーバ |
| `interview/<label>.answer.json` | ブラウザが送った回答 JSON (同じ label の前回のものは `open_form` が起動前に消す) | 受信サーバ |
| `interview/<label>.md` | 回答固定形 (`reply` または user turn として届いたものと同じ。末尾に改行 1 つ) | Mod (`failed` で人が回答 JSON を貼ったときは Claude) |

回答の正は届いた固定形 (`answered` の `reply`、または user turn) です。全体へのコメントに `---` や `## ` の行が含まれていて読み方に迷うときや、表のセルを原文で確かめたいときだけ `interview/<label>.answer.json` を読んで照合します。証跡は消しません。「なぜこの設計か」の答えになります。

## 完了報告

文書を書き終えたら、次を絶対パスで示します (ja-text-communication G1)。

- 書いた (更新した) 文書
- 質問票 `interview/<label>.json` と回答 `interview/<label>.md` (2 枚目があればそれも)
- 各問の決定 (お任せで確定した項目は「推奨案で確定」と明記)
- 人に確認していない仮定があればその一覧

反映後の文書やコードの commit は、人に確認してから行います。

## Additional resources

- `references/form-spec-v1.md` — 質問票 JSON の書き方。Mod の検証規則 (上限・必須・一意性・文字種) と完全な例。質問票を書く前に Read
- `references/reply-format-v1.md` — 回答固定形 v1 の契約と読み方。回答 JSON の形と、`failed` で貼られた回答の読み方
- `references/question-lint.md` — 質問文の自己検査表 (ja-text-communication の規範番号順)
- `references/preflight.md` — 試問の手順、質問票の Markdown の形、subagent に渡すプロンプトの雛形、打ち切り規則
