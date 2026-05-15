/**
 * Pipeline A — Deterministic ingredient parser
 *
 * Input:  raw string, e.g. "1/2 c flour"
 * Output: { quantity, unit, ingredient, grams, confidence, debug }
 */

// ─── Data (loaded once) ──────────────────────────────────────────────────────

let _ingredients = null;
let _units = null;
let _aliases = null;

export function loadData(ingredientsJson, unitsJson, aliasesJson) {
  _ingredients = ingredientsJson;
  _units = unitsJson;
  _aliases = aliasesJson;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const VULGAR = {
  '½': 0.5, '⅓': 1/3, '⅔': 2/3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1/6, '⅚': 5/6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const WORD_NUMS = {
  'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'half': 0.5, 'quarter': 0.25, 'third': 1/3,
};

// Compound word-number phrases, checked before single-word patterns
const COMPOUND_QTYS = [
  [/^one\s+and\s+a?\s*half\b/i,    1.5],
  [/^one\s+and\s+a?\s*quarter\b/i, 1.25],
  [/^one\s+and\s+a?\s*third\b/i,   1 + 1/3],
  [/^a\s+half\b/i,                  0.5],
  [/^a\s+quarter\b/i,               0.25],
  [/^a\s+third\b/i,                 1/3],
  [/^one\s+half\b/i,                0.5],
  [/^one\s+quarter\b/i,             0.25],
  [/^one\s+third\b/i,               1/3],
  [/^three\s+quarters?\b/i,         0.75],
  [/^two\s+thirds?\b/i,             2/3],
];

export function parseQuantity(s) {
  s = s.trim();
  for (const [ch, val] of Object.entries(VULGAR)) s = s.replace(ch, ` ${val} `);
  s = s.trim();

  const wordMatch = s.match(/^([a-z]+)$/i);
  if (wordMatch && WORD_NUMS[wordMatch[1].toLowerCase()] !== undefined) {
    return WORD_NUMS[wordMatch[1].toLowerCase()];
  }

  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);

  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);

  const range = s.match(/^([\d\.]+)\s+to\s+([\d\.]+)$/i);
  if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;

  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Single-letter units (t/T) must match case-sensitively to avoid t↔T confusion
const CASE_SENSITIVE_UNITS = new Set(['t', 'T', 'c', 'C', 'l', 'L']);

// All unit aliases sorted longest-first so multi-word units match before substrings
let _unitAliases = null;
function getUnitAliases() {
  if (_unitAliases) return _unitAliases;
  _unitAliases = Object.keys(_units.lookup).sort((a, b) => b.length - a.length);
  return _unitAliases;
}

export function tokenize(input) {
  let s = input.trim().replace(/\s+/g, ' ');

  // Strip leading modifiers
  s = s.replace(/^(heaping|heaped|scant|level|about|approx\.?|roughly|around|~)\s+/i, '');

  // Normalise vulgar fractions inline
  for (const [ch, val] of Object.entries(VULGAR)) s = s.replace(ch, ` ${val} `);
  s = s.replace(/\s+/g, ' ').trim();

  // Try compound word-number phrases first ("a quarter", "one half", …)
  let quantityRaw = null;
  let quantityVal = null;
  let rest = s;

  for (const [re, val] of COMPOUND_QTYS) {
    const m = s.match(re);
    if (m) {
      quantityRaw = m[0];
      quantityVal = val;
      rest = s.slice(m[0].length).trim();
      break;
    }
  }

  // Standard quantity patterns
  if (quantityRaw === null) {
    const qtyPatterns = [
      /^(\d+\s+\d+\s*\/\s*\d+)/,
      /^(\d+\s*\/\s*\d+)/,
      /^([\d\.]+)\s+to\s+([\d\.]+)/i,
      /^([\d\.]+)/,
      /^([a-z]+)/i,
    ];
    for (const pat of qtyPatterns) {
      const m = s.match(pat);
      if (m) {
        const qty = parseQuantity(m[0]);
        if (qty !== null) {
          quantityRaw = m[0];
          quantityVal = qty;
          rest = s.slice(m[0].length).trim();
          break;
        }
      }
    }
  }

  // Strip "of [the]" and leading article "a/an" between quantity and unit/ingredient
  rest = rest.replace(/^of\s+(the\s+)?/i, '')
  rest = rest.replace(/^an?\s+(?=\w)/i, '');

  // Find unit
  let unitKey = null;
  let unitMl = null;
  let unitMassG = null;
  let ingredientPhrase = rest;

  const unitAliases = getUnitAliases();
  for (const alias of unitAliases) {
    const isCaseSensitive = CASE_SENSITIVE_UNITS.has(alias);
    const flags = isCaseSensitive ? '' : 'i';
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Single-letter units: must be followed by space or end (no trailing 's')
    const pattern = alias.length === 1
      ? `^${escaped}(?=\\s|$)`
      : `^${escaped}s?\\b`;
    const re = new RegExp(pattern, flags);
    const m = rest.match(re);
    if (m) {
      const entry = _units.lookup[alias];
      unitKey = entry.canonical;
      unitMl = entry.ml;
      unitMassG = entry.massG;
      ingredientPhrase = rest.slice(m[0].length).trim().replace(/^of\s+(the\s+)?/i, '').trim();
      break;
    }
  }

  return {
    quantity: quantityVal,
    unit: unitKey,
    unitMl,
    unitMassG,
    ingredientPhrase: ingredientPhrase.toLowerCase().trim(),
  };
}

// ─── Ingredient resolver ─────────────────────────────────────────────────────

function trigrams(s) {
  const padded = `  ${s}  `;
  const tg = new Set();
  for (let i = 0; i < padded.length - 2; i++) tg.add(padded.slice(i, i + 3));
  return tg;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// Filler words to strip before matching (adjectives/descriptors unlikely in KA names)
const FILLER_RE = /\b(fresh|dried|frozen|canned|cooked|raw|cold|warm|hot|melted|softened|unsalted|salted|whole|ground|chopped|sliced|diced|minced|packed|sifted|sieved|heaping|large|small|medium)\b/gi;

let _ingredientIndex = null;
function getIngredientIndex() {
  if (_ingredientIndex) return _ingredientIndex;
  _ingredientIndex = _ingredients.map(i => ({
    ...i,
    nameLower: i.name.toLowerCase(),
    tg: trigrams(i.name.toLowerCase()),
  }));
  return _ingredientIndex;
}

function resolvePhrase(phrase) {
  const index = getIngredientIndex();
  const p = phrase.toLowerCase().trim();
  if (!p) return null;

  // 1. Alias exact match
  if (_aliases[p]) {
    const match = index.find(i => i.name === _aliases[p]);
    if (match) return { ingredient: match, confidence: 0.95, method: 'alias' };
  }

  // 2. Exact name match
  const exact = index.find(i => i.nameLower === p);
  if (exact) return { ingredient: exact, confidence: 1.0, method: 'exact' };

  // 3. Prefix match
  const prefix = index.filter(i => i.nameLower.startsWith(p));
  if (prefix.length === 1) return { ingredient: prefix[0], confidence: 0.9, method: 'prefix' };
  if (prefix.length > 1) {
    return { ingredient: prefix.sort((a, b) => a.nameLower.length - b.nameLower.length)[0], confidence: 0.75, method: 'prefix-ambiguous' };
  }

  // 4. Contains match
  const contains = index.filter(i => i.nameLower.includes(p));
  if (contains.length === 1) return { ingredient: contains[0], confidence: 0.8, method: 'contains' };

  // 5. Trigram fuzzy
  const pTg = trigrams(p);
  const scored = index
    .map(i => ({ ingredient: i, score: dice(pTg, i.tg) }))
    .filter(x => x.score > 0.2)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    return {
      ingredient: scored[0].ingredient,
      confidence: scored[0].score * 0.85,
      method: 'fuzzy',
      topCandidates: scored.slice(0, 5).map(x => ({ name: x.ingredient.name, score: x.score })),
    };
  }

  return null;
}

export function resolveIngredient(phrase) {
  // Try the phrase as-is
  const direct = resolvePhrase(phrase);
  if (direct && direct.confidence >= 0.5) return direct;

  // Strip filler adjectives and retry ("cold butter" → "butter")
  const stripped = phrase.replace(FILLER_RE, '').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== phrase) {
    const strippedResult = resolvePhrase(stripped);
    if (strippedResult && (!direct || strippedResult.confidence > direct.confidence)) {
      return { ...strippedResult, method: strippedResult.method + '+stripped' };
    }
  }

  // Try progressively shorter suffixes ("gf bread flour" → "bread flour" → "flour")
  const words = phrase.split(/\s+/);
  for (let start = 1; start < Math.min(words.length, 4); start++) {
    const sub = words.slice(start).join(' ');
    if (sub.length < 3) continue;
    const subResult = resolvePhrase(sub);
    if (subResult && subResult.confidence >= 0.5) {
      return { ...subResult, confidence: subResult.confidence * 0.9, method: subResult.method + '+suffix' };
    }
  }

  // Return best result we have, even if low confidence
  return direct ?? { ingredient: null, confidence: 0, method: 'none' };
}

