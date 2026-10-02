"""Create a quarantined Common Corpus candidate from metadata-qualified rows.

This recipe intentionally does not change Ilaria's production data pipeline.
It requires the pinned Parquet shard and writes only rows labeled both Public
Domain and Open Culture from four explicitly book-scoped collections.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
import time

import pyarrow.parquet as pq
import pyarrow as pa


REVISION = "307910e4c5d040d6f318e6edf2a2b97849155771"
SOURCE = "PleIAs/common_corpus"
PARQUET_SHA256 = "4ee719a130b7f86978b08c20cc9f490309e2bae2a5c0df4f04fd427365530f07"
ALLOWED_COLLECTIONS = {
    "US-PD-Books",
    "French-PD-Books",
    "LoC-PD-Books",
    "Spanish-PD-Books",
}
METADATA_COLUMNS = [
    "identifier",
    "collection",
    "open_type",
    "license",
    "date",
    "title",
    "creator",
    "language",
    "language_type",
    "word_count",
    "token_count",
]
OUTPUT_CAP = 512 * 1024**2
WALL_CAP_SECONDS = 15 * 60
RETAINED_METADATA = ("identifier", "collection", "open_type", "license", "date", "language")


class Budget:
    def __init__(self, max_bytes=OUTPUT_CAP, max_seconds=WALL_CAP_SECONDS):
        self.started = time.monotonic()
        self.bytes = 0
        self.max_bytes = max_bytes
        self.max_seconds = max_seconds

    def check(self, size=0):
        if time.monotonic() - self.started > self.max_seconds:
            raise ValueError("extraction wall cap exceeded")
        if self.bytes + size > self.max_bytes:
            raise ValueError("extraction output cap exceeded")
        self.bytes += size


def write_new_json(path: Path, value: dict, budget: Budget):
    payload = canonical_json(value)
    budget.check(len(payload))
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.link(temporary, path)
    temporary.unlink()


def seed_dedup(manifest_path: Path, document_hash, seen: set[str]) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if Path(manifest["output_file"]).name != manifest["output_file"]:
        raise ValueError("invalid frozen seed filename")
    path = manifest_path.parent / manifest["output_file"]
    if sha256_file(path) != manifest["output_sha256"]:
        raise ValueError("frozen dedup seed hash mismatch")
    count = repeated = 0
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            digest = document_hash(row["text"])
            repeated += digest in seen
            seen.add(digest)
            count += 1
    if count != manifest["candidate_documents_after_cleaning_and_exact_dedup"]:
        raise ValueError("frozen dedup seed count mismatch")
    return {"manifest_sha256": sha256_file(manifest_path), "candidate_sha256": sha256_file(path),
            "documents": count, "normalized_duplicates_already_in_frozen_seed": repeated}


def metadata_value(value):
    # Dates are literal decimal strings for integer inputs, not invented years
    # or timestamps. The input type remains explicit for later source review.
    if value is None or isinstance(value, str):
        return value
    if type(value) is int:
        return str(value)
    raise ValueError("unsupported selected metadata scalar type")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def paragraph_segments(paragraph: str, max_chars: int = 2800):
    """Split without dropping source characters before the canonical cleaner."""
    rest = paragraph.strip()
    while len(rest) > max_chars:
        floor = max_chars // 2
        cut = max(
            rest.rfind(". ", floor, max_chars),
            rest.rfind("? ", floor, max_chars),
            rest.rfind("! ", floor, max_chars),
            rest.rfind("\n", floor, max_chars),
        )
        if cut >= floor:
            cut += 1
        else:
            cut = rest.rfind(" ", floor, max_chars)
            if cut < floor:
                cut = max_chars
        yield rest[:cut].strip()
        rest = rest[cut:].lstrip()
    if rest:
        yield rest


def extract(parquet_path: Path, tokenizer_path: Path, output_dir: Path, *,
            forge_root: Path, expected_sha256: str, source_path: str,
            source_card: Path, seen: set[str], budget: Budget,
            seed_bindings: list[dict]) -> dict:
    budget.check()
    parquet_hash = sha256_file(parquet_path)
    if (len(expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in expected_sha256)
            or parquet_hash != expected_sha256):
        raise ValueError("pinned Parquet SHA-256 mismatch")
    if source_path != "common_corpus_1/" + parquet_path.name:
        raise ValueError("source path differs from shard filename")
    forge = forge_root.resolve() / "ilaria" / "forge"
    sys.path.insert(0, str(forge))
    from prepare_corpus import clean_text, scrub_pii  # noqa: E402
    from data_audit import document_sha256  # noqa: E402
    from hf_tokenizer import load as load_ilarialex, tokenizer_sha256  # noqa: E402
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["RAYON_NUM_THREADS"] = "2"
    pa.set_cpu_count(2)
    pa.set_io_thread_count(1)
    output_dir.mkdir(parents=True, exist_ok=False)
    recipe_sha = sha256_file(Path(__file__))
    cleaner_path = forge / "prepare_corpus.py"
    cleaner_sha = sha256_file(cleaner_path)
    tokenizer = load_ilarialex(str(tokenizer_path))
    tokenizer_sha = tokenizer_sha256(tokenizer_path)
    fields = METADATA_COLUMNS + ["text"]
    source_rows = selected_rows = segmented_long_paragraphs = rejected_empty_rows = 0
    token_count = written_docs = duplicates_removed = rejected_segments = 0
    by_collection: dict[str, int] = {}
    by_language: dict[str, int] = {}
    jsonl_path = output_dir / "common-corpus-pd-books.quarantine.jsonl"
    tmp_path = jsonl_path.with_suffix(jsonl_path.suffix + ".tmp")
    def normalized(value: object) -> str:
        return value.strip() if isinstance(value, str) and value.strip() else ""
    with tmp_path.open("xb") as output:
        parquet = pq.ParquetFile(parquet_path)
        for batch in parquet.iter_batches(batch_size=32, columns=fields, use_threads=False):
            budget.check()
            data = batch.to_pydict()
            for i in range(batch.num_rows):
                budget.check()
                source_rows += 1
                collection = normalized(data["collection"][i])
                if (
                    normalized(data["open_type"][i]) != "Open Culture"
                    or normalized(data["license"][i]).casefold() != "public domain"
                    or collection not in ALLOWED_COLLECTIONS
                ):
                    continue

                source_text = data["text"][i]
                if not isinstance(source_text, str) or not source_text.strip():
                    rejected_empty_rows += 1
                    continue
                selected_rows += 1
                by_collection[collection] = by_collection.get(collection, 0) + 1
                language = normalized(data["language"][i]) or "<MISSING>"
                by_language[language] = by_language.get(language, 0) + 1
                raw_doc_sha = sha256_bytes(source_text.encode("utf-8"))
                identifier = metadata_value(data["identifier"][i])
                book_identity = {"source": SOURCE, "revision": REVISION, "collection": collection,
                                 "identifier": identifier or raw_doc_sha}
                book_group = sha256_bytes(canonical_json(book_identity))
                source_segment = 0
                for paragraph_index, paragraph in enumerate(source_text.replace("\r", "").split("\n\n")):
                    paragraph = paragraph.strip()
                    if len(paragraph) > 2800:
                        segmented_long_paragraphs += 1
                    for segment in paragraph_segments(paragraph):
                        budget.check()
                        segment_index = source_segment
                        source_segment += 1  # physical ordinal also advances for rejected/duplicate segments
                        # Masking may expand text; use a recorded safe upper
                        # bound instead of invoking the cleaner's truncation.
                        no_clip_limit = max(3000, len(segment) * 2 + 4096)
                        candidate = clean_text(segment, max_len=no_clip_limit)
                        if not candidate:
                            rejected_segments += 1
                            continue
                        # Canonical cleaning masks email/phone/IBAN. Keep only
                        # the sanitized value and verify those patterns are absent.
                        if scrub_pii(candidate) != candidate:
                            rejected_segments += 1
                            continue
                        candidate_bytes = candidate.encode("utf-8")
                        candidate_sha = sha256_bytes(candidate_bytes)
                        normalized_sha = document_sha256(candidate)
                        if normalized_sha in seen:
                            duplicates_removed += 1
                            continue
                        seen.add(normalized_sha)
                        encoded = tokenizer.encode(candidate, add_special_tokens=False)
                        token_count += len(encoded.ids) + 1  # canonical EOS per document
                        meta = {key: metadata_value(data[key][i]) for key in RETAINED_METADATA}
                        meta["date_input_type"] = type(data["date"][i]).__name__
                        record = {
                            "schema": "ilaria-quarantined-corpus-document-v1",
                            "source": SOURCE,
                            "source_revision": REVISION,
                            "source_path": source_path,
                            "source_parquet_sha256": parquet_hash,
                            "source_row": source_rows - 1,
                            "source_segment": segment_index,
                            "source_paragraph": paragraph_index,
                            "source_segment_sha256": sha256_bytes(segment.encode("utf-8")),
                            "original_book_group_sha256": book_group,
                            "source_metadata": meta,
                            "raw_document_sha256": raw_doc_sha,
                            "candidate_text_sha256": candidate_sha,
                            "document_sha256": normalized_sha,
                            "text": candidate,
                        }
                        encoded_record = canonical_json(record)
                        budget.check(len(encoded_record))
                        output.write(encoded_record)
                        written_docs += 1
        output.flush()
        os.fsync(output.fileno())

    os.link(tmp_path, jsonl_path)
    tmp_path.unlink()
    manifest = {
        "schema": "ilaria-public-data-quarantine-manifest-v1",
        "status": "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED",
        "source": SOURCE,
        "source_revision": REVISION,
        "source_path": source_path,
        "source_parquet_sha256": parquet_hash,
        "source_card": source_card.name,
        "source_card_sha256": sha256_file(source_card),
        "acquisition_recipe_sha256": recipe_sha,
        "dependency_versions": {"pyarrow": pa.__version__},
        "candidate_policy": {
            "open_type_equals": "Open Culture",
            "license_equals_case_insensitive": "Public Domain",
            "collections_allowlist": sorted(ALLOWED_COLLECTIONS),
            "explicit_exclusions": [
                "government records",
                "court/case records",
                "newspaper collections",
                "non-book collections",
            ],
        },
        "source_rows_scanned": source_rows,
        "selected_source_rows": selected_rows,
        "selected_rows_by_collection": dict(sorted(by_collection.items())),
        "selected_rows_by_language": dict(sorted(by_language.items())),
        "romanian_selected_rows": by_language.get("Romanian", 0),
        "candidate_documents_after_cleaning_and_exact_dedup": written_docs,
        "dedup_policy": "data_audit.document_sha256; NFKC-casefold-whitespace-v1",
        "dedup_seed_bindings": seed_bindings,
        "duplicates_removed_against_prior_and_current_candidates": duplicates_removed,
        "rejected_cleaning_segments": rejected_segments,
        "segment_policy": "max2800-input; physical-monotonic-ordinal; cleaner-no-clip-limit=max3000,2len+4096",
        "retained_metadata": list(RETAINED_METADATA),
        "date_normalization": "integer to literal base10 string; preserve input type; no date interpretation",
        "rejected_empty_source_rows": rejected_empty_rows,
        "segmented_long_paragraphs_without_truncation": segmented_long_paragraphs,
        "candidate_token_count_ilarialex_diagnostic_only": token_count,
        "tokenizer_path": str(tokenizer_path),
        "tokenizer_sha256": tokenizer_sha,
        "cleaner_path": str(cleaner_path),
        "cleaner_sha256": cleaner_sha,
        "output_file": jsonl_path.name,
        "output_bytes": jsonl_path.stat().st_size,
        "output_sha256": sha256_file(jsonl_path),
        "training_performed": False,
        "production_rights_approved": False,
    }
    manifest_path = output_dir / "candidate-manifest.json"
    write_new_json(manifest_path, manifest, budget)
    print(
        json.dumps(
            {
                "source_rows_scanned": source_rows,
                "selected_source_rows": selected_rows,
                "rows_by_collection": by_collection,
                "rows_by_language": by_language,
                "romanian_selected_rows": by_language.get("Romanian", 0),
                "candidate_documents": written_docs,
                "candidate_tokens_diagnostic": token_count,
                "segmented_long_paragraphs": segmented_long_paragraphs,
                "candidate_bytes": jsonl_path.stat().st_size,
                "candidate_sha256": manifest["output_sha256"],
                "manifest_sha256": sha256_file(manifest_path),
                "quarantine_only": True,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    if sha256_file(cleaner_path) != cleaner_sha or tokenizer_sha256(tokenizer_path) != tokenizer_sha:
        raise ValueError("canonical dependency drift")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("parquet_path", type=Path)
    parser.add_argument("tokenizer_path", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--forge-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--expected-sha256", default=PARQUET_SHA256)
    parser.add_argument("--source-path", default="common_corpus_1/subset_100_1.parquet")
    parser.add_argument("--source-card", type=Path, required=True)
    parser.add_argument("--dedup-against", action="append", type=Path, default=[])
    args = parser.parse_args()
    sys.path.insert(0, str(args.forge_root.resolve() / "ilaria" / "forge"))
    from data_audit import document_sha256
    seen: set[str] = set()
    seeds = [seed_dedup(p, document_sha256, seen) for p in args.dedup_against]
    extract(args.parquet_path, args.tokenizer_path, args.output_dir,
            forge_root=args.forge_root, expected_sha256=args.expected_sha256,
            source_path=args.source_path, source_card=args.source_card,
            seen=seen, budget=Budget(), seed_bindings=seeds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
