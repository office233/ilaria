from __future__ import annotations

import hashlib
from importlib import import_module
import json
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root

import pytest

import scan
import verify

FORGE = ilaria_root(__file__) / "forge"
import sys
sys.path.insert(0, str(FORGE))
_contract = import_module("data_contract")
_audit = import_module("data_audit")
canonical_json_sha256 = _contract.canonical_json_sha256
sha256_file = _contract.sha256_file
document_sha256 = _audit.document_sha256


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def _write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, sort_keys=True) + "\n")


def _artifact(root: Path, artifact_id: str, relative: str) -> dict:
    path = root / relative
    return {
        "artifact_id": artifact_id,
        "file": relative.replace("\\", "/"),
        "sha256": sha256_file(path),
    }


def _row(text: str, group: str) -> dict:
    return {
        "text": text,
        "source_group": group,
        "document_sha256": document_sha256(text),
    }


def _selection(root: Path, train_text: str) -> dict:
    directory = root / "tokenizer"
    directory.mkdir()
    emitted = (train_text.replace("\r", " ").replace("\n", " ").strip() + "\n").encode("utf-8")
    sample = directory / "sample.txt"
    sample.write_bytes(emitted)
    ledger_row = {
        "format": scan.LEDGER_FORMAT,
        "input": {"fixture": "train-only"},
        "row_identity_sha256": "1" * 64,
        "document_sha256": document_sha256(train_text),
        "item_metadata": {},
        "identifier_field": None,
        "emitted": {
            "sha256": hashlib.sha256(emitted).hexdigest(),
            "bytes": len(emitted),
            "byte_start": 0,
            "byte_end": len(emitted),
        },
    }
    ledger = directory / "sample.selection.ledger.jsonl"
    _write_jsonl(ledger, [ledger_row])
    metadata = {
        "format": scan.SELECTION_FORMAT,
        "generator": {"format": "fixture-generator-v1"},
        "origin": {"kind": "fixture", "source": "fixture"},
        "selection_policy": "fixture",
        "normalization": scan.NORMALIZATION,
        "target_bytes": len(emitted),
        "materialization_limits": {
            "max_row_bytes": 65536,
            "max_document_bytes": 65536,
            "max_ledger_row_bytes": 65536,
            "max_metadata_bytes": 65536,
        },
        "sample": {
            "filename": sample.name,
            "sha256": sha256_file(sample),
            "bytes": sample.stat().st_size,
            "documents": 1,
        },
        "ledger": {
            "filename": ledger.name,
            "sha256": sha256_file(ledger),
            "bytes": ledger.stat().st_size,
            "documents": 1,
        },
        "verification": "fixture",
    }
    metadata["selection_sha256"] = canonical_json_sha256(metadata)
    metadata_path = directory / "sample.selection.json"
    _write_json(metadata_path, metadata)
    return _artifact(root, "tokenizer-fixture", "tokenizer/sample.selection.json")


def fixture(
    tmp_path: Path,
    *,
    train_text: str | None = None,
    validation_text: str | None = None,
    sealed_text: str | None = None,
    train_group: str = "group-train",
    validation_group: str = "group-validation",
    sealed_group: str = "group-sealed",
    benchmark_text: str | None = None,
) -> tuple[Path, dict]:
    root = tmp_path / "package"
    root.mkdir()
    train_text = train_text or "train alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu unique"
    validation_text = validation_text or "validation red orange yellow green blue indigo violet copper silver gold quartz unique"
    sealed_text = sealed_text or "sealed north south east west spring summer autumn winter cedar birch maple unique"
    benchmark_text = benchmark_text or "benchmark aardvark bison cougar dolphin eagle falcon gecko heron ibis jaguar koala lemur"

    _write_jsonl(root / "train.jsonl", [_row(train_text, train_group)])
    _write_jsonl(root / "validation.jsonl", [_row(validation_text, validation_group)])
    _write_jsonl(root / "sealed.jsonl", [_row(sealed_text, sealed_group)])
    _write_jsonl(root / "benchmark.jsonl", [{"prompt": benchmark_text}])
    selection_record = _selection(root, train_text)

    benchmark_sha = sha256_file(root / "benchmark.jsonl")
    binding = {
        "dataset": {
            "manifest_file_sha256": "1" * 64,
            "identity_sha256": "2" * 64,
            "train_stream_sha256": "3" * 64,
            "validation_stream_sha256": "4" * 64,
        },
        "tokenizer": {
            "sha256": "5" * 64,
            "freeze_file_sha256": "6" * 64,
            "freeze_sha256": "7" * 64,
        },
        "benchmark_plan_sha256": "8" * 64,
        "benchmark_artifacts": [
            {"path": "bench/frozen.jsonl", "sha256": benchmark_sha},
        ],
    }
    value = {
        "format": scan.INPUT_FORMAT,
        "binding": binding,
        "shingle_width": 12,
        "group_field": "source_group",
        "limits": {
            "max_row_bytes": 1024 * 1024,
            "max_ledger_row_bytes": 1024 * 1024,
            "max_documents": 1000,
            "max_files": 100,
        },
        "splits": {
            "train": [_artifact(root, "train-main", "train.jsonl")],
            "validation": [_artifact(root, "validation-main", "validation.jsonl")],
            "sealed": [_artifact(root, "sealed-main", "sealed.jsonl")],
        },
        "tokenizer_selections": [selection_record],
        "benchmarks": [_artifact(root, "bench/frozen.jsonl", "benchmark.jsonl")],
    }
    value["input_sha256"] = canonical_json_sha256(value)
    manifest = root / "input.json"
    _write_json(manifest, value)
    return manifest, value


