# Generating the Alias Map

## Overview

`scripts/gen-aliases.js` uses `claude -p` (Sonnet) to generate a comprehensive map of shorthands, typos, abbreviations, and generic terms to their canonical King Arthur ingredient names. The output is committed as static data and loaded by Pipeline A at runtime.

## Output

`data/aliases.json` — flat object, all keys lowercase:

```json
{
  "flour": "All-Purpose Flour",
  "ap flour": "All-Purpose Flour",
  "flur": "All-Purpose Flour",
  "icing sugar": "Confectioners' sugar (unsifted)",
  "whole wheat": "Whole Wheat Flour (Premium 100%)",
  ...
}
```

## Running

Requires `data/ingredients.json` to exist first (run scraping step).

```bash
pnpm run build:aliases
# or directly:
node scripts/gen-aliases.js
```

The script is **incremental**: it loads any existing `data/aliases.json` before starting and writes after every batch, so a partial run is never lost. Re-running adds to (and overwrites) existing entries.

## How it works

1. Splits the 323 canonical ingredient names into batches of 25.
2. Runs 2 batches concurrently via `claude -p --model sonnet`, each with a 2-minute timeout.
3. Validates all returned values are exact canonical names; silently drops any that aren't.
4. Writes the accumulated map to disk after each batch.

Typical runtime: ~5 minutes for a full run. Individual batches occasionally time out or return a conversational reply instead of JSON — these are skipped, and re-running the script fills the gaps (the incremental design means you won't re-generate what already succeeded).

## Resolution principle

The prompt instructs the model to be aggressive about defaults:

- Generic terms get the most common culinary default: `flour` → All-Purpose Flour, `sugar` → Sugar (granulated white), `butter` → Butter, `yeast` → Yeast (instant).
- More specific terms override the default: `wheat flour` → Whole Wheat Flour, `bread flour` → Bread Flour.
- An alias is only omitted if it is genuinely ambiguous with no clear culinary winner.

See also: the **Ingredient resolution principle** in `docs/PROMPT.md`.

## After running

Commit `data/aliases.json`. It is static build-time data — the frontend bundles it directly and never regenerates it at runtime.

If the King Arthur ingredient list changes (re-scrape), re-run alias generation so new ingredients get coverage.
