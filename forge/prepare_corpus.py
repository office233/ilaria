"""prepare_corpus.py — download, clean and shard training corpora for Ilaria.

Sources (all streamed from HuggingFace, nothing is stored twice):
  tinystories   roneneldan/TinyStories               en   simple narrative (coherence at 10-50M)
  wiki_ro       wikimedia/wikipedia 20231101.ro      ro   encyclopedic Romanian
  wiki_en       wikimedia/wikipedia 20231101.en      en   encyclopedic English
  fineweb2_ro   HuggingFaceFW/fineweb-2 ron_Latn     ro   filtered Romanian web (the bulk of RO tokens)
  fineweb_edu   HuggingFaceFW/fineweb-edu sample-10BT en   educational English web

Output: <out-dir>/<source>-NNNNN.jsonl shards of {"text": ...} lines plus a
<source>.manifest.json. Shards already listed as complete in the manifest are
skipped on re-run, so an interrupted Colab session resumes where it stopped.

Usage:
    # corpus shards on Google Drive (Colab)
    python forge/prepare_corpus.py --out-dir /content/drive/MyDrive/ilaria/corpus \
        --sources fineweb2_ro,fineweb_edu,wiki_ro,wiki_en --max fineweb2_ro=3000000 --max fineweb_edu=2000000

    # balanced RO/EN plain-text sample for training the tokenizer (local)
    python forge/prepare_corpus.py --tokenizer-sample data/corpus/tokenizer_sample.txt --sample-bytes 200000000 \
        --sources wiki_ro,fineweb2_ro,tinystories,fineweb_edu

Then: go run ./cmd/corpus-tokenize -tokenizer data/tokenizer.json -in <shard>.jsonl -out <shard>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from typing import Callable, Dict, Generator, Iterable, Iterator, Optional

# ---------------------------------------------------------------- cleaning

# Lines that are mostly punctuation/digits (tables, navigation) or that carry
# web boilerplate are dropped. This is a data-quality filter, not knowledge.
_BOILERPLATE = re.compile(
    r"(?i)\b(cookie|cookies|javascript|subscribe|newsletter|all rights reserved|"
    r"terms of (use|service)|privacy policy|click here|log ?in|sign ?up|"
    r"politica de confiden|accept(ă|a)(ți|ti)? (toate )?cookie|abonea|drepturi rezervate)\b"
)
_MIN_ALPHA_RATIO = 0.5


def clean_text(text: str, min_len: int = 20, max_len: int = 3000) -> str:
    """Normalize whitespace, drop boilerplate/table-like text, cut long text at a sentence."""
    if not text:
        return ""
    text = text.replace("\r", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = "\n".join(line.strip() for line in text.split("\n")).strip()
    if len(text) < min_len:
        return ""
    letters = sum(1 for ch in text if ch.isalpha())
    if letters / max(1, len(text)) < _MIN_ALPHA_RATIO:
        return ""
    if _BOILERPLATE.search(text) and len(text) < 400:
        return ""
    if len(text) > max_len:
        cut = text[:max_len]
        last_punct = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind("? "), cut.rfind("! "))
        if last_punct > min_len:
            text = cut[: last_punct + 1]
        else:
            last_space = cut.rfind(" ")
            text = cut[:last_space] if last_space > min_len else cut
    return text.strip()


def chunk_paragraphs(text: str, target_chars: int = 300, max_len: int = 3000) -> Generator[str, None, None]:
    """Group paragraphs into chunks of about target_chars, skipping headings."""
    chunk, chunk_len = [], 0
    for p in text.split("\n\n"):
        p = p.strip()
        if not p or len(p) < 30 or p.startswith("=") or p.endswith("="):
            continue
        chunk.append(p)
        chunk_len += len(p)
        if chunk_len >= target_chars:
            joined = clean_text("\n\n".join(chunk), max_len=max_len)
            if joined:
                yield joined
            chunk, chunk_len = [], 0
    if chunk:
        joined = clean_text("\n\n".join(chunk), max_len=max_len)
        if joined:
            yield joined


# ---------------------------------------------------------------- sources


def _load(hf_id: str, config: Optional[str]):
    try:
        from datasets import load_dataset
    except ImportError:
        sys.exit("[prepare_corpus] ERROR: 'datasets' package not installed. Run: pip install datasets")
    if config:
        return load_dataset(hf_id, config, split="train", streaming=True)
    return load_dataset(hf_id, split="train", streaming=True)


def _docs(hf_id: str, config: Optional[str], max_samples: Optional[int], max_len: int) -> Generator[str, None, None]:
    count = 0
    for row in _load(hf_id, config):
        t = clean_text(row.get("text", ""), max_len=max_len)
        if t:
            yield t
            count += 1
            if max_samples and count >= max_samples:
                return


def _wiki(hf_id: str, config: str, max_samples: Optional[int]) -> Generator[str, None, None]:
    count = 0
    for row in _load(hf_id, config):
        for chunk in chunk_paragraphs(row.get("text", ""), target_chars=600, max_len=4000):
            yield chunk
            count += 1
            if max_samples and count >= max_samples:
                return


@dataclass(frozen=True)
class Source:
    name: str
    hf_id: str
    config: Optional[str]
    lang: str
    stream: Callable[[Optional[int]], Generator[str, None, None]]
    default_max: int


SOURCES: Dict[str, Source] = {
    "tinystories": Source("tinystories", "roneneldan/TinyStories", None, "en",
                          lambda n: _docs("roneneldan/TinyStories", None, n, 3000), 300_000),
    "wiki_ro": Source("wiki_ro", "wikimedia/wikipedia", "20231101.ro", "ro",
                      lambda n: _wiki("wikimedia/wikipedia", "20231101.ro", n), 200_000),
    "wiki_en": Source("wiki_en", "wikimedia/wikipedia", "20231101.en", "en",
                      lambda n: _wiki("wikimedia/wikipedia", "20231101.en", n), 300_000),
    "fineweb2_ro": Source("fineweb2_ro", "HuggingFaceFW/fineweb-2", "ron_Latn", "ro",
                          lambda n: _docs("HuggingFaceFW/fineweb-2", "ron_Latn", n, 8000), 2_000_000),
    "fineweb_edu": Source("fineweb_edu", "HuggingFaceFW/fineweb-edu", "sample-10BT", "en",
                          lambda n: _docs("HuggingFaceFW/fineweb-edu", "sample-10BT", n, 8000), 2_000_000),
}

# Kept for callers of the previous version.
stream_tinystories = SOURCES["tinystories"].stream
stream_wiki_ro = SOURCES["wiki_ro"].stream


# ---------------------------------------------------------------- output


def manifest_path(out_dir: str, name: str) -> str:
    return os.path.join(out_dir, f"{name}.manifest.json")


def _load_manifest(out_dir: str, name: str) -> dict:
    try:
        with open(manifest_path(out_dir, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"docs": 0, "shards": 0, "complete": []}


def _save_manifest(out_dir: str, name: str, man: dict) -> None:
    tmp = manifest_path(out_dir, name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(man, f)
    os.replace(tmp, manifest_path(out_dir, name))


def write_shards(docs: Iterator[str], out_dir: str, name: str, shard_docs: int = 50_000,
                 on_skip: Optional[Callable[[int], None]] = None) -> int:
    """Write docs as <name>-NNNNN.jsonl shards; complete shards are skipped on re-run."""
    os.makedirs(out_dir, exist_ok=True)
    man = _load_manifest(out_dir, name)
    complete = set(man.get("complete", []))
    total, shard = 0, 0
    exhausted = False
    while not exhausted:
        path = os.path.join(out_dir, f"{name}-{shard:05d}.jsonl")
        if shard in complete and os.path.exists(path):
            n = 0
            for _ in range(shard_docs):
                try:
                    next(docs)
                    n += 1
                except StopIteration:
                    exhausted = True
                    break
            total += n
            if on_skip:
                on_skip(shard)
            shard += 1
            continue
        n = 0
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            for _ in range(shard_docs):
                try:
                    t = next(docs)
                except StopIteration:
                    exhausted = True
                    break
                f.write(json.dumps({"text": t}, ensure_ascii=False) + "\n")
                n += 1
        if n == 0:
            os.remove(tmp)
            break
        os.replace(tmp, path)
        total += n
        complete.add(shard)
        man = {"docs": total, "shards": shard + 1, "shard_docs": shard_docs, "complete": sorted(complete)}
        _save_manifest(out_dir, name, man)
        print(f"  [{name}] shard {shard:05d}: {n:,} docs (total {total:,})", flush=True)
        shard += 1
    man = _load_manifest(out_dir, name)
    man["docs"] = max(man.get("docs", 0), total)
    man["shards"] = max(man.get("shards", 0), shard if total else 0)
    _save_manifest(out_dir, name, man)
    return total


def write_tokenizer_sample(streams: Dict[str, Iterable[str]], path: str, max_bytes: int = 200_000_000) -> Dict[str, int]:
    """Interleave languages 1:1 into one plain-text file (one doc per line) up to max_bytes."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    iters = {lang: iter(s) for lang, s in streams.items()}
    stats = {lang: 0 for lang in streams}
    written = 0
    with open(path, "w", encoding="utf-8", newline="\n") as f:  # LF only: byte count must match file size
        while iters and written < max_bytes:
            for lang in list(iters):
                try:
                    doc = next(iters[lang])
                except StopIteration:
                    del iters[lang]
                    continue
                line = doc.replace("\n", " ").strip() + "\n"
                f.write(line)
                written += len(line.encode("utf-8"))
                stats[lang] += 1
                if written >= max_bytes:
                    break
    print(f"[prepare_corpus] tokenizer sample: {written/1e6:.1f} MB, docs per language {stats} -> {path}")
    return stats


