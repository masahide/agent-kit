#!/usr/bin/env node
// jev ランナー: cases ファイル (export const cases = [{id, state, questions}]) を順に投げ、JSONL を stdout へ。
// 使い方: AI_GATEWAY_API_KEY=... node jev-eval.mjs ./cases.mjs [caseId]  (env か .env で鍵を渡す)
// 実行前にこの dir で `npm i` (ai@^7)。
import { experimental_evaluate as evaluate } from 'ai';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [file, only] = process.argv.slice(2);
if (!file) { console.error('usage: jev-eval.mjs <cases.mjs> [caseId]'); process.exit(2); }
const { cases } = await import(pathToFileURL(resolve(file)).href);
for (const c of cases) {
  if (only && c.id !== only) continue;
  const t0 = Date.now();
  try {
    const r = await evaluate({ model: c.model ?? 'typesafe-ai/jev', state: c.state, questions: c.questions });
    console.log(JSON.stringify({ id: c.id, ms: Date.now() - t0, usage: r.usage, answers: r.answers }));
  } catch (e) {
    console.log(JSON.stringify({ id: c.id, ms: Date.now() - t0, error: String(e.cause?.responseBody ?? e.message).slice(0, 300) }));
  }
}
