"""prepare_corpus.py — download, clean and shard training corpora for Ilaria.

Sources (all streamed from HuggingFace, nothing is stored twice):
  tinystories   roneneldan/TinyStories               en   simple narrative (coherence at 10-50M)
  wiki_ro       wikimedia/wikipedia 20231101.ro      ro   encyclopedic Romanian
  wiki_en       wikimedia/wikipedia 20231101.en      en   encyclopedic English
  fineweb2_ro   HuggingFaceFW/fineweb-2 ron_Latn     ro   filtered Romanian web (the bulk of RO tokens)
  fineweb_edu   HuggingFaceFW/fineweb-edu sample-10BT en   educational English web
  openmath_reasoning_cot nvidia/OpenMathReasoning       en   verifier-oriented math reasoning (CoT split)
  openscience_reasoning_2 nvidia/OpenScienceReasoning-2  en   synthetic multi-domain science/reasoning
  opencode_reasoning_split0 nvidia/OpenCodeReasoning split_0 en licensed coding reasoning with embedded prompts

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
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Dict, Generator, Iterable, Iterator, Optional

try:
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        load_rights_registry,
        require_approved_rights,
        sha256_file,
    )
except ImportError:  # direct script execution
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        load_rights_registry,
        require_approved_rights,
        sha256_file,
    )

try:
    from .corpus_source_lock import load_source_lock
except ImportError:
    from corpus_source_lock import load_source_lock


def validate_tokenizer_sample_rights(
    rights_registry_path: str | Path,
    source_names: list[str],
    *,
    source_lock_path: str | Path | None,
) -> dict:
    """Validate approval plus any configured evidence chain before streaming."""
    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    require_approved_rights(rights, source_names)
    configured_evidence = rights.get("evidence")
    if configured_evidence is None:
        return rights
    if source_lock_path is None:
        raise ValueError(
            "tokenizer sample requires --source-lock when rights evidence is configured"
        )
    if not isinstance(configured_evidence, dict):
        raise ValueError("rights registry evidence identity is invalid")
    evidence_name = configured_evidence.get("filename")
    if not isinstance(evidence_name, str) or not evidence_name:
        raise ValueError("rights registry evidence filename is invalid")
    try:
        from .rights_evidence import load_and_validate_evidence, require_approved_evidence
    except ImportError:
        from rights_evidence import load_and_validate_evidence, require_approved_evidence
    evidence = load_and_validate_evidence(
        rights_path.parent / evidence_name,
        source_lock_path=source_lock_path,
        rights_registry_path=rights_path,
    )
    require_approved_evidence(rights, evidence, source_names)
    return rights

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


def _load(
    hf_id: str,
    config: Optional[str],
    revision: Optional[str] = None,
    *,
    split: str = "train",
):
    try:
        from datasets import load_dataset
    except ImportError:
        sys.exit("[prepare_corpus] ERROR: 'datasets' package not installed. Run: pip install datasets")
    kwargs = {"split": split, "streaming": True}
    if revision:
        kwargs["revision"] = revision
    if config:
        return load_dataset(hf_id, config, **kwargs)
    return load_dataset(hf_id, **kwargs)


_THINK_TAG = re.compile(r"</?think>", re.IGNORECASE)


def _clean_reasoning_text(text: str, *, max_len: int = 8_000) -> str:
    """Normalize math/reasoning text without the prose-heavy alpha-ratio filter.

    Math rows contain substantial LaTeX and symbolic content, so the generic web
    cleaner would discard valid examples. We still apply PII masking, whitespace
    normalization and a context-sized deterministic truncation.
    """
    if not text:
        return ""
    text = _THINK_TAG.sub("", scrub_pii(text.replace("\r", "")))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
    if len(text) < 20:
        return ""
    if len(text) <= max_len:
        return text
    cut = text[:max_len]
    boundary = max(cut.rfind("\n\n"), cut.rfind(". "), cut.rfind("\n"), cut.rfind(" "))
    if boundary >= max_len // 2:
        cut = cut[:boundary]
    return cut.strip()


def _openmath_reasoning_cot_from(
    ds,
    max_samples: Optional[int],
    *,
    skip: int = 0,
    max_len: int = 8_000,
) -> Generator[tuple, None, None]:
    """Yield deterministic problem/solution documents from OpenMathReasoning CoT."""
    count = 0
    for i, row in enumerate(ds, start=skip):
        problem = row.get("problem", "")
        solution = row.get("generated_solution", "")
        if not isinstance(problem, str) or not isinstance(solution, str):
            continue
        problem = problem.strip()
        solution = solution.strip()
        if not problem or not solution:
            continue
        text = _clean_reasoning_text(
            f"Problem:\n{problem}\n\nSolution:\n{solution}",
            max_len=max_len,
        )
        if not text:
            continue
        metadata = {"path": f"cot/{i:012d}"}
        for field in ("problem_source", "generation_model", "problem_type"):
            value = row.get(field)
            if isinstance(value, str) and value.strip():
                metadata[field] = value.strip()
        expected = row.get("expected_answer")
        if isinstance(expected, str) and expected.strip():
            metadata["expected_answer"] = expected.strip()
        used_in_kaggle = row.get("used_in_kaggle")
        if isinstance(used_in_kaggle, bool):
            metadata["used_in_kaggle"] = used_in_kaggle
        yield i, text, metadata
        count += 1
        if max_samples and count >= max_samples:
            return


def _openmath_reasoning_cot(
    max_samples: Optional[int],
    skip: int = 0,
    revision: Optional[str] = None,
) -> Generator[tuple, None, None]:
    ds = _load("nvidia/OpenMathReasoning", None, revision, split="cot")
    if skip:
        ds = ds.skip(skip)
    return _openmath_reasoning_cot_from(ds, max_samples, skip=skip)


def _openscience_reasoning_2_from(
    ds,
    max_samples: Optional[int],
    *,
    skip: int = 0,
    max_len: int = 8_000,
) -> Generator[tuple, None, None]:
    """Yield self-contained OpenScienceReasoning-2 question/reasoning rows."""
    count = 0
    for i, row in enumerate(ds, start=skip):
        prompt = row.get("input", "")
        reasoning = row.get("output", "")
        expected = row.get("expected_answer", "")
        if not isinstance(prompt, str) or not isinstance(reasoning, str):
            continue
        prompt = prompt.strip()
        reasoning = reasoning.strip()
        if not prompt or not reasoning:
            continue
        suffix = (
            f"\n\nExpected answer:\n{expected.strip()}"
            if isinstance(expected, str) and expected.strip()
            else ""
        )
        text = _clean_reasoning_text(
            f"Question:\n{prompt}\n\nReasoning and answer:\n{reasoning}{suffix}",
            max_len=max_len,
        )
        if text:
            metadata = {"path": f"train/{i:012d}"}
            if isinstance(expected, str) and expected.strip():
                metadata["expected_answer"] = expected.strip()
            yield i, text, metadata
            count += 1
            if max_samples and count >= max_samples:
                return


def _openscience_reasoning_2(
    max_samples: Optional[int],
    skip: int = 0,
    revision: Optional[str] = None,
) -> Generator[tuple, None, None]:
    ds = _load("nvidia/OpenScienceReasoning-2", None, revision, split="train")
    if skip:
        ds = ds.skip(skip)
    return _openscience_reasoning_2_from(ds, max_samples, skip=skip)


_OPENCODE_REQUIRED_DATASET = "code_contests"
_OPENCODE_REQUIRED_LICENSE = "cc-by-4.0"


def _opencode_reasoning_split0_from(
    ds,
    max_samples: Optional[int],
    *,
    skip: int = 0,
    max_len: int = 8_000,
) -> Generator[tuple, None, None]:
    """Yield embedded-prompt OpenCodeReasoning rows with allowlisted licenses."""
    count = 0
    for i, row in enumerate(ds, start=skip):
        license_id = row.get("license", "")
        dataset_id = row.get("dataset", "")
        prompt = row.get("input", "")
        reasoning = row.get("output", "")
        solution = row.get("solution", "")
        if (
            not isinstance(license_id, str)
            or license_id.strip().lower() != _OPENCODE_REQUIRED_LICENSE
            or not isinstance(dataset_id, str)
            or dataset_id.strip().lower() != _OPENCODE_REQUIRED_DATASET
        ):
            continue
        if not all(isinstance(value, str) for value in (prompt, reasoning, solution)):
            continue
        prompt = prompt.strip()
        reasoning = reasoning.strip()
        solution = solution.strip()
        if not prompt or prompt == "-" or not reasoning or not solution:
            continue
        text = _clean_reasoning_text(
            f"Coding problem:\n{prompt}\n\nReference solution:\n{solution}\n\nReasoning:\n{reasoning}",
            max_len=max_len,
        )
        if text:
            metadata = {
                "path": f"split_0/{i:012d}",
                "license": license_id.strip().lower(),
                "dataset": dataset_id.strip().lower(),
            }
            for field in ("id", "source", "split", "difficulty"):
                value = row.get(field)
                if isinstance(value, str) and value.strip():
                    metadata[field if field != "id" else "record_id"] = value.strip()
            yield i, text, metadata
            count += 1
            if max_samples and count >= max_samples:
                return


def _opencode_reasoning_split0(
    max_samples: Optional[int],
    skip: int = 0,
    revision: Optional[str] = None,
) -> Generator[tuple, None, None]:
    ds = _load(
        "nvidia/OpenCodeReasoning",
        "split_0",
        revision,
        split="split_0",
    )
    if skip:
        ds = ds.skip(skip)
    return _opencode_reasoning_split0_from(ds, max_samples, skip=skip)


def _docs(
    hf_id: str,
    config: Optional[str],
    max_samples: Optional[int],
    max_len: int,
    skip: int = 0,
    revision: Optional[str] = None,
):
    ds = _load(hf_id, config, revision)
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


def _wiki_from_rows(
    ds,
    max_samples: Optional[int],
    *,
    skip: int = 0,
) -> Generator[tuple, None, None]:
    count = 0
    for i, row in enumerate(ds, start=skip):
        article_id = row.get("id")
        title = row.get("title")
        url = row.get("url")
        article_key = (
            article_id.strip()
            if isinstance(article_id, str) and article_id.strip()
            else f"row-{i:012d}"
        )
        for chunk_index, chunk in enumerate(
            chunk_paragraphs(row.get("text", ""), target_chars=600, max_len=4000)
        ):
            metadata = {
                "path": f"article/{article_key}/{chunk_index:04d}",
                "article_id": article_key,
            }
            if isinstance(title, str) and title.strip():
                metadata["title"] = title.strip()
            if isinstance(url, str) and url.strip():
                metadata["article_url"] = url.strip()
            yield i, chunk, metadata
            count += 1
            if max_samples and count >= max_samples:
                return


def _wiki(
    hf_id: str,
    config: str,
    max_samples: Optional[int],
    skip: int = 0,
    revision: Optional[str] = None,
) -> Generator[tuple, None, None]:
    ds = _load(hf_id, config, revision)
    if skip:
        ds = ds.skip(skip)
    return _wiki_from_rows(ds, max_samples, skip=skip)


@dataclass(frozen=True)
class Source:
    name: str
    hf_id: str
    config: Optional[str]
    lang: str
    stream: Callable[..., Generator[tuple, None, None]]  # stream(max_docs, skip=0) -> (raw_row, text)
    default_max: int
    revision: Optional[str] = None


SOURCES: Dict[str, Source] = {
    "tinystories": Source("tinystories", "roneneldan/TinyStories", None, "en",
                          lambda n, skip=0, revision=None: _docs("roneneldan/TinyStories", None, n, 3000, skip, revision), 300_000),
    "wiki_ro": Source("wiki_ro", "wikimedia/wikipedia", "20231101.ro", "ro",
                      lambda n, skip=0, revision=None: _wiki("wikimedia/wikipedia", "20231101.ro", n, skip, revision), 200_000),
    "wiki_en": Source("wiki_en", "wikimedia/wikipedia", "20231101.en", "en",
                      lambda n, skip=0, revision=None: _wiki("wikimedia/wikipedia", "20231101.en", n, skip, revision), 300_000),
    "fineweb2_ro": Source("fineweb2_ro", "HuggingFaceFW/fineweb-2", "ron_Latn", "ro",
                          lambda n, skip=0, revision=None: _docs("HuggingFaceFW/fineweb-2", "ron_Latn", n, 8000, skip, revision), 2_000_000),
    "fineweb_edu": Source("fineweb_edu", "HuggingFaceFW/fineweb-edu", "sample-10BT", "en",
                           lambda n, skip=0, revision=None: _docs("HuggingFaceFW/fineweb-edu", "sample-10BT", n, 8000, skip, revision), 2_000_000),
    "openmath_reasoning_cot": Source(
        "openmath_reasoning_cot",
        "nvidia/OpenMathReasoning",
        None,
        "en",
        _openmath_reasoning_cot,
        70_000,
    ),
    "openscience_reasoning_2": Source(
        "openscience_reasoning_2",
        "nvidia/OpenScienceReasoning-2",
        None,
        "en",
        _openscience_reasoning_2,
        80_000,
    ),
    "opencode_reasoning_split0": Source(
        "opencode_reasoning_split0",
        "nvidia/OpenCodeReasoning",
        "split_0",
        "en",
        _opencode_reasoning_split0,
        80_000,
    ),
}


def texts(stream: Iterable[tuple]) -> Generator[str, None, None]:
    """Drop raw-row/provenance fields from a corpus stream."""
    for row in stream:
        if not isinstance(row, tuple) or len(row) not in {2, 3}:
            raise ValueError("corpus stream rows must be (raw_row, text[, metadata])")
        yield row[1]


# Kept for callers of the previous version (text-only streams).
def stream_tinystories(n: Optional[int] = None) -> Generator[str, None, None]:
    source = SOURCES["tinystories"]
    return texts(source.stream(n, revision=source.revision))


def stream_wiki_ro(n: Optional[int] = None) -> Generator[str, None, None]:
    source = SOURCES["wiki_ro"]
    return texts(source.stream(n, revision=source.revision))


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
    atomic_write_json(manifest_path(out_dir, name), man)


def _source_identity(source: Optional[Source]) -> dict:
    if source is None:
        return {"name": "unknown", "provider": "unknown", "config": None, "revision": "", "language": "unknown"}
    return {
        "name": source.name,
        "provider": source.hf_id,
        "config": source.config,
        "revision": source.revision or "UNLOCKED",
        "language": source.lang,
    }


def _pipeline_identity(seed: Optional[int]) -> dict:
    return {
        "name": "prepare-corpus-v2",
        "source_sha256": sha256_file(__file__),
        "seed": seed,
        "pii_policy": "mask-email-phone-iban-v1",
        "cleaning_policy": "ilaria-clean-text-v1",
    }


def _upgrade_manifest(out_dir: str, name: str, man: dict, source: Optional[Source], seed: Optional[int]) -> dict:
    complete = sorted(int(x) for x in man.get("complete", []))
    records = {int(r["index"]): r for r in man.get("shard_records", []) if isinstance(r, dict) and "index" in r}
    for index in complete:
        if index in records:
            continue
        path = os.path.join(out_dir, f"{name}-{index:05d}.jsonl")
        if not os.path.isfile(path):
            raise ValueError(f"manifest lists missing shard {path}")
        with open(path, encoding="utf-8") as stream:
            docs = sum(1 for line in stream if line.strip())
        records[index] = {
            "index": index,
            "filename": os.path.basename(path),
            "sha256": sha256_file(path),
            "bytes": os.path.getsize(path),
            "documents": docs,
        }
    identity = _source_identity(source)
    old_identity = man.get("source")
    if old_identity and source is not None and old_identity != identity:
        raise ValueError(f"source identity changed for {name}: {old_identity!r} != {identity!r}")
    man = dict(man)
    man["schema_version"] = CORPUS_MANIFEST_SCHEMA
    man["source"] = old_identity or identity
    man["pipeline"] = man.get("pipeline") or _pipeline_identity(seed)
    man["shard_records"] = [records[i] for i in sorted(records)]
    return man


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


def write_shards(
    docs: Iterator[tuple],
    out_dir: str,
    name: str,
    shard_docs: int = 50_000,
    start_shard: int = 0,
    *,
    source: Optional[Source] = None,
    seed: Optional[int] = None,
) -> int:
    """Write (raw_row, text[, metadata]) docs as JSONL shards.

    The manifest records the complete shards, the total docs and `raw_rows`
    (= last raw row index + 1) so resume_plan can `.skip()` the stream on the
    next run. Returns the number of docs written by this call."""
    os.makedirs(out_dir, exist_ok=True)
    man = _load_manifest(out_dir, name) if start_shard else {"docs": 0, "shards": 0, "complete": []}
    man = _upgrade_manifest(out_dir, name, man, source, seed)
    complete = set(man.get("complete", []))
    records = {int(r["index"]): r for r in man.get("shard_records", [])}
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
                    item = next(docs)
                except StopIteration:
                    exhausted = True
                    break
                if not isinstance(item, tuple) or len(item) not in {2, 3}:
                    raise ValueError(
                        "corpus stream rows must be (raw_row, text[, metadata])"
                    )
                raw, t = item[0], item[1]
                metadata = item[2] if len(item) == 3 else {}
                if type(raw) is not int or raw < 0:
                    raise ValueError(
                        "corpus stream raw-row index must be a non-negative integer"
                    )
                if not isinstance(t, str) or not t:
                    raise ValueError("corpus stream text must be a non-empty string")
                if not isinstance(metadata, dict):
                    raise ValueError("corpus stream metadata must be an object")
                if "text" in metadata:
                    raise ValueError("corpus stream metadata cannot override text")
                payload = dict(metadata)
                path_value = payload.get("path")
                if path_value is None:
                    path_value = f"row/{raw:012d}"
                    payload["path"] = path_value
                if not isinstance(path_value, str) or not path_value.strip():
                    raise ValueError(
                        "corpus stream metadata path must be a non-empty string"
                    )
                payload["text"] = t
                f.write(
                    json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
                )
                n += 1
                last_raw = raw
        if n == 0:
            os.remove(tmp)
            break
        os.replace(tmp, path)
        records[shard] = {
            "index": shard,
            "filename": os.path.basename(path),
            "sha256": sha256_file(path),
            "bytes": os.path.getsize(path),
            "documents": n,
        }
        total += n
        written += n
        raw_rows = last_raw + 1
        complete.add(shard)
        man = {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": man["source"],
            "pipeline": man["pipeline"],
            "docs": total,
            "shards": max(complete) + 1,
            "shard_docs": shard_docs,
            "complete": sorted(complete),
            "raw_rows": raw_rows,
            "shard_records": [records[i] for i in sorted(records)],
        }
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
    ap.add_argument(
        "--rights-registry",
        default=str(Path(__file__).resolve().parent / "config" / "data_rights.json"),
        help="rights registry required before any tokenizer sample is streamed",
    )
    ap.add_argument(
        "--source-lock",
        default="",
        help="ilaria-corpus-source-lock-v1 with exact Hugging Face repo SHAs",
    )
    ap.add_argument(
        "--allow-unlocked-sources",
        action="store_true",
        help="smoke tests only: allow mutable upstream main revisions",
    )
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    random.seed(args.seed)
    names = [s.strip() for s in args.sources.split(",") if s.strip()]
    for n in names:
        if n not in SOURCES:
            sys.exit(f"[prepare_corpus] unknown source {n!r}; choose from {list(SOURCES)}")
    maxes = _parse_max(args.max)

    if args.source_lock and args.allow_unlocked_sources:
        raise ValueError(
            "--source-lock and --allow-unlocked-sources are mutually exclusive"
        )

    def resolve_sources() -> Dict[str, Source]:
        if args.source_lock:
            lock = load_source_lock(args.source_lock, SOURCES)
            missing = sorted(set(names) - set(lock["sources"]))
            if missing:
                raise ValueError(
                    f"source lock is missing selected sources: {missing}"
                )
            return {
                name: replace(
                    SOURCES[name],
                    revision=lock["sources"][name]["revision"],
                )
                for name in names
            }
        if not args.allow_unlocked_sources:
            raise ValueError(
                "--source-lock is required for corpus acquisition; "
                "--allow-unlocked-sources is smoke-test only"
            )
        return {name: SOURCES[name] for name in names}

    if args.tokenizer_sample:
        validate_tokenizer_sample_rights(
            args.rights_registry,
            names,
            source_lock_path=args.source_lock or None,
        )
        selected = resolve_sources()
        # one interleaved stream per language, round-robin over that language's sources
        per_lang: Dict[str, list] = {}
        for n in names:
            src = selected[n]
            per_lang.setdefault(src.lang, []).append(
                texts(src.stream(maxes.get(n), revision=src.revision))
            )

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
    selected = resolve_sources()
    grand = 0
    for name in names:
        src = selected[name]
        limit = maxes.get(name, src.default_max)
        plan = resume_plan(args.out_dir, name, limit)
        if plan["remaining"] == 0:
            print(f"\n--- {name}: already complete ({limit:,} docs), skipped ---", flush=True)
            continue
        todo = "all" if plan["remaining"] is None else f"{plan['remaining']:,}"
        print(f"\n--- {name} ({src.hf_id}{'/' + src.config if src.config else ''}, {src.lang}) up to {limit:,} docs; "
              f"skip {plan['skip_rows']:,} raw rows, start at shard {plan['start_shard']}, {todo} docs to go ---", flush=True)
        n_stream = None if plan["remaining"] is None else plan["remaining"] + plan["skip_docs"]
        stream = src.stream(
            n_stream,
            skip=plan["skip_rows"],
            revision=src.revision,
        )
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
        grand += write_shards(
            stream,
            args.out_dir,
            name,
            args.shard_docs,
            start_shard=plan["start_shard"],
            source=src,
            seed=args.seed,
        )
    print(f"\n[prepare_corpus] done: {grand:,} new docs in {args.out_dir}")
    print("Next: python forge/hf_tokenizer.py encode --tokenizer <tokenizer.json> --in <shard>.jsonl --out <shard>")


if __name__ == "__main__":
    main()
