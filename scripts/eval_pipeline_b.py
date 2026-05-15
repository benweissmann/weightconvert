"""
Evaluate the fine-tuned Pipeline B model against data/eval.jsonl.
Produces the same metrics as scripts/eval.js so results are directly comparable.

The model's ingredient output is post-processed through a fuzzy resolver (same as
Pipeline A) so near-miss names like "Sticky Bun Topping" resolve to "Sticky Bun Sugar".
This matches the intended runtime architecture.

Usage:
  uv run python scripts/eval_pipeline_b.py
  uv run python scripts/eval_pipeline_b.py --model finetune/output   # default
  uv run python scripts/eval_pipeline_b.py --model finetune/merged   # post-merge
  uv run python scripts/eval_pipeline_b.py --no-fuzzy                # raw exact-match only
"""

import argparse
import json
import re
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).parent.parent

SYSTEM_PROMPT = (
    "You are a baking ingredient parser. "
    "Given a raw ingredient string, output a single JSON object with three fields: "
    '"ingredient" (the canonical King Arthur Baking ingredient name), '
    '"quantity" (a number), and "unit" (one of: cup, tablespoon, teaspoon, '
    "fluid_ounce, liter, milliliter, pint, quart, gram, kilogram, ounce, pound, each). "
    "Output only the JSON object, nothing else."
)

GRAM_TOLERANCE = 0.05

parser = argparse.ArgumentParser()
parser.add_argument("--model",    default="finetune/output")
parser.add_argument("--no-fuzzy", action="store_true", help="Skip fuzzy post-processing")
args = parser.parse_args()

# ─── Load static data ────────────────────────────────────────────────────────

ingredients_db = json.loads((ROOT / "data" / "ingredients.json").read_text())
units_db       = json.loads((ROOT / "data" / "units.json").read_text())
aliases_db     = json.loads((ROOT / "data" / "aliases.json").read_text())

canonical_names = {i["name"] for i in ingredients_db}

# ─── Fuzzy resolver (mirrors pipeline-a.js logic) ────────────────────────────

def trigrams(s: str) -> set:
    p = "  " + s + "  "
    return {p[i:i+3] for i in range(len(p) - 2)}

def dice(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))

_ing_index = None
def get_index():
    global _ing_index
    if _ing_index is None:
        _ing_index = [(i, trigrams(i["name"].lower())) for i in ingredients_db]
    return _ing_index

def fuzzy_resolve(name: str) -> str | None:
    """Given a model-output ingredient name (possibly hallucinated), return
    the closest canonical name, or None if confidence is too low."""
    name_lower = name.lower().strip()

    # 1. Exact match
    for i in ingredients_db:
        if i["name"].lower() == name_lower:
            return i["name"]

    # 2. Alias lookup
    if name_lower in aliases_db:
        return aliases_db[name_lower]

    # 3. Trigram fuzzy
    q_tg = trigrams(name_lower)
    scored = [(i["name"], dice(q_tg, tg)) for i, tg in get_index()]
    scored.sort(key=lambda x: x[1], reverse=True)
    if scored and scored[0][1] >= 0.35:
        return scored[0][0]

    return None

# ─── Grams computation ────────────────────────────────────────────────────────

def compute_grams(ingredient_name: str, unit: str, quantity: float) -> float | None:
    ing = next((i for i in ingredients_db if i["name"] == ingredient_name), None)
    if not ing or quantity is None:
        return None

    unit_entry = units_db["lookup"].get(unit)

    if unit_entry and unit_entry.get("ml") and ing.get("gPerMl"):
        return round(quantity * unit_entry["ml"] * ing["gPerMl"], 1)
    if unit_entry and unit_entry.get("massG"):
        return round(quantity * unit_entry["massG"], 1)
    # Per-item (eggs, etc.)
    if not unit_entry and ing.get("perItem") and ing.get("gramsEach"):
        return round(quantity * ing["gramsEach"], 1)
    return None

# ─── Load model ──────────────────────────────────────────────────────────────

model_path = ROOT / args.model
if not model_path.exists():
    print(f"Model not found at {model_path}. Run 'uv run python finetune/train.py' first.")
    raise SystemExit(1)

device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
print(f"Loading model from {model_path} on {device}…")
print(f"Fuzzy post-processing: {'OFF (--no-fuzzy)' if args.no_fuzzy else 'ON'}\n")

