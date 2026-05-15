# Weight Convert — Design Doc

## Goal

A client-side web app that converts ingredient quantities in natural language to the equivalent weight in grams.

Example: `1/2 c flour` → `60g All-Purpose Flour`

## Design goals

- **Tolerant input.** Case-sensitive abbreviations (`c`/`C` for cups, `t`/`tsp` for teaspoons, `T`/`tbsp` for tablespoons, etc.), shorthands and typos (`flour` → "All-Purpose Flour"; `wheat flor` → "Whole Wheat Flour").
- **Fast, client-side.** Runs entirely in-browser. As-you-type results: target <100ms input → output, with <500ms acceptable when debounced.
- **Offline-first.** After the first successful load, the app works fully offline, including the LLM pipeline if the user has opted into it. Updates happen in the background without blocking the UI.
- **Minimal, mobile-friendly UI.** Layout considers mobile keyboard placement.
- **Transparent.** The user can inspect the parsing pipeline and the underlying source data so they can trust the answer.

## Architecture

We will implement **two parsing pipelines side-by-side** and evaluate them against a held-back test set before deciding on the final shipping configuration.

### Pipeline A — Deterministic parser (always available)

1. **Tokenize input** into `{quantity, unit, ingredient_phrase}` using a small grammar (regex + handling for vulgar fractions, mixed numbers, ranges). Existing libraries like `parse-ingredient` are a reasonable starting point but will likely need adaptation.
2. **Normalize unit** via a static volume → milliliters table (cup, tbsp, tsp, fl oz, mL, L, etc.). Mass units (g, kg, oz, lb) bypass conversion.
3. **Resolve ingredient** via fuzzy match against the scraped King Arthur ingredient list, using:
   - An exact/prefix match first
   - A handcrafted alias map (`flour` → All-Purpose Flour, `wheat flour` → Whole Wheat Flour, etc.) generated offline by an LLM at build time, then committed as static data
   - Trigram or Fuse.js-style fuzzy fallback for typos

   **Ingredient resolution principle:** prefer the more specific ingredient when the input implies it (e.g. `wheat flour` → Whole Wheat Flour, `bread flour` → Bread Flour), but apply reasonable culinary defaults for bare generic terms: `flour` → All-Purpose Flour, `sugar` → Sugar (granulated white), `salt` → Salt (table), `butter` → Butter, `oil` → Vegetable oil. Only leave a resolution ambiguous if no clear default exists in culinary practice.
4. **Compute weight** by multiplying mL × (g/mL from King Arthur).
5. **Emit a confidence score** alongside the result. Low confidence triggers Pipeline B if enabled.

This pipeline ships in <100KB, runs in <1ms, requires no model download, and works on every browser.

### Pipeline B — Fine-tuned SmolLM2-135M-Instruct (lazy-loaded)

1. **Base model:** [HuggingFaceTB/SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct). Chosen because it is small enough to be tractable in-browser (~76MB MLC q4 prebuild) and `mlc-ai` already publishes prebuilt MLC versions on Hugging Face.
2. **Fine-tune** on synthetic training data to emit a single tool call with `{ingredient, quantity, unit}` — ingredient must match a King Arthur entry exactly.
3. **Convert** the fine-tuned weights to MLC format using `mlc_llm convert_weight` and `mlc_llm gen_config`, and host them on Hugging Face.
4. **Run in browser** via [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm), inside a Web Worker so generation does not block the main thread.
5. **Post-process** the tool call through the same unit-normalization → King Arthur lookup → grams pipeline as Pipeline A. The LLM only handles the *parsing* step; the conversion math is always deterministic so we can always show the user the verbatim King Arthur source row.

### Evaluation harness

- Use an LLM (`claude -p`) to generate a large corpus of training and test data, balancing easy cases (`1 cup of flour`) with hard cases (`half tsp wheet flour`, `1/3 oz sugar` — should infer fluid ounces; assume volume input).
- Hold out a fixed evaluation set (the LLM never sees this during fine-tuning data generation).
- Score both pipelines on the held-out set: parse accuracy, gram-output accuracy within tolerance, latency.
- Decide based on results whether to ship Pipeline A only, both with B as fallback, or both with user choice.

## Offline & update strategy

A Service Worker is the central piece — it makes the app installable as a PWA and gives us a single place to manage caching for both the static app shell and the model weights.

- **App shell** (HTML, JS bundle, CSS, ingredient JSON, alias JSON, unit table) is cached with a `cache-first, network-revalidate` strategy. After the first load, the app launches instantly and works offline.
- **LLM weights** are large enough to deserve explicit, user-visible handling. We do *not* prefetch them automatically. When the user opts into Pipeline B, the Service Worker streams the MLC model files into the Cache API (or web-llm's built-in IndexedDB cache, whichever integrates more cleanly), with a visible progress indicator. After the download completes once, Pipeline B is offline-capable too.
- **Background updates.** On each launch with network, the Service Worker checks for new versions of the app shell and, separately, of the model weights. New versions install in the background and apply on next launch (no forced reload mid-session).
- **Web Workers** run the actual heavy lifting: Pipeline A in the main thread is fine, but Pipeline B's web-llm runtime runs in a dedicated worker so the main thread stays responsive while the model generates.

## Implementation steps

### 1. Data ingestion

- Build a scraper for the [King Arthur weight chart](https://www.kingarthurbaking.com/learn/ingredient-weight-chart). Deterministic HTML parsing — extract ingredient, volume, ounces, grams. Handle ranges (e.g., "5 to 6 oz") and duplicates (e.g., yeast appears multiple times). Compute g/mL per ingredient using the volume column normalized to mL.
- Use `claude -p` to post-process the scraped list, generating a comprehensive map of shorthands, synonyms, and likely typos → canonical King Arthur ingredient. Commit this map as static JSON.
- Build a static units-of-volume → milliliters table.

### 2. Training data + evaluation set

- Use `claude -p` to generate a balanced corpus: easy → hard, ambiguous units, typos, varied phrasing.
- Reserve a held-out evaluation slice. Track it in version control so eval is reproducible.

### 3. Pipeline A — deterministic parser

- Implement the parser, unit normalizer, alias-aware fuzzy ingredient resolver, and confidence scoring.
- Run against the eval set. Iterate. Track accuracy and latency.

### 4. Pipeline B — fine-tuned LLM

- Fine-tune SmolLM2-135M-Instruct on the training corpus to emit the structured tool call. Use whatever LoRA-friendly tooling is convenient (TRL, Unsloth, etc.).
- Convert fine-tuned weights to MLC format. Verify they load in web-llm in a standalone test page.
- Wire up a Web Worker that hosts the web-llm runtime and exposes a parse RPC.
- Run against the same eval set. Compare with Pipeline A.

### 5. Frontend (Vite)

- Free-form text input, debounced.
- Show grams output as the user types.
- **Transparency panel** (always visible or one click away) showing:
  - Which pipeline produced the answer (and confidence)
  - Detected `{quantity, unit, ingredient}`
  - Volume in mL (if applicable)
  - Top-N candidate ingredient matches with scores
  - The verbatim King Arthur source row (e.g., "1 Cup of All-Purpose Flour = 120 grams") with a link back to the source page
- Service Worker registration; PWA manifest; install prompt.
- Settings panel with an opt-in toggle for "Enable LLM fallback (downloads ~80MB once, then works offline)".
- Mobile-aware layout — input near the bottom of the viewport so it stays visible above the on-screen keyboard.