// ─── Weight computation ───────────────────────────────────────────────────────

export function computeGrams(quantity, unitMl, unitMassG, ingredient) {
  if (!ingredient || quantity === null) return null;
  if (unitMl !== null) {
    if (!ingredient.gPerMl) return null;
    return Math.round(quantity * unitMl * ingredient.gPerMl * 10) / 10;
  }
  if (unitMassG !== null) return Math.round(quantity * unitMassG * 10) / 10;
  // Unitless count: per-item ingredient (eggs, etc.) — multiply by per-item weight
  if (unitMl === null && unitMassG === null && ingredient.perItem && ingredient.gramsEach) {
    return Math.round(quantity * ingredient.gramsEach * 10) / 10;
  }
  return null;
}

// ─── Main parse function ──────────────────────────────────────────────────────

export function parse(input) {
  const { quantity, unit, unitMl, unitMassG, ingredientPhrase } = tokenize(input);

  const resolution = ingredientPhrase
    ? resolveIngredient(ingredientPhrase)
    : { ingredient: null, confidence: 0, method: 'none' };

  const grams = resolution.ingredient
    ? computeGrams(quantity, unitMl, unitMassG, resolution.ingredient)
    : null;

  let confidence = resolution.confidence;
  if (quantity === null) confidence *= 0.5;
  // unitless is fine for per-item ingredients; penalise only for volume/mass ingredients
  if (unit === null && !resolution.ingredient?.perItem) confidence *= 0.6;
  if (grams === null) confidence *= 0.3;

  return {
    input,
    quantity,
    unit,
    ingredient: resolution.ingredient?.name ?? null,
    grams,
    confidence: Math.round(confidence * 100) / 100,
    debug: {
      ingredientPhrase,
      method: resolution.method,
      topCandidates: resolution.topCandidates ?? [],
      unitMl,
      unitMassG,
      sourceRow: resolution.ingredient
        ? { name: resolution.ingredient.name, grams: resolution.ingredient.grams, volume: resolution.ingredient.volume }
        : null,
    },
  };
}
