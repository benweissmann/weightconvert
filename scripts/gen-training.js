import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ingredients = JSON.parse(readFileSync(resolve(__dirname, '../data/ingredients.json'), 'utf8'));

// Only use ingredients with volume density (can convert from volume input)
const volumeIngredients = ingredients.filter(i => i.gPerMl !== null);
// All ingredients (for mass-input examples)
const allIngredients = ingredients;

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn('claude', ['-p', '--model', 'haiku', prompt], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`claude exited ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    proc.on('error', reject);
  });
}

// Sample N random items from an array
function sample(arr, n) {
  const out = [];
  const copy = [...arr];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

const BATCH_SIZE = 40;
const TOTAL_EXAMPLES = 600;
const EVAL_FRACTION = 0.15; // 15% held out for eval

const SYSTEM = `You generate training data for a baking ingredient parser.

Each example is a JSON object on its own line (JSONL):
{"input": "<user text>", "quantity": <number>, "unit": "<unit>", "ingredient": "<canonical name>", "grams": <number>}

Rules:
- "input" is the raw text a user might type (natural language, may have typos/shorthand)
- "quantity" is the numeric amount (use decimals, not fractions: 0.5 not 1/2)
- "unit" must be one of: cup, tablespoon, teaspoon, fluid_ounce, liter, milliliter, pint, quart, gram, kilogram, ounce, pound
- "ingredient" must be an EXACT canonical name from the list provided
- "grams" is the computed weight in grams (quantity × gPerMl × volumeMl for volume units; quantity × massG for mass units)
- Output ONLY valid JSONL, one JSON object per line, no other text`;

async function generateBatch(batchIngredients, difficulty, index) {
  const ingredientSummary = batchIngredients.map(i =>
    `${i.name}: ${i.grams}g per ${i.volume} (${i.gPerMl ? `${i.gPerMl} g/mL` : 'mass-only'})`
  ).join('\n');

  const difficultyInstructions = {
    easy: `Generate EASY examples: clear quantities, full ingredient names, standard units.
Examples of easy inputs: "1 cup flour", "2 tablespoons butter", "1/2 cup sugar"`,

    medium: `Generate MEDIUM difficulty examples: mix of shorthand, abbreviations, informal phrasing.
Examples: "1/2 c AP flour", "2 T butter", "3/4 cup brown sugar", "1 tbsp honey"`,

    hard: `Generate HARD examples: typos, unusual phrasing, ambiguous terms, mixed numbers, ranges.
Examples: "half tsp wheet flour", "1/3 oz sugur", "two cups flur", "1 1/2 T butr",
"heaping tbsp cocoa pwdr", "scant cup AP flur", "3/4 c whole wheet"`,
  };

  const prompt = `${SYSTEM}

Difficulty: ${difficulty.toUpperCase()}
${difficultyInstructions[difficulty]}

Generate exactly ${BATCH_SIZE} examples using ONLY the following ingredients (vary which ones you use):

${ingredientSummary}

Important:
- For volume units, compute grams as: quantity × (grams_per_volume / volume_in_mL) × quantity_mL
- Use the EXACT canonical ingredient name in the "ingredient" field
- Hard examples should have realistic typos a home baker would make, not random noise
- Vary quantities realistically (common recipe amounts)`;

  const raw = await runClaude(prompt);
  // Parse JSONL
  const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
  const examples = [];
  for (const line of lines) {
    try {
      examples.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return examples;
}

async function main() {
  const allExamples = [];
  const batches = Math.ceil(TOTAL_EXAMPLES / BATCH_SIZE);
  const difficulties = ['easy', 'easy', 'medium', 'medium', 'hard', 'hard',
                        'easy', 'medium', 'hard', 'medium', 'hard', 'easy',
                        'medium', 'hard', 'medium'];

  const rawPath = resolve(__dirname, '../data/training-raw.jsonl');
  // Resume from existing raw file if present
  if (existsSync(rawPath)) {
    const existing = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean);
    allExamples.push(...existing.map(l => JSON.parse(l)));
    console.log(`Resuming — loaded ${allExamples.length} existing examples`);
  }

  const doneBatches = Math.floor(allExamples.length / BATCH_SIZE);
  console.log(`Generating ${TOTAL_EXAMPLES} training examples in ${batches} batches (starting at ${doneBatches})…`);

  for (let i = doneBatches; i < batches; i++) {
    const difficulty = difficulties[i % difficulties.length];
    const batchIngredients = sample(volumeIngredients.concat(
      difficulty === 'easy' ? [] : allIngredients.filter(x => !x.gPerMl)
    ), 15);

    process.stdout.write(`  Batch ${i + 1}/${batches} (${difficulty})… `);
    try {
      const examples = await generateBatch(batchIngredients, difficulty, i);
      allExamples.push(...examples);
      // Write each batch immediately so progress is never lost
      appendFileSync(rawPath, examples.map(e => JSON.stringify(e)).join('\n') + '\n');
      console.log(`${examples.length} examples`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  console.log(`\nTotal raw examples: ${allExamples.length}`);

  // Shuffle and split
  const shuffled = allExamples.sort(() => Math.random() - 0.5);
  const evalCount = Math.floor(shuffled.length * EVAL_FRACTION);
  const evalSet = shuffled.slice(0, evalCount);
  const trainSet = shuffled.slice(evalCount);

  const trainPath = resolve(__dirname, '../data/training.jsonl');
  const evalPath = resolve(__dirname, '../data/eval.jsonl');

  writeFileSync(trainPath, trainSet.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(evalPath, evalSet.map(e => JSON.stringify(e)).join('\n') + '\n');

  console.log(`Wrote ${trainSet.length} training examples to data/training.jsonl`);
  console.log(`Wrote ${evalSet.length} eval examples to data/eval.jsonl`);
}

main().catch(err => { console.error(err); process.exit(1); });
