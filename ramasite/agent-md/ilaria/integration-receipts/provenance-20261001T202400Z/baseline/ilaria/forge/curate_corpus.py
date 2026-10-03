"""Create the trainable corpus from cleaned raw source shards.

Pipeline:
  rights gate -> exact normalized dedup -> benchmark shingle exclusion ->
  deterministic content-hash train/validation split -> hashed output shards.

The first occurrence of an exact normalized document survives. Source manifests
are sorted by source name/path, making precedence deterministic. The output
contains source name and normalized document hash for lineage; tokenizer code
reads only the text field.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path

try:
    from .corpus_inventory import classify_path, load_lane_rules
    from .curriculum_stream import REQUIRED_LANES
    from .data_audit import benchmark_shingles, document_sha256, shingle_hashes
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_bytes,
        load_rights_registry,
        require_approved_rights,
        require_lower_sha256,
        sha256_file,
    )
    from .first_party_attestation import evaluate_source_attestation
except ImportError:
    from corpus_inventory import classify_path, load_lane_rules
    from curriculum_stream import REQUIRED_LANES
    from data_audit import benchmark_shingles, document_sha256, shingle_hashes
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_bytes,
        load_rights_registry,
        require_approved_rights,
        require_lower_sha256,
        sha256_file,
    )
    from first_party_attestation import evaluate_source_attestation

CURATED_SCHEMA_VERSION = 1
CURATED_FORMAT = "ilaria-curated-corpus-v1"
SPLIT_POLICY = "normalized-document-sha256-v1"
SPLIT_SALT = "ilaria-validation-v1"


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def _load_source_manifest(path: Path) -> tuple[dict, list[Path]]:
    data = _load_json(path)
    if data.get("schema_version") != CORPUS_MANIFEST_SCHEMA:
        raise ValueError(f"{path}: unsupported source manifest schema")
    source = data.get("source")
    if not isinstance(source, dict) or not source.get("name"):
        raise ValueError(f"{path}: missing source identity")
    records = data.get("shard_records")
    if not isinstance(records, list) or not records:
        raise ValueError(f"{path}: missing shard_records")

    shards = []
    for record in records:
        filename = record.get("filename")
        digest = record.get("sha256")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"{path}: invalid shard filename")
        require_lower_sha256(f"{path}:{filename}", digest or "")
        shard = path.parent / filename
        if not shard.is_file():
            raise ValueError(f"{path}: missing shard {shard}")
        if shard.stat().st_size != int(record.get("bytes", -1)):
            raise ValueError(f"{path}:{filename}: size mismatch")
        if sha256_file(shard) != digest:
            raise ValueError(f"{path}:{filename}: SHA-256 mismatch")
        shards.append(shard)
    return data, shards


def validation_side(document_hash: str, fraction: float) -> bool:
    if not 0 < fraction < 1:
        raise ValueError("validation fraction must lie between zero and one")
    digest = hashlib.sha256(
        (SPLIT_SALT + "\0" + document_hash).encode("ascii")
    ).digest()
    return int.from_bytes(digest[:8], "big") / 2**64 < fraction


class _ShardWriter:
    def __init__(self, out_dir: Path, split: str, shard_docs: int):
        if shard_docs < 1:
            raise ValueError("shard_docs must be positive")
        self.out_dir = out_dir
        self.split = split
        self.shard_docs = shard_docs
        self.index = 0
        self.buffer: list[dict] = []
        self.records: list[dict] = []
        self.documents = 0

    def add(self, row: dict) -> None:
        self.buffer.append(row)
        if len(self.buffer) >= self.shard_docs:
            self.flush()

    def flush(self) -> None:
        if not self.buffer:
            return
        filename = f"{self.split}-{self.index:05d}.jsonl"
        destination = self.out_dir / filename
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for row in self.buffer:
                stream.write(
                    json.dumps(
                        row,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        count = len(self.buffer)
        self.records.append(
            {
                "index": self.index,
                "filename": filename,
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
                "documents": count,
            }
        )
        self.documents += count
        self.index += 1
        self.buffer.clear()

    def close(self) -> None:
        self.flush()


def curate(
    source_manifest_paths: list[str],
    *,
    rights_registry_path: str,
    benchmark_paths: list[str],
    out_dir: str,
    validation_fraction: float = 0.01,
    shingle_width: int = 12,
    shard_docs: int = 50_000,
    sqlite_path: str | None = None,
    first_party_attestations: dict[str, str] | None = None,
    first_party_root: str | None = None,
    lane_rules_path: str | None = None,
) -> dict:
    if not source_manifest_paths:
        raise ValueError("curation requires source manifests")
    if not 0 < validation_fraction < 1:
        raise ValueError("validation fraction must lie between zero and one")
    if shingle_width < 2:
        raise ValueError("shingle width must be at least 2")

    lane_rules = None
    if lane_rules_path is not None:
        lane_rules = load_lane_rules(lane_rules_path, set(REQUIRED_LANES))

    sources = []
    shard_inputs = []
    for raw_path in sorted(source_manifest_paths):
        path = Path(raw_path)
        manifest, shards = _load_source_manifest(path)
        sources.append({"path": path, "manifest": manifest, "shards": shards})
    sources.sort(
        key=lambda item: (
            item["manifest"]["source"]["name"],
            str(item["path"]),
        )
    )
    source_names = [item["manifest"]["source"]["name"] for item in sources]
    if len(source_names) != len(set(source_names)):
        raise ValueError("duplicate source names are not allowed")

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    first_party_attestations = dict(first_party_attestations or {})
    unused_first_party = sorted(set(first_party_attestations) - set(source_names))
    if unused_first_party:
        raise ValueError(
            "first-party attestation mappings have no matching input source: "
            + ", ".join(unused_first_party)
        )
    if first_party_attestations and first_party_root is None:
        raise ValueError("first-party curation sources require first_party_root")
    ambiguous = sorted(set(first_party_attestations) & set(rights["sources"]))
    if ambiguous:
        raise ValueError(
            "sources have ambiguous external and first-party rights bases: "
            + ", ".join(ambiguous)
        )
    external_sources = sorted(set(source_names) - set(first_party_attestations))
    require_approved_rights(rights, external_sources)
    first_party_reports = {}
    for item in sources:
        source_name = item["manifest"]["source"]["name"]
        if source_name not in first_party_attestations:
            continue
        first_party_reports[source_name] = evaluate_source_attestation(
            item["manifest"],
            first_party_attestations[source_name],
            workspace_root=first_party_root,
            require_approved=True,
        )

    bench_shingles, benchmark_records = benchmark_shingles(
        benchmark_paths, shingle_width
    )

    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.glob("train-*.jsonl")) or any(
        output.glob("validation-*.jsonl")
    ):
        raise ValueError(
            "curation output already contains shards; use a new output directory"
        )

    cleanup_db = False
    if sqlite_path is None:
        fd, sqlite_path = tempfile.mkstemp(
            prefix="ilaria-curate-", suffix=".sqlite3"
        )
        os.close(fd)
        cleanup_db = True

    train_writer = _ShardWriter(output, "train", shard_docs)
    val_writer = _ShardWriter(output, "validation", shard_docs)

    input_docs = kept_docs = duplicates_removed = contamination_removed = 0
    by_source = {
        name: {
            "input_documents": 0,
            "kept_documents": 0,
            "duplicates_removed": 0,
            "contamination_removed": 0,
        }
        for name in source_names
    }
    by_lane = (
        {
            lane: {
                "kept_documents": 0,
                "train_documents": 0,
                "validation_documents": 0,
            }
            for lane in sorted(REQUIRED_LANES)
        }
        if lane_rules is not None
        else None
    )

    try:
        db = sqlite3.connect(sqlite_path)
        try:
            db.execute(
                "CREATE TABLE IF NOT EXISTS seen "
                "(hash TEXT PRIMARY KEY, source TEXT NOT NULL)"
            )
            db.execute("DELETE FROM seen")

            for source_item in sources:
                source_name = source_item["manifest"]["source"]["name"]
                for shard in source_item["shards"]:
                    shard_inputs.append(
                        {
                            "source_name": source_name,
                            "filename": shard.name,
                            "sha256": sha256_file(shard),
                            "bytes": shard.stat().st_size,
                        }
                    )
                    with shard.open(encoding="utf-8") as stream:
                        for line_no, line in enumerate(stream, 1):
                            if not line.strip():
                                continue
                            try:
                                value = json.loads(line)
                            except json.JSONDecodeError as exc:
                                raise ValueError(
                                    f"{shard}:{line_no}: invalid JSON: {exc}"
                                ) from exc
                            text = (
                                value.get("text")
                                if isinstance(value, dict)
                                else None
                            )
                            if not isinstance(text, str) or not text.strip():
                                raise ValueError(
                                    f"{shard}:{line_no}: missing text"
                                )

                            input_docs += 1
                            by_source[source_name]["input_documents"] += 1
                            digest = document_sha256(text)
                            try:
                                db.execute(
                                    "INSERT INTO seen(hash, source) VALUES (?, ?)",
                                    (digest, source_name),
                                )
                            except sqlite3.IntegrityError:
                                duplicates_removed += 1
                                by_source[source_name][
                                    "duplicates_removed"
                                ] += 1
                                continue

                            if (
                                bench_shingles
                                and shingle_hashes(text, shingle_width)
                                & bench_shingles
                            ):
                                contamination_removed += 1
                                by_source[source_name][
                                    "contamination_removed"
                                ] += 1
                                continue

                            row = {
                                "text": text,
                                "source": source_name,
                                "document_sha256": digest,
                            }
                            lane = None
                            if lane_rules is not None:
                                source_path = value.get("path", "")
                                if not isinstance(source_path, str):
                                    raise ValueError(
                                        f"{shard}:{line_no}: invalid source path for lane classification"
                                    )
                                lane = classify_path(source_name, source_path, lane_rules)
                                row["lane"] = lane
                                row["source_path"] = source_path
                                by_lane[lane]["kept_documents"] += 1
                            if validation_side(digest, validation_fraction):
                                val_writer.add(row)
                                if lane is not None:
                                    by_lane[lane]["validation_documents"] += 1
                            else:
                                train_writer.add(row)
                                if lane is not None:
                                    by_lane[lane]["train_documents"] += 1
                            kept_docs += 1
                            by_source[source_name]["kept_documents"] += 1
                    db.commit()
        finally:
            db.close()
    finally:
        train_writer.close()
        val_writer.close()
        if cleanup_db:
            Path(sqlite_path).unlink(missing_ok=True)

    if train_writer.documents + val_writer.documents != kept_docs:
        raise AssertionError("curation writer/document count mismatch")
    if input_docs != kept_docs + duplicates_removed + contamination_removed:
        raise AssertionError("curation accounting mismatch")

    source_records = []
    for item in sources:
        manifest_path = item["path"]
        manifest = item["manifest"]
        source_records.append(
            {
                "source": manifest["source"],
                "manifest_filename": manifest_path.name,
                "manifest_sha256": sha256_file(manifest_path),
            }
        )

    report = {
        "schema_version": CURATED_SCHEMA_VERSION,
        "format": CURATED_FORMAT,
        "policy": {
            "dedup": "exact-normalized-sha256",
            "contamination": "hashed-word-shingles",
            "shingle_width": shingle_width,
            "split": SPLIT_POLICY,
            "split_salt": SPLIT_SALT,
            "validation_fraction": validation_fraction,
            "precedence": "source-name-then-manifest-path",
            **(
                {
                    "lane_assignment": "imc-125m-inventory-lanes-v1",
                }
                if lane_rules is not None
                else {}
            ),
        },
        "rights": {
            "filename": rights_path.name,
            "sha256": sha256_file(rights_path),
            "policy": rights.get("policy", ""),
            "approved_sources": sorted(source_names),
            "external_approved_sources": external_sources,
            "first_party_attestations": {
                name: report
                for name, report in sorted(first_party_reports.items())
            },
        },
        "sources": source_records,
        "input_shards": shard_inputs,
        "benchmarks": benchmark_records,
        "totals": {
            "input_documents": input_docs,
            "kept_documents": kept_docs,
            "duplicates_removed": duplicates_removed,
            "contamination_removed": contamination_removed,
            "train_documents": train_writer.documents,
            "validation_documents": val_writer.documents,
        },
        "by_source": by_source,
        **(
            {
                "lane_rules": {
                    "filename": Path(lane_rules_path).name,
                    "sha256": sha256_file(lane_rules_path),
                    "identity_sha256": lane_rules["rules_sha256"],
                },
                "by_lane": by_lane,
            }
            if lane_rules is not None
            else {}
        ),
        "splits": {
            "train": train_writer.records,
            "validation": val_writer.records,
        },
    }
    report["curated_manifest_sha256"] = hashlib.sha256(
        canonical_json_bytes(report)
    ).hexdigest()
    atomic_write_json(output / "curated.manifest.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-manifest", action="append", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--benchmark", action="append", default=[])
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--validation-fraction", type=float, default=0.01)
    parser.add_argument("--shingle-width", type=int, default=12)
    parser.add_argument("--shard-docs", type=int, default=50_000)
    parser.add_argument("--sqlite", default="")
    parser.add_argument(
        "--first-party-attestation",
        action="append",
        default=[],
        metavar="SOURCE=PATH",
    )
    parser.add_argument("--first-party-root", default="")
    parser.add_argument("--lane-rules", default="")
    args = parser.parse_args()

    first_party_attestations = {}
    for raw in args.first_party_attestation:
        source, sep, path = raw.partition("=")
        if (
            not sep
            or not source.strip()
            or not path.strip()
            or source in first_party_attestations
        ):
            raise ValueError(
                "--first-party-attestation must be a unique SOURCE=PATH mapping"
            )
        first_party_attestations[source] = path

    report = curate(
        args.source_manifest,
        rights_registry_path=args.rights,
        benchmark_paths=args.benchmark,
        out_dir=args.out_dir,
        validation_fraction=args.validation_fraction,
        shingle_width=args.shingle_width,
        shard_docs=args.shard_docs,
        sqlite_path=args.sqlite or None,
        first_party_attestations=first_party_attestations,
        first_party_root=args.first_party_root or None,
        lane_rules_path=args.lane_rules or None,
    )
    print(
        f"[curate_corpus] input={report['totals']['input_documents']} "
        f"kept={report['totals']['kept_documents']} "
        f"duplicates={report['totals']['duplicates_removed']} "
        f"contamination={report['totals']['contamination_removed']} "
        f"train={report['totals']['train_documents']} "
        f"validation={report['totals']['validation_documents']}"
    )


if __name__ == "__main__":
    main()