def test_zero_scan_and_independent_verifier_emit_gate_compatible_clearance(tmp_path):
    manifest, value = fixture(tmp_path)
    produced = scan.scan(manifest)
    assert produced["state"] == "SCAN_COMPLETE"
    assert produced["checks"] == {name: 0 for name in scan.ZERO_CHECKS}
    scan_path = tmp_path / "scan.json"
    _write_json(scan_path, produced)

    clearance = verify.verify(
        manifest,
        scan_path,
        reviewed_by="independent-fixture-reviewer",
        review_ref="fixture-review:zero-overlap",
    )
    assert clearance["format"] == verify.CLEARANCE_FORMAT
    assert clearance["state"] == "VERIFIED_INDEPENDENT"
    assert clearance["validation_level"] == verify.VALIDATION_LEVEL
    assert clearance["binding"] == value["binding"]
    assert clearance["checks"] == {name: 0 for name in verify.ZERO_CHECKS}
    assert clearance["allocation_authorized"] is False
    assert clearance["promotion_authorized"] is False
    assert any(item["scope"] == "sealed" for item in clearance["heldout_artifacts"])
    required = {
        "production.validation.stream": ("validation", value["binding"]["dataset"]["validation_stream_sha256"]),
        "benchmark:bench/frozen.jsonl": ("benchmark", value["binding"]["benchmark_artifacts"][0]["sha256"]),
    }
    observed = {
        item["artifact_id"]: (item["scope"], item["sha256"])
        for item in clearance["heldout_artifacts"]
    }
    assert all(observed[key] == expected for key, expected in required.items())
    unsigned = dict(clearance)
    declared = unsigned.pop("clearance_sha256")
    assert canonical_json_sha256(unsigned) == declared
    assert clearance["producer_source_sha256"] != clearance["verifier_source_sha256"]


def test_exact_train_validation_overlap_is_counted_and_refused(tmp_path):
    same = "same exact document with twelve words alpha beta gamma delta epsilon zeta eta theta"
    manifest, _ = fixture(tmp_path, train_text=same, validation_text=same)
    produced = scan.scan(manifest)
    assert produced["checks"]["train_validation_exact_overlap"] == 1
    path = tmp_path / "scan.json"
    _write_json(path, produced)
    with pytest.raises(verify.VerifyError, match="non-zero"):
        verify.verify(manifest, path, reviewed_by="r", review_ref="x")


def test_tokenizer_heldout_exact_and_normalized_overlap_are_counted(tmp_path):
    same = "tokenizer heldout collision exact alpha beta gamma delta epsilon zeta eta theta iota"
    manifest, _ = fixture(tmp_path, train_text=same, sealed_text=same)
    produced = scan.scan(manifest)
    assert produced["checks"]["tokenizer_heldout_exact_overlap"] == 1
    assert produced["checks"]["tokenizer_heldout_normalized_overlap"] == 1


def test_group_overlap_is_counted_even_with_different_text(tmp_path):
    manifest, _ = fixture(
        tmp_path,
        train_group="shared-group",
        sealed_group="shared-group",
    )
    produced = scan.scan(manifest)
    assert produced["checks"]["group_overlap"] == 1


