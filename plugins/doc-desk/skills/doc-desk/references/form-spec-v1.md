# 質問票 JSON スキーマ v1 — open_form に渡す `form` の書き方

Claude が `mcp__doc-desk__open_form` の `form` に渡す JSON の契約です。Mod の `hooks/form/validate.ts` がこの規則で検証し、落ちた項目を `{ "status": "invalid", "errors": [...] }` で全部返します。`hooks/form/schema.ts` の JSON Schema (`$.tool.register` の `inputSchema`) も同じ形を宣言しています。

## 全体の形

```json
{
  "schemaVersion": 1,
  "documentId": "<文書の識別子>",
  "revision": 1,
  "label": "<証跡ファイル名>",
  "source": "<これから書く、または更新する文書のパス>",
  "title": "<主張のタイトル>",
  "conclusion": "結論: <3 文以内>",
  "glossary": [ { "term": "<語>", "definition": "<1 行の定義>" } ],
  "outline": "<構成案の HTML。問いは <span data-q=\"<問い ID>\"></span>、表は <div data-table=\"<表 ID>\"></div> で置く>",
  "themes": [
    {
      "id": "<テーマ ID>",
      "name": "<テーマ名>",
      "questions": [
        {
          "id": "<問い ID>",
          "title": "<問いの 1 文>",
          "cite": "<根拠: file:line か実行結果の引用>",
          "options": [
            { "id": "A", "label": "<選択肢>", "pros": "<利点 1 行>", "cons": "<代償 1 行>", "recommended": true, "preview": "<この案を選んだときに構成案の印に入る文>" },
            { "id": "B", "label": "<選択肢>", "pros": "<利点 1 行>", "cons": "<代償 1 行>", "preview": "<同上>" }
          ],
          "note": { "placeholder": "<補足欄の placeholder>" }
        }
      ]
    }
  ],
  "tables": [
    { "id": "<表 ID>", "title": "<表の題>", "columns": ["<列名>"], "rows": [["<セル>"]], "editable": [true] }
  ],
  "globalNote": { "label": "<全体へのコメント欄のラベル>" }
}
```

必須は `schemaVersion`, `documentId`, `revision`, `label`, `title`, `conclusion`, `outline`, `themes` です。`source`, `glossary`, `tables`, `globalNote`, 各問の `note`, 各選択肢の `recommended` と `preview`, 各表の `editable` は省略できます。

フォームの左には `title`、`conclusion`、`glossary` と構成案 (`outline`) が出ます。構成案の中の印 (問いと表) を人が押すと、右にその問いの選択肢や表の説明が出ます。

## 欄ごとの規則

「空でない」は、空白だけの文字列も空として落とすという意味です (`trim()` して判定します)。

### 文書と質問票の識別

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `schemaVersion` | 整数 | `1` に固定 | `schemaVersion: 1 にしてください` |
| `documentId` | 文字列 | `^[A-Za-z0-9_-]{1,64}$`。英数字と `-` と `_` の 1〜64 文字。空白や日本語は不可。同じ文書の質問票は全部同じ値にする。回答固定形の 1 行目 `【doc-desk 回答】<documentId>` に出る | `documentId: 1〜64 文字の英数字と - と _ にしてください` |
| `revision` | 整数 | 1 以上。同じ文書の何枚目の質問票か。2 枚目は 2 | `revision: 1 以上の整数にしてください` |
| `label` | 文字列 | `documentId` と同じ文字種と長さ。証跡ファイル名 `doc-desk/<label>.json` などになる。**質問票ごとに変える** (同じ `label` を使い回すと、前の質問票の証跡 `doc-desk/<label>.*` が上書きされる。Mod は起動前に前回の `.answer.json` を消し、`documentId` と `revision` が違う回答は無視するので、古い回答を拾うことはない)。推奨: 1 枚目は `<documentId>`、2 枚目以降は `<documentId>-r<revision>` | `label: 1〜64 文字の英数字と - と _ にしてください` |
| `source` | 文字列 | 省略可。1〜1024 文字の空でない文字列。これから書く、または更新する文書のパス (cwd 基準の相対か絶対)。書くと、回答が届くまで Mod がこのパスへの `Write`、`Edit`、`NotebookEdit` を止める (理由の文がツールのエラーとして返る)。SKILL.md の手順では常に書く | `source: 省略するか、1〜1024 文字の空でない文字列 (これから書く文書のパス) にしてください` |

