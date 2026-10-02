"""Bounded producer scan for production contamination separation.

This module computes hashes/counters only. It never grants readiness, promotion,
allocation or rights approval. A separate verifier implementation must independently
recompute the same package before a clearance can exist.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib import import_module
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import sys
import tempfile
from typing import Any, Mapping

FORGE = Path(__file__).resolve().parents[2] / "forge"
sys.path.insert(0, str(FORGE))

_audit = import_module("data_audit")
_contract = import_module("data_contract")
benchmark_shingles = _audit.benchmark_shingles
document_sha256 = _audit.document_sha256
shingle_hashes = _audit.shingle_hashes
canonical_json_sha256 = _contract.canonical_json_sha256
require_lower_sha256 = _contract.require_lower_sha256
sha256_file = _contract.sha256_file


INPUT_FORMAT = "ilaria-production-contamination-input-v1"
SCAN_FORMAT = "ilaria-production-contamination-scan-v1"
SELECTION_FORMAT = "ilarialex-production-selection-v1"
LEDGER_FORMAT = "ilarialex-production-selection-row-v1"
NORMALIZATION = "replace-cr-lf-with-space-strip-append-lf-v1"
ZERO_CHECKS = (
    "train_validation_exact_overlap",
    "tokenizer_heldout_exact_overlap",
    "tokenizer_heldout_normalized_overlap",
    "dataset_benchmark_shingle_overlap",
    "group_overlap",
)
MAX_METADATA_BYTES = 2 * 1024 * 1024


class ScanError(ValueError):
    """Malformed or unsafe contamination scan input."""


def _pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise ScanError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _load_json(path: Path, cap: int = MAX_METADATA_BYTES) -> Any:
    if path.is_symlink() or not path.is_file():
        raise ScanError(f"metadata missing or symlinked: {path}")
    with path.open("rb") as stream:
        raw = stream.read(cap + 1)
    if len(raw) > cap:
        raise ScanError(f"metadata exceeds byte cap: {path}")

    def nonfinite(value):
        raise ScanError(f"non-finite JSON value: {value}")

    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)


def _source_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _safe_relative(root: Path, value: Any) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or ":" in value
        or PurePosixPath(value).is_absolute()
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise ScanError("unsafe package-relative path")
    candidate = root.joinpath(*PurePosixPath(value).parts)
    if candidate.is_symlink():
        raise ScanError("package input symlink is forbidden")
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    if resolved_root != resolved and resolved_root not in resolved.parents:
        raise ScanError("package input escapes package root")
    return candidate


def _hash_field(name: str, value: Any) -> str:
    if not isinstance(value, str):
        raise ScanError(f"{name} must be SHA-256 text")
    require_lower_sha256(name, value)
    return value


def _limits(value: Any) -> dict[str, int]:
    expected = {
        "max_row_bytes",
        "max_ledger_row_bytes",
        "max_documents",
        "max_files",
    }
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ScanError("limits fields differ")
    result = {}
    for key in expected:
        item = value[key]
        if type(item) is not int or item <= 0 or item > 100_000_000:
            raise ScanError(f"invalid {key}")
        result[key] = item
    if result["max_row_bytes"] > 16 * 1024 * 1024:
        raise ScanError("max_row_bytes exceeds hard cap")
    if result["max_ledger_row_bytes"] > 4 * 1024 * 1024:
        raise ScanError("max_ledger_row_bytes exceeds hard cap")
    if result["max_files"] > 100_000:
        raise ScanError("max_files exceeds hard cap")
    return result


def _binding(value: Any) -> dict:
    if not isinstance(value, Mapping):
        raise ScanError("binding must be an object")
    expected = {
        "dataset",
        "tokenizer",
        "benchmark_plan_sha256",
        "benchmark_artifacts",
    }
    if set(value) != expected:
        raise ScanError("binding fields differ")
    dataset = value["dataset"]
    tokenizer = value["tokenizer"]
    if not isinstance(dataset, Mapping) or set(dataset) != {
        "manifest_file_sha256",
        "identity_sha256",
        "train_stream_sha256",
        "validation_stream_sha256",
    }:
        raise ScanError("dataset binding fields differ")
    if not isinstance(tokenizer, Mapping) or set(tokenizer) != {
        "sha256",
        "freeze_file_sha256",
        "freeze_sha256",
    }:
        raise ScanError("tokenizer binding fields differ")
    for key, digest in dataset.items():
        _hash_field(f"dataset:{key}", digest)
    for key, digest in tokenizer.items():
        _hash_field(f"tokenizer:{key}", digest)
    _hash_field("benchmark_plan_sha256", value["benchmark_plan_sha256"])
    artifacts = value["benchmark_artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise ScanError("benchmark binding inventory is empty")
    seen = set()
    for record in artifacts:
        if not isinstance(record, Mapping) or set(record) != {"path", "sha256"}:
            raise ScanError("benchmark binding record is invalid")
        path = record["path"]
        if not isinstance(path, str) or not path or path in seen:
            raise ScanError("benchmark binding path is invalid/duplicated")
        seen.add(path)
        _hash_field(f"benchmark:{path}", record["sha256"])
    return json.loads(json.dumps(value))


def _artifact_records(
    root: Path,
    records: Any,
    *,
    limits: dict[str, int],
    require_nonempty: bool = True,
) -> list[dict]:
    if not isinstance(records, list) or (require_nonempty and not records):
        raise ScanError("artifact inventory must be a non-empty list")
    if len(records) > limits["max_files"]:
        raise ScanError("artifact inventory exceeds file cap")
    out = []
    seen_ids = set()
    seen_files = set()
    for record in records:
        if not isinstance(record, Mapping) or set(record) != {"artifact_id", "file", "sha256"}:
            raise ScanError("artifact record fields differ")
        artifact_id = record["artifact_id"]
        if (
            not isinstance(artifact_id, str)
            or not artifact_id
            or len(artifact_id) > 512
            or any(ch in artifact_id for ch in "\r\n\0")
            or artifact_id in seen_ids
        ):
            raise ScanError("artifact_id is invalid/duplicated")
        path = _safe_relative(root, record["file"])
        if path in seen_files:
            raise ScanError("artifact file is duplicated")
        digest = _hash_field(f"{artifact_id}:sha256", record["sha256"])
        if not path.is_file() or sha256_file(path) != digest:
            raise ScanError(f"artifact byte identity differs: {artifact_id}")
        out.append({"artifact_id": artifact_id, "path": path, "sha256": digest})
        seen_ids.add(artifact_id)
        seen_files.add(path)
    return out


def load_input(path: str | Path) -> dict:
    manifest_path = Path(path).resolve()
    value = _load_json(manifest_path)
    if not isinstance(value, Mapping) or value.get("format") != INPUT_FORMAT:
        raise ScanError(f"unsupported {INPUT_FORMAT} input")
    expected = {
        "format",
        "input_sha256",
        "binding",
        "shingle_width",
        "group_field",
        "limits",
        "splits",
        "tokenizer_selections",
        "benchmarks",
    }
    if set(value) != expected:
        raise ScanError("input manifest fields differ")
    declared = _hash_field("input_sha256", value["input_sha256"])
    unsigned = dict(value)
    del unsigned["input_sha256"]
    if canonical_json_sha256(unsigned) != declared:
        raise ScanError("input manifest identity mismatch")
    width = value["shingle_width"]
    if type(width) is not int or not 2 <= width <= 64:
        raise ScanError("shingle_width must be 2..64")
    group_field = value["group_field"]
    if (
        not isinstance(group_field, str)
        or not group_field
        or len(group_field) > 128
        or any(ch in group_field for ch in "\r\n\0")
    ):
        raise ScanError("group_field is invalid")
    limits = _limits(value["limits"])
    root = manifest_path.parent.resolve()
    splits = value["splits"]
    if not isinstance(splits, Mapping) or set(splits) != {"train", "validation", "sealed"}:
        raise ScanError("split set must be train/validation/sealed")
    split_records = {
        split: _artifact_records(root, splits[split], limits=limits)
        for split in ("train", "validation", "sealed")
    }
    selections = _artifact_records(
        root,
        value["tokenizer_selections"],
        limits=limits,
        require_nonempty=True,
    )
    benchmark_records = _artifact_records(
        root,
        value["benchmarks"],
        limits=limits,
        require_nonempty=True,
    )
    binding = _binding(value["binding"])
    expected_benchmarks = {
        (item["path"], item["sha256"]) for item in binding["benchmark_artifacts"]
    }
    observed_benchmarks = {
        (item["artifact_id"], item["sha256"]) for item in benchmark_records
    }
    if observed_benchmarks != expected_benchmarks:
        raise ScanError("benchmark package differs from expected binding")
    return {
        "manifest_path": manifest_path,
        "root": root,
        "input_sha256": declared,
        "binding": binding,
        "shingle_width": width,
        "group_field": group_field,
        "limits": limits,
        "splits": split_records,
        "tokenizer_selections": selections,
        "benchmarks": benchmark_records,
    }


def _fragment(text: str) -> bytes:
    return (text.replace("\r", " ").replace("\n", " ").strip() + "\n").encode("utf-8")


def _selection_tokens(
    package_root: Path,
    metadata_record: dict,
    limits: dict[str, int],
) -> list[tuple[str, str]]:
    metadata_path = metadata_record["path"]
    metadata = _load_json(metadata_path, MAX_METADATA_BYTES)
    if not isinstance(metadata, Mapping) or metadata.get("format") != SELECTION_FORMAT:
        raise ScanError("unsupported tokenizer selection metadata")
    declared = _hash_field("selection_sha256", metadata.get("selection_sha256"))
    unsigned = dict(metadata)
    del unsigned["selection_sha256"]
    if canonical_json_sha256(unsigned) != declared:
        raise ScanError("tokenizer selection identity mismatch")
    if metadata.get("normalization") not in {
        NORMALIZATION,
        "byte-identical-attested-file-v1",
    }:
        raise ScanError("tokenizer selection normalization is unsupported")
    sample = metadata.get("sample")
    ledger = metadata.get("ledger")
    if not isinstance(sample, Mapping) or not isinstance(ledger, Mapping):
        raise ScanError("tokenizer selection sample/ledger metadata missing")
    for record, name in ((sample, "sample"), (ledger, "ledger")):
        if set(record) != {"filename", "sha256", "bytes", "documents"}:
            raise ScanError(f"tokenizer {name} metadata fields differ")
        _hash_field(f"tokenizer {name} sha256", record["sha256"])
        if type(record["bytes"]) is not int or record["bytes"] < 0:
            raise ScanError(f"tokenizer {name} byte count is invalid")
        if type(record["documents"]) is not int or record["documents"] <= 0:
            raise ScanError(f"tokenizer {name} document count is invalid")
    if sample["documents"] != ledger["documents"]:
        raise ScanError("tokenizer sample/ledger document counts differ")
    sample_path = _safe_relative(metadata_path.parent.resolve(), sample["filename"])
    ledger_path = _safe_relative(metadata_path.parent.resolve(), ledger["filename"])
    # _safe_relative above is rooted at metadata dir. Ensure it is still inside package.
    for target in (sample_path, ledger_path):
        resolved = target.resolve()
        if package_root != resolved and package_root not in resolved.parents:
            raise ScanError("tokenizer sample/ledger escapes package root")
    if (
        not sample_path.is_file()
        or sample_path.stat().st_size != sample["bytes"]
        or sha256_file(sample_path) != sample["sha256"]
    ):
        raise ScanError("tokenizer sample byte identity differs")
    if (
        not ledger_path.is_file()
        or ledger_path.stat().st_size != ledger["bytes"]
        or sha256_file(ledger_path) != ledger["sha256"]
    ):
        raise ScanError("tokenizer ledger byte identity differs")

    documents = []
    offset = 0
    count = 0
    with sample_path.open("rb") as sample_stream, ledger_path.open("rb") as ledger_stream:
        for line_no, raw in enumerate(ledger_stream, 1):
            if len(raw) > limits["max_ledger_row_bytes"]:
                raise ScanError("tokenizer ledger row exceeds byte cap")
            try:
                row = json.loads(raw, object_pairs_hook=_pairs)
            except json.JSONDecodeError as exc:
                raise ScanError(f"invalid tokenizer ledger JSON at line {line_no}") from exc
            if not isinstance(row, Mapping) or row.get("format") != LEDGER_FORMAT:
                raise ScanError("tokenizer ledger row format differs")
            normalized = _hash_field(
                "tokenizer ledger document_sha256",
                row.get("document_sha256"),
            )
            emitted = row.get("emitted")
            if not isinstance(emitted, Mapping) or set(emitted) != {
                "sha256",
                "bytes",
                "byte_start",
                "byte_end",
            }:
                raise ScanError("tokenizer ledger emitted record differs")
            digest = _hash_field("tokenizer emitted sha256", emitted["sha256"])
            size = emitted["bytes"]
            start = emitted["byte_start"]
            end = emitted["byte_end"]
            if (
                type(size) is not int
                or type(start) is not int
                or type(end) is not int
                or size < 0
                or start != offset
                or end != start + size
            ):
                raise ScanError("tokenizer emitted byte interval is invalid")
            chunk = sample_stream.read(size)
            if len(chunk) != size or hashlib.sha256(chunk).hexdigest() != digest:
                raise ScanError("tokenizer sample fragment differs from ledger")
            documents.append((normalized, digest))
            offset = end
            count += 1
        if sample_stream.read(1):
            raise ScanError("tokenizer sample has unbound trailing bytes")
    if count != sample["documents"] or offset != sample["bytes"]:
        raise ScanError("tokenizer ledger coverage differs from sample")
    return documents


def _create_db() -> tuple[sqlite3.Connection, str]:
    handle = tempfile.NamedTemporaryFile(prefix="ilaria-clearance-", suffix=".sqlite3", delete=False)
    path = handle.name
    handle.close()
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute(
        "CREATE TABLE docs (split TEXT NOT NULL, exact TEXT NOT NULL, normalized TEXT NOT NULL, "
        "fragment TEXT NOT NULL, group_id TEXT NOT NULL)"
    )
    db.execute("CREATE INDEX docs_exact ON docs(exact)")
    db.execute("CREATE INDEX docs_normalized ON docs(normalized)")
    db.execute("CREATE INDEX docs_fragment ON docs(fragment)")
    db.execute("CREATE INDEX docs_group ON docs(group_id)")
    db.execute(
        "CREATE TABLE tokenizer (normalized TEXT NOT NULL, fragment TEXT NOT NULL)"
    )
    db.execute("CREATE INDEX tokenizer_normalized ON tokenizer(normalized)")
    db.execute("CREATE INDEX tokenizer_fragment ON tokenizer(fragment)")
    return db, path


def scan(input_path: str | Path) -> dict:
    package = load_input(input_path)
    benchmark_paths = [str(item["path"]) for item in package["benchmarks"]]
    bench, _ = benchmark_shingles(benchmark_paths, package["shingle_width"])
    db, db_path = _create_db()
    stats = {
        "documents": {"train": 0, "validation": 0, "sealed": 0},
        "tokenizer_documents": 0,
        "benchmark_matching_documents": 0,
    }
    try:
        total_docs = 0
        for split in ("train", "validation", "sealed"):
            for artifact in package["splits"][split]:
                with artifact["path"].open("rb") as stream:
                    for line_no, raw in enumerate(stream, 1):
                        if len(raw) > package["limits"]["max_row_bytes"]:
                            raise ScanError(f"{split}:{artifact['artifact_id']} row exceeds byte cap")
                        if not raw.strip():
                            continue
                        total_docs += 1
                        if total_docs > package["limits"]["max_documents"]:
                            raise ScanError("document count exceeds configured cap")
                        try:
                            row = json.loads(raw, object_pairs_hook=_pairs)
                        except json.JSONDecodeError as exc:
                            raise ScanError(
                                f"{split}:{artifact['artifact_id']}:{line_no}: invalid JSON"
                            ) from exc
                        text = row.get("text") if isinstance(row, Mapping) else None
                        group_id = (
                            row.get(package["group_field"])
                            if isinstance(row, Mapping)
                            else None
                        )
                        if not isinstance(text, str) or not text.strip():
                            raise ScanError("split row lacks non-empty text")
                        if (
                            not isinstance(group_id, str)
                            or not group_id
                            or len(group_id) > 4096
                            or any(ch in group_id for ch in "\r\n\0")
                        ):
                            raise ScanError("split row lacks explicit safe group id")
                        normalized = document_sha256(text)
                        if "document_sha256" in row and row["document_sha256"] != normalized:
                            raise ScanError("split row document_sha256 differs from canonical normalization")
                        exact = hashlib.sha256(text.encode("utf-8")).hexdigest()
                        fragment = hashlib.sha256(_fragment(text)).hexdigest()
                        db.execute(
                            "INSERT INTO docs(split,exact,normalized,fragment,group_id) VALUES(?,?,?,?,?)",
                            (split, exact, normalized, fragment, group_id),
                        )
                        if shingle_hashes(text, package["shingle_width"]) & bench:
                            stats["benchmark_matching_documents"] += 1
                        stats["documents"][split] += 1
        if any(stats["documents"][split] == 0 for split in ("train", "validation", "sealed")):
            raise ScanError("every split must contain at least one document")

        for metadata in package["tokenizer_selections"]:
            for normalized, fragment in _selection_tokens(
                package["root"],
                metadata,
                package["limits"],
            ):
                db.execute(
                    "INSERT INTO tokenizer(normalized,fragment) VALUES(?,?)",
                    (normalized, fragment),
                )
                stats["tokenizer_documents"] += 1
        db.commit()

        checks = {
            "train_validation_exact_overlap": db.execute(
                "SELECT COUNT(*) FROM (SELECT DISTINCT a.exact FROM docs a "
                "JOIN docs b ON a.exact=b.exact WHERE a.split='train' AND b.split='validation')"
            ).fetchone()[0],
            "tokenizer_heldout_exact_overlap": db.execute(
                "SELECT COUNT(*) FROM (SELECT DISTINCT t.fragment FROM tokenizer t "
                "JOIN docs d ON t.fragment=d.fragment WHERE d.split IN ('validation','sealed'))"
            ).fetchone()[0],
            "tokenizer_heldout_normalized_overlap": db.execute(
                "SELECT COUNT(*) FROM (SELECT DISTINCT t.normalized FROM tokenizer t "
                "JOIN docs d ON t.normalized=d.normalized WHERE d.split IN ('validation','sealed'))"
            ).fetchone()[0],
            "dataset_benchmark_shingle_overlap": stats["benchmark_matching_documents"],
            "group_overlap": db.execute(
                "SELECT COUNT(*) FROM (SELECT group_id FROM docs GROUP BY group_id "
                "HAVING COUNT(DISTINCT split) > 1)"
            ).fetchone()[0],
        }
    finally:
        db.close()
        try:
            os.unlink(db_path)
        except OSError:
            pass

    heldout = [
        {
            "artifact_id": "production.validation.stream",
            "scope": "validation",
            "sha256": package["binding"]["dataset"]["validation_stream_sha256"],
        }
    ]
    for item in package["splits"]["validation"]:
        heldout.append(
            {
                "artifact_id": f"validation:{item['artifact_id']}",
                "scope": "validation",
                "sha256": item["sha256"],
            }
        )
    for item in package["splits"]["sealed"]:
        heldout.append(
            {
                "artifact_id": f"sealed:{item['artifact_id']}",
                "scope": "sealed",
                "sha256": item["sha256"],
            }
        )
    for item in sorted(
        package["binding"]["benchmark_artifacts"],
        key=lambda value: value["path"],
    ):
        heldout.append(
            {
                "artifact_id": f"benchmark:{item['path']}",
                "scope": "benchmark",
                "sha256": item["sha256"],
            }
        )
    ids = [item["artifact_id"] for item in heldout]
    if len(ids) != len(set(ids)):
        raise ScanError("heldout artifact ids are not unique")

    result = {
        "format": SCAN_FORMAT,
        "state": "SCAN_COMPLETE",
        "input_sha256": package["input_sha256"],
        "binding": package["binding"],
        "heldout_artifacts": heldout,
        "heldout_inventory_sha256": canonical_json_sha256(heldout),
        "checks": {name: int(checks[name]) for name in ZERO_CHECKS},
        "stats": stats,
        "producer_source_sha256": _source_sha256(),
        "verification_method": "bounded-sqlite-hash-and-shingle-scan-v1",
        "allocation_authorized": False,
        "promotion_authorized": False,
        "limitations": [
            "tokenizer sample/ledger consistency is verified, but original source selection replay remains the tokenizer pipeline authority",
            "benchmark contamination is lexical word-shingle detection, not semantic paraphrase detection",
        ],
    }
    result["scan_sha256"] = canonical_json_sha256(result)
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    result = scan(args.input)
    target = Path(args.out)
    if target.exists() or target.is_symlink():
        raise ScanError("scan output must be new")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"scan_sha256": result["scan_sha256"], "checks": result["checks"]}, sort_keys=True))
    return 0 if all(value == 0 for value in result["checks"].values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
