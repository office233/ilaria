from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path

import pytest


RECIPE = Path(__file__).with_name("acquire_cot_shard.py")


def load_recipe():
    spec = importlib.util.spec_from_file_location("openmath_acquisition", RECIPE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_length_policy_keeps_boundary_and_rejects_whole_over_limit_row() -> None:
    recipe = load_recipe()
    limit = 80_000
    assert recipe.within_max_chars("x" * limit, limit)
    assert not recipe.within_max_chars("x" * (limit + 1), limit)
    recipe.validate_limits(limit, 512 * 1024 * 1024)
    with pytest.raises(ValueError, match="max_chars"):
        recipe.validate_limits(128_001, 512 * 1024 * 1024)


def test_output_budget_allows_exact_boundary_only() -> None:
    recipe = load_recipe()
    assert recipe.row_fits_budget(90, 10, 100)
    assert not recipe.row_fits_budget(90, 11, 100)


def test_existing_output_refuses_before_source_or_tokenizer_load_and_preserves_bytes(
    tmp_path: Path,
) -> None:
    recipe = load_recipe()
    output = tmp_path / "existing"
    output.mkdir()
    sentinel = output / "openmath-cot.quarantine.jsonl"
    sentinel.write_bytes(b"keep these bytes\n")
    args = [
        "missing-source.parquet",
        "missing-tokenizer.json",
        str(output),
        "--max-chars",
        "80000",
        "--max-output-bytes",
        "512",
        "--reference-jsonl",
        "missing-reference.jsonl",
        "--reference-manifest",
        "missing-reference-manifest.json",
    ]
    with pytest.raises(FileExistsError, match="fresh output directory"):
        recipe.main(args)
    assert sentinel.read_bytes() == b"keep these bytes\n"


def test_rights_gate_fails_closed_when_registry_is_tampered() -> None:
    recipe = load_recipe()
    with pytest.raises(ValueError, match="does not approve"):
        recipe.require_approved_source_rights({
            "sources": {"openmath_reasoning_cot": {
                "status": "APPROVED", "commercial_use_approved": False,
            }}
        })


def test_reference_requires_matching_manifest_identity_hash_and_document_count(
    tmp_path: Path,
) -> None:
    recipe = load_recipe()
    candidate = tmp_path / "reference.jsonl"
    candidate.write_text('{"text":"reference document"}\n', encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    manifest = {
        "schema": "ilaria-public-data-quarantine-manifest-v1",
        "source": "nvidia/OpenMathReasoning",
        "source_revision": recipe.REVISION,
        "source_sha256": recipe.SOURCE_SHA256,
        "status": "QUARANTINE_NOT_PRODUCTION_RIGHTS_APPROVED",
        "output_sha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        "output_file": candidate.name,
        "candidate_documents": 1,
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    seen, docs, candidate_hash, manifest_hash = recipe.load_reference(candidate, manifest_path)
    assert docs == 1
    assert candidate_hash == manifest["output_sha256"]
    assert manifest_hash == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    assert recipe.normalized_text_hash("reference document") in seen
    manifest["candidate_documents"] = 2
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="document count"):
        recipe.load_reference(candidate, manifest_path)


def test_budget_rejection_does_not_commit_candidate_accounting() -> None:
    recipe = load_recipe()
    seen = {"reference"}
    source_counts = {"already-emitted": 1}
    counters = {"tokens": 9, "bytes": 90, "documents": 1}
    assert not recipe.candidate_accounting_commit(
        90, 11, 100, seen, "candidate", source_counts, "math", 7, counters,
    )
    assert seen == {"reference"}
    assert source_counts == {"already-emitted": 1}
    assert counters == {"tokens": 9, "bytes": 90, "documents": 1}
    assert recipe.candidate_accounting_commit(
        90, 10, 100, seen, "candidate", source_counts, "math", 7, counters,
    )
    assert seen == {"reference", "candidate"}
    assert source_counts["math"] == 1
    assert counters == {"tokens": 16, "bytes": 100, "documents": 2}


def test_exact_text_dedup_preserves_math_case_and_unicode_distinctions() -> None:
    recipe = load_recipe()
    assert recipe.normalized_text_hash("x") == recipe.normalized_text_hash("X")
    assert recipe.text_byte_hash("x") != recipe.text_byte_hash("X")
    assert recipe.normalized_text_hash("ℕ") == recipe.normalized_text_hash("N")
    assert recipe.text_byte_hash("ℕ") != recipe.text_byte_hash("N")
