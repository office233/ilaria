"""Independent replay verifier for a production contamination scan.

This file intentionally does not import scan.py. It reparses and recomputes the
package independently, then emits the exact clearance format consumed by the
production-readiness gate only when every required overlap count is exactly zero.
"""
from __future__ import annotations

import argparse
import hashlib
from importlib import import_module
import json
import os
from pathlib import Path, PurePosixPath
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nexus_ilaria_benchmark_paths import ilaria_root
import sqlite3
import sys
import tempfile
from typing import Any, Mapping

FORGE = ilaria_root(__file__) / "forge"
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
CLEARANCE_FORMAT = "ilaria-production-contamination-clearance-v1"
VALIDATION_LEVEL = "dataset-tokenizer-heldout-benchmark-separation-v1"
SELECTION_FORMAT = "ilarialex-production-selection-v1"
LEDGER_FORMAT = "ilarialex-production-selection-row-v1"
ZERO_CHECKS = frozenset({
    "train_validation_exact_overlap",
    "tokenizer_heldout_exact_overlap",
    "tokenizer_heldout_normalized_overlap",
    "dataset_benchmark_shingle_overlap",
    "group_overlap",
})
MAX_METADATA_BYTES = 2 * 1024 * 1024


class VerifyError(ValueError):
    """Independent replay refused."""


def _pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise VerifyError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _read_json(path: Path, cap: int = MAX_METADATA_BYTES) -> Any:
    if path.is_symlink() or not path.is_file():
        raise VerifyError(f"metadata missing or symlinked: {path}")
    with path.open("rb") as stream:
        raw = stream.read(cap + 1)
    if len(raw) > cap:
        raise VerifyError("metadata exceeds byte cap")

    def reject_nonfinite(value):
        raise VerifyError(f"non-finite JSON value: {value}")

    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=reject_nonfinite)


def _sha_text(name: str, value: Any) -> str:
    if not isinstance(value, str):
        raise VerifyError(f"{name} must be SHA-256 text")
    require_lower_sha256(name, value)
    return value


def _safe(root: Path, value: Any) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or ":" in value
        or PurePosixPath(value).is_absolute()
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise VerifyError("unsafe package-relative path")
    path = root.joinpath(*PurePosixPath(value).parts)
    if path.is_symlink():
        raise VerifyError("symlinked package input is forbidden")
    resolved_root = root.resolve()
    resolved = path.resolve()
    if resolved_root != resolved and resolved_root not in resolved.parents:
        raise VerifyError("package path escapes root")
    return path


def _verifier_sha256() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _canonical_fragment(text: str) -> bytes:
    return (text.replace("\r", " ").replace("\n", " ").strip() + "\n").encode("utf-8")


def _validate_binding(binding: Any) -> dict:
    if not isinstance(binding, Mapping) or set(binding) != {
        "dataset", "tokenizer", "benchmark_plan_sha256", "benchmark_artifacts"
    }:
        raise VerifyError("binding fields differ")
    dataset = binding["dataset"]
    tokenizer = binding["tokenizer"]
    if not isinstance(dataset, Mapping) or set(dataset) != {
        "manifest_file_sha256", "identity_sha256",
        "train_stream_sha256", "validation_stream_sha256",
    }:
        raise VerifyError("dataset binding differs")
    if not isinstance(tokenizer, Mapping) or set(tokenizer) != {
        "sha256", "freeze_file_sha256", "freeze_sha256"
    }:
        raise VerifyError("tokenizer binding differs")
    for prefix, record in (("dataset", dataset), ("tokenizer", tokenizer)):
        for key, digest in record.items():
            _sha_text(f"{prefix}:{key}", digest)
    _sha_text("benchmark_plan_sha256", binding["benchmark_plan_sha256"])
    benchmarks = binding["benchmark_artifacts"]
    if not isinstance(benchmarks, list) or not benchmarks:
        raise VerifyError("benchmark binding inventory missing")
    seen = set()
    for item in benchmarks:
        if not isinstance(item, Mapping) or set(item) != {"path", "sha256"}:
            raise VerifyError("benchmark binding record differs")
        logical = item["path"]
        if not isinstance(logical, str) or not logical or logical in seen:
            raise VerifyError("benchmark logical path is invalid")
        seen.add(logical)
        _sha_text(f"benchmark:{logical}", item["sha256"])
    return json.loads(json.dumps(binding))


