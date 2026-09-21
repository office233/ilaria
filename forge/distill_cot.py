"""distill_cot.py — generate Chain-of-Thought (CoT) reasoning data from a teacher model.

Produces training data formatted for Ilaria:
    {"text": "<question>\nLet's think step by step:\n<reasoning>\n\nTherefore, the answer is: <final_answer>"}

Backends:
    1. OpenAI-compatible API (--api-url, --api-key, --model)
    2. Anthropic API (--anthropic-key, --anthropic-model)
    3. Local HuggingFace model (--local-model, e.g. Qwen/Qwen2.5-3B-Instruct or DeepSeek-R1-Distill-Qwen-1.5B)

Usage:
    # OpenAI-compatible / local server (vLLM, Ollama, LM Studio):
    python forge/distill_cot.py --in questions.jsonl --out cot_data.jsonl --api-url http://localhost:11434/v1 --model qwen2.5:3b

    # Local HuggingFace on Colab H100:
    python forge/distill_cot.py --in questions.jsonl --out cot_data.jsonl --local-model deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional


SYSTEM_PROMPT = (
    "You are an expert tutor. When answering a question or solving a problem, always break down your "
    "reasoning step by step. Explain your thought process clearly before providing the concise final answer."
)


def format_cot_prompt(question: str) -> str:
    return f"{question}\nLet's think step by step:"


def parse_qa_input(line: str) -> Optional[str]:
    try:
        data = json.loads(line)
    except Exception:
        return None

    if "question" in data:
        return data["question"].strip()
    elif "instruction" in data:
        inp = data.get("input", "").strip()
        inst = data["instruction"].strip()
        return f"{inst}\n{inp}".strip() if inp else inst
    elif "prompt" in data:
        return data["prompt"].strip()
    elif "text" in data and len(data["text"]) < 500:
        return data["text"].strip()
    return None


class OpenAITeacher:
    def __init__(self, api_url: str, api_key: str, model: str):
        try:
            import requests
        except ImportError:
            sys.exit("Error: 'requests' is required for OpenAI teacher backend (pip install requests)")
        self.requests = requests
        self.api_url = api_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key or "sk-dummy"
        self.model = model

    def query(self, prompt: str) -> Optional[str]:
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.6,
            "max_tokens": 1024,
        }
        for attempt in range(3):
            try:
                resp = self.requests.post(self.api_url, headers=headers, json=payload, timeout=60)
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"].strip()
                elif resp.status_code == 429:
                    time.sleep(2 ** attempt * 3)
                else:
                    print(f"[teacher] warning: status {resp.status_code}: {resp.text[:200]}")
            except Exception as e:
                time.sleep(2 ** attempt * 2)
        return None


class LocalHFTeacher:
    def __init__(self, model_id: str, device: str = "cuda"):
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
        except ImportError:
            sys.exit("Error: 'torch' and 'transformers' are required (pip install transformers accelerate)")

        print(f"[local-teacher] loading model: {model_id} onto {device}...")
        dtype = torch.bfloat16 if (torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
        self.pipe = pipeline(
            "text-generation",
            model=model_id,
            torch_dtype=dtype,
            device_map="auto" if device == "cuda" else None,
        )

    def query(self, prompt: str) -> Optional[str]:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        try:
            outputs = self.pipe(
                messages,
                max_new_tokens=768,
                temperature=0.6,
                top_p=0.9,
                do_sample=True,
            )
            resp = outputs[0]["generated_text"]
            # Pipeline returns list of messages; grab last assistant response
            if isinstance(resp, list):
                return resp[-1]["content"].strip()
            elif isinstance(resp, str):
                return resp.strip()
        except Exception as e:
            print(f"[local-teacher] error: {e}")
        return None


def main():
    ap = argparse.ArgumentParser(description="Distill Chain-of-Thought reasoning into JSONL.")
    ap.add_argument("--in", dest="in_file", required=True, help="input questions JSONL")
    ap.add_argument("--out", dest="out_file", default="./data/corpus/cot_distilled.jsonl")
    ap.add_argument("--api-url", default="", help="OpenAI-compatible URL (e.g. http://localhost:8000/v1)")
    ap.add_argument("--api-key", default="", help="API key for teacher")
    ap.add_argument("--model", default="gpt-3.5-turbo", help="teacher model name")
    ap.add_argument("--local-model", default="", help="local HuggingFace model identifier for Colab/local GPU")
    ap.add_argument("--max-items", type=int, default=0, help="max items to process (0 = all)")
    ap.add_argument("--sleep-delay", type=float, default=0.2, help="delay between API requests in seconds")
    args = ap.parse_args()

    teacher = None
    if args.local_model:
        teacher = LocalHFTeacher(args.local_model)
    elif args.api_url:
        teacher = OpenAITeacher(args.api_url, args.api_key, args.model)
    else:
        sys.exit("Error: must specify either --api-url or --local-model")

    os.makedirs(os.path.dirname(os.path.abspath(args.out_file)), exist_ok=True)

    # Resume support: see what questions were already answered
    seen_questions = set()
    if os.path.exists(args.out_file):
        with open(args.out_file, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    t = obj.get("text", "")
                    q = t.split("\nLet's think step by step:")[0].strip()
                    if q:
                        seen_questions.add(q)
                except Exception:
                    pass
        print(f"[distill_cot] resumed: {len(seen_questions)} questions already distilled in {args.out_file}")

    with open(args.in_file, "r", encoding="utf-8") as f_in, \
         open(args.out_file, "a", encoding="utf-8") as f_out:

        processed = 0
        success = 0
        for line in f_in:
            q = parse_qa_input(line)
            if not q or q in seen_questions:
                continue

            reasoning = teacher.query(q)
            if reasoning:
                formatted_text = f"{q}\nLet's think step by step:\n{reasoning}"
                f_out.write(json.dumps({"text": formatted_text}, ensure_ascii=False) + "\n")
                f_out.flush()
                seen_questions.add(q)
                success += 1
                if success % 20 == 0:
                    print(f"[distill_cot] successfully distilled {success} samples...")

            processed += 1
            if args.max_items and processed >= args.max_items:
                break
            if args.sleep_delay > 0:
                time.sleep(args.sleep_delay)

    print(f"\n[distill_cot] Finished: {success} new reasoning traces written to {args.out_file}")


if __name__ == "__main__":
    main()
