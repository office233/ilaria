#!/usr/bin/env python3
"""
Ilaria â€” Hugging Face Corpus Downloader & Converter

Downloads datasets from Hugging Face and converts them to JSONL format
compatible with cortex-train.

Supported formats:
  {"text": "..."}                          â€” passive sequential learning
  {"instruction": "...", "response": "..."} â€” active Q&A learning

Usage:
  python download_hf_corpus.py --all         # Download everything
  python download_hf_corpus.py --wiki-ro     # Just Romanian Wikipedia
  python download_hf_corpus.py --wiki-en     # Just English Wikipedia (subset)
  python download_hf_corpus.py --alpaca      # Stanford Alpaca instructions
  python download_hf_corpus.py --dolly       # Databricks Dolly
  python download_hf_corpus.py --slimorca    # SlimOrca instructions
"""

import argparse
import json
import os
import sys

# Ensure stdout supports emojis on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import re
import time
from pathlib import Path

# Target directory for corpus files
CORPUS_DIR = Path(__file__).resolve().parent.parent / "data" / "corpus"

def clean_text(text: str) -> str:
    """Clean text for cortex training â€” remove wiki markup, extra whitespace."""
    if not text or not text.strip():
        return ""
    # Remove URLs
    text = re.sub(r'https?://\S+', '', text)
    # Remove wiki-style references like [1], [2], etc.
    text = re.sub(r'\[\d+\]', '', text)
    # Remove excessive whitespace
    text = re.sub(r'\s+', ' ', text)
    # Remove lines that are just headers or too short
    text = text.strip()
    return text


def split_into_sentences(text: str, max_words: int = 50) -> list[str]:
    """Split text into sentence-like chunks for training."""
    # Split on sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    result = []
    for s in sentences:
        s = s.strip()
        words = s.split()
        if len(words) < 3:  # Skip very short fragments
            continue
        if len(words) > max_words:
            # Split long sentences into chunks
            for i in range(0, len(words), max_words):
                chunk = ' '.join(words[i:i+max_words])
                if len(chunk.split()) >= 3:
                    result.append(chunk)
        else:
            result.append(s)
    return result


def download_wikipedia_ro(max_articles: int = 50000):
    """Download Romanian Wikipedia and convert to JSONL."""
    from datasets import load_dataset
    
    output_path = CORPUS_DIR / "wikipedia_ro.jsonl"
    print(f"\nđź“Ą Downloading Romanian Wikipedia...")
    print(f"   Target: {output_path}")
    print(f"   Max articles: {max_articles}")
    
    ds = load_dataset("wikimedia/wikipedia", "20231101.ro", split="train", trust_remote_code=False)
    
    count = 0
    total_sentences = 0
    
    with open(output_path, 'w', encoding='utf-8') as f:
        for i, article in enumerate(ds):
            if i >= max_articles:
                break
            
            text = clean_text(article.get('text', ''))
            if not text or len(text) < 50:
                continue
            
            sentences = split_into_sentences(text)
            for sentence in sentences:
                entry = {"text": sentence}
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
                total_sentences += 1
            
            count += 1
            if count % 5000 == 0:
                print(f"   đź“Š Processed {count} articles, {total_sentences} sentences...")
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   âś… Wikipedia RO: {count} articles â†’ {total_sentences} sentences ({size_mb:.1f} MB)")
    return total_sentences


def download_wikipedia_en(max_articles: int = 100000):
    """Download English Wikipedia subset and convert to JSONL."""
    from datasets import load_dataset
    
    output_path = CORPUS_DIR / "wikipedia_en.jsonl"
    print(f"\nđź“Ą Downloading English Wikipedia (subset)...")
    print(f"   Target: {output_path}")
    print(f"   Max articles: {max_articles}")
    
    ds = load_dataset("wikimedia/wikipedia", "20231101.en", split="train", 
                       trust_remote_code=False, streaming=True)
    
    count = 0
    total_sentences = 0
    
    with open(output_path, 'w', encoding='utf-8') as f:
        for article in ds:
            if count >= max_articles:
                break
            
            text = clean_text(article.get('text', ''))
            if not text or len(text) < 100:
                continue
            
            sentences = split_into_sentences(text)
            for sentence in sentences:
                entry = {"text": sentence}
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
                total_sentences += 1
            
            count += 1
            if count % 10000 == 0:
                print(f"   đź“Š Processed {count} articles, {total_sentences} sentences...")
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   âś… Wikipedia EN: {count} articles â†’ {total_sentences} sentences ({size_mb:.1f} MB)")
    return total_sentences


