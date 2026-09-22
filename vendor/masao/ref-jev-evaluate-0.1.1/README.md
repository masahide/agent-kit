# ref-jev-evaluate

Claude Code 用の skill。分類・ルーティング・合否・段階づけを、LLM でなく jev (Vercel AI Gateway の評価専用モデル `typesafe-ai/jev`) の typed question に翻訳して、安く速く決めるための知識をまとめたもの。実測 80 回に基づく。

## 入れ方

```bash
# project に入れる
mkdir -p .claude/skills && cp -r ref-jev-evaluate .claude/skills/
# または個人用 (全 project)
mkdir -p ~/.claude/skills && cp -r ref-jev-evaluate ~/.claude/skills/
```

前提: Vercel AI Gateway の API key を env `AI_GATEWAY_API_KEY` に置く (jev は paid tier 限定)。Node 20+ と `ai@^7`。

## 中身

| ファイル | 役割 |
|---|---|
| `ref-jev-evaluate/SKILL.md` | いつ使う / 呼び方 / 翻訳表 / 関心の分離 / 較正 / Gotchas |
| `ref-jev-evaluate/references/api-contract.md` | 経路・質問の型・上限・エラー切り分け表 |
| `ref-jev-evaluate/references/findings.md` | 実測 80 回の数値表 |
| `ref-jev-evaluate/scripts/jev-eval.mjs` | cases ファイルをまとめて投げるランナー (JSONL 出力) |
| `ref-jev-evaluate/scripts/calibrate.mjs` | 正解付きサンプルで boolean の閾値を決める |
