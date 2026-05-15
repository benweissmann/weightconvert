/**
 * Haiku-powered hard example generator.
 *
 * Takes correctly-labeled examples from the programmatic corpus and asks Haiku
 * to rewrite the input string with harder phrasing — typos, unusual abbreviations,
 * natural language variation. Labels (ingredient, quantity, unit, grams) are fixed,
 * so Haiku can't hallucinate wrong answers.
 *
 * Usage:
 *   node scripts/gen-training-hard.js [--train 2000] [--eval 500]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const TRAIN_TARGET = parseInt(args[args.indexOf('--train') + 1] ?? '2000');
const EVAL_TARGET  = parseInt(args[args.indexOf('--eval')  + 1] ?? '500');
const TOTAL        = TRAIN_TARGET + EVAL_TARGET;
const CONCURRENCY  = 8;
const TIMEOUT_MS   = 90_000;
const BATCH_SIZE   = 20; // rewrites per claude call

const rawExamples = readFileSync(resolve(__dirname, '../data/training-raw.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

// Sample without replacement from the raw pool
function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, TIMEOUT_MS);
    const chunks = [];
    const proc = spawn('claude', ['-p', '--model', 'haiku', prompt], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) reject(new Error(`exit ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function buildPrompt(batch) {
  const examples = batch.map((e, i) =>
    `${i + 1}. canonical="${e.ingredient}" qty=${e.quantity} unit=${e.unit} → input: "${e.input}"`
  ).join('\n');

  return `You are generating hard training examples for a baking ingredient parser.

For each example below, rewrite ONLY the "input" field to make it harder to parse. Keep canonical, qty, unit, and grams EXACTLY the same.

Rewrite rules — apply 1–3 of these per example:
- Add realistic typos (character swap, deletion, doubling): "flour" → "flur", "butter" → "butur"
- Use abbreviations: "tablespoon" → "T", "teaspoon" → "tsp", "cup" → "c"
- Use informal phrasing: "1/2 cup of flour" → "half a cup flour", "a generous tbsp"
- Add descriptors that don't change meaning: "cold butter", "fresh milk", "sifted flour"
- Use British spellings: "colour", "favourite" (for non-ingredient words)
- Spell out numbers: "2 tbsp" → "two tbsp", "1/4 tsp" → "quarter tsp"
- Rearrange slightly: "flour, 1 cup" or "1c flour"

Output a JSON array of ${batch.length} objects, one per input example, in order:
[{"input": "<rewritten input>"}, ...]

Output ONLY the JSON array, no other text.

Examples to rewrite:
${examples}`;
}

const RAW_OUT   = resolve(__dirname, '../data/hard-raw.jsonl');
const TRAIN_OUT = resolve(__dirname, '../data/training.jsonl');
const EVAL_OUT  = resolve(__dirname, '../data/eval.jsonl');

// Clear raw output for fresh run
writeFileSync(RAW_OUT, '');

const allHard = [];
const batches = [];
const pool = sample(rawExamples, Math.min(TOTAL * 2, rawExamples.length)); // oversample in case of failures

for (let i = 0; i < pool.length && batches.length * BATCH_SIZE < TOTAL * 1.5; i += BATCH_SIZE) {
  batches.push(pool.slice(i, i + BATCH_SIZE));
}

console.log(`Generating ${TOTAL} hard examples (${TRAIN_TARGET} train + ${EVAL_TARGET} eval) via haiku…`);
console.log(`${batches.length} batches × ${BATCH_SIZE}, concurrency=${CONCURRENCY}\n`);

let done = 0;
let failed = 0;

async function processBatch(batch, idx) {
  try {
    const raw = await runClaude(buildPrompt(batch));
    const json = raw.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();
    const rewrites = JSON.parse(json);

    let added = 0;
    for (let i = 0; i < Math.min(rewrites.length, batch.length); i++) {
      const rewritten = rewrites[i]?.input?.trim();
      if (!rewritten || rewritten === batch[i].input) continue;
      const example = { ...batch[i], input: rewritten };
      allHard.push(example);
      appendFileSync(RAW_OUT, JSON.stringify(example) + '\n');
      added++;
    }
    done += added;
    process.stdout.write(`  batch ${idx + 1}: +${added} (total ${done})\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  batch ${idx + 1}: FAILED (${e.message})\n`);
  }
}

// Run with fixed concurrency, stop once we have enough
for (let i = 0; i < batches.length && allHard.length < TOTAL; i += CONCURRENCY) {
  const wave = batches.slice(i, i + CONCURRENCY);
  await Promise.all(wave.map((b, j) => processBatch(b, i + j)));
}

console.log(`\nGenerated ${allHard.length} hard examples (${failed} batches failed)`);

// Trim to exact targets
allHard.sort(() => Math.random() - 0.5);
const hardTrain = allHard.slice(0, TRAIN_TARGET);
const hardEval  = allHard.slice(TRAIN_TARGET, TRAIN_TARGET + EVAL_TARGET);

// Merge with existing programmatic data
const existingTrain = readFileSync(TRAIN_OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const existingEval  = readFileSync(EVAL_OUT,  'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const finalTrain = [...existingTrain, ...hardTrain].sort(() => Math.random() - 0.5);
const finalEval  = [...existingEval,  ...hardEval ].sort(() => Math.random() - 0.5);

writeFileSync(TRAIN_OUT, finalTrain.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(EVAL_OUT,  finalEval.map(e => JSON.stringify(e)).join('\n') + '\n');

console.log(`Training set : ${finalTrain.length} (${existingTrain.length} programmatic + ${hardTrain.length} hard)`);
console.log(`Eval set     : ${finalEval.length} (${existingEval.length} programmatic + ${hardEval.length} hard)`);
