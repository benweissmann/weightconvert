import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ingredients = JSON.parse(readFileSync(resolve(__dirname, '../data/ingredients.json'), 'utf8'));
const volumeIngredients = ingredients.filter(i => i.gPerMl !== null);

function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function runClaude(model, prompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 60000);
    const chunks = [];
    const proc = spawn('claude', ['-p', '--model', model, prompt], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => { clearTimeout(timer); if (code !== 0 && code !== null) reject(new Error('exit ' + code)); else resolve(Buffer.concat(chunks).toString().trim()); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function buildPrompt(batchIngredients, difficulty) {
  const summary = batchIngredients.map(i =>
    `${i.name}: ${i.grams}g per ${i.volume} (${i.gPerMl} g/mL)`
  ).join('\n');

  const diffNote = {
    easy: 'Clear quantities and full ingredient names: "1 cup flour", "2 tablespoons butter"',
    hard: 'Typos, shorthand, mixed numbers: "half tsp wheet flour", "1 1/2 T butr", "3/4 c AP flur"',
  }[difficulty];

  return `You generate training data for a baking ingredient parser.

Output exactly 20 JSONL lines — one JSON object per line, no other text:
{"input": "<user text>", "quantity": <number>, "unit": "<unit>", "ingredient": "<canonical name>", "grams": <number>}

Rules:
- quantity is a decimal number (0.5 not 1/2)
- unit must be one of: cup, tablespoon, teaspoon, fluid_ounce, gram, kilogram, ounce, pound
- ingredient must be the EXACT canonical name from the list
- grams = quantity * unitMl * gPerMl (compute this correctly)

Difficulty: ${difficulty.toUpperCase()} — ${diffNote}

Ingredients to use (vary which ones appear):
${summary}`;
}

async function runBatch(model, difficulty) {
  const batch = sample(volumeIngredients, 12);
  const start = Date.now();
  const raw = await runClaude(model, buildPrompt(batch, difficulty));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
  let parsed = [], bad = 0;
  for (const l of lines) {
    try { parsed.push(JSON.parse(l)); }
    catch { bad++; }
  }
  return { parsed, bad, elapsed };
}

console.log('Testing haiku vs sonnet on 1 easy + 1 hard batch each…\n');

for (const model of ['haiku', 'sonnet']) {
  for (const diff of ['easy', 'hard']) {
    process.stdout.write(`${model} / ${diff}… `);
    try {
      const { parsed, bad, elapsed } = await runBatch(model, diff);
      console.log(`${parsed.length} examples, ${bad} bad lines, ${elapsed}s`);
      // Show 3 samples
      parsed.slice(0, 3).forEach(e => console.log(`  "${e.input}" → ${e.ingredient} | ${e.grams}g`));
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  console.log();
}