# ---------------------------------------------------------------- main


def _parse_max(items: Iterable[str]) -> Dict[str, int]:
    out = {}
    for it in items or []:
        name, _, n = it.partition("=")
        if name not in SOURCES or not n.isdigit():
            sys.exit(f"[prepare_corpus] bad --max {it!r}; use <source>=<count> with source in {list(SOURCES)}")
        out[name] = int(n)
    return out


def main(argv: Optional[list] = None) -> None:
    ap = argparse.ArgumentParser(description="Download, clean and shard training corpora for Ilaria.")
    ap.add_argument("--out-dir", default="./data/corpus", help="directory for JSONL shards (can be on Drive)")
    ap.add_argument("--sources", default="tinystories,wiki_ro", help="comma-separated: " + ",".join(SOURCES))
    ap.add_argument("--max", action="append", default=[], help="<source>=<max docs> (repeatable)")
    ap.add_argument("--shard-docs", type=int, default=50_000)
    ap.add_argument("--tokenizer-sample", default="", help="write a balanced RO/EN plain-text sample here instead of shards")
    ap.add_argument("--sample-bytes", type=int, default=200_000_000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    random.seed(args.seed)
    names = [s.strip() for s in args.sources.split(",") if s.strip()]
    for n in names:
        if n not in SOURCES:
            sys.exit(f"[prepare_corpus] unknown source {n!r}; choose from {list(SOURCES)}")
    maxes = _parse_max(args.max)

    if args.tokenizer_sample:
        # one interleaved stream per language, round-robin over that language's sources
        per_lang: Dict[str, list] = {}
        for n in names:
            per_lang.setdefault(SOURCES[n].lang, []).append(SOURCES[n].stream(maxes.get(n)))

        def roundrobin(gens):
            gens = list(gens)
            while gens:
                for g in list(gens):
                    try:
                        yield next(g)
                    except StopIteration:
                        gens.remove(g)

        write_tokenizer_sample({lang: roundrobin(g) for lang, g in per_lang.items()}, args.tokenizer_sample, args.sample_bytes)
        return

    os.makedirs(args.out_dir, exist_ok=True)
    grand = 0
    for n in names:
        src = SOURCES[n]
        limit = maxes.get(n, src.default_max)
        print(f"\n--- {n} ({src.hf_id}{'/' + src.config if src.config else ''}, {src.lang}) up to {limit:,} docs ---", flush=True)
        grand += write_shards(src.stream(limit), args.out_dir, n, args.shard_docs, on_skip=lambda k: print(f"  [{n}] shard {k:05d} already complete, skipped"))
    print(f"\n[prepare_corpus] done: {grand:,} docs in {args.out_dir}")
    print("Next: for each shard, go run ./cmd/corpus-tokenize -tokenizer data/tokenizer.json -in <shard>.jsonl -out <shard>")


if __name__ == "__main__":
    main()
