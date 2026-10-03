"""Extract a bounded, provenance-preserving OpenMath CoT quarantine shard."""
from __future__ import annotations

import hashlib
import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import workspace_root

import pyarrow.parquet as pq


REVISION = "d3d08664755704f422af97d43a7ff0ded4bd95df"
SOURCE_PATH = "data/cot-00000-of-00144.parquet"
SOURCE_SHA256 = "6640e85f89bb829702a7d30b622acbe2bdb76bb943eb37d77ef20ab145081ddc"
LICENSE = "CC-BY-4.0"
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_CONFIGURED_CHARS = 128_000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def publish_no_clobber(temp: Path, final: Path) -> None:
    os.link(temp, final)
    temp.unlink()


def validate_limits(max_chars: int, max_output_bytes: int) -> None:
    if not 1 <= max_chars <= MAX_CONFIGURED_CHARS:
        raise ValueError(f"max_chars must be in 1..{MAX_CONFIGURED_CHARS}")
    if not 1 <= max_output_bytes <= MAX_EXTRACTED_BYTES:
        raise ValueError(f"max_output_bytes must be in 1..{MAX_EXTRACTED_BYTES}")


def row_fits_budget(current_bytes: int, payload_bytes: int, output_cap: int) -> bool:
    return current_bytes + payload_bytes <= output_cap


def within_max_chars(text: str, max_chars: int) -> bool:
    return len(text) <= max_chars