tokenizer = AutoTokenizer.from_pretrained(str(model_path))
model = AutoModelForCausalLM.from_pretrained(
    str(model_path),
    dtype=torch.float16 if device != "cpu" else torch.float32,
    device_map=device,
)
model.eval()

eval_examples = [
    json.loads(l)
    for l in (ROOT / "data" / "eval.jsonl").read_text().splitlines()
    if l.strip()
]

print(f"Evaluating {len(eval_examples)} examples…\n")

parse_correct = 0
gram_correct  = 0
fuzzy_assists = 0  # cases where fuzzy post-processing saved a wrong raw name
failures      = []
latencies     = []

for example in eval_examples:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": example["input"]},
    ]
    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(prompt, return_tensors="pt").to(device)

    t0 = time.perf_counter()
    with torch.no_grad():
        output = model.generate(
            **inputs,
            max_new_tokens=80,
            do_sample=False,
            temperature=None,
            top_p=None,
            pad_token_id=tokenizer.eos_token_id,
        )
    latency_ms = (time.perf_counter() - t0) * 1000
    latencies.append(latency_ms)

    new_tokens = output[0][inputs["input_ids"].shape[1]:]
    raw = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    json_str = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.M)
    json_str = re.sub(r"```\s*$", "", json_str).strip()

    parsed = None
    try:
        parsed = json.loads(json_str)
    except Exception:
        pass

    resolved_name = None
    if parsed and parsed.get("ingredient"):
        raw_name = parsed["ingredient"]
        if raw_name in canonical_names:
            resolved_name = raw_name
        elif not args.no_fuzzy:
            resolved_name = fuzzy_resolve(raw_name)
            if resolved_name and resolved_name != raw_name:
                fuzzy_assists += 1

    quantity = float(parsed["quantity"]) if parsed and parsed.get("quantity") is not None else None
    unit     = parsed.get("unit", "") if parsed else ""

    ingredient_match = resolved_name == example["ingredient"]
    grams_got = compute_grams(resolved_name, unit, quantity) if resolved_name else None
    gram_match = (
        grams_got is not None and
        abs(grams_got - example["grams"]) / max(example["grams"], 1e-6) <= GRAM_TOLERANCE
    )

    if ingredient_match:
        parse_correct += 1
    if gram_match:
        gram_correct += 1

    if not ingredient_match or not gram_match:
        failures.append({
            "input":    example["input"],
            "expected": {"ingredient": example["ingredient"], "grams": example["grams"]},
            "got":      {"raw_name": parsed.get("ingredient") if parsed else None,
                         "resolved": resolved_name, "grams": grams_got},
        })

total     = len(eval_examples)
parse_acc = parse_correct / total * 100
gram_acc  = gram_correct  / total * 100
p50 = sorted(latencies)[len(latencies) // 2]
p95 = sorted(latencies)[int(len(latencies) * 0.95)]

print(f"── Pipeline B Evaluation ({args.model}) {'[exact]' if args.no_fuzzy else '[+fuzzy]'} ──")
print(f"Total examples  : {total}")
print(f"Parse accuracy  : {parse_acc:.1f}% ({parse_correct}/{total})")
print(f"Gram accuracy   : {gram_acc:.1f}% ({gram_correct}/{total}, ±{GRAM_TOLERANCE*100:.0f}%)")
print(f"Latency         : p50={p50:.0f}ms  p95={p95:.0f}ms  (on {device})")
if not args.no_fuzzy:
    print(f"Fuzzy assists   : {fuzzy_assists} ({fuzzy_assists/total*100:.1f}% of examples saved by post-processing)")
print("──────────────────────────────────────────────────────────────\n")

print(f"── Pipeline A baseline ────────────────────────────────────────")
print(f"Parse accuracy  : 94.4% (1416/1500)")
print(f"Gram accuracy   : 95.3% (1429/1500, ±5%)")
print(f"Latency         : <1ms (deterministic)")
print(f"──────────────────────────────────────────────────────────────\n")

if failures:
    print(f"First 10 failures:")
    for f in failures[:10]:
        print(f'  Input: "{f["input"]}"')
        print(f'    Expected : {f["expected"]["ingredient"]} → {f["expected"]["grams"]}g')
        raw_n = f["got"]["raw_name"]
        res_n = f["got"]["resolved"]
        if raw_n != res_n:
            print(f'    Model out: {raw_n!r} → fuzzy→ {res_n} → {f["got"]["grams"]}g')
        else:
            print(f'    Got       : {res_n} → {f["got"]["grams"]}g')
