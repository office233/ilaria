"""Build an auditable English-Wikipedia candidate corpus with topic lanes.

This is planning/candidate data only. It never changes rights state. Every
emitted chunk keeps the upstream article id/title/url and a deterministic path
whose prefix is the exclusive IMC curriculum lane used by corpus_inventory.py.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Iterable, Iterator

try:
    from .corpus_source_lock import load_source_lock
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from .prepare_corpus import SOURCES, chunk_paragraphs
except ImportError:  # direct script execution
    from corpus_source_lock import load_source_lock
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from prepare_corpus import SOURCES, chunk_paragraphs


TOPIC_POLICY_FORMAT = "wiki-en-topic-policy-v1"
PIPELINE_NAME = "wiki-en-topic-corpus-v1"
TOPIC_LANES = frozenset({"mathematics", "science_technical_reasoning"})
GENERAL_LANE = "general_knowledge"
_SAFE_ARTICLE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def _identity_hash(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def _normalize_match_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return " ".join(normalized.split())


def _normalize_terms(values: object, *, label: str) -> list[str]:
    if not isinstance(values, list) or not values:
        raise ValueError(f"wiki topic policy {label} must be a non-empty list")
    out = []
    for raw in values:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"wiki topic policy {label} contains an invalid term")
        term = _normalize_match_text(raw)
        if not term:
            raise ValueError(f"wiki topic policy {label} contains an empty term")
        out.append(term)
    if len(set(out)) != len(out):
        raise ValueError(f"wiki topic policy {label} contains duplicate terms")
    return sorted(out)


def load_topic_policy(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        raw = json.load(stream)
    if not isinstance(raw, dict) or raw.get("format") != TOPIC_POLICY_FORMAT:
        raise ValueError("unsupported wiki topic policy format")
    if set(raw.get("lanes", {})) != TOPIC_LANES:
        raise ValueError("wiki topic policy lane set mismatch")
    lead_chars = raw.get("lead_chars")
    chunk_target = raw.get("chunk_target_chars")
    chunk_max = raw.get("chunk_max_chars")
    if type(lead_chars) is not int or lead_chars < 200:
        raise ValueError("wiki topic policy lead_chars is invalid")
    if type(chunk_target) is not int or chunk_target < 100:
        raise ValueError("wiki topic policy chunk_target_chars is invalid")
    if type(chunk_max) is not int or chunk_max < chunk_target:
        raise ValueError("wiki topic policy chunk_max_chars is invalid")

    lanes = {}
    for lane in sorted(TOPIC_LANES):
        cfg = raw["lanes"][lane]
        if not isinstance(cfg, dict):
            raise ValueError(f"wiki topic policy {lane!r} is invalid")
        min_hits = cfg.get("min_lead_hits")
        if type(min_hits) is not int or min_hits < 1:
            raise ValueError(f"wiki topic policy {lane!r} min_lead_hits is invalid")
        lanes[lane] = {
            "min_lead_hits": min_hits,
            "title_terms": _normalize_terms(
                cfg.get("title_terms"), label=f"{lane}.title_terms"
            ),
            "lead_terms": _normalize_terms(
                cfg.get("lead_terms"), label=f"{lane}.lead_terms"
            ),
        }
    policy = {
        "format": TOPIC_POLICY_FORMAT,
        "lead_chars": lead_chars,
        "chunk_target_chars": chunk_target,
        "chunk_max_chars": chunk_max,
        "lanes": lanes,
    }
    policy["policy_sha256"] = _identity_hash(policy, "policy_sha256")
    return policy


def _hits(text: str, terms: Iterable[str]) -> set[str]:
    padded = f" {_normalize_match_text(text)} "
    return {term for term in terms if f" {term} " in padded}


def classify_article(title: str, text: str, policy: dict) -> str:
    """Assign one exclusive lane; ambiguous evidence falls back to general."""
    title_matches = {
        lane: _hits(title, policy["lanes"][lane]["title_terms"])
        for lane in TOPIC_LANES
    }
    title_lanes = [lane for lane, hits in title_matches.items() if hits]
    if len(title_lanes) == 1:
        return title_lanes[0]
    if len(title_lanes) > 1:
        return GENERAL_LANE

    lead = text[: policy["lead_chars"]]
    lead_matches = {
        lane: _hits(lead, policy["lanes"][lane]["lead_terms"])
        for lane in TOPIC_LANES
    }
    eligible = [
        lane
        for lane, hits in lead_matches.items()
        if len(hits) >= policy["lanes"][lane]["min_lead_hits"]
    ]
    if len(eligible) == 1:
        return eligible[0]
    if len(eligible) == 2:
        counts = {lane: len(lead_matches[lane]) for lane in eligible}
        if counts[eligible[0]] != counts[eligible[1]]:
            return max(eligible, key=lambda lane: counts[lane])
    return GENERAL_LANE


def article_chunks(raw_index: int, article: dict, policy: dict) -> list[dict]:
    if not isinstance(article, dict):
        raise ValueError("wiki article must be an object")
    article_id = article.get("id")
    title = article.get("title")
    url = article.get("url")
    text = article.get("text")
    if not all(isinstance(value, str) and value.strip() for value in (article_id, title, url, text)):
        raise ValueError("wiki article is missing id/title/url/text provenance")
    stable_id = article_id if _SAFE_ARTICLE_ID.fullmatch(article_id) else canonical_json_sha256({"id": article_id})[:20]
    lane = classify_article(title, text, policy)
    rows = []
    for chunk_index, chunk in enumerate(
        chunk_paragraphs(
            text,
            target_chars=policy["chunk_target_chars"],
            max_len=policy["chunk_max_chars"],
        )
    ):
        rows.append(
            {
                "article_id": article_id,
                "chunk_index": chunk_index,
                "path": f"{lane}/{stable_id}/{chunk_index:04d}",
                "source_row": raw_index,
                "text": chunk,
                "title": title,
                "topic_lane": lane,
                "url": url,
            }
        )
    return rows


def _verify_existing_manifest(
    manifest_path: Path,
    *,
    source_identity: dict,
    policy: dict,
) -> dict:
    if not manifest_path.exists():
        return {
            "docs": 0,
            "raw_rows": 0,
            "shard_records": [],
            "article_counts": {GENERAL_LANE: 0, **{lane: 0 for lane in TOPIC_LANES}},
            "topic_docs": {GENERAL_LANE: 0, **{lane: 0 for lane in TOPIC_LANES}},
        }
    with manifest_path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if manifest.get("schema_version") != CORPUS_MANIFEST_SCHEMA:
        raise ValueError("wiki candidate manifest schema mismatch")
    if manifest.get("source") != source_identity:
        raise ValueError("wiki candidate source identity changed")
    pipeline = manifest.get("pipeline")
    if not isinstance(pipeline, dict) or pipeline.get("name") != PIPELINE_NAME:
        raise ValueError("wiki candidate pipeline identity changed")
    if pipeline.get("topic_policy_sha256") != policy["policy_sha256"]:
        raise ValueError("wiki candidate topic policy changed")
    for record in manifest.get("shard_records", []):
        path = manifest_path.parent / record["filename"]
        if not path.is_file():
            raise ValueError(f"wiki candidate shard is missing: {path}")
        if path.stat().st_size != int(record["bytes"]):
            raise ValueError(f"wiki candidate shard size changed: {path.name}")
        if sha256_file(path) != record["sha256"]:
            raise ValueError(f"wiki candidate shard hash changed: {path.name}")
    return manifest


def write_candidate_corpus(
    articles: Iterable[tuple[int, dict]],
    *,
    out_dir: str | Path,
    source_identity: dict,
    policy: dict,
    shard_docs: int = 20_000,
) -> dict:
    if shard_docs < 1:
        raise ValueError("wiki candidate shard_docs must be positive")
    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "wiki_en.manifest.json"
    manifest = _verify_existing_manifest(
        manifest_path, source_identity=source_identity, policy=policy
    )
    records = list(manifest.get("shard_records", []))
    shard_index = len(records)
    total_docs = int(manifest.get("docs", 0))
    raw_rows = int(manifest.get("raw_rows", 0))
    article_counts = dict(manifest.get("article_counts", {}))
    topic_docs = dict(manifest.get("topic_docs", {}))
    for lane in [GENERAL_LANE, *sorted(TOPIC_LANES)]:
        article_counts.setdefault(lane, 0)
        topic_docs.setdefault(lane, 0)
    buffer: list[dict] = []

    def persist() -> None:
        value = {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": source_identity,
            "pipeline": {
                "name": PIPELINE_NAME,
                "topic_policy_sha256": policy["policy_sha256"],
                "provenance": "article-id-title-url-source-row-v1",
                "lane_policy": "exclusive-article-topic-general-fallback-v1",
            },
            "docs": total_docs,
            "shards": len(records),
            "shard_docs": shard_docs,
            "complete": [record["index"] for record in records],
            "raw_rows": raw_rows,
            "article_counts": dict(sorted(article_counts.items())),
            "topic_docs": dict(sorted(topic_docs.items())),
            "shard_records": records,
        }
        atomic_write_json(manifest_path, value)

    def flush() -> None:
        nonlocal shard_index, total_docs
        if not buffer:
            return
        filename = f"wiki_en-{shard_index:05d}.jsonl"
        destination = output / filename
        if destination.exists():
            raise ValueError(f"wiki candidate refuses to overwrite {destination}")
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for row in buffer:
                stream.write(
                    json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                    + "\n"
                )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        count = len(buffer)
        records.append(
            {
                "index": shard_index,
                "filename": filename,
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
                "documents": count,
            }
        )
        total_docs += count
        shard_index += 1
        buffer.clear()
        persist()

    for raw_index, article in articles:
        if raw_index < raw_rows:
            raise ValueError("wiki candidate input starts before persisted raw_rows")
        rows = article_chunks(raw_index, article, policy)
        lane = rows[0]["topic_lane"] if rows else classify_article(
            str(article.get("title", "")), str(article.get("text", "")), policy
        )
        article_counts[lane] += 1
        topic_docs[lane] += len(rows)
        buffer.extend(rows)
        raw_rows = raw_index + 1
        if len(buffer) >= shard_docs:
            flush()
    flush()
    persist()
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", required=True)
    parser.add_argument(
        "--source-lock", default=str(root / "config" / "corpus_sources.lock.json")
    )
    parser.add_argument(
        "--topic-policy", default=str(root / "config" / "wiki_en_topics.json")
    )
    parser.add_argument("--max-articles", type=int, default=100_000)
    parser.add_argument("--shard-docs", type=int, default=20_000)
    args = parser.parse_args()
    if args.max_articles < 1:
        raise ValueError("--max-articles must be positive")

    policy = load_topic_policy(args.topic_policy)
    lock = load_source_lock(args.source_lock, SOURCES)
    locked = lock["sources"]["wiki_en"]
    source_identity = {
        "name": "wiki_en",
        "provider": locked["provider"],
        "config": locked["config"],
        "revision": locked["revision"],
        "language": "en",
    }
    manifest_path = Path(args.out_dir) / "wiki_en.manifest.json"
    existing = _verify_existing_manifest(
        manifest_path, source_identity=source_identity, policy=policy
    )
    start = int(existing.get("raw_rows", 0))
    if start >= args.max_articles:
        print(f"[wiki-candidate] already processed {start:,} articles")
        return

    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise RuntimeError("datasets is required for wiki candidate acquisition") from exc
    dataset = load_dataset(
        locked["provider"],
        locked["config"],
        split="train",
        streaming=True,
        revision=locked["revision"],
    )
    if start:
        dataset = dataset.skip(start)
    remaining = args.max_articles - start

    def rows() -> Iterator[tuple[int, dict]]:
        for offset, article in enumerate(dataset):
            if offset >= remaining:
                return
            yield start + offset, article

    report = write_candidate_corpus(
        rows(),
        out_dir=args.out_dir,
        source_identity=source_identity,
        policy=policy,
        shard_docs=args.shard_docs,
    )
    print(
        f"[wiki-candidate] articles={report['raw_rows']:,} docs={report['docs']:,} "
        f"topics={report['topic_docs']}"
    )


if __name__ == "__main__":
    main()