def _limits(value: Any) -> dict[str, int]:
    keys = {"max_row_bytes", "max_ledger_row_bytes", "max_documents", "max_files"}
    if not isinstance(value, Mapping) or set(value) != keys:
        raise VerifyError("limits fields differ")
    out = {}
    for key in keys:
        item = value[key]
        if type(item) is not int or item <= 0 or item > 100_000_000:
            raise VerifyError(f"invalid {key}")
        out[key] = item
    if out["max_row_bytes"] > 16 * 1024 * 1024:
        raise VerifyError("row byte cap exceeds hard limit")
    if out["max_ledger_row_bytes"] > 4 * 1024 * 1024:
        raise VerifyError("ledger row byte cap exceeds hard limit")
    if out["max_files"] > 100_000:
        raise VerifyError("file cap exceeds hard limit")
    return out


def _files(root: Path, records: Any, limits: dict[str, int]) -> list[dict]:
    if not isinstance(records, list) or not records or len(records) > limits["max_files"]:
        raise VerifyError("artifact inventory is invalid")
    out = []
    ids = set()
    files = set()
    for record in records:
        if not isinstance(record, Mapping) or set(record) != {"artifact_id", "file", "sha256"}:
            raise VerifyError("artifact record differs")
        artifact_id = record["artifact_id"]
        if (
            not isinstance(artifact_id, str)
            or not artifact_id
            or len(artifact_id) > 512
            or any(ch in artifact_id for ch in "\r\n\0")
            or artifact_id in ids
        ):
            raise VerifyError("artifact id invalid/duplicated")
        path = _safe(root, record["file"])
        if path in files or not path.is_file():
            raise VerifyError("artifact file invalid/duplicated")
        expected = _sha_text(f"{artifact_id}:sha256", record["sha256"])
        if sha256_file(path) != expected:
            raise VerifyError(f"artifact hash differs: {artifact_id}")
        out.append({"artifact_id": artifact_id, "path": path, "sha256": expected})
        ids.add(artifact_id)
        files.add(path)
    return out


def _package(path: str | Path) -> dict:
    manifest_path = Path(path).resolve()
    value = _read_json(manifest_path)
    expected = {
        "format", "input_sha256", "binding", "shingle_width", "group_field",
        "limits", "splits", "tokenizer_selections", "benchmarks",
    }
    if not isinstance(value, Mapping) or value.get("format") != INPUT_FORMAT or set(value) != expected:
        raise VerifyError("unsupported contamination input manifest")
    declared = _sha_text("input_sha256", value["input_sha256"])
    unsigned = dict(value)
    del unsigned["input_sha256"]
    if canonical_json_sha256(unsigned) != declared:
        raise VerifyError("input manifest identity mismatch")
    width = value["shingle_width"]
    if type(width) is not int or not 2 <= width <= 64:
        raise VerifyError("invalid shingle width")
    group_field = value["group_field"]
    if (
        not isinstance(group_field, str)
        or not group_field
        or len(group_field) > 128
        or any(ch in group_field for ch in "\r\n\0")
    ):
        raise VerifyError("invalid group field")
    limits = _limits(value["limits"])
    root = manifest_path.parent.resolve()
    splits = value["splits"]
    if not isinstance(splits, Mapping) or set(splits) != {"train", "validation", "sealed"}:
        raise VerifyError("split inventory differs")
    parsed_splits = {name: _files(root, splits[name], limits) for name in splits}
    selections = _files(root, value["tokenizer_selections"], limits)
    benchmarks = _files(root, value["benchmarks"], limits)
    binding = _validate_binding(value["binding"])
    if {
        (item["artifact_id"], item["sha256"]) for item in benchmarks
    } != {
        (item["path"], item["sha256"]) for item in binding["benchmark_artifacts"]
    }:
        raise VerifyError("benchmark package differs from binding")
    return {
        "root": root,
        "input_sha256": declared,
        "binding": binding,
        "shingle_width": width,
        "group_field": group_field,
        "limits": limits,
        "splits": parsed_splits,
        "tokenizer_selections": selections,
        "benchmarks": benchmarks,
    }