def test_benchmark_shingle_overlap_is_counted(tmp_path):
    collision = "benchmark aardvark bison cougar dolphin eagle falcon gecko heron ibis jaguar koala lemur plus"
    manifest, _ = fixture(tmp_path, validation_text=collision)
    produced = scan.scan(manifest)
    assert produced["checks"]["dataset_benchmark_shingle_overlap"] == 1


def test_tampered_scan_is_rejected_by_independent_replay(tmp_path):
    manifest, _ = fixture(tmp_path)
    produced = scan.scan(manifest)
    produced["stats"]["documents"]["train"] = 999
    unsigned = dict(produced)
    unsigned.pop("scan_sha256")
    produced["scan_sha256"] = canonical_json_sha256(unsigned)
    path = tmp_path / "scan.json"
    _write_json(path, produced)
    with pytest.raises(verify.VerifyError, match="independent replay"):
        verify.verify(manifest, path, reviewed_by="r", review_ref="x")


def test_tampered_sample_is_rejected_before_overlap_claim(tmp_path):
    manifest, _ = fixture(tmp_path)
    sample = manifest.parent / "tokenizer" / "sample.txt"
    sample.write_bytes(sample.read_bytes() + b"x")
    with pytest.raises((scan.ScanError, verify.VerifyError)):
        scan.scan(manifest)


def test_missing_explicit_group_id_is_refused(tmp_path):
    manifest, value = fixture(tmp_path)
    row = json.loads((manifest.parent / "sealed.jsonl").read_text().strip())
    del row["source_group"]
    _write_jsonl(manifest.parent / "sealed.jsonl", [row])
    value["splits"]["sealed"][0]["sha256"] = sha256_file(manifest.parent / "sealed.jsonl")
    unsigned = dict(value)
    unsigned.pop("input_sha256")
    value["input_sha256"] = canonical_json_sha256(unsigned)
    _write_json(manifest, value)
    with pytest.raises(scan.ScanError, match="group"):
        scan.scan(manifest)


def test_benchmark_binding_drift_is_refused(tmp_path):
    manifest, value = fixture(tmp_path)
    value["binding"]["benchmark_artifacts"][0]["sha256"] = "9" * 64
    unsigned = dict(value)
    unsigned.pop("input_sha256")
    value["input_sha256"] = canonical_json_sha256(unsigned)
    _write_json(manifest, value)
    with pytest.raises(scan.ScanError, match="benchmark package"):
        scan.scan(manifest)


def test_selection_ledger_fragment_tamper_is_refused(tmp_path):
    manifest, value = fixture(tmp_path)
    ledger = manifest.parent / "tokenizer" / "sample.selection.ledger.jsonl"
    row = json.loads(ledger.read_text().strip())
    row["emitted"]["sha256"] = "a" * 64
    _write_jsonl(ledger, [row])
    meta = json.loads((manifest.parent / "tokenizer" / "sample.selection.json").read_text())
    meta["ledger"]["sha256"] = sha256_file(ledger)
    meta["ledger"]["bytes"] = ledger.stat().st_size
    unsigned_meta = dict(meta)
    unsigned_meta.pop("selection_sha256")
    meta["selection_sha256"] = canonical_json_sha256(unsigned_meta)
    _write_json(manifest.parent / "tokenizer" / "sample.selection.json", meta)
    value["tokenizer_selections"][0]["sha256"] = sha256_file(
        manifest.parent / "tokenizer" / "sample.selection.json"
    )
    unsigned = dict(value)
    unsigned.pop("input_sha256")
    value["input_sha256"] = canonical_json_sha256(unsigned)
    _write_json(manifest, value)
    with pytest.raises(scan.ScanError, match="sample fragment"):
        scan.scan(manifest)


def test_review_metadata_is_required(tmp_path):
    manifest, _ = fixture(tmp_path)
    produced = scan.scan(manifest)
    path = tmp_path / "scan.json"
    _write_json(path, produced)
    with pytest.raises(verify.VerifyError, match="reviewed_by"):
        verify.verify(manifest, path, reviewed_by="", review_ref="x")
    with pytest.raises(verify.VerifyError, match="review_ref"):
        verify.verify(manifest, path, reviewed_by="r", review_ref="")
