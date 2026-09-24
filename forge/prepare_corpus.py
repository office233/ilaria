"""prepare_corpus.py — download, clean and shard training corpora for Ilaria.

Sources (all streamed from HuggingFace, nothing is stored twice):
  tinystories   roneneldan/TinyStories               en   simple narrative (coherence at 10-50M)
  wiki_ro       wikimedia/wikipedia 20231101.ro      ro   encyclopedic Romanian
  wiki_en       wikimedia/wikipedia 20231101.en      en   encyclopedic English
  fineweb2_ro   HuggingFaceFW/fineweb-2 ron_Latn     ro   filtered Romanian web (the bulk of RO tokens)
  fineweb_edu   HuggingFaceFW/fineweb-edu sample-10BT en   educational English web

Output: <out-dir>/<source>-NNNNN.jsonl shards of {"text": ...} lines plus a
<source>.manifest.json recording the complete shards, the number of documents
written and `raw_rows` — how many rows of the HuggingFace stream those shards
consumed (filtered rows included). A re-run `.skip()`s that many rows and
appends new shards, so an interrupted Colab session resumes where it stopped
without re-cleaning what is already on Drive.

Usage:
    # corpus shards on Google Drive (Colab)
    python forge/prepare_corpus.py --out-dir /content/drive/MyDrive/ilaria/corpus \
        --sources fineweb2_ro,fineweb_edu,wiki_ro,wiki_en --max fineweb2_ro=3000000 --max fineweb_edu=2000000

    # balanced RO/EN plain-text sample for training the tokenizer (local)
    python forge/prepare_corpus.py --tokenizer-sample data/corpus/tokenizer_sample.txt --sample-bytes 200000000 \
        --sources wiki_ro,fineweb2_ro,tinystories,fineweb_edu

Then: python forge/hf_tokenizer.py encode --tokenizer <tokenizer.json> --in <shard>.jsonl --out <shard>
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

# Personal-data masking (promised in the EuroHPC ethics self-assessment):
# e-mail addresses, phone numbers and IBANs are replaced by placeholders
# before tokenisation. Phones need a leading +CC or 0 and at least 9 digits,
# so years, dates and population counts stay untouched.
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b")
_PHONE = re.compile(r"(?<![\w.])(?:\+\d{1,3}[ .-]?|0)\d{2,3}(?:[ .-]?\d{2,4}){2,3}(?!\w|\.\d)")


def scrub_pii(text: str) -> str:
    """Mask e-mail addresses, IBANs and phone numbers with [EMAIL]/[IBAN]/[PHONE]."""
    text = _EMAIL.sub("[EMAIL]", text)
    text = _IBAN.sub("[IBAN]", text)
    return _PHONE.sub("[PHONE]", text)


def clean_text(text: str, min_len: int = 20, max_len: int = 3000) -> str:
    """Normalize whitespace, mask personal data, drop boilerplate/table-like text, cut long text at a sentence."""
    if not text:
        return ""
    text = scrub_pii(text.replace("\r", ""))
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


def _docs(hf_id: str, config: Optional[str], max_samples: Optional[int], max_len: int, skip: int = 0):
    ds = _load(hf_id, config)
    if skip:
        ds = ds.skip(skip)
    return _docs_from(ds, max_samples, max_len, skip)


def _docs_from(ds, max_samples: Optional[int], max_len: int, skip: int = 0) -> Generator[tuple, None, None]:
    """Yield (raw_row_index, cleaned_text).

    Raw indices count every stream row, filtered or not, so the shard manifest
    can record how many rows to `.skip()` when the run is resumed."""
    count = 0
    for i, row in enumerate(ds, start=skip):
        t = clean_text(row.get("text", ""), max_len=max_len)
        if t:
            yield i, t
            count += 1
            if max_samples and count >= max_samples:
                return


def _wiki(hf_id: str, config: str, max_samples: Optional[int], skip: int = 0) -> Generator[tuple, None, None]:
    ds = _load(hf_id, config)
    if skip:
        ds = ds.skip(skip)
    count = 0
    for i, row in enumerate(ds, start=skip):
        for chunk in chunk_paragraphs(row.get("text", ""), target_chars=600, max_len=4000):
            yield i, chunk
            count += 1
            if max_samples and count >= max_samples:
                return


@dataclass(frozen=True)
class Source:
    name: str
    hf_id: str
    config: Optional[str]
    lang: str
    stream: Callable[..., Generator[tuple, None, None]]  # stream(max_docs, skip=0) -> (raw_row, text)
    default_max: int


SOURCES: Dict[str, Source] = {
    "tinystories": Source("tinystories", "roneneldan/TinyStories", None, "en",
                          lambda n, skip=0: _docs("roneneldan/TinyStories", None, n, 3000, skip), 300_000),
    "wiki_ro": Source("wiki_ro", "wikimedia/wikipedia", "20231101.ro", "ro",
                      lambda n, skip=0: _wiki("wikimedia/wikipedia", "20231101.ro", n, skip), 200_000),
    "wiki_en": Source("wiki_en", "wikimedia/wikipedia", "20231101.en", "en",
                      lambda n, skip=0: _wiki("wikimedia/wikipedia", "20231101.en", n, skip), 300_000),
    "fineweb2_ro": Source("fineweb2_ro", "HuggingFaceFW/fineweb-2", "ron_Latn", "ro",
                          lambda n, skip=0: _docs("HuggingFaceFW/fineweb-2", "ron_Latn", n, 8000, skip), 2_000_000),
    "fineweb_edu": Source("fineweb_edu", "HuggingFaceFW/fineweb-edu", "sample-10BT", "en",
                          lambda n, skip=0: _docs("HuggingFaceFW/fineweb-edu", "sample-10BT", n, 8000, skip), 2_000_000),
}


def texts(stream: Iterable[tuple]) -> Generator[str, None, None]:
    """Drop the raw-row index from a (raw_row, text) stream."""
    for _, t in stream:
        yield t


# Kept for callers of the previous version (text-only streams).
def stream_tinystories(n: Optional[int] = None) -> Generator[str, None, None]:
    return texts(SOURCES["tinystories"].stream(n))


def stream_wiki_ro(n: Optional[int] = None) -> Generator[str, None, None]:
    return texts(SOURCES["wiki_ro"].stream(n))


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


def resume_plan(out_dir: str, name: str, limit: Optional[int]) -> dict:
    """What a re-run must do for one source.

    skip_rows   rows of the HF stream to `.skip()` (manifests with `raw_rows`)
    skip_docs   cleaned docs to drop after streaming from row 0 (manifests
                written by the previous version, which had no raw-row count)
    start_shard index of the first shard to write
    remaining   docs still to write (None = no limit)"""
    man = _load_manifest(out_dir, name)
    complete = sorted(man.get("complete", []))
    if not complete:
        return {"skip_rows": 0, "skip_docs": 0, "start_shard": 0, "remaining": limit}
    done = int(man.get("docs", 0))
    remaining = None if not limit else max(0, limit - done)
    if "raw_rows" in man:
        return {"skip_rows": int(man["raw_rows"]), "skip_docs": 0, "start_shard": complete[-1] + 1, "remaining": remaining}
    return {"skip_rows": 0, "skip_docs": done, "start_shard": complete[-1] + 1, "remaining": remaining}


def write_shards(docs: Iterator[tuple], out_dir: str, name: str, shard_docs: int = 50_000,
                 start_shard: int = 0) -> int:
    """Write (raw_row, text) docs as <name>-NNNNN.jsonl shards from start_shard on.

    The manifest records the complete shards, the total docs and `raw_rows`
    (= last raw row index + 1) so resume_plan can `.skip()` the stream on the
    next run. Returns the number of docs written by this call."""
    os.makedirs(out_dir, exist_ok=True)
    man = _load_manifest(out_dir, name) if start_shard else {"docs": 0, "shards": 0, "complete": []}
    complete = set(man.get("complete", []))
    total = int(man.get("docs", 0))
    raw_rows = int(man.get("raw_rows", 0))
    written = 0
    shard = start_shard
    exhausted = False
    while not exhausted:
        path = os.path.join(out_dir, f"{name}-{shard:05d}.jsonl")
        tmp = path + ".tmp"
        n = 0
        last_raw = raw_rows - 1
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            for _ in range(shard_docs):
                try:
                    raw, t = next(docs)
                except StopIteration:
                    exhausted = True
                    break
                f.write(json.dumps({"text": t}, ensure_ascii=False) + "\n")
                n += 1
                last_raw = raw
        if n == 0:
            os.remove(tmp)
            break
        os.replace(tmp, path)
        total += n
        written += n
        raw_rows = last_raw + 1
        complete.add(shard)
        man = {"docs": total, "shards": max(complete) + 1, "shard_docs": shard_docs,
               "complete": sorted(complete), "raw_rows": raw_rows}
        _save_manifest(out_dir, name, man)
        print(f"  [{name}] shard {shard:05d}: {n:,} docs (total {total:,}, raw rows {raw_rows:,})", flush=True)
        shard += 1
    return written


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
            per_lang.setdefault(SOURCES[n].lang, []).append(texts(SOURCES[n].stream(maxes.get(n))))

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
    for name in names:
        src = SOURCES[name]
        limit = maxes.get(name, src.default_max)
        plan = resume_plan(args.out_dir, name, limit)
        if plan["remaining"] == 0:
            print(f"\n--- {name}: already complete ({limit:,} docs), skipped ---", flush=True)
            continue
        todo = "all" if plan["remaining"] is None else f"{plan['remaining']:,}"
        print(f"\n--- {name} ({src.hf_id}{'/' + src.config if src.config else ''}, {src.lang}) up to {limit:,} docs; "
              f"skip {plan['skip_rows']:,} raw rows, start at shard {plan['start_shard']}, {todo} docs to go ---", flush=True)
        n_stream = None if plan["remaining"] is None else plan["remaining"] + plan["skip_docs"]
        stream = src.stream(n_stream, skip=plan["skip_rows"])
        if plan["skip_docs"]:
            print(f"  [{name}] manifest from the previous version: re-streaming and dropping "
                  f"{plan['skip_docs']:,} docs already on disk", flush=True)
            for k in range(plan["skip_docs"]):
                try:
                    next(stream)
                except StopIteration:
                    break
                if (k + 1) % 100_000 == 0:
                    print(f"  [{name}] dropped {k + 1:,}/{plan['skip_docs']:,}", flush=True)
        grand += write_shards(stream, args.out_dir, name, args.shard_docs, start_shard=plan["start_shard"])
    print(f"\n[prepare_corpus] done: {grand:,} new docs in {args.out_dir}")
    print("Next: python forge/hf_tokenizer.py encode --tokenizer <tokenizer.json> --in <shard>.jsonl --out <shard>")


if __name__ == "__main__":
    main()