def _tokenizer_rows(package: dict) -> list[tuple[str, str]]:
    output = []
    for selection in package["tokenizer_selections"]:
        path = selection["path"]
        meta = _read_json(path)
        if not isinstance(meta, Mapping) or meta.get("format") != SELECTION_FORMAT:
            raise VerifyError("selection metadata format differs")
        declared = _sha_text("selection_sha256", meta.get("selection_sha256"))
        unsigned = dict(meta)
        del unsigned["selection_sha256"]
        if canonical_json_sha256(unsigned) != declared:
            raise VerifyError("selection identity differs")
        sample = meta.get("sample")
        ledger = meta.get("ledger")
        if not isinstance(sample, Mapping) or not isinstance(ledger, Mapping):
            raise VerifyError("selection sample/ledger metadata missing")
        fields = {"filename", "sha256", "bytes", "documents"}
        if set(sample) != fields or set(ledger) != fields:
            raise VerifyError("selection sample/ledger fields differ")
        for item, label in ((sample, "sample"), (ledger, "ledger")):
            _sha_text(f"{label}:sha256", item["sha256"])
            if type(item["bytes"]) is not int or item["bytes"] < 0:
                raise VerifyError(f"{label} bytes invalid")
            if type(item["documents"]) is not int or item["documents"] <= 0:
                raise VerifyError(f"{label} document count invalid")
        if sample["documents"] != ledger["documents"]:
            raise VerifyError("sample/ledger document counts differ")
        sample_path = _safe(path.parent.resolve(), sample["filename"])
        ledger_path = _safe(path.parent.resolve(), ledger["filename"])
        for target in (sample_path, ledger_path):
            resolved = target.resolve()
            if package["root"] != resolved and package["root"] not in resolved.parents:
                raise VerifyError("selection artifact escapes package")
        if (
            not sample_path.is_file()
            or sample_path.stat().st_size != sample["bytes"]
            or sha256_file(sample_path) != sample["sha256"]
        ):
            raise VerifyError("sample identity differs")
        if (
            not ledger_path.is_file()
            or ledger_path.stat().st_size != ledger["bytes"]
            or sha256_file(ledger_path) != ledger["sha256"]
        ):
            raise VerifyError("ledger identity differs")

        position = 0
        count = 0
        with sample_path.open("rb") as sample_stream, ledger_path.open("rb") as ledger_stream:
            while True:
                raw = ledger_stream.readline(package["limits"]["max_ledger_row_bytes"] + 1)
                if not raw:
                    break
                if len(raw) > package["limits"]["max_ledger_row_bytes"]:
                    raise VerifyError("ledger row exceeds byte cap")
                try:
                    row = json.loads(raw, object_pairs_hook=_pairs)
                except json.JSONDecodeError as exc:
                    raise VerifyError("invalid tokenizer ledger row") from exc
                if not isinstance(row, Mapping) or row.get("format") != LEDGER_FORMAT:
                    raise VerifyError("ledger row format differs")
                normalized = _sha_text("document_sha256", row.get("document_sha256"))
                emitted = row.get("emitted")
                if not isinstance(emitted, Mapping) or set(emitted) != {
                    "sha256", "bytes", "byte_start", "byte_end"
                }:
                    raise VerifyError("ledger emitted record differs")
                digest = _sha_text("emitted sha256", emitted["sha256"])
                size, start, end = emitted["bytes"], emitted["byte_start"], emitted["byte_end"]
                if (
                    type(size) is not int
                    or type(start) is not int
                    or type(end) is not int
                    or size < 0
                    or start != position
                    or end - start != size
                ):
                    raise VerifyError("ledger byte interval differs")
                chunk = sample_stream.read(size)
                if len(chunk) != size or hashlib.sha256(chunk).hexdigest() != digest:
                    raise VerifyError("sample bytes differ from ledger")
                output.append((normalized, digest))
                position = end
                count += 1
            if sample_stream.read(1):
                raise VerifyError("sample contains trailing unbound bytes")
        if count != sample["documents"] or position != sample["bytes"]:
            raise VerifyError("ledger does not cover entire sample")
    return output


def _database() -> tuple[sqlite3.Connection, str]:
    fd, path = tempfile.mkstemp(prefix="ilaria-clearance-verify-", suffix=".sqlite3")
    os.close(fd)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.executescript(
        "CREATE TABLE corpus(split TEXT, exact TEXT, normalized TEXT, fragment TEXT, group_id TEXT);"
        "CREATE INDEX corpus_exact ON corpus(exact);"
        "CREATE INDEX corpus_norm ON corpus(normalized);"
        "CREATE INDEX corpus_frag ON corpus(fragment);"
        "CREATE INDEX corpus_group ON corpus(group_id);"
        "CREATE TABLE tok(normalized TEXT, fragment TEXT);"
        "CREATE INDEX tok_norm ON tok(normalized);"
        "CREATE INDEX tok_frag ON tok(fragment);"
    )
    return db, path


