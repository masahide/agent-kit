# jev の API 契約 (ai@7.0.105, 2026-09-17)

数値の測定表は `findings.md`。ここは形・上限・エラーだけ。

## 経路
- Vercel AI Gateway (https://vercel.com/ai-gateway) 経由。鍵は Gateway の API key を env `AI_GATEWAY_API_KEY` に置く。jev は paid tier 限定 (無料クレジットでは 403)
- AI SDK 7 以降の `experimental_evaluate` (`import { experimental_evaluate } from 'ai'`) のみ。provider package は不要 (`ai` が gateway を内蔵し、model 文字列 `'typesafe-ai/jev'` は env の鍵で gateway へ行く。`globalThis.AI_SDK_DEFAULT_PROVIDER` を設定したアプリでは行かないので `gateway.evaluationModel('typesafe-ai/jev')` を明示)
- OpenAI 互換 `/v1/chat/completions` からは呼べない (400)。Python / curl の経路は無い
- API 名に experimental が付く。`ai` の minor 更新で形が変わりうる。壊れたら `findings.md` の版と突き合わせる

## 質問の型 (`@ai-sdk/provider` EvaluationModelV4Question)
- boolean: `{ type, instructions, criteria?: { true: string, false: string } }` → `{ probability }`
- choice: `{ type, instructions, criteria: Record<name, string> }` → `{ choice, probabilities? }`
- score: `{ type, instructions, criteria: string[] }` (2 段以上、低→高) → `{ score, probabilities? }`。score は段の 0 始まり index を補間した値、probabilities のキーは `'0'..'n-1'`。criteria を object で渡すと provider へ行く前に `InvalidArgumentError` で落ちる
- state: string | object | array。複数質問は 1 リクエストで同じ state を共有

## 速度・費用・再現性 (実測)
- 300〜900ms / 回 (30k トークンの state でも 0.9s)
- 課金は input のみ 0.042 ドル / 100 万トークン (出力は無料)。400 トークンの判定 1 回で約 0.00002 ドル
- 同一入力はほぼ再現する (連続 2 回で ±0.01)。確率を固定値で突き合わせるテストは書かない

## 上限
- state の上限は実測 ≈ 32k トークン (超えると 400 `max_tokens_exceeded`)。API の model 一覧では `context_window: 0` と出る。実測値・質問数・並列数は `findings.md`
- `result.usage` = `{ inputTokens, outputTokens, totalTokens }`

## エラーの切り分け
| 応答 | 意味 | 対処 |
|---|---|---|
| 403 `RestrictedModelsError` "Free tier users do not have access" | 残高切れ / 無料枠 | `curl -H "Authorization: Bearer $AI_GATEWAY_API_KEY" https://ai-gateway.vercel.sh/v1/credits` で残高を見て、Gateway の dashboard で credits を top-up |
| 403 `customer_verification_required` | team にカード未登録 | Vercel dashboard でカードを登録 |
| 400 `ModelTypeMismatchError` | chat endpoint に投げた | `experimental_evaluate` に戻す |
| 400 `max_tokens_exceeded` | state が大きい | 特徴量に切り出す (関心の分離) |
| `InvalidArgumentError: score criteria must contain at least two ordered levels` | score の criteria が配列でない / 1 段 | 低→高の配列にする |
