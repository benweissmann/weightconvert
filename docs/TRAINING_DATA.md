# Generating Training & Evaluation Data

## Overview

`scripts/gen-training.js` uses `claude -p` (Sonnet) to generate a labelled corpus of ingredient-parsing examples. The corpus is split into a training set (used for fine-tuning Pipeline B) and a held-out evaluation set (used to score both pipelines).

## Output

`data/training.jsonl` and `data/eval.jsonl` — one JSON object per line:

```json
{"input": "1/2 c flour", "quantity": 0.5, "unit": "cup", "ingredient": "All-Purpose Flour", "grams": 60}
{"input": "half tsp wheet flour", "quantity": 0.5, "unit": "teaspoon", "ingredient": "Whole Wheat Flour (Premium 100%)", "grams": 2.2}
```

Fields:
- `input` — raw text as a user might type it
- `quantity` — numeric amount (decimal, not fraction)
- `unit` — canonical unit name (cup, tablespoon, teaspoon, fluid_ounce, gram, ounce, pound, etc.)
- `ingredient` — exact canonical King Arthur name
- `grams` — computed weight in grams

## Running

Requires `data/ingredients.json` to exist first (run scraping step).

```bash
pnpm run build:training
# or directly:
node scripts/gen-training.js
```

Rewrites both output files from scratch each run (not incremental).

## Corpus design

The script generates **600 total examples** across 15 batches of 40, using a mix of difficulties:

| Difficulty | Share | Examples |
|---|---|---|
| Easy | ~33% | Clear quantities, full ingredient names, standard units: `"1 cup flour"` |
| Medium | ~33% | Abbreviations, shorthand, informal phrasing: `"1/2 c AP flour"`, `"2 T butter"` |
| Hard | ~33% | Typos, mixed numbers, unusual phrasing: `"half tsp wheet flour"`, `"1 1/2 T butr"` |

Each batch draws a random sample of ~15 ingredients from `data/ingredients.json`, preferring ingredients with known volume density (so grams can be computed).

**Eval split:** 15% of examples are held out as `eval.jsonl`. The split is done after shuffling, so difficulty levels are proportionally represented in both sets.

## Reproducibility

The split is seeded by shuffle order at generation time and then committed — `eval.jsonl` is fixed in version control so eval results are always comparable across pipeline changes.

To regenerate (e.g. after adding new ingredients or changing the difficulty balance), re-run the script and commit the new files. Update any recorded baseline scores in the eval results.

## Running the eval harness

Once `data/eval.jsonl` and `data/aliases.json` both exist:

```bash
pnpm run eval
```

This runs Pipeline A against the held-out set and reports parse accuracy and gram accuracy (±5% tolerance).