def recompute(input_path: str | Path) -> dict:
    package = _package(input_path)
    benchmark_hashes, _ = benchmark_shingles(
        [str(item["path"]) for item in package["benchmarks"]],
        package["shingle_width"],
    )
    db, db_path = _database()
    stats = {
        "documents": {"train": 0, "validation": 0, "sealed": 0},
        "tokenizer_documents": 0,
        "benchmark_matching_documents": 0,
    }
    try:
        total = 0
        for split in ("train", "validation", "sealed"):
            for artifact in package["splits"][split]:
                with artifact["path"].open("rb") as handle:
                    line_no = 0
                    while True:
                        raw = handle.readline(package["limits"]["max_row_bytes"] + 1)
                        if not raw:
                            break
                        line_no += 1
                        if len(raw) > package["limits"]["max_row_bytes"]:
                            raise VerifyError("corpus row exceeds byte cap")
                        if not raw.strip():
                            continue
                        total += 1
                        if total > package["limits"]["max_documents"]:
                            raise VerifyError("document count exceeds cap")
                        try:
                            row = json.loads(raw, object_pairs_hook=_pairs)
                        except json.JSONDecodeError as exc:
                            raise VerifyError(f"invalid corpus JSON at {split}:{line_no}") from exc
                        text = row.get("text") if isinstance(row, Mapping) else None
                        group = row.get(package["group_field"]) if isinstance(row, Mapping) else None
                        if not isinstance(text, str) or not text.strip():
                            raise VerifyError("corpus row missing text")
                        if (
                            not isinstance(group, str)
                            or not group
                            or len(group) > 4096
                            or any(ch in group for ch in "\r\n\0")
                        ):
                            raise VerifyError("corpus row missing explicit group id")
                        normalized = document_sha256(text)
                        if "document_sha256" in row and row["document_sha256"] != normalized:
                            raise VerifyError("corpus canonical document hash differs")
                        exact = hashlib.sha256(text.encode("utf-8")).hexdigest()
                        fragment = hashlib.sha256(_canonical_fragment(text)).hexdigest()
                        db.execute(
                            "INSERT INTO corpus VALUES(?,?,?,?,?)",
                            (split, exact, normalized, fragment, group),
                        )
                        if shingle_hashes(text, package["shingle_width"]) & benchmark_hashes:
                            stats["benchmark_matching_documents"] += 1
                        stats["documents"][split] += 1

        if any(stats["documents"][name] == 0 for name in stats["documents"]):
            raise VerifyError("all three splits must be non-empty")
        for normalized, fragment in _tokenizer_rows(package):
            db.execute("INSERT INTO tok VALUES(?,?)", (normalized, fragment))
            stats["tokenizer_documents"] += 1
        db.commit()

        queries = {
            "train_validation_exact_overlap":
                "SELECT COUNT(*) FROM (SELECT exact FROM corpus WHERE split='train' "
                "INTERSECT SELECT exact FROM corpus WHERE split='validation')",
            "tokenizer_heldout_exact_overlap":
                "SELECT COUNT(*) FROM (SELECT fragment FROM tok INTERSECT "
                "SELECT fragment FROM corpus WHERE split IN ('validation','sealed'))",
            "tokenizer_heldout_normalized_overlap":
                "SELECT COUNT(*) FROM (SELECT normalized FROM tok INTERSECT "
                "SELECT normalized FROM corpus WHERE split IN ('validation','sealed'))",
            "group_overlap":
                "SELECT COUNT(*) FROM (SELECT group_id FROM corpus GROUP BY group_id "
                "HAVING COUNT(DISTINCT split)>1)",
        }
        checks = {name: int(db.execute(query).fetchone()[0]) for name, query in queries.items()}
        checks["dataset_benchmark_shingle_overlap"] = int(stats["benchmark_matching_documents"])
    finally:
        db.close()
        try:
            os.unlink(db_path)
        except OSError:
            pass

    heldout = [{
        "artifact_id": "production.validation.stream",
        "scope": "validation",
        "sha256": package["binding"]["dataset"]["validation_stream_sha256"],
    }]
    heldout.extend({
        "artifact_id": f"validation:{item['artifact_id']}",
        "scope": "validation",
        "sha256": item["sha256"],
    } for item in package["splits"]["validation"])
    heldout.extend({
        "artifact_id": f"sealed:{item['artifact_id']}",
        "scope": "sealed",
        "sha256": item["sha256"],
    } for item in package["splits"]["sealed"])
    heldout.extend({
        "artifact_id": f"benchmark:{item['path']}",
        "scope": "benchmark",
        "sha256": item["sha256"],
    } for item in sorted(package["binding"]["benchmark_artifacts"], key=lambda x: x["path"]))
    ids = [item["artifact_id"] for item in heldout]
    if len(ids) != len(set(ids)):
        raise VerifyError("heldout artifact ids collide")
    return {
        "input_sha256": package["input_sha256"],
        "binding": package["binding"],
        "heldout_artifacts": heldout,
        "heldout_inventory_sha256": canonical_json_sha256(heldout),
        "checks": checks,
        "stats": stats,
    }


