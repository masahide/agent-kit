---
name: ref-jev-evaluate
description: 同じ型の判定 (分類・ルーティング・合否・段階づけ) を繰り返し、高速に低コストで決めたい場面で使う。LLM に判定だけさせようとした時、文章の出力が要らず特徴量のスコアリングで足りるならこちらが先 (理由文が要る判定は LLM)。「jev で判定」「安く速く決めたい」で発動。
---

# ref-jev-evaluate — 安く速い判定を typed question に翻訳する

jev (typesafe-ai/jev) は文章を書かない評価専用モデル。state (判定材料) と型付き質問から、確率・択一・段階を返す。速度・費用・再現性は `references/api-contract.md`。

## いつ使う

- 欲しい答えが「はい/いいえの確率」「N 択」「段階」で、text 出力が要らない
- 判定材料が特徴量として切り出せる (exit code・diff stat・チケット本文・候補 A/B)
- 同じ型の判定を繰り返す (script に焼く)。1 件だけなら agent が自分で決めたほうが速い
- 上を満たすなら LLM subagent より先にこちら。理由の説明が要る、材料が構造化できない、なら LLM
- 境界: 理由文・feedback 付きの採点は LLM judge。jev はその前段の粗ふるい・一次選抜に限る

## 呼び方

Vercel AI Gateway 経由で、AI SDK 7 以降の `experimental_evaluate` 専用。鍵は env `AI_GATEWAY_API_KEY` (Gateway の API key。paid tier が必要で、無料枠では 403)。

```bash
test -n "$AI_GATEWAY_API_KEY" || echo "AI_GATEWAY_API_KEY が無い"   # preflight
W=./jev && mkdir -p $W && cp <this-skill>/scripts/* $W/ && cd $W && npm i   # 初回のみ (ai@^7)
node judge.mjs   # 自分の判定 script と cases.mjs も $W に置く (node は実行ファイルの dir から node_modules を探す)
```

```ts
import { experimental_evaluate as evaluate } from 'ai';
const r = await evaluate({
  model: 'typesafe-ai/jev',
  state: { exit_code: 1, tail: 'error TS2322: Type string is not assignable to number' },
  questions: {
    fixable: { type: 'boolean', instructions: 'Can this be fixed by editing project code?',
      criteria: { true: 'compile, type, or assertion error in project source', false: 'network, disk, permission, or environment error' } },
    next: { type: 'choice', instructions: 'What should the agent do next?',
      criteria: { fix: 'compile or assertion error in project code', retry: 'timeout or transient network error', other: 'none of the above' } },
    severity: { type: 'score', instructions: 'How severe?',
      criteria: ['low: warning only', 'medium: one test or file fails', 'high: build or process dies'] },   // 配列、低→高
  },
});
r.answers.fixable.probability;   // 0.94 (実測)
r.answers.next.choice;           // 'fix'   (.probabilities = { fix: 1, retry: 0, other: 0 })
r.answers.severity.score;        // 1.98   (段の 0 始まり index を補間。.probabilities = { "0": 0, "1": 0.02, "2": 0.98 })
```

まとめて回すランナー: `node jev-eval.mjs ./cases.mjs` (cases.mjs は `export const cases = [{id, state, questions}]`、出力は JSONL)。経路・上限・エラーコードは `references/api-contract.md`。

## 翻訳表

| 判定の形 | type | criteria の書き方 | 答え |
|---|---|---|---|
| 合否・有無 | boolean | true と false の両方を観測できる語で定義 (object) | `.probability` |
| どれか 1 つ | choice | 選択肢名 → 観測できる条件 (object)。other を入れる | `.choice` + `.probabilities` |
| 程度・段階 | score | 低→高の順に並べた観測語ラベルの配列、3〜5 段 | `.score` (0 始まり) + `.probabilities` |

- criteria は観測できる言葉で書く。「良い」ではなく「テストと docs がある」。曖昧な criteria は確率が割れる (0.74 → 観測語で 1.00)
- 肯定形で聞く。否定形 ("NOT fixable?") は鈍る
- 日本語の instructions / criteria / state はそのまま通る
- 候補比較は state を `{A, B}` の object にして choice{A, B} で聞く (一対比較)

## 関心の分離

- **1 script = 1 関心**。state に載せる情報を増やすほど判定が散る (課金だけの state で billing 1.00、課金+ログイン混在の生文で 0.78)。「マージ可か」と「緊急度は」のように関心が違う判定は script も評価関数も分ける
- 同じ狭い state への複数質問はまとめてよい (1 回で 20 問まで実測、正答)。悪いのは state を広げることで、質問を増やすことではない
- state には判定に効く特徴量だけを object で渡す。会話履歴を丸ごと渡さず項目を切り出す (object と JSON 文字列は同結果なので整形不要)

## 較正 (boolean)

返るのは確率なので、閾値は本番前に決める。`calibrate.mjs` は boolean 専用。

1. 正解付きサンプルを 10 件前後用意する。`export const question = {type:'boolean', …}` と `export const samples = [{id, truth: true|false|null, state}]` (`null` = 曖昧例、採点から除外)
2. `node calibrate.mjs ./samples.mjs`。true と false の帯が離れていれば script が出す midpoint を閾値にする (実測: true 0.78〜0.97 / false 0.02〜0.11、12/12 正解)
3. 0.4〜0.6 に寄る質問は criteria が曖昧か、state に無関係な情報が混ざっている。criteria を直す前に state を削る
4. 曖昧例は帯として決め打てない (実測 0.09 と 0.28 に割れた)。「LLM へ回す」帯を作るなら自分のサンプルで測ってから script に焼く

## Gotchas

**jev は棄権しない**。根拠が無くても必ず答えるので、質問が state から答えられるかは書く側の責任。型ごとの症状:
- boolean: 無関係な質問に 0.24、空 state に 0.53 のような中途半端な値
- choice: **該当なしの入力にも高確信で誤答する** (言語設定の質問を billing/auth/shipping に投げると auth 0.94)。`other: 'none of the above'` を入れると other 1.00
- score: 根拠が無ければ最低段に落ちる。数字だけの段 ('1'..'7') は確率が散るので観測語ラベルの 3〜5 段にする

## 参照先

- 経路・上限・エラーの切り分け: `references/api-contract.md`
- 実測の数値表: `references/findings.md`
- ランナー・較正: `scripts/jev-eval.mjs` / `scripts/calibrate.mjs` (作業 dir へ copy して使う)