def normalized_text_hash(text: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def text_byte_hash(text: str) -> str:
    """Hash exact cleaned UTF-8 text; math case and Unicode symbols are significant."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def create_fresh_dir(path: Path) -> None:
    if path.exists():
        raise FileExistsError(f"choose a fresh output directory: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir(exist_ok=False)


def require_approved_source_rights(rights: dict) -> str:
    entry = rights.get("sources", {}).get("openmath_reasoning_cot")
    if not isinstance(entry, dict):
        raise ValueError("canonical rights registry has no OpenMath source entry")
    status = entry.get("status")
    if status != "APPROVED" or entry.get("commercial_use_approved") is not True:
        raise ValueError("canonical rights gate does not approve this source")
    return str(status)


def load_reference(path: Path, manifest_path: Path) -> tuple[set[str], int, str, str]:
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError("reference candidate manifest must be an object")
    candidate_sha = sha256_file(path)
    if (
        manifest.get("schema") != "ilaria-public-data-quarantine-manifest-v1"
        or manifest.get("source") != "nvidia/OpenMathReasoning"
        or manifest.get("source_revision") != REVISION
        or manifest.get("source_sha256") != SOURCE_SHA256
        or manifest.get("status") != "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED"
        or manifest.get("output_sha256") != candidate_sha
        or manifest.get("output_file") != path.name
    ):
        raise ValueError("reference candidate manifest identity/hash mismatch")
    seen: set[str] = set()
    docs = 0
    with path.open(encoding="utf-8") as reference:
        for line in reference:
            row = json.loads(line)
            value = row.get("text") if isinstance(row, dict) else None
            if not isinstance(value, str) or not value:
                raise ValueError("reference candidate contains an invalid document")
            seen.add(text_byte_hash(value))
            docs += 1
    if docs != manifest.get("candidate_documents"):
        raise ValueError("reference candidate document count mismatch")
    return seen, docs, candidate_sha, hashlib.sha256(manifest_bytes).hexdigest()


def candidate_accounting_commit(
    current_bytes: int,
    payload_bytes: int,
    output_cap: int,
    seen: set[str],
    norm_hash: str,
    source_counts: dict[str, int],
    source: str,
    token_count: int,
    counters: dict[str, int],
) -> bool:
    if not row_fits_budget(current_bytes, payload_bytes, output_cap):
        return False
    seen.add(norm_hash)
    source_counts[source] = source_counts.get(source, 0) + 1
    counters["tokens"] += token_count
    counters["bytes"] += payload_bytes
    counters["documents"] += 1
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("shard", type=Path)
    parser.add_argument("tokenizer", type=Path)
    parser.add_argument("fresh_output_dir", type=Path)
    parser.add_argument("--max-chars", type=int, default=80_000)
    parser.add_argument("--max-output-bytes", type=int, default=MAX_EXTRACTED_BYTES)
    parser.add_argument("--reference-jsonl", type=Path, required=True)
    parser.add_argument("--reference-manifest", type=Path, required=True)
    parser.add_argument("--forge-root", type=Path, default=workspace_root(__file__))
    args = parser.parse_args(argv)
    shard, tokenizer_path, out = args.shard, args.tokenizer, args.fresh_output_dir
    validate_limits(args.max_chars, args.max_output_bytes)
    create_fresh_dir(out)
    forge = args.forge_root.resolve() / "ilaria" / "forge"
    sys.path.insert(0, str(forge))
    from prepare_corpus import _clean_reasoning_text, scrub_pii, validate_tokenizer_sample_rights  # noqa: E402
    from hf_tokenizer import load as load_ilarialex, tokenizer_sha256  # noqa: E402
    rights_path = forge / "config" / "data_rights.json"
    source_lock_path = forge / "config" / "corpus_sources.lock.json"
    rights = validate_tokenizer_sample_rights(
        rights_path, ["openmath_reasoning_cot"], source_lock_path=source_lock_path
    )
    registry_status = require_approved_source_rights(rights)
    seen, reference_docs, reference_sha, reference_manifest_sha = load_reference(
        args.reference_jsonl, args.reference_manifest
    )
    if shard.stat().st_size > 512 * 1024 * 1024 or sha256_file(shard) != SOURCE_SHA256:
        raise SystemExit("pinned source shard size/SHA mismatch")
    tok = load_ilarialex(str(tokenizer_path))
    tok_sha = tokenizer_sha256(tokenizer_path)
    cleaner_sha = sha256_file(forge / "prepare_corpus.py")
    recipe_sha = sha256_file(Path(__file__).resolve())

    metadata_fields = ["inference_mode", "problem_type", "expected_answer", "used_in_kaggle", "generation_model", "problem_source", "pass_rate_72b_tir"]
    out_file = out / "openmath-cot.quarantine.jsonl"
    temp = out / "openmath-cot.quarantine.jsonl.tmp"
    docs = tokens = train_rows = duplicate_count = rejected_long = rejected_empty = 0
    source_row_index = 0
    bytes_out = 0
    source_counts: dict[str, int] = {}
    max_composed_chars_seen = 0
    budget_stopped = False
    first_unwritten_source_row: int | None = None
    skipped_physical_rows = 0
    parquet = pq.ParquetFile(shard)
    total_physical_rows = parquet.metadata.num_rows
    with temp.open("xb") as dest:
        for batch in parquet.iter_batches(batch_size=128, columns=["problem", "generated_solution", *metadata_fields]):
            rows = batch.to_pydict()
            for i in range(batch.num_rows):
                current_source_row = source_row_index
                source_row_index += 1
                used = rows["used_in_kaggle"][i]
                # Exclude likely benchmark-contaminated items before touching text.
                if used is not False:
                    continue
                train_rows += 1
                problem, solution = rows["problem"][i], rows["generated_solution"][i]
                if not isinstance(problem, str) or not problem.strip() or not isinstance(solution, str) or not solution.strip():
                    rejected_empty += 1
                    continue
                expected = rows["expected_answer"][i]
                text = f"Problem:\n{problem.strip()}\n\nSolution:\n{solution.strip()}"
                if isinstance(expected, str) and expected.strip():
                    text += f"\n\nExpected answer:\n{expected.strip()}"
                max_composed_chars_seen = max(max_composed_chars_seen, len(text))
                if not within_max_chars(text, args.max_chars):
                    rejected_long += 1
                    continue
                cleaned = _clean_reasoning_text(text, max_len=args.max_chars)
                if not cleaned or scrub_pii(cleaned) != cleaned:
                    rejected_empty += 1
                    continue
                text_hash = text_byte_hash(cleaned)
                norm_hash = normalized_text_hash(cleaned)
                if text_hash in seen:
                    duplicate_count += 1
                    continue
                source_row = {k: rows[k][i] for k in metadata_fields}
                source_row_bytes = json.dumps({"problem": problem, "generated_solution": solution, **source_row}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
                raw_hash = hashlib.sha256(source_row_bytes).hexdigest()
                source = str(source_row.get("problem_source") or "<missing>")
                token_count = len(tok.encode(cleaned, add_special_tokens=False).ids) + 1
                record = {
                    "schema": "ilaria-quarantined-corpus-document-v1",
                    "source": "nvidia/OpenMathReasoning",
                    "source_revision": REVISION,
                    "source_path": SOURCE_PATH,
                    "source_row": current_source_row,
                    "license": LICENSE,
                    "license_scope": "dataset-level; per-row license field unavailable",
                    "source_metadata": source_row,
                    "source_row_sha256": raw_hash,
                    "text_byte_sha256": text_hash,
                    "normalized_text_sha256": norm_hash,
                    "text": cleaned,
                }
                payload = (json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n").encode()
                accounting = {"tokens": tokens, "bytes": bytes_out, "documents": docs}
                if not candidate_accounting_commit(
                    bytes_out, len(payload), args.max_output_bytes, seen, text_hash,
                    source_counts, source, token_count, accounting,
                ):
                    budget_stopped = True
                    first_unwritten_source_row = current_source_row
                    skipped_physical_rows = total_physical_rows - current_source_row
                    break
                tokens = accounting["tokens"]
                bytes_out = accounting["bytes"]
                dest.write(payload)
                docs = accounting["documents"]
            if budget_stopped:
                break
        dest.flush()
        os.fsync(dest.fileno())
    publish_no_clobber(temp, out_file)

    manifest = {
        "schema": "ilaria-public-data-quarantine-manifest-v1",
        "status": "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED",
        "source": "nvidia/OpenMathReasoning",
        "source_revision": REVISION,
        "source_path": SOURCE_PATH,
        "source_sha256": SOURCE_SHA256,
        "source_card_path": str(shard.parent / "source-README.md"),
        "source_card_sha256": sha256_file(shard.parent / "source-README.md"),
        "source_tree_receipt_sha256": sha256_file(shard.parent / "source-tree-receipt.json"),
        "license": LICENSE,
        "rights_registry_status": registry_status,
        "unresolved_obligation": "Upstream AoPS/MATH problem-source obligations must be reviewed before production eligibility.",
        "selected_policy": "used_in_kaggle == false; cot split; problem + generated_solution + expected_answer where present; exact cleaned UTF-8 byte-hash dedup against batch1 (case and Unicode distinctions preserved); NFKC-casefold-whitespace hash is diagnostic only",
        "dedup_policy": "sha256 of exact cleaned UTF-8 bytes; case and Unicode distinctions are preserved",
        "max_composed_chars_config": args.max_chars,
        "max_composed_chars_observed_before_filter": max_composed_chars_seen,
        "over_max_rows_rejected_without_truncation": rejected_long,
        "output_cap_bytes": args.max_output_bytes,
        "output_budget_stopped": budget_stopped,
        "first_unwritten_physical_source_row": first_unwritten_source_row,
        "physical_rows_skipped_after_budget_stop": skipped_physical_rows,
        "reference_candidate_jsonl": str(args.reference_jsonl),
        "reference_candidate_sha256": reference_sha,
        "reference_candidate_manifest": str(args.reference_manifest),
        "reference_candidate_manifest_sha256": reference_manifest_sha,
        "reference_candidate_documents": reference_docs,
        "rows_after_metadata_filter": train_rows,
        "candidate_documents": docs,
        "source_counts": dict(sorted(source_counts.items())),
        "tokens_ilarialex_diagnostic_including_eos": tokens,
        "duplicates_removed": duplicate_count,
        "rejected_over_configured_max_chars_without_truncation": rejected_long,
        "rejected_empty_or_invalid": rejected_empty,
        "tokenizer_sha256": tok_sha,
        "cleaner_sha256": cleaner_sha,
        "acquisition_recipe_sha256": recipe_sha,
        "source_lock_sha256": sha256_file(source_lock_path),
        "rights_registry_sha256": sha256_file(rights_path),
        "rights_evidence_sha256": sha256_file(forge / "config" / "data_rights_evidence.json"),
        "output_file": out_file.name,
        "output_bytes": out_file.stat().st_size,
        "output_sha256": sha256_file(out_file),
        "training_performed": False,
        "production_rights_approved": False,
    }
    manifest_path = out / "candidate-manifest.json"
    manifest_temp = out / "candidate-manifest.json.tmp"
    if manifest_path.exists() or manifest_temp.exists():
        raise FileExistsError("manifest publication target exists")
    with manifest_temp.open("xb") as dest:
        dest.write((json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())
        dest.flush()
        os.fsync(dest.fileno())
    publish_no_clobber(manifest_temp, manifest_path)
    print(json.dumps({"candidate_documents": docs, "tokens_diagnostic": tokens, "bytes": out_file.stat().st_size, "sha256": manifest["output_sha256"], "manifest_sha256": sha256_file(manifest_path), "budget_stopped": budget_stopped, "physical_rows_skipped_after_budget_stop": skipped_physical_rows, "quarantine": True}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
