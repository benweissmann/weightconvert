# Fine-tuning Pipeline B

Fine-tunes SmolLM2-135M-Instruct on the ingredient-parsing corpus using LoRA, then converts the result to MLC format for in-browser inference via web-llm.

## Prerequisites

- Python ≥ 3.11
- [uv](https://docs.astral.sh/uv/)
- A GPU is strongly recommended (CUDA or Apple MPS). The model is 135M params — any GPU with 4GB+ VRAM is sufficient. CPU training works but is very slow.

## Setup

```bash
uv sync
```

This creates `.venv` and installs all dependencies pinned in `uv.lock`.

## Steps

### 1. Prepare training data

Converts `data/training.jsonl` and `data/eval.jsonl` into chat-format JSONL expected by the SFTTrainer:

```bash
uv run python finetune/prepare_data.py
```

Output: `data/finetune-train.jsonl`, `data/finetune-eval.jsonl`

### 2. Smoke-test (optional)

Runs 10 training steps on CPU to verify the pipeline end-to-end before committing to a full GPU run:

```bash
uv run python finetune/train.py --smoke-test
```

Completes in ~2 minutes. Saves a checkpoint to `finetune/output/`.

### 3. Full fine-tuning

```bash
uv run python finetune/train.py
```

- **5 epochs**, LoRA (r=16, α=32) on all attention projections
- Saves the best checkpoint (by eval loss) to `finetune/output/`
- On a modern GPU: ~5–10 minutes

To regenerate more training data before fine-tuning, see [TRAINING_DATA.md](TRAINING_DATA.md).

### 4. Convert to MLC format

Merges the LoRA adapter into the base weights and quantizes to q4f16 for web-llm.
Requires Docker (to avoid native dylib issues with mlc-llm on macOS). The merge step
runs locally via uv; the MLC conversion runs in a Linux container:

```bash
bash finetune/convert_to_mlc.sh
```

The first run builds the Docker image (~2 min). Subsequent runs reuse it.

Output: `finetune/mlc-model/` — the quantized weights and MLC config ready for the browser.

## Publishing model releases

Fine-tuned model weights are **not committed to git** (see `.gitignore`). They are published as GitHub releases using a separate `model-vN` tag scheme, kept distinct from code releases (`vN.N.N`).

To publish a new model release:

```bash
# Tag the model release (separate from code version tags)
git tag model-v1
git push origin model-v1

# Create a GitHub release and attach the MLC model files
gh release create model-v1 \
  --title "Model v1 — SmolLM2-135M fine-tuned" \
  --notes "Fine-tuned on 272 training examples. See docs/FINETUNE.md." \
  finetune/mlc-model/*

# Update MLC_MODEL_URL in src/worker-b.js:
# "https://github.com/YOUR_ORG/weightconvert/releases/download/model-v1/"
```

The ~76MB of MLC weight files are served directly from GitHub release assets, which support HTTP range requests — required by web-llm to stream weights progressively into the browser cache.
