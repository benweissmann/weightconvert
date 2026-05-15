/**
 * Programmatic training data generator.
 *
 * Generates labeled examples purely from data/ingredients.json, data/units.json,
 * and data/aliases.json — no LLM calls, no API cost, runs in seconds.
 *
 * Strategy:
 *   easy   — canonical/alias name + clean quantity string + full unit name
 *   medium — alias + abbreviated unit + varied quantity format
 *   hard   — typo-injected ingredient phrase + abbreviated/omitted unit
 *
 * Usage:
 *   node scripts/gen-training-programmatic.js [--count 10000]
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ingredients = JSON.parse(readFileSync(resolve(__dirname, '../data/ingredients.json'), 'utf8'));
const unitsData   = JSON.parse(readFileSync(resolve(__dirname, '../data/units.json'), 'utf8'));
const aliases     = JSON.parse(readFileSync(resolve(__dirname, '../data/aliases.json'), 'utf8'));

const args = process.argv.slice(2);
const TARGET = parseInt(args[args.indexOf('--count') + 1] ?? '10000');

// ─── Reverse alias map: canonical → [alias, alias, ...] ──────────────────────

const reverseAliases = {};
for (const [alias, canonical] of Object.entries(aliases)) {
  if (!reverseAliases[canonical]) reverseAliases[canonical] = [];
  reverseAliases[canonical].push(alias);
}

// ─── Unit configuration ───────────────────────────────────────────────────────

// Units usable for volume-based ingredients, with realistic baking quantities
const VOLUME_UNITS = [
  { canonical: 'cup',         ml: 236.588, abbrevs: ['cup', 'cups', 'c', 'C'],               qtys: [0.25, 1/3, 0.5, 2/3, 0.75, 1, 1.5, 2, 3] },
  { canonical: 'tablespoon',  ml: 14.787,  abbrevs: ['tbsp', 'tbsps', 'T', 'Tbsp', 'tbs'],   qtys: [1, 2, 3, 4] },
  { canonical: 'teaspoon',    ml: 4.929,   abbrevs: ['tsp', 'tsps', 't', 'tsp.'],             qtys: [0.25, 0.5, 0.75, 1, 1.5, 2, 3] },
];

// Units usable for all ingredients (mass)
const MASS_UNITS = [
  { canonical: 'ounce',     massG: 28.3495, abbrevs: ['oz', 'oz.', 'ounce', 'ounces'],    qtys: [0.5, 1, 2, 4, 8] },
  { canonical: 'gram',      massG: 1,       abbrevs: ['g', 'grams', 'gram'],               qtys: [15, 25, 30, 50, 100, 150, 200, 250] },
  { canonical: 'pound',     massG: 453.592, abbrevs: ['lb', 'lbs', 'pound', 'pounds'],     qtys: [0.25, 0.5, 1, 2] },
];

// ─── Quantity formatting ──────────────────────────────────────────────────────

const FRACTION_STRINGS = {
  0.25: ['1/4', '1/4', 'one quarter', 'a quarter'],
  [1/3]: ['1/3', '1/3'],
  0.5:  ['1/2', '1/2', 'half', 'one half'],
  [2/3]: ['2/3', '2/3'],
  0.75: ['3/4', '3/4'],
  1.5:  ['1 1/2', '1 1/2', '1.5'],
};

const WORD_NUMS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };

function formatQty(qty, style = 'clean') {
  const frac = FRACTION_STRINGS[qty];
  if (frac) {
    if (style === 'word') return frac[frac.length - 1];
    return frac[Math.floor(Math.random() * Math.min(2, frac.length))];
  }
  if (Number.isInteger(qty)) {
    if (style === 'word' && WORD_NUMS[qty]) return WORD_NUMS[qty];
    return String(qty);
  }
  return String(qty);
}

function qtyToDecimal(qty) {
  return Math.round(qty * 10000) / 10000;
}

// ─── Typo injection ───────────────────────────────────────────────────────────

const KEYBOARD_NEIGHBORS = {
  a:'qwsz', b:'vghn', c:'xdfv', d:'serfcx', e:'wsdr', f:'dcgvr', g:'fhbvt',
  h:'gjnby', i:'ujko', j:'hknmu', k:'jlmio', l:'kop', m:'njk', n:'bhjm',
  o:'iklp', p:'ol', q:'wa', r:'edf', s:'awedxz', t:'rfgy', u:'yhji',
  v:'cfgb', w:'qase', x:'zsdc', y:'tghu', z:'asx',
};

function typoChar(ch) {
  const neighbors = KEYBOARD_NEIGHBORS[ch.toLowerCase()];
  if (neighbors && Math.random() < 0.7) {
    const n = neighbors[Math.floor(Math.random() * neighbors.length)];
    return ch === ch.toUpperCase() ? n.toUpperCase() : n;
  }
  return '';
}

function injectTypo(word) {
  if (word.length < 3) return word;
  const r = Math.random();
  const i = 1 + Math.floor(Math.random() * (word.length - 2));

  if (r < 0.25) {
    // Delete a character
    return word.slice(0, i) + word.slice(i + 1);
  } else if (r < 0.5) {
    // Transpose adjacent
    return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  } else if (r < 0.75) {
    // Substitute with keyboard neighbor
    return word.slice(0, i) + typoChar(word[i]) + word.slice(i + 1);
  } else {
    // Double a character
    return word.slice(0, i) + word[i] + word.slice(i);
  }
}

function applyTypos(phrase, intensity = 1) {
  // Apply typos to 1–2 words in the phrase
  const words = phrase.split(/\s+/);
  let count = 0;
  return words.map(w => {
    if (w.length > 3 && count < intensity && Math.random() < 0.5) {
      count++;
      return injectTypo(w);
    }
    return w;
  }).join(' ');
}

// ─── Input string builder ─────────────────────────────────────────────────────

const PREPOSITIONS = ['', 'of ', 'of the '];
const PREFIXES = ['', '', '', 'about ', 'roughly '];

function buildInput(qtyStr, unitStr, ingredientPhrase, style) {
  const prep = style === 'easy' ? '' : PREPOSITIONS[Math.floor(Math.random() * PREPOSITIONS.length)];
  const prefix = style === 'hard' ? PREFIXES[Math.floor(Math.random() * PREFIXES.length)] : '';

  // Occasionally drop unit for tablespoon/teaspoon in hard examples (implied)
  if (style === 'hard' && Math.random() < 0.1 && unitStr.length <= 4) {
    return `${prefix}${qtyStr} ${ingredientPhrase}`.trim();
  }

  return `${prefix}${qtyStr} ${unitStr} ${prep}${ingredientPhrase}`.trim();
}

// ─── Example generation ───────────────────────────────────────────────────────

function computeGrams(qty, unit, ingredient) {
  if (unit.ml !== undefined) {
    if (!ingredient.gPerMl) return null;
    return Math.round(qty * unit.ml * ingredient.gPerMl * 100) / 100;
  }
  return Math.round(qty * unit.massG * 100) / 100;
}

function pickIngredientPhrase(ingredient, style) {
  const canonical = ingredient.name;
  const aliasList = reverseAliases[canonical] ?? [];

  if (style === 'easy') {
    // Use canonical name or a clean alias
    const clean = [canonical.toLowerCase(), ...aliasList.filter(a => !a.includes('('))];
    return clean[Math.floor(Math.random() * Math.min(3, clean.length))];
  }

  if (style === 'medium') {
    // Prefer shorter aliases and abbreviations
    const all = [canonical.toLowerCase(), ...aliasList];
    return all[Math.floor(Math.random() * all.length)];
  }

  // hard: pick a phrase then inject typos
  const all = [canonical.toLowerCase(), ...aliasList];
  const base = all[Math.floor(Math.random() * all.length)];
  return applyTypos(base, Math.random() < 0.5 ? 1 : 2);
}

function* generateExamples(ingredient, unitDef, style) {
  for (const qty of unitDef.qtys) {
    const grams = computeGrams(qty, unitDef, ingredient);
    if (!grams || grams <= 0) continue;

    const qtyStyle = style === 'hard' && Math.random() < 0.3 ? 'word' : 'clean';
    const qtyStr = formatQty(qty, qtyStyle);
    const unitStr = unitDef.abbrevs[Math.floor(Math.random() * unitDef.abbrevs.length)];
    const ingredientPhrase = pickIngredientPhrase(ingredient, style);
    const input = buildInput(qtyStr, unitStr, ingredientPhrase, style);

    yield {
      input,
      quantity: qtyToDecimal(qty),
      unit: unitDef.canonical,
      ingredient: ingredient.name,
      grams,
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const STYLES = ['easy', 'easy', 'medium', 'medium', 'hard'];

const examples = [];

// Volume-capable ingredients
const volIngredients = ingredients.filter(i => i.gPerMl !== null);
// All ingredients (for mass units)
const allIngredients = ingredients;

// Expand: each ingredient × each applicable unit × each qty × each style
function expandPool() {
  const pool = [];

  for (const ing of volIngredients) {
    for (const unit of VOLUME_UNITS) {
      for (const style of STYLES) {
        pool.push({ ing, unit, style });
      }
    }
  }
  for (const ing of allIngredients) {
    for (const unit of MASS_UNITS) {
      for (const style of STYLES) {
        pool.push({ ing, unit, style });
      }
    }
  }
  return pool;
}

const pool = expandPool();
// Shuffle pool for variety
pool.sort(() => Math.random() - 0.5);

// Per-item (unitless) examples for eggs etc.
const perItemIngredients = ingredients.filter(i => i.perItem);
const PER_ITEM_QTYS = [1, 2, 3, 4, 6];
const PER_ITEM_STYLES = ['easy', 'medium', 'hard'];
const PER_ITEM_PHRASES = {
  'Egg (fresh)':        ['egg', 'eggs', 'large egg', 'large eggs', 'whole egg', 'whole eggs', 'an egg'],
  'Egg white (fresh)':  ['egg white', 'egg whites', 'whites'],
  'Egg yolk (fresh)':   ['egg yolk', 'egg yolks', 'yolk', 'yolks'],
  'Garlic (cloves, in skin for roasting)': ['garlic clove', 'garlic cloves', 'clove of garlic', 'cloves garlic'],
};

for (const ing of perItemIngredients) {
  const phrases = PER_ITEM_PHRASES[ing.name] ?? [ing.name.toLowerCase()];
  for (const style of PER_ITEM_STYLES) {
    for (const qty of PER_ITEM_QTYS) {
      const qtyStr = style === 'hard' && WORD_NUMS[qty] ? WORD_NUMS[qty] : String(qty);
      const phrase = phrases[Math.floor(Math.random() * phrases.length)];
      const inputPhrase = style === 'hard' ? applyTypos(phrase, 1) : phrase;
      examples.push({
        input: `${qtyStr} ${inputPhrase}`.trim(),
        quantity: qty,
        unit: 'each',
        ingredient: ing.name,
        grams: Math.round(qty * ing.gramsEach * 10) / 10,
      });
    }
  }
}

outer:
for (const { ing, unit, style } of pool) {
  for (const ex of generateExamples(ing, unit, style)) {
    examples.push(ex);
    if (examples.length >= TARGET) break outer;
  }
}

// Shuffle and split 85/15
examples.sort(() => Math.random() - 0.5);
const evalCount = Math.floor(examples.length * 0.15);
const evalSet   = examples.slice(0, evalCount);
const trainSet  = examples.slice(evalCount);

const rawPath   = resolve(__dirname, '../data/training-raw.jsonl');
const trainPath = resolve(__dirname, '../data/training.jsonl');
const evalPath  = resolve(__dirname, '../data/eval.jsonl');

writeFileSync(rawPath,   examples.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(trainPath, trainSet.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(evalPath,  evalSet.map(e => JSON.stringify(e)).join('\n') + '\n');

const difficulties = { easy: 0, medium: 0, hard: 0 };
examples.forEach(e => {
  // Re-detect difficulty by checking for typos (rough heuristic)
  const hasTypo = !aliases[e.input.split(' ').slice(2).join(' ')] &&
                  !ingredients.find(i => e.input.toLowerCase().includes(i.name.toLowerCase()));
  // (just count by style distribution instead)
});

console.log(`Generated ${examples.length} examples in ${pool.length} pool slots`);
console.log(`  Train : ${trainSet.length}`);
console.log(`  Eval  : ${evalSet.length}`);
console.log(`  Units : ${[...new Set(examples.map(e=>e.unit))].join(', ')}`);
console.log(`  Ingredients covered: ${new Set(examples.map(e=>e.ingredient)).size}/${ingredients.length}`);
console.log(`\nSample examples:`);
[0, Math.floor(examples.length/3), Math.floor(2*examples.length/3), examples.length-1]
  .forEach(i => {
    const e = examples[i];
    console.log(`  "${e.input}" → ${e.ingredient} | ${e.grams}g`);
  });