def download_wikipedia_simple(max_articles: int = 200000):
    """Download Wikipedia Simple English â€” perfect for small models.

    Simple Wikipedia uses a controlled vocabulary and shorter sentences,
    giving cleaner training signal than full Wikipedia for a 5-50M model.
    Total ~170K articles; we stream so we can cap at any size.
    """
    from datasets import load_dataset

    output_path = CORPUS_DIR / "wikipedia_simple.jsonl"
    print(f"\n[*] Downloading Wikipedia Simple English...")
    print(f"   Target: {output_path}")
    print(f"   Max articles: {max_articles}")

    ds = load_dataset("wikimedia/wikipedia", "20231101.simple", split="train",
                      trust_remote_code=False, streaming=True)

    count = 0
    total_sentences = 0

    with open(output_path, 'w', encoding='utf-8') as f:
        for article in ds:
            if count >= max_articles:
                break
            text = clean_text(article.get('text', ''))
            if not text or len(text) < 100:
                continue
            sentences = split_into_sentences(text)
            for sentence in sentences:
                entry = {"text": sentence}
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
                total_sentences += 1
            count += 1
            if count % 5000 == 0:
                print(f"   [..] Processed {count} articles, {total_sentences} sentences...")

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   [OK] Wikipedia Simple: {count} articles -> {total_sentences} sentences ({size_mb:.1f} MB)")
    return total_sentences


def download_alpaca():
    """Download Stanford Alpaca 52K instructions."""
    from datasets import load_dataset
    
    output_path = CORPUS_DIR / "alpaca.jsonl"
    print(f"\nđź“Ą Downloading Stanford Alpaca (52K instructions)...")
    
    ds = load_dataset("tatsu-lab/alpaca", split="train", trust_remote_code=False)
    
    count = 0
    with open(output_path, 'w', encoding='utf-8') as f:
        for item in ds:
            instruction = item.get('instruction', '').strip()
            inp = item.get('input', '').strip()
            output = item.get('output', '').strip()
            
            if not instruction or not output:
                continue
            
            # Combine instruction + input if present
            if inp:
                full_instruction = f"{instruction} {inp}"
            else:
                full_instruction = instruction
            
            entry = {"instruction": full_instruction, "response": output}
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
            count += 1
            
            # Also add the output as passive text for vocabulary building
            for sentence in split_into_sentences(output):
                text_entry = {"text": sentence}
                f.write(json.dumps(text_entry, ensure_ascii=False) + '\n')
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   âś… Alpaca: {count} instruction pairs ({size_mb:.1f} MB)")
    return count


def download_dolly():
    """Download Databricks Dolly 15K instructions."""
    from datasets import load_dataset
    
    output_path = CORPUS_DIR / "dolly.jsonl"
    print(f"\nđź“Ą Downloading Databricks Dolly (15K instructions)...")
    
    ds = load_dataset("databricks/databricks-dolly-15k", split="train", trust_remote_code=False)
    
    count = 0
    with open(output_path, 'w', encoding='utf-8') as f:
        for item in ds:
            instruction = item.get('instruction', '').strip()
            response = item.get('response', '').strip()
            context = item.get('context', '').strip()
            
            if not instruction or not response:
                continue
            
            if context:
                full_instruction = f"{instruction} Context: {context}"
            else:
                full_instruction = instruction
            
            entry = {"instruction": full_instruction, "response": response}
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
            count += 1
            
            # Also add passive text
            for sentence in split_into_sentences(response):
                text_entry = {"text": sentence}
                f.write(json.dumps(text_entry, ensure_ascii=False) + '\n')
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   âś… Dolly: {count} instruction pairs ({size_mb:.1f} MB)")
    return count


