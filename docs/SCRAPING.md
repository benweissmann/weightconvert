# Scraping the King Arthur Weight Chart

## Overview

`scripts/scrape.js` fetches the [King Arthur Baking ingredient weight chart](https://www.kingarthurbaking.com/learn/ingredient-weight-chart) and writes structured JSON to `data/ingredients.json`.

## Output

`data/ingredients.json` — array of objects:

```json
{
  "name": "All-Purpose Flour",
  "volume": "1 cup",
  "volumeMl": 236.588,
  "grams": 120,
  "gPerMl": 0.5072
}
```

- `volumeMl` — the reference volume converted to mL (null for mass-only entries like eggs)
- `gPerMl` — density in g/mL, used to convert any volume to grams (null for mass-only entries)

## Running

```bash
pnpm run build:scrape
# or directly:
node scripts/scrape.js
```

Requires outbound network access to `kingarthurbaking.com`.

## Units table

The units→mL conversion table is a separate static file, not scraped:

```bash
pnpm run build:units
# or:
node scripts/build-units.js
```

This writes `data/units.json` with all volume and mass unit aliases. It is fully offline and idempotent — re-run any time the unit definitions change.

## Notes

- **Deduplication:** the chart lists some ingredients twice (e.g. yeast). The scraper keeps the first occurrence.
- **Ranges:** weight values like "5 to 6 oz" are averaged.
- **Mass-only entries:** some rows (eggs, egg whites) have no volume column. They are kept in the output with `volumeMl: null` and `gPerMl: null`; Pipeline A can still use them when the user inputs a mass unit directly.
- The scraper sends a `User-Agent` header to avoid bot-detection blocks. If the site structure changes, update the `table tbody tr` selector in `scrape.js`.
