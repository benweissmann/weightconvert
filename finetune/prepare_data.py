"""
Convert data/training.jsonl into chat-format JSONL for SmolLM2-135M-Instruct fine-tuning.

Each example becomes a two-turn conversation:
  user:      the raw ingredient string
  assistant: a JSON tool call  {"ingredient": "...", "quantity": N, "unit": "..."}

The model only needs to learn the *parsing* step — the conversion math stays deterministic
in Pipeline A's post-processor.
"""

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
TRAIN_IN  = ROOT / "data" / "training.jsonl"
EVAL_IN   = ROOT / "data" / "eval.jsonl"
TRAIN_OUT = ROOT / "data" / "finetune-train.jsonl"
EVAL_OUT  = ROOT / "data" / "finetune-eval.jsonl"

SYSTEM_PROMPT = (
    "You are a baking ingredient parser. "
    "Given a raw ingredient string, output a single JSON object with three fields: "
    "\"ingredient\" (the canonical King Arthur Baking ingredient name), "
    "\"quantity\" (a number), and \"unit\" (one of: cup, tablespoon, teaspoon, "
    "fluid_ounce, liter, milliliter, pint, quart, gram, kilogram, ounce, pound). "
    "Output only the JSON object, nothing else."
)

def to_chat(example: dict) -> dict:
    tool_call = json.dumps({
        "ingredient": example["ingredient"],
        "quantity":   example["quantity"],
        "unit":       example["unit"],
    }, separators=(",", ":"))

    return {
        "messages": [
            {"role": "system",    "content": SYSTEM_PROMPT},
            {"role": "user",      "content": example["input"]},
            {"role": "assistant", "content": tool_call},
        ]
    }

def convert(src: Path, dst: Path):
    examples = [json.loads(l) for l in src.read_text().splitlines() if l.strip()]
    converted = [to_chat(e) for e in examples]
    dst.write_text("\n".join(json.dumps(c) for c in converted) + "\n")
    print(f"  {src.name} → {dst.name}: {len(converted)} examples")

print("Converting training data to chat format…")
convert(TRAIN_IN, TRAIN_OUT)
convert(EVAL_IN,  EVAL_OUT)
print("Done.")
