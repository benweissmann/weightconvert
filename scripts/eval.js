import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadData, parse } from '../src/pipeline-a.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ingredients = JSON.parse(readFileSync(resolve(__dirname, '../data/ingredients.json'), 'utf8'));
const units = JSON.parse(readFileSync(resolve(__dirname, '../data/units.json'), 'utf8'));
const aliases = JSON.parse(readFileSync(resolve(__dirname, '../data/aliases.json'), 'utf8'));
const evalLines = readFileSync(resolve(__dirname, '../data/eval.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

loadData(ingredients, units, aliases);

const GRAM_TOLERANCE = 0.05; // 5% tolerance for gram accuracy

let parseCorrect = 0;
let gramCorrect = 0;
let total = 0;

const failures = [];

for (const example of evalLines) {
  total++;
  const result = parse(example.input);

  const ingredientMatch = result.ingredient === example.ingredient;
  const gramMatch = result.grams !== null &&
    Math.abs(result.grams - example.grams) / example.grams <= GRAM_TOLERANCE;

  if (ingredientMatch) parseCorrect++;
  if (gramMatch) gramCorrect++;

  if (!ingredientMatch || !gramMatch) {
    failures.push({
      input: example.input,
      expected: { ingredient: example.ingredient, grams: example.grams },
      got: { ingredient: result.ingredient, grams: result.grams, confidence: result.confidence },
      method: result.debug.method,
    });
  }
}

const parseAcc = (parseCorrect / total * 100).toFixed(1);
const gramAcc = (gramCorrect / total * 100).toFixed(1);

console.log('\n── Pipeline A Evaluation ──────────────────────────');
console.log(`Total examples : ${total}`);
console.log(`Parse accuracy : ${parseAcc}% (${parseCorrect}/${total})`);
console.log(`Gram accuracy  : ${gramAcc}% (${gramCorrect}/${total}, ±${GRAM_TOLERANCE * 100}%)`);
console.log('───────────────────────────────────────────────────\n');

if (failures.length > 0) {
  console.log(`First 20 failures:`);
  failures.slice(0, 20).forEach(f => {
    console.log(`  Input: "${f.input}"`);
    console.log(`    Expected: ${f.expected.ingredient} → ${f.expected.grams}g`);
    console.log(`    Got:      ${f.got.ingredient} → ${f.got.grams}g (conf ${f.got.confidence}, method: ${f.method})`);
  });
}
