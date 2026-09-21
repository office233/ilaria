"""prepare_corpus.py — download, clean, and format training corpora for Ilaria.

Supports:
  1. TinyStories (roneneldan/TinyStories) — high-quality simple narrative English,
     proven recipe for coherence at 10M–50M parameter scale.
  2. Romanian Wikipedia (wikimedia/wikipedia, 20231101.ro) — encyclopedic Romanian knowledge.
  3. Optional English Wikipedia subset or custom text files.

Outputs clean JSONL files where each line is:
    {"text": "..."}

Usage:
    python forge/prepare_corpus.py --out-dir ./data/corpus --tinystories --wiki-ro
    python forge/prepare_corpus.py --tinystories --max-samples 50000
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from typing import Generator, Iterable


def clean_text(text: str, min_len: int = 20, max_len: int = 3000) -> str:
    """Normalize whitespace and strip useless formatting while retaining punctuation."""
    if not text:
        return ""
    # Normalize excessive newlines/spaces
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    if len(text) < min_len:
        return ""
    if len(text) > max_len:
        # Cut at word or sentence boundary near max_len
        cut = text[:max_len]
        last_punct = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind("? "), cut.rfind("! "))
        if last_punct > min_len:
            text = cut[:last_punct + 1]
        else:
            last_space = cut.rfind(" ")
            text = cut[:last_space] if last_space > min_len else cut
    return text.strip()


def stream_tinystories(max_samples: int | None = None) -> Generator[str, None, None]:
    """Stream texts from HuggingFace roneneldan/TinyStories."""
    try:
        from datasets import load_dataset
    except ImportError:
        print("[prepare_corpus] ERROR: 'datasets' package not installed. Run: pip install datasets")
        return

    print("[prepare_corpus] loading TinyStories from HuggingFace...")
    ds = load_dataset("roneneldan/TinyStories", split="train", streaming=True)
    count = 0
    for row in ds:
        t = clean_text(row.get("text", ""))
        if t:
            yield t
            count += 1
            if max_samples and count >= max_samples:
                break


def stream_wiki_ro(max_samples: int | None = None) -> Generator[str, None, None]:
    """Stream Romanian Wikipedia articles."""
    try:
        from datasets import load_dataset
    except ImportError:
        print("[prepare_corpus] ERROR: 'datasets' package not installed. Run: pip install datasets")
        return

    print("[prepare_corpus] loading Romanian Wikipedia from HuggingFace...")
    ds = load_dataset("wikimedia/wikipedia", "20231101.ro", split="train", streaming=True)
    count = 0
    for row in ds:
        full_text = row.get("text", "")
        # Break long Wikipedia articles into coherent paragraphs/chunks
        paragraphs = full_text.split("\n\n")
        chunk = []
        chunk_len = 0
        for p in paragraphs:
            p = p.strip()
            if not p or len(p) < 30 or p.startswith("=="):
                continue
            chunk.append(p)
            chunk_len += len(p)
            if chunk_len >= 300:
                joined = clean_text("\n\n".join(chunk))
                if joined:
                    yield joined
                    count += 1
                    if max_samples and count >= max_samples:
                        return
                chunk = []
                chunk_len = 0
        if chunk:
            joined = clean_text("\n\n".join(chunk))
            if joined:
                yield joined
                count += 1
                if max_samples and count >= max_samples:
                    return


def write_jsonl(texts: Iterable[str], path: str, desc: str = "") -> int:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    count = 0
    with open(path, "w", encoding="utf-8") as f:
        for t in texts:
            f.write(json.dumps({"text": t}, ensure_ascii=False) + "\n")
            count += 1
            if count % 10000 == 0:
                print(f"  [{desc}] written {count:,} samples...")
    print(f"[prepare_corpus] finished {desc}: {count:,} lines -> {path}")
    return count


def main():
    ap = argparse.ArgumentParser(description="Download and format training datasets for Ilaria.")
    ap.add_argument("--out-dir", default="./data/corpus", help="directory to write JSONL files")
    ap.add_argument("--tinystories", action="store_true", default=True, help="include TinyStories")
    ap.add_argument("--no-tinystories", action="store_false", dest="tinystories")
    ap.add_argument("--wiki-ro", action="store_true", default=True, help="include Romanian Wikipedia")
    ap.add_argument("--no-wiki-ro", action="store_false", dest="wiki_ro")
    ap.add_argument("--max-tinystories", type=int, default=300000, help="max TinyStories samples")
    ap.add_argument("--max-wiki-ro", type=int, default=100000, help="max Romanian Wikipedia chunks")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--merge", action="store_true", default=True, help="create a merged all.jsonl file")
    args = ap.parse_args()

    random.seed(args.seed)
    os.makedirs(args.out_dir, exist_ok=True)
    all_files = []

    if args.tinystories:
        ts_path = os.path.join(args.out_dir, "tinystories.jsonl")
        print(f"\n--- Processing TinyStories (up to {args.max_tinystories:,} samples) ---")
        cnt = write_jsonl(stream_tinystories(args.max_tinystories), ts_path, "TinyStories")
        if cnt > 0:
            all_files.append(ts_path)

    if args.wiki_ro:
        ro_path = os.path.join(args.out_dir, "wikipedia_ro.jsonl")
        print(f"\n--- Processing Wikipedia RO (up to {args.max_wiki_ro:,} samples) ---")
        cnt = write_jsonl(stream_wiki_ro(args.max_wiki_ro), ro_path, "Wikipedia RO")
        if cnt > 0:
            all_files.append(ro_path)

    if args.merge and all_files:
        merged_path = os.path.join(args.out_dir, "all.jsonl")
        print(f"\n--- Creating merged corpus: {merged_path} ---")
        total = 0
        with open(merged_path, "w", encoding="utf-8") as out_f:
            for fpath in all_files:
                with open(fpath, "r", encoding="utf-8") as in_f:
                    for line in in_f:
                        out_f.write(line)
                        total += 1
        print(f"[prepare_corpus] merged total: {total:,} lines -> {merged_path}")

    print("\n[prepare_corpus] Complete! You can now tokenize with:")
    print("  go run ./cmd/corpus-tokenize -tokenizer <tokenizer.json> -in ./data/corpus/all.jsonl -out ./data/corpus/train_stream")


if __name__ == "__main__":
    main()
