# Document Interview Mod 計画書

作成日: 2026-09-22 / 更新: 2026-09-23 (実装しなかった設計と将来の計画を削除) / 状態: 背景と決定の記録。実装の仕様は [mvp-design.md](mvp-design.md)、使い方は [usage.md](usage.md) にあります

## 要点

- 文書を書く前に Claude が論点を整理し、一枚のフォームとして人に出し、人がまとめて答え、その回答を Claude が読んで設計書・仕様書・企画書・記事を書く仕組みを、Claude Mods として作りました。
- 元ネタは 3 つです。akapen からは「決定だけを人に聞く」出題規律と回答の固定形と試問を、grilling-viz からは質問データの型と回答の保持を、ja-text-communication からは質問文と生成文書の日本語規範を引き継ぎます。
- 当初はペインの中で答える設計でしたが、検証 (4 章) を経て、ブラウザの HTML フォームで答えて受信サーバに POST で戻す経路にしました。回答はツールの結果か、`$.prompt.submit` による user turn で Claude に届きます。

## 用語

| 語 | 意味 |
|---|---|
| Claude Mods (Mod) | function hooks を使う Claude Code の plugin の製品名です。Anthropic の担当者が GitHub issue #91870 (2026-09-09 更新) で命名しました。 |
| function hooks (関数フック) | plugin の `hooks/register.ts` が `on("イベント名", ($, e, next) => ...)` で登録する TypeScript の関数です。`$` はエンジン API、`e` はイベントの引数、`next` は下流のフックとエンジン本体へ処理を渡す継続です。 |
| ペイン (Pane) | Mod が `$.ui.open({ id })` で開く枠付きの画面領域です。この Mod では、回答を待つ間の URL と経過秒数の表示だけに使います。 |
| 質問票 (form) | Claude が論点を整理して作る JSON データです。この Mod はこれをフォームにし、回答を集めます。 |
| 回答固定形 | 人の回答を Claude が読むための、決まった形のテキストです。akapen の【赤ペン回答】と同じ文法にします。 |
| 試問 (preflight) | 質問票を人に見せる前に、文脈を持たない subagent に読ませて伝わるかを検査する手順です。akapen から引き継ぎます。 |
| お任せ | 人が選択肢を選ばなかった状態です。Claude は推奨案で確定します。 |

## 1. 背景と目的

### 1.1 いまの往復と、その限界

akapen と grilling-viz はどちらも「質問を HTML 1 枚にしてブラウザで開き、人が答え、生成されたテキストをターミナルに貼る」往復です。この往復は次の点で重いです。

- 人がブラウザとターミナルを行き来します。回答のテキストをコピーして貼る操作が毎回入ります。
- 回答の下書きは `localStorage` に残りますが、Claude 側からは見えません。

ja-text-communication は日本語で書くときの規範集で、UI や往復の仕組みは持ちません。質問文と生成文書の品質を上げる材料として使います。

### 1.2 Mods で変わること

Claude Mods では、plugin がツールを登録し、外部プロセス (受信サーバ) を起動し、`$.prompt.submit` で Claude に user turn を投入できます。これにより、ブラウザで [送信] を押すだけで回答が Claude に届き、コピーと貼り付けが要らなくなります。

### 1.3 目的

1. 文書作成前の論点整理を、人の判断コストを最小にした一枚のフォームで行えるようにします。
2. 人の回答を、コピーと貼り付けなしで Claude に渡せるようにします。
3. 回答をもとに Claude が文書を生成・更新する手順を、スキル (SKILL.md) として固定します。

## 2. 元ネタから引き継ぐもの

### 2.1 akapen から引き継ぐもの

| 良いところ | Mod での置き場所 |
|---|---|
| 事実を人に聞かず、決定 (好み・優先度・トレードオフの裁定) だけを聞く。各問に `file:line` か実行結果の引用を添える | SKILL.md の出題規律。質問票 JSON の `cite` 欄を必須にする |
| 決めてほしいことは 3±1 問。未選択はお任せ、推奨案に印を付ける | 質問票 JSON の `recommended`。フォームの初期状態は未選択で、フッターに「未選択はお任せ」と明記する |
| 非推奨の選択肢にも「選ぶ理由 (利点)」を 1 行書く。利点と代償を各 1 行 | 質問票 JSON の `pros` と `cons`。空の選択肢は検証で落とす |
| 結論ファースト (キッカー → 主張のタイトル → 結論 3 文) と用語欄 | HTML シートの先頭。質問票 JSON の `title`, `conclusion`, `glossary` |
| 【赤ペン回答】の固定形と、末尾の `---` + 締めの 1 文 | 回答固定形 v1 (`references/reply-format-v1.md`) |
| 出題前の試問 (文脈ゼロの subagent に 5 問) | SKILL.md の手順 (`references/preflight.md`) |
| 回答が届く前に実装を始めない | SKILL.md の禁則。ツールの結果の `context` でも Claude に念押しする |
| 証跡として HTML を残す | `./interview/<label>.*` に質問票、HTML、回答を保存する |

### 2.2 grilling-viz から引き継ぐもの