def download_slimorca():
    """Download Open-Orca SlimOrca (~518K instructions)."""
    from datasets import load_dataset
    
    output_path = CORPUS_DIR / "slimorca.jsonl"
    print(f"\nđź“Ą Downloading SlimOrca (518K instructions)...")
    print(f"   âš ď¸Ź  This is a large dataset, may take a while...")
    
    ds = load_dataset("Open-Orca/SlimOrca", split="train", trust_remote_code=False)
    
    count = 0
    with open(output_path, 'w', encoding='utf-8') as f:
        for item in ds:
            conversations = item.get('conversations', [])
            if len(conversations) < 2:
                continue
            
            # Extract human/gpt turns
            instruction = None
            response = None
            for turn in conversations:
                role = turn.get('from', '')
                value = turn.get('value', '').strip()
                if role == 'human' and not instruction:
                    instruction = value
                elif role == 'gpt' and instruction and not response:
                    response = value
            
            if not instruction or not response:
                continue
            
            entry = {"instruction": instruction, "response": response}
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
            count += 1
            
            # Add response as passive text too
            for sentence in split_into_sentences(response):
                text_entry = {"text": sentence}
                f.write(json.dumps(text_entry, ensure_ascii=False) + '\n')
            
            if count % 50000 == 0:
                print(f"   đź“Š Processed {count} conversations...")
    
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   âś… SlimOrca: {count} instruction pairs ({size_mb:.1f} MB)")
    return count


def print_summary():
    """Print a summary of all corpus files."""
    print(f"\n{'='*60}")
    print(f"đź“š CORPUS SUMMARY â€” {CORPUS_DIR}")
    print(f"{'='*60}")
    
    total_size = 0
    total_lines = 0
    
    for f in sorted(CORPUS_DIR.glob("*.jsonl")):
        size = f.stat().st_size
        lines = sum(1 for _ in open(f, encoding='utf-8'))
        total_size += size
        total_lines += lines
        size_mb = size / (1024 * 1024)
        print(f"   đź“„ {f.name:<30} {lines:>10,} lines  {size_mb:>8.1f} MB")
    
    total_mb = total_size / (1024 * 1024)
    print(f"{'='*60}")
    print(f"   TOTAL: {total_lines:>10,} lines  {total_mb:>8.1f} MB")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Download HuggingFace datasets for Ilaria")
    parser.add_argument("--all", action="store_true", help="Download all datasets")
    parser.add_argument("--wiki-ro", action="store_true", help="Romanian Wikipedia")
    parser.add_argument("--wiki-en", action="store_true", help="English Wikipedia (100K articles)")
    parser.add_argument("--wiki-simple", action="store_true", help="Wikipedia Simple English (~170K articles, perfect for small models)")
    parser.add_argument("--alpaca", action="store_true", help="Stanford Alpaca 52K")
    parser.add_argument("--dolly", action="store_true", help="Databricks Dolly 15K")
    parser.add_argument("--slimorca", action="store_true", help="Open-Orca SlimOrca 518K")
    parser.add_argument("--wiki-ro-max", type=int, default=50000, help="Max RO Wikipedia articles")
    parser.add_argument("--wiki-en-max", type=int, default=100000, help="Max EN Wikipedia articles")
    parser.add_argument("--wiki-simple-max", type=int, default=200000, help="Max Simple Wikipedia articles")
    parser.add_argument("--summary", action="store_true", help="Just print corpus summary")
    args = parser.parse_args()
    
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    
    if args.summary:
        print_summary()
        return
    
    if not any([args.all, args.wiki_ro, args.wiki_en, args.wiki_simple, args.alpaca, args.dolly, args.slimorca]):
        print("No dataset selected. Use --help for options, or --all to download everything.")
        return
    
    print("â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—")
    print("â•‘  đź§  ILARIA â€” HUGGING FACE CORPUS DOWNLOADER  â•‘")
    print("â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•ť")
    
    start = time.time()
    
    if args.all or args.wiki_ro:
        download_wikipedia_ro(args.wiki_ro_max)
    
    if args.all or args.alpaca:
        download_alpaca()
    
    if args.all or args.dolly:
        download_dolly()
    
    if args.all or args.wiki_en:
        download_wikipedia_en(args.wiki_en_max)

    if args.wiki_simple:
        download_wikipedia_simple(args.wiki_simple_max)

    if args.all or args.slimorca:
        download_slimorca()
    
    elapsed = time.time() - start
    print(f"\nâŹ±ď¸Ź  Total download time: {elapsed/60:.1f} minutes")
    
    print_summary()


if __name__ == "__main__":
    main()
