#!/usr/bin/env bash
# Convert fine-tuned LoRA weights to MLC format for web-llm.
#
# Step 1 (merge) runs locally via uv.
# Step 2 (MLC conversion) runs in Docker to avoid native dylib issues.
#
# Prerequisites: Docker must be running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
MERGED_DIR="$ROOT/finetune/merged"
MLC_DIR="$ROOT/finetune/mlc-model"

# ── Step 1: Merge LoRA → base weights (runs locally with uv) ─────────────────
if [ ! -d "$MERGED_DIR" ] || [ ! -f "$MERGED_DIR/config.json" ]; then
  echo "Merging LoRA adapter into base model…"
  uv run python - <<'EOF'
from pathlib import Path
from peft import AutoPeftModelForCausalLM
from transformers import AutoTokenizer

root      = Path(__file__).parent.parent if "__file__" in dir() else Path(".")
lora_dir  = root / "finetune" / "output"
merge_dir = root / "finetune" / "merged"

print(f"Loading LoRA model from {lora_dir}…")
model  = AutoPeftModelForCausalLM.from_pretrained(str(lora_dir))
merged = model.merge_and_unload()
merged.save_pretrained(str(merge_dir))

tokenizer = AutoTokenizer.from_pretrained(str(lora_dir))
tokenizer.save_pretrained(str(merge_dir))
print(f"Merged model saved to {merge_dir}")
EOF
else
  echo "Merged model already exists at $MERGED_DIR — skipping merge."
fi

# ── Step 2: MLC conversion in Docker ─────────────────────────────────────────
echo "Building MLC conversion image (first run takes a few minutes)…"
# linux/amd64 required: mlc.ai only ships x86_64 Linux wheels; Docker Desktop on
# Apple Silicon handles the emulation via Rosetta transparently.
docker build --platform linux/amd64 -t weightconvert-mlc -f "$SCRIPT_DIR/Dockerfile.mlc" "$SCRIPT_DIR"

echo "Converting weights to MLC format…"
mkdir -p "$MLC_DIR"

docker run --rm --platform linux/amd64 \
  -v "$MERGED_DIR:/work/merged" \
  -v "$MLC_DIR:/work/mlc-model" \
  weightconvert-mlc \
  bash -c "
    python -m mlc_llm convert_weight /work/merged \
      --quantization q0f16 \
      --output /work/mlc-model \
    && python -m mlc_llm gen_config /work/merged \
      --quantization q0f16 \
      --conv-template chatml \
      --output /work/mlc-model
  "

echo ""
echo "MLC model ready at: $MLC_DIR"
echo "The Vite dev server serves it at /model/ automatically."
echo "For production, upload to S3 and set VITE_MODEL_BASE_URL in .env.production.local."