### 結論と用語

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `title` | 文字列 | 空でない。内容の要約ではなく主張の言い切り (例: `認証方式は OIDC に統一する`) | `title: 空でない文字列にしてください` |
| `conclusion` | 文字列 | 空でない。`結論:` で始め、3 文以内 (文の数は検証しない。書き手の規律) | `conclusion: 空でない文字列にしてください` |
| `glossary` | 配列 | 省略可。読者が知らない語だけ。各要素はオブジェクトで `term` と `definition` がどちらも空でない | `glossary: 配列にしてください` / `glossary[0]: オブジェクトにしてください` / `glossary[0].term: 空でない文字列にしてください` / `glossary[0].definition: 空でない文字列にしてください` |

### 構成案

これから書く文書の見出しと各節の要旨を、HTML の断片 (`body` の中身にあたる部分) で書きます。未確定事項 (問い) と、人に埋めてもらう表は、構成案の中の置き場所に印で置きます。

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `outline` | 文字列 | 空でない。20000 文字以内 | `outline: 構成案 (文書の見出しと各節の要旨を書いた HTML) を書いてください。空は不可です` / `outline: 20000 文字以内にしてください (今は 20412 文字)。本文ではなく見出しと各節の要旨だけを書きます` |
| 要素 | | 使えるのは `h2`, `h3`, `h4`, `p`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `table`, `caption`, `thead`, `tbody`, `tr`, `th`, `td`, `strong`, `em`, `code`, `pre`, `blockquote`, `br`, `hr`, `span`, `div` だけ。`<!-- -->` のコメントの中は検査しない | `outline: 使えない要素 <script>, <a> があります。使えるのは h2, h3, ... です` |
| 属性 | | 使えるのは `span` の `data-q`、`div` の `data-table`、`th` と `td` の `colspan` と `rowspan` だけ。`class`, `style`, `id`, `on〜` も使えない | `outline: 使えない属性があります (<p> の class)。使えるのは span の data-q、div の data-table、th と td の colspan と rowspan だけです` |
| 問いの印 | | `<span data-q="<問い ID>"></span>`。**どの問いも 1 回以上置く**。同じ問いを 2 か所に置いてもよい。印の ID は問いの `id` と同じにする | `outline: 問い "q2" の印 <span data-q="q2"></span> がありません。未確定事項は、構成案の中のその決定で文が変わる箇所に置いてください` / `outline: data-q="q9" の問いがありません。印の ID は問いの id と同じにしてください` |
| 表の印 | | `<div data-table="<表 ID>"></div>`。**どの表もちょうど 1 回置く** | `outline: 表 "tb1" の印 <div data-table="tb1"></div> がありません。表を置く節に 1 つ置いてください` / `outline: 表 "tb1" の印が 2 個あります。1 つにしてください` / `outline: data-table="tb9" の表がありません。印の ID は表の id と同じにしてください` |

画面では、問いの印は番号付きの文になります。未選択の間は推奨案の `preview` (無ければ `label`) を灰色の破線で出し、選ぶと選んだ案の文に変わります。推奨案の無い問いは、選択肢の `label` を ` / ` でつないで出します。表の印の位置には、`tables` の表が入力欄付きで入ります。

Mod は構成案の HTML をそのまま画面に差し込みません。ブラウザが HTML を解析し、上の要素と属性だけで組み直して描きます。検証を通っていれば、見た目は書いたとおりになります。

### テーマと問い

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `themes` | 配列 | 1 つ以上 | `themes: テーマを 1 つ以上にしてください` |
| `themes[i]` | オブジェクト | | `themes[0]: オブジェクトにしてください` |
| `themes[i].id` | 文字列 | 空でない。テーマ間で一意 | `themes[0].id: 空でない文字列にしてください` / `themes[1].id: テーマ ID "t1" が重複しています` |
| `themes[i].name` | 文字列 | 空でない。フォームの右で、問いの上に小さく出る | `themes[0].name: 空でない文字列にしてください` |
| `themes[i].questions` | 配列 | 配列であること。テーマ単位の下限は無いが、**全テーマ合計で 2〜5 問** | `themes[0].questions: 配列にしてください` / `themes: 問いは全テーマ合わせて 2〜5 問にしてください (今は 1 問)。決定だけを問う形に整理してください` / `themes: 問いは全テーマ合わせて 2〜5 問にしてください (今は 6 問)。圧縮してください` |
| `questions[j]` | オブジェクト | | `themes[0].questions[0]: オブジェクトにしてください` |
| `questions[j].id` | 文字列 | 空でない。**全テーマを通して一意** (テーマが違っても同じ ID は不可) | `themes[1].questions[0].id: 問い ID "q1" が重複しています` |
| `questions[j].title` | 文字列 | 空でない。問いの 1 文。回答固定形の `Qn. <title>:` に出る | `themes[0].questions[0].title: 空でない文字列にしてください` |
| `questions[j].cite` | 文字列 | 空でない。`file:line` か実行結果の引用。事実を人に聞かないための強制 | `themes[0].questions[0].cite: 根拠 (file:line か実行結果の引用) を書いてください。空は不可です` |
| `questions[j].note` | オブジェクト | 省略可。`placeholder` があれば文字列。省略時のフォームの placeholder は「補足があれば 1 行で」 | `themes[0].questions[0].note: オブジェクトにしてください` / `...note.placeholder: 文字列にしてください` |
| `questions[j].options` | 配列 | 2 つ以上 | `themes[0].questions[0].options: 選択肢を 2 つ以上にしてください` |

