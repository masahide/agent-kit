#!/usr/bin/env node
// 較正: 正解付きサンプルを 1 つの boolean 質問に流し、分離度と閾値候補を表にする。
// 使い方: (初回この dir で npm i) AI_GATEWAY_API_KEY=... node calibrate.mjs ./samples.mjs
// boolean 専用 (choice / score には使えない)
// samples.mjs: export const question = { type: 'boolean', instructions, criteria };
//              export const samples = [{ id, truth: true|false|null, state }];  (null = 曖昧例、採点から除外)
import { experimental_evaluate as evaluate } from 'ai';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: calibrate.mjs <samples.mjs>'); process.exit(2); }
const { question, samples } = await import(pathToFileURL(resolve(file)).href);
const rows = await Promise.all(samples.map(async (s) => {
  const r = await evaluate({ model: 'typesafe-ai/jev', state: s.state, questions: { q: question } });
  return { ...s, p: r.answers.q.probability };
}));
const pad = (v, n) => String(v).padEnd(n);
console.log(pad('id', 14) + pad('truth', 7) + 'p');
for (const r of rows) console.log(pad(r.id, 14) + pad(r.truth, 7) + r.p.toFixed(2));
const t = rows.filter((r) => r.truth === true).map((r) => r.p);
const f = rows.filter((r) => r.truth === false).map((r) => r.p);
const a = rows.filter((r) => r.truth === null).map((r) => r.p);
const rng = (xs) => (xs.length ? `${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}` : '-');
console.log(`\ntrue ${rng(t)}  false ${rng(f)}  ambiguous ${rng(a)}`);
if (t.length && f.length) {
  const gapLo = Math.max(...f), gapHi = Math.min(...t);
  if (gapHi > gapLo) console.log(`separable: threshold anywhere in (${gapLo.toFixed(2)}, ${gapHi.toFixed(2)}), midpoint ${((gapLo + gapHi) / 2).toFixed(2)}`);
  else console.log(`NOT separable: false max ${gapLo.toFixed(2)} >= true min ${gapHi.toFixed(2)} — tighten criteria or narrow state`);
  const mid = rows.filter((r) => r.truth !== null && r.p > 0.4 && r.p < 0.6);
  if (mid.length) console.log(`in 0.4..0.6: ${mid.map((r) => r.id).join(', ')} (criteria or state is ambiguous)`);
}
