# WeightConvert

Converts ingredient quantities to grams. Two parsing pipelines: a fast deterministic parser and an in-browser fine-tuned language model.

Weight data sourced from: https://www.kingarthurbaking.com/learn/ingredient-weight-chart

## Setup

```bash
pnpm install      # JS dependencies
uv sync           # Python dependencies (fine-tuning only)
```

Requires Node ≥ 26, pnpm ≥ 11, Python ≥ 3.11.

## Development

```bash
pnpm dev          # Vite dev server at http://localhost:5173
```

Data files are served from `data/` at `/data/`, model files from `finetune/mlc-model/` at `/model/`.

## Data pipeline

| Step | Command | Output | Docs |
|---|---|---|---|
| Scrape King Arthur | `pnpm run build:scrape` | `data/ingredients.json` | [SCRAPING.md](docs/SCRAPING.md) |
| Build units table | `pnpm run build:units` | `data/units.json` | [SCRAPING.md](docs/SCRAPING.md) |
| Generate aliases | `pnpm run build:aliases` | `data/aliases.json` | [GEN_ALIASES.md](docs/GEN_ALIASES.md) |
| Generate training data | `node scripts/gen-training-programmatic.js` | `data/training.jsonl`, `data/eval.jsonl` | [TRAINING_DATA.md](docs/TRAINING_DATA.md) |
| Generate hard examples | `node scripts/gen-training-hard.js` | appended to training/eval | [TRAINING_DATA.md](docs/TRAINING_DATA.md) |

Run `pnpm eval` to score the deterministic parser against `data/eval.jsonl`.

## Fine-tuning Pipeline B

```bash
uv run python finetune/prepare_data.py   # convert to chat format
uv run python finetune/train.py          # fine-tune SmolLM2-135M
bash finetune/convert_to_mlc.sh          # convert to MLC for browser
```

See [FINETUNE.md](docs/FINETUNE.md) for full instructions including model conversion prerequisites.

## Deployment

Push to `main` → GitHub Actions builds and deploys to [convert.fuzzy.codes](https://convert.fuzzy.codes).

Data and model files are served from S3 separately from the Pages bundle.

See [DEPLOY.md](docs/DEPLOY.md) for:
- GitHub repo and Pages configuration
- S3 CORS policy
- Uploading updated data/model files
- Deploying a new model version