### 選択肢

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `options[k]` | オブジェクト | | `themes[0].questions[0].options[0]: オブジェクトにしてください` |
| `options[k].id` | 文字列 | 空でない。**同じ問いの中で一意** (別の問いで同じ `A`, `B` を使うのは可)。回答固定形の `<id> — <label>` に出るので、`A`, `B`, `C` のような短い記号にする | `...options[1].id: 選択肢 ID "A" が重複しています` |
| `options[k].label` | 文字列 | 空でない。選択肢の名前 | `...options[0].label: 空でない文字列にしてください` |
| `options[k].pros` | 文字列 | 空でない。利点 (この案を選ぶ理由) を 1 行 | `...options[0].pros: 利点 (選ぶ理由) を 1 行書いてください` |
| `options[k].cons` | 文字列 | 空でない。代償を 1 行 | `...options[0].cons: 代償を 1 行書いてください` |
| `options[k].recommended` | 真偽値 | 省略可。`true` は **1 問に高々 1 つ**。フォームに「AI の推奨」の印が付き、未選択のときの確定案になる | `...options[0].recommended: true か false にしてください` / `themes[0].questions[0].options: recommended: true は 1 問に 1 つまでにしてください` |
| `options[k].preview` | 文字列 | 省略可。この案を選んだときに、構成案の印の位置に入る文。200 文字以内。省略すると `label` が入る | `...options[0].preview: 省略するか、200 文字以内の空でない文字列にしてください` |

### 表

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `tables` | 配列 | 省略可 | `tables: 配列にしてください` |
| `tables[i]` | オブジェクト | | `tables[0]: オブジェクトにしてください` |
| `tables[i].id` | 文字列 | 空でない。表の間で一意 | `tables[1].id: 表 ID "tb1" が重複しています` |
| `tables[i].title` | 文字列 | 空でない。回答固定形の `### <title>` に出る | `tables[0].title: 空でない文字列にしてください` |
| `tables[i].columns` | 文字列の配列 | 1〜6 個。各要素は文字列 | `tables[0].columns: 列名を 1〜6 個にしてください` / `tables[0].columns[2]: 文字列にしてください` |
| `tables[i].rows` | 文字列の配列の配列 | 0〜20 行。各行の長さは `columns` と同じ。各セルは文字列 (空文字列でよい。人に埋めてもらうセルは空にする) | `tables[0].rows: 行を 0〜20 行にしてください` / `tables[0].rows[1]: 列数 (3) と同じ長さの配列にしてください` / `tables[0].rows[1][2]: 文字列にしてください` |
| `tables[i].editable` | 真偽値の配列 | 省略可。`columns` と同じ長さ。`true` の列だけフォームで入力欄になり、`false` の列は固定表示。省略時は全列 `true` | `tables[0].editable: 列数 (3) と同じ長さの boolean 配列にしてください` |

### 全体へのコメント欄

| 欄 | 型 | 規則 | 落ちたときのエラー文 |
|---|---|---|---|
| `globalNote` | オブジェクト | 省略可。`label` があれば文字列。フォームの複数行の欄の見出しになる。省略時の見出しは「全体へのコメント」 | `globalNote: オブジェクトにしてください` / `globalNote.label: 文字列にしてください` |

## エラーの読み方

- `form` がオブジェクトでないときだけ `form: オブジェクトにしてください` の 1 件で止まります。それ以外は見つかったエラーを全部まとめて返します。
- パスは `themes[0].questions[1].options[0].pros` のように、配列の添字付きで書かれます。0 始まりです。
- 1 回の呼び出しで全部直して再送します。直せない (問いを減らせない) ときは論点の圧縮からやり直します。

## 書き手の規律 (検証はしないが守ること)