| 良いところ | Mod での置き場所 |
|---|---|
| 質問データを JSON にし、生成前に検証する (`validateDocument`) | 質問票 JSON スキーマ v1 と `hooks/form/validate.ts` |
| `documentId` を固定し、更新は版を進める | 質問票の `documentId` と `revision`。2 枚目は `revision` を進め、違う版の回答は無視する |
| 質問や選択肢の意味が変わったら質問 ID を新しくし、旧回答を流用しない | SKILL.md の 2 枚目の規則 |
| 選択肢は縦に並べ、再クリックで解除し、自由入力欄を常に置く | HTML シートの問いカード |
| 回答の下書きをブラウザに保存する | HTML シートの `localStorage` |
| 送信に失敗したときの手動の導線 | 回答 JSON を画面に出し、チャットに貼ってもらう |

### 2.3 ja-text-communication から引き継ぐもの

| 規範 | Mod での適用点 |
|---|---|
| A1, A3, A5: 用語・内部要素は初出で定義し、成果物ごとに再導入する | 質問票の `glossary` 欄。Claude が作った ID や記号名を質問文に出さない |
| B2, B4: 英単語に助詞を直結しない、造語を作らない | 質問文の自己検査表 (`references/question-lint.md`) |
| C1, C2, C4: 一文一義、主語を省かない、表のセルに未説明の圧縮句を置かない | 質問文・選択肢・表の列名の書き方の規則 |
| D4: 数値には単位・分母・範囲を添える | 判断材料の数値の書き方。`cite` 欄に範囲を書く |
| E2, E7: 要点先行、確認質問には判断材料を添える | 結論ボックスと、選択肢ごとの `pros` と `cons` |
| F2, F3: 推測と事実を分け、一次情報を優先する | `cite` 欄の必須化と、試問の「引用の有無」検査 |
| H1: ユーザーの指定語を一字一句そのまま使う | 回答固定形に人の自由記述を改変せず載せる |
| 全体: 生成文書の文章規範 | 文書生成の手順で ja-text-communication スキルを参照する |

## 3. 決定事項

2026-09-22 に、akapen の流儀で挙げた 4 問すべてについて推奨案を採用しました。その後の変更を「現在」の列に書きます。

| 問い | 決定 | 理由 | 現在 |
|---|---|---|---|
| Q1. 置き場所 | A. `plugins/document-interview/` (このリポジトリ内) | vendor の元ネタと並べて差分を追えます。使うときは `--plugin-dir` で指定します | そのまま |
| Q2. 選択肢の部品 | A. ペインの `Select` 1 つ (値 = 選択肢 ID) | 全サーフェスで同じ挙動で、行数が少なくて済みます | ブラウザ経路に変えたため不要。HTML の radio にした |
| Q3. 回答の見せ方 | A. 回答固定形の全文を user turn の本文にし、JSON を隠し context に添える | トランスクリプトに何を答えたかが残ります | 隠し context は成立しなかった (4 章 V7)。JSON は `interview/<label>.answer.json` を読む |
| Q4. レビューモード (生成文書への段落ごとの指摘) の範囲 | A. 最初の範囲に含めない | MVP を小さく早く動かします。生成文書への指摘は当面チャットで受けます | 作る予定なし。指摘はチャットで受ける |

採用しなかった案は次のとおりです。Q1 は `~/.claude/skills/` への配置、Q2 は選択肢ごとの `Button`、Q3 は本文 1 行と隠し context だけ、Q4 は最初から含める案でした。

2026-09-22 には、答える面をペインからブラウザの HTML フォームに変えました。ペインの `Input` は 1 行だけで補足や表を書くには狭いこと、ブラウザ経路が検証 (4 章 V2, V4〜V6) で動いたことが理由です。詳細は [mvp-design.md](mvp-design.md) の 0 章にあります。

## 4. 検証結果 (スパイク、2026-09-22)

検証用の plugin `spikes/mods-spike/` と `spikes/mods-spike-v3/` (リポジトリからは削除済み。コミット `e9dd2ca` の履歴にあります。`git show e9dd2ca --stat` で一覧できます) を、Claude Code 2.1.278 に `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` を付けた非対話モード (`claude -p --plugin-dir`) で実行しました。数値はそのときの実測です。

