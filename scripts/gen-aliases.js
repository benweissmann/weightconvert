import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ingredients = JSON.parse(readFileSync(resolve(__dirname, '../data/ingredients.json'), 'utf8'));
const names = ingredients.map(i => i.name);
const canonical = new Set(names);

const BATCH_SIZE = 25;
const TIMEOUT_MS = 2 * 60 * 1000;
const CONCURRENCY = 2;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Timed out after 2 minutes'));
    }, TIMEOUT_MS);

    const chunks = [];
    const proc = spawn('claude', ['-p', '--model', 'sonnet', prompt], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) reject(new Error(`claude exited ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function buildPrompt(batch) {
  return `You are generating a JSON alias map for a baking ingredient resolver.

Map every plausible shorthand, abbreviation, typo, and generic term to its canonical King Arthur name.

Be AGGRESSIVE — use culinary best-guesses for generic terms:
- "flour" -> "All-Purpose Flour"
- "sugar" -> "Sugar (granulated white)"
- "butter" -> "Butter"
- "salt" -> "Salt (table)"
- "oil" -> "Vegetable oil"
- "milk" -> "Milk (fresh)"
- "cream" -> "Heavy cream"
- "yeast" -> "Yeast (instant)"
- "cocoa" -> "Cocoa (unsweetened)"
- "oats" -> "Oats (old-fashioned or quick-cooking)"

For each canonical name in the list below, generate all reasonable aliases (lowercase keys). Include:
- Shortened/abbreviated forms
- Common misspellings and typos
- British/international equivalents (icing sugar, caster sugar, plain flour, etc.)
- Generic terms with obvious culinary defaults
- Variants without qualifiers ("rye flour" for "Medium Rye Flour")

Only skip an alias if it is genuinely ambiguous with NO clear winner.

Output ONLY valid JSON. No markdown fences. No explanation.

Canonical names for this batch:
${JSON.stringify(batch, null, 2)}`;
}

const outPath = resolve(__dirname, '../data/aliases.json');

// Load any existing aliases so re-runs accumulate
let allAliases = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, 'utf8'))
  : {};

const batches = [];
for (let i = 0; i < names.length; i += BATCH_SIZE) {
  batches.push({ index: batches.length, names: names.slice(i, i + BATCH_SIZE) });
}

console.log(`Generating aliases for ${names.length} ingredients in ${batches.length} batches (sonnet, concurrency=${CONCURRENCY})…`);

let removed = 0;

async function processBatch({ index, names: batch }) {
  process.stdout.write(`  Batch ${index + 1}/${batches.length} (${batch.length} names)… `);
  try {
    const raw = await runClaude(buildPrompt(batch));
    const json = raw.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/```\s*$/m, '').trim();
    const result = JSON.parse(json);
    let added = 0;
    for (const [alias, target] of Object.entries(result)) {
      if (!canonical.has(target)) { removed++; }
      else { allAliases[alias] = target; added++; }
    }
    writeFileSync(outPath, JSON.stringify(allAliases, null, 2));
    console.log(`done (+${added})`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}

// Run with fixed concurrency
for (let i = 0; i < batches.length; i += CONCURRENCY) {
  await Promise.all(batches.slice(i, i + CONCURRENCY).map(processBatch));
}

console.log(`\nWrote ${Object.keys(allAliases).length} aliases to data/aliases.json (${removed} invalid removed)`);