- `title` と `conclusion` は結論ファーストで書きます。読者が最初に見るのは結論ボックスです。
- 構成案 (`outline`) は、見出しと各節の要旨 (1 節 3 文以内) までにします。本文は書きません。本文は回答を受け取ってから書きます。
- 構成案の見出しは、節の名前 (名詞句) にします。表の題 (`tables[i].title`) は表の上に出るので、同じ語を見出しで繰り返しません。
- 問いの印は、その決定で文が変わる箇所に置きます。文書全体に関わる問いは、冒頭の「前提」の節に置きます。
- `preview` は、印の前後の文とつながる形で書きます。印が文の途中にあるなら語句 (`90 日`)、段落の頭にあるなら文 (`既存ユーザーは、初回ログイン時に自動で移行します。`) にします。語句で足りるなら `preview` を省いて `label` を使います。
- 問いの並び (テーマ順 → 問い順) は、構成案の中の印の順に合わせます。画面の番号と回答固定形の `Qn.` がこの並びで振られるので、構成案を上から読んだときに ① ② ③ の順に並びます。
- 各問は自己完結のカードにします。問いの 1 文、根拠、各選択肢の利点と代償だけで答えられる形にします。判断に要る数値は `cite` に単位付きで再掲します。
- 問いの文に `q1` や `tb1` のような ID、コード内の変数名、Claude が作った略語を出しません。人はそれを知りません。
- `glossary` は読者が知らない語だけです。定義済みの語は問いの文でそのまま使えます。
- `tables` は人に埋めてもらう表だけに使います。Claude が調べれば埋まる列は `editable: false` にして埋めておきます。

## 完全な例

`tests/fixtures/spec-auth-01.form.json` と同じ内容です (2 テーマ 2 問、表 1 つ)。

```json
{
  "schemaVersion": 1,
  "documentId": "spec-auth-01",
  "revision": 1,
  "label": "spec-auth-01",
  "source": "docs/auth.md",
  "title": "認証方式は OIDC に統一する",
  "conclusion": "結論: 認証は OIDC に統一します。自前のセッション管理は捨てます。移行期間は 2 週間です。",
  "glossary": [
    { "term": "OIDC", "definition": "OpenID Connect。OAuth 2.0 の上で認証を行う標準です。" }
  ],
  "outline": "<h2>前提</h2>\n<p>対象は、自前のセッションでログインしている既存ユーザーです。</p>\n<h2>移行</h2>\n<p><span data-q=\"q1\"></span>移行期間は 2 週間で、期間が過ぎたら自前のセッションの発行を止めます。</p>\n<h2>運用</h2>\n<p>監査ログは <span data-q=\"q2\"></span> 保持します。</p>\n<h2>画面</h2>\n<p>ログインが要る画面を、次の表で決めます。</p>\n<div data-table=\"tb1\"></div>",
  "themes": [
    {
      "id": "t1",
      "name": "方式",
      "questions": [
        {
          "id": "q1",
          "title": "既存ユーザーの移行をどう扱いますか",
          "cite": "src/auth/session.ts:40-88 に自前セッションの発行があります",
          "options": [
            { "id": "A", "label": "初回ログイン時に自動移行", "pros": "利用者の操作が増えません", "cons": "移行失敗時の切り分けが難しくなります", "recommended": true, "preview": "既存ユーザーは、初回ログイン時に自動で移行します。" },
            { "id": "B", "label": "全員に再登録を求める", "pros": "実装が単純です", "cons": "離脱が増えます", "preview": "既存ユーザーには、全員に再登録を求めます。" }
          ],
          "note": { "placeholder": "補足があれば 1 行で" }
        }
      ]
    },
    {
      "id": "t2",
      "name": "運用",
      "questions": [
        {
          "id": "q2",
          "title": "ログの保持期間",
          "cite": "docs/ops/retention.md:12 に「監査ログは 90 日」とあります",
          "options": [
            { "id": "A", "label": "90 日", "pros": "現行の規定と揃います", "cons": "長期の調査に使えません", "recommended": true },
            { "id": "B", "label": "1 年", "pros": "長期の調査に使えます", "cons": "保存費用が約 4 倍になります" }
          ]
        }
      ]
    }
  ],
  "tables": [
    {
      "id": "tb1",
      "title": "画面ごとの認証要否",
      "columns": ["画面", "認証", "備考"],
      "rows": [["トップ", "", ""], ["設定", "", ""]],
      "editable": [false, true, true]
    }
  ],
  "globalNote": { "label": "全体へのコメント" }
}
```

2 枚目を出すときは `documentId` を変えず、`revision` を 2 に、`label` を `spec-auth-01-r2` にします。意味が変わった問いは ID を新しくします (人の前の回答を流用しないため)。