| 番号 | 検証したこと | 結果 | 実測 |
|---|---|---|---|
| V1 | タイマーの中で 15 秒の `$.process.run` を待つ | 完走した。フック予算 10 秒に数えられない | 15,023 ms |
| V2 | `sh -c "nohup ... >/dev/null 2>&1 &"` で切り離した子を起動する | すぐ戻った。受信サーバの常駐起動に使える | 40 ms |
| V3 | `tool.call` の中で 20 秒待ってから結果を返す (同期型) | 待てた。ただし結果の形が文字列か content ブロック配列でないとモデルにエラーが届く | 20,021 ms |
| V4 | 受信サーバを起動し、フォームを GET、回答を POST、回答ファイルを検知する | 全段階が通った | 起動から検知まで 1,537 ms |
| V5 | 回答検知後に `$.prompt.submit` で user turn を投入する | 投入され、モデルが「受信確認」と応答した。origin は `{ kind: "plugin", name }` | 2 ターン目 1,392 ms |
| V6 | 実ブラウザ (Claude デスクトップアプリ内蔵の Chromium) でフォームを開き [送信] を押す | 同一オリジンの `fetch` POST が 200 で返り、回答ファイルが書かれ、受信サーバが自動終了した | 回答は `{"answers":{"q1":"B"},"note":"..."}` |
| V7 | MVP 実装 (plugins/document-interview) を `claude -p` で通しで実行: open_form → 受信サーバ → 内蔵ブラウザで送信 → 回答検知 → `$.prompt.submit` | 全段階が通り、2 ターン目に `【インタビュー回答】` の固定形がそのまま届いた。ただし plugin 自身の `prompt.submit` フックは自分の投入を見ないため、隠し context は付かない (`config.set` の origin plugin の説明「その plugin 自身のフックは見ない」と同じ扱い) | 回答検知から 2 ターン目まで約 8 秒 (待機ループの粒度 2 秒を含む) |

V3 の補足: `{ result: JSON.stringify(...) }` と `{ result: [{ type: "text", text }] }` はモデルに届き、`{ result: { content: [...] } }` は「出力の形に合わない」と拒否されます。

実装上の規則も 2 つ分かりました。

- `$` を変数に代入したり引数に渡したりすると `claude plugin validate` が拒否します。`$.fs.write(...)` のように呼び出し位置で必ず `$.名詞.イベント(...)` と書き、後で使う場合は `session.start` の中で `text => $.fs.write(path, text)` のような閉包を作ります。
- `claude plugin validate` はフックの一覧と `$` の呼び出し一覧を印字します。README の「What it hooks / What it calls on `$`」はこの出力と一致させます。

V6 の補足: Chrome 拡張 (Claude in Chrome) は接続できなかったため、内蔵ブラウザで代替しました。ブラウザ側の表示は「送信しました。ターミナルに戻ってください。」で、ネットワークログにも `POST /answer?t=test → 200 OK` が残りました。既定のブラウザで開く場合も同一オリジンの `fetch` なので動作は同じと見ています。

V7 の補足: 3 章の決定 Q3 の「JSON を隠し context に添える」は成立しないので、回答 JSON は `interview/<label>.answer.json` を Claude が読む形に変えました。`$.fs.write` は親ディレクトリ `interview/` を作りました (mkdir は不要)。

未検証のまま残るのは、対話モードでのペインの描画とフォーカス移動、[取り消す] ボタンの押下です (テストキットの `$.ui.mount` と `$.ui.press` では通っています)。

受信サーバのプロトタイプは `spikes/mods-spike/scripts/receiver.py` と `form.html` でした (コミット `e9dd2ca` の履歴にあります)。トークン無しの GET は 403、POST 1 件でファイルに書いて自動終了します。

## 付録 A. 根拠にした一次情報

| 資料 | 所在 | 使った箇所 |
|---|---|---|
| Claude Mods の提案と経緯 | https://github.com/anthropics/claude-code/issues/91870 | 命名、出荷予定、有効化フラグ |
| 組み込み mod の実装と README | https://github.com/anthropics/claude-code/tree/main/mods | ファイル構成、`diff` mod のペイン描画、テストの書き方 |
| 型定義 `claude-code.d.ts` (2.1.277 が生成) | https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts | 要素、イベント、`$` の名詞、上限値、時間予算 |
| ローカルの Claude Code 2.1.278 | `~/.local/share/claude/versions/2.1.278` | フラグ `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`、`claude plugin test` の存在 |
| akapen 0.2.0 | `vendor/masao/akapen-skills-0.2.0/akapen/` | SKILL.md、`references/paper-spec-v3.md`、`reply-format.md`、`preflight.md`、`assets/shiteki/README.md` |
| grilling-viz | `vendor/mathbullet/plugins/grilling-viz/skills/grilling-viz/` | SKILL.md、`scripts/answer.js`、`scripts/components.js`、`scripts/render.mjs`、`design-system/tokens.css` |
| ja-text-communication | `vendor/mathbullet/plugins/ja-text-communication/skills/ja-text-communication/SKILL.md` | A〜H の規範 |

## 付録 B. 型定義から確認した要点

- `$.tool.register({ name, description, inputSchema })` で `mcp__<plugin>__<name>` が登録され、`tool.call` フックを `{ tool: "mcp__<plugin>__<name>" }` で受けて `{ result }` を返します。`session.start` 以降でないと登録できません。
- `$.prompt.submit({ text })` は plugin 発の user turn です。origin は `{ kind: "plugin", name }` で、セッションが待機状態のときに実行されます。
- `$.ui.open({ id, title, focus, ... })`。人の入力に応えた open はどの幅でも置かれ、plugin が自発的に開く場合は 144 列 (2 回目以降 110 列) 未満では描かれません。
- `Link` の `href` は `https:` か `http://localhost` だけが通ります。
- フックの時間予算は `HookBudget.ms = 10_000`。`$` 呼び出しの待ち中は時計が止まりますが、`$.clock` の待ちは予算に入ります。
