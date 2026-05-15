"""
Fine-tune SmolLM2-135M-Instruct on the ingredient-parsing corpus using LoRA + TRL SFTTrainer.

Recommended: run on a GPU machine (CUDA or Apple MPS).
For a quick smoke-test on CPU, set MAX_STEPS=10 and BATCH_SIZE=1.

Usage:
  python finetune/train.py [--smoke-test]
"""

import argparse
import json
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from trl import SFTConfig, SFTTrainer as _SFTTrainer

class SFTTrainer(_SFTTrainer):
    def create_model_card(self, *args, **kwargs):
        pass

ROOT       = Path(__file__).parent.parent
TRAIN_DATA = ROOT / "data" / "finetune-train.jsonl"
EVAL_DATA  = ROOT / "data" / "finetune-eval.jsonl"
OUTPUT_DIR = ROOT / "finetune" / "output"

BASE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"

LORA_CONFIG = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)

def load_dataset(path: Path) -> Dataset:
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    return Dataset.from_list(rows)

def formatting_fn(example):
    """Apply the chat template and return a list of formatted strings."""
    return tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )

parser = argparse.ArgumentParser()
parser.add_argument("--smoke-test", action="store_true", help="Run 10 steps on CPU to verify setup")
args = parser.parse_args()

smoke = args.smoke_test
device = "cpu" if smoke else ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
print(f"Device: {device}  |  smoke-test: {smoke}")

print(f"Loading {BASE_MODEL}…")
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
tokenizer.pad_token = tokenizer.eos_token

model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    dtype=torch.float32 if device == "cpu" else torch.bfloat16,
    device_map=device,
)
model = get_peft_model(model, LORA_CONFIG)
model.print_trainable_parameters()

train_ds = load_dataset(TRAIN_DATA)
eval_ds  = load_dataset(EVAL_DATA)

if smoke:
    train_ds = train_ds.select(range(min(20, len(train_ds))))
    eval_ds  = eval_ds.select(range(min(5,  len(eval_ds))))

sft_config = SFTConfig(
    output_dir=str(OUTPUT_DIR),
    num_train_epochs=1 if smoke else 5,
    max_steps=10 if smoke else -1,
    per_device_train_batch_size=1 if smoke else 4,
    gradient_accumulation_steps=1 if smoke else 4,
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_steps=10,
    logging_steps=5,
    eval_strategy="epoch",
    save_strategy="epoch",
    load_best_model_at_end=True,
    fp16=False,
    bf16=(device != "cpu"),
    report_to="none",
)

trainer = SFTTrainer(
    model=model,
    args=sft_config,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    formatting_func=formatting_fn,
)

print("Training…")
trainer.train()

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
trainer.save_model(str(OUTPUT_DIR))
tokenizer.save_pretrained(str(OUTPUT_DIR))
print(f"Saved to {OUTPUT_DIR}")