def verify(
    input_path: str | Path,
    scan_path: str | Path,
    *,
    reviewed_by: str,
    review_ref: str,
) -> dict:
    if not isinstance(reviewed_by, str) or not reviewed_by.strip():
        raise VerifyError("reviewed_by must be explicit")
    if not isinstance(review_ref, str) or not review_ref.strip():
        raise VerifyError("review_ref must be explicit")
    scan = _read_json(Path(scan_path).resolve())
    if not isinstance(scan, Mapping) or scan.get("format") != SCAN_FORMAT:
        raise VerifyError("unsupported scan format")
    declared_scan = _sha_text("scan_sha256", scan.get("scan_sha256"))
    unsigned = dict(scan)
    del unsigned["scan_sha256"]
    if canonical_json_sha256(unsigned) != declared_scan:
        raise VerifyError("scan identity mismatch")
    if scan.get("state") != "SCAN_COMPLETE":
        raise VerifyError("scan is not complete")
    if (
        scan.get("allocation_authorized") is not False
        or scan.get("promotion_authorized") is not False
    ):
        raise VerifyError("scan cannot grant authority")
    _sha_text("producer_source_sha256", scan.get("producer_source_sha256"))

    replay = recompute(input_path)
    for field in (
        "input_sha256",
        "binding",
        "heldout_artifacts",
        "heldout_inventory_sha256",
        "checks",
        "stats",
    ):
        if scan.get(field) != replay[field]:
            raise VerifyError(f"scan differs from independent replay: {field}")
    if set(replay["checks"]) != ZERO_CHECKS:
        raise VerifyError("required zero-check set differs")
    failures = {key: value for key, value in replay["checks"].items() if type(value) is not int or value != 0}
    if failures:
        raise VerifyError("contamination checks are non-zero: " + json.dumps(failures, sort_keys=True))

    clearance = {
        "format": CLEARANCE_FORMAT,
        "state": "VERIFIED_INDEPENDENT",
        "validation_level": VALIDATION_LEVEL,
        "binding": replay["binding"],
        "heldout_artifacts": replay["heldout_artifacts"],
        "heldout_inventory_sha256": replay["heldout_inventory_sha256"],
        "checks": replay["checks"],
        "scan_sha256": declared_scan,
        "input_sha256": replay["input_sha256"],
        "producer_source_sha256": scan["producer_source_sha256"],
        "verifier_source_sha256": _verifier_sha256(),
        "verification_method": "independent-second-pass-sqlite-hash-shingle-and-sample-ledger-replay-v1",
        "reviewed_by": reviewed_by.strip(),
        "review_ref": review_ref.strip(),
        "allocation_authorized": False,
        "promotion_authorized": False,
        "limitations": [
            "lexical shingle exclusion is not semantic paraphrase detection",
            "tokenizer source-origin replay remains the production tokenizer lineage validator's authority",
            "clearance proves separation only for the exact content-addressed binding and heldout inventory",
        ],
    }
    clearance["clearance_sha256"] = canonical_json_sha256(clearance)
    return clearance


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--scan", required=True)
    parser.add_argument("--reviewed-by", required=True)
    parser.add_argument("--review-ref", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    clearance = verify(
        args.input,
        args.scan,
        reviewed_by=args.reviewed_by,
        review_ref=args.review_ref,
    )
    target = Path(args.out)
    if target.exists() or target.is_symlink():
        raise VerifyError("clearance output must be new")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(clearance, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "clearance_sha256": clearance["clearance_sha256"],
        "checks": clearance["checks"],
        "allocation_authorized": False,
        "promotion_authorized": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
