import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const KA_URL = 'https://www.kingarthurbaking.com/learn/ingredient-weight-chart';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../data/ingredients.json');

// Volume unit → mL
const UNIT_TO_ML = {
  'cup': 236.588, 'cups': 236.588,
  'tablespoon': 14.787, 'tablespoons': 14.787, 'tbsp': 14.787,
  'teaspoon': 4.929, 'teaspoons': 4.929, 'tsp': 4.929,
  'fluid ounce': 29.574, 'fluid ounces': 29.574, 'fl oz': 29.574,
  'liter': 1000, 'liters': 1000, 'ml': 1, 'milliliter': 1,
  'pint': 473.176, 'pints': 473.176,
  'quart': 946.353, 'quarts': 946.353,
};

function evalFraction(s) {
  s = s.trim().replace(/[,]/g, '');
  if (!s) return null;
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseVolumeMl(str) {
  if (!str) return null;
  // Strip parenthetical annotations: "8 tablespoons (1/2 cup)" → "8 tablespoons"
  const s = str.trim().replace(/\s*\([^)]*\)/g, '').toLowerCase().trim();
  const m = s.match(/^([\d\s\/\.]+)\s+(.+)$/);
  if (!m) return null;
  const unit = m[2].trim().replace(/\.$/, '');
  const ml = UNIT_TO_ML[unit];
  if (!ml) return null;
  const qty = evalFraction(m[1]);
  return qty !== null ? qty * ml : null;
}

// Parse a weight cell: may be plain number (use defaultUnit), range, or "N oz/g"
function parseGramsFromCell(str, defaultUnit) {
  if (!str) return null;
  const s = str.trim().toLowerCase();
  if (!s) return null;

  // Range: "5 to 6" or "5 to 6 oz" → average
  const range = s.match(/^([\d\s\/\.]+)\s+to\s+([\d\s\/\.]+)\s*(oz|g|kg|lb)?/);
  if (range) {
    const a = evalFraction(range[1]);
    const b = evalFraction(range[2]);
    const unit = range[3] || defaultUnit;
    if (a !== null && b !== null) return convertToGrams((a + b) / 2, unit);
  }

  // Number + optional unit: "4", "4 oz", "120g"
  const m = s.match(/^([\d\s\/\.]+)\s*(oz|ounces?|g|grams?|kg|kilograms?|lb|pounds?)?\.?$/);
  if (m) {
    const qty = evalFraction(m[1]);
    const unit = (m[2] || defaultUnit).replace(/s$/, '').replace(/ram$/, 'g').replace(/ounce$/, 'oz').replace(/pound$/, 'lb').replace(/kilogram$/, 'kg');
    if (qty !== null) return convertToGrams(qty, unit);
  }

  return null;
}

function convertToGrams(value, unit) {
  switch ((unit || '').toLowerCase().replace(/s$/, '')) {
    case 'g': case 'gram': return value;
    case 'oz': case 'ounce': return value * 28.3495;
    case 'lb': case 'pound': return value * 453.592;
    case 'kg': case 'kilogram': return value * 1000;
    default: return null;
  }
}

async function scrape() {
  console.log('Fetching King Arthur weight chart…');
  const res = await fetch(KA_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; weightconvert-scraper/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Normalise Unicode soft-hyphens and non-breaking spaces that appear in KA's HTML
  function cleanText(el) {
    return $(el).text()
      .replace(/­/g, '')  // soft hyphen
      .replace(/ /g, ' ') // non-breaking space
      .trim();
  }

  const ingredients = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const name = cleanText(cells[0]);
    const volumeRaw = cleanText(cells[1]);
    const ozRaw = cleanText(cells[2]);
    const gRaw = cells.length >= 4 ? cleanText(cells[3]) : '';

    if (!name) return;

    const volumeMl = parseVolumeMl(volumeRaw);

    // Prefer explicit grams column; fall back to oz column (KA oz column = weight ounces)
    const grams = gRaw ? parseGramsFromCell(gRaw, 'g') : null;
    const gramsFromOz = ozRaw ? parseGramsFromCell(ozRaw, 'oz') : null;
    const finalGrams = grams ?? gramsFromOz;

    if (!finalGrams) return;

    const gPerMl = (volumeMl && finalGrams) ? finalGrams / volumeMl : null;

    // Per-item ingredients: volume is "1 large", "1 each", etc. — counted by piece
    const perItem = !volumeMl && /^\d+\s+(large|medium|small|each|piece|whole)\b/i.test(volumeRaw);

    ingredients.push({
      name,
      volume: volumeRaw,
      volumeMl: volumeMl ? Math.round(volumeMl * 1000) / 1000 : null,
      grams: Math.round(finalGrams * 10) / 10,
      gPerMl: gPerMl ? Math.round(gPerMl * 10000) / 10000 : null,
      ...(perItem ? { perItem: true, gramsEach: Math.round(finalGrams * 10) / 10 } : {}),
    });
  });

  // Deduplicate by name (keep first occurrence)
  const seen = new Set();
  const deduped = ingredients.filter(i => {
    const key = i.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(deduped, null, 2));
  console.log(`Wrote ${deduped.length} ingredients to data/ingredients.json`);

  const withDensity = deduped.filter(i => i.gPerMl !== null);
  const massOnly = deduped.filter(i => i.gPerMl === null);
  console.log(`  ${withDensity.length} with volume+density, ${massOnly.length} mass-only`);
}

scrape().catch(err => { console.error(err); process.exit(1); });
