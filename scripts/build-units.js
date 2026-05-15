import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Canonical volume units → mL, with all accepted aliases
const units = [
  {
    canonical: 'cup',
    ml: 236.588,
    aliases: ['cup', 'cups', 'c', 'C'],
  },
  {
    canonical: 'tablespoon',
    ml: 14.787,
    aliases: ['tablespoon', 'tablespoons', 'tbsp', 'tbsps', 'T', 'tbs'],
  },
  {
    canonical: 'stick',
    ml: 118.294, // 8 tablespoons
    aliases: ['stick', 'sticks'],
  },
  {
    canonical: 'teaspoon',
    ml: 4.929,
    aliases: ['teaspoon', 'teaspoons', 'tsp', 'tsps', 't'],
  },
  {
    canonical: 'fluid_ounce',
    ml: 29.574,
    aliases: ['fluid ounce', 'fluid ounces', 'fl oz', 'fl. oz', 'floz', 'fl oz.'],
  },
  {
    canonical: 'liter',
    ml: 1000,
    aliases: ['liter', 'liters', 'litre', 'litres', 'l', 'L'],
  },
  {
    canonical: 'milliliter',
    ml: 1,
    aliases: ['milliliter', 'milliliters', 'millilitre', 'millilitres', 'ml', 'mL'],
  },
  {
    canonical: 'pint',
    ml: 473.176,
    aliases: ['pint', 'pints', 'pt'],
  },
  {
    canonical: 'quart',
    ml: 946.353,
    aliases: ['quart', 'quarts', 'qt'],
  },
  {
    canonical: 'gallon',
    ml: 3785.41,
    aliases: ['gallon', 'gallons', 'gal'],
  },
  // Mass units — not converted; parser uses massG directly
  {
    canonical: 'gram',
    ml: null,
    massG: 1,
    aliases: ['gram', 'grams', 'g'],
  },
  {
    canonical: 'kilogram',
    ml: null,
    massG: 1000,
    aliases: ['kilogram', 'kilograms', 'kg'],
  },
  {
    canonical: 'ounce',
    ml: null,
    massG: 28.3495,
    aliases: ['ounce', 'ounces', 'oz'],
  },
  {
    canonical: 'pound',
    ml: null,
    massG: 453.592,
    aliases: ['pound', 'pounds', 'lb', 'lbs'],
  },
];

// Build flat lookup: alias → {canonical, ml, massG}
const lookup = {};
for (const u of units) {
  for (const alias of u.aliases) {
    lookup[alias] = {
      canonical: u.canonical,
      ml: u.ml ?? null,
      massG: u.massG ?? null,
    };
  }
}

const outPath = resolve(__dirname, '../data/units.json');
writeFileSync(outPath, JSON.stringify({ units, lookup }, null, 2));
console.log(`Wrote ${units.length} unit definitions (${Object.keys(lookup).length} aliases) to data/units.json`);
