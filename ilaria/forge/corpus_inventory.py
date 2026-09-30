"""Build a deterministic, rights-aware inventory for the IMC-125M curriculum.

The inventory is deliberately pre-curation: it measures candidate corpus capacity
without making a rights decision. Documents are assigned to exactly one curriculum
lane, exact-normalized duplicates are counted once globally, and source/shard hashes
are verified before any statistics are accepted.

Before IlariaLex is frozen the report emits a conservative token interval derived
from UTF-8 bytes. With --tokenizer it counts the exact IlariaLex token stream
contribution, including the canonical EOS appended once per document.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
from typing import Iterable

try:
    from .curriculum_stream import allocate_token_budget, load_curriculum
    from .data_audit import document_sha256
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        RIGHTS_APPROVED,
        atomic_write_json,
        canonical_json_sha256,
        load_rights_registry,
        require_lower_sha256,
        sha256_file,
    )
except ImportError:  # direct script execution
    from curriculum_stream import allocate_token_budget, load_curriculum
    from data_audit import document_sha256
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        RIGHTS_APPROVED,
        atomic_write_json,
        canonical_json_sha256,
        load_rights_registry,
        require_lower_sha256,
        sha256_file,
    )


INVENTORY_FORMAT = "ilaria-corpus-inventory-v1"
LANE_RULES_FORMAT = "imc-125m-inventory-lanes-v1"
ESTIMATE_BYTES_PER_TOKEN_MIN = 3.2
ESTIMATE_BYTES_PER_TOKEN_MAX = 4.0


def _load_json(path: str | Path) -> dict:
    source = Path(path)
    with source.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"{source}: expected JSON object")
    return value


def load_lane_rules(path: str | Path, valid_lanes: set[str]) -> dict:
    config = _load_json(path)
    if config.get("format") != LANE_RULES_FORMAT:
        raise ValueError("unsupported IMC-125M inventory lane-rules format")
    sources = config.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("inventory lane-rules config has no sources")

    normalized: dict[str, list[dict]] = {}
    for source_name, source_cfg in sorted(sources.items()):
        if not isinstance(source_name, str) or not source_name:
            raise ValueError("inventory lane-rules source name is invalid")
        if not isinstance(source_cfg, dict):
            raise ValueError(f"inventory lane-rules {source_name!r} must be an object")
        rules = source_cfg.get("rules")
        if not isinstance(rules, list) or not rules:
            raise ValueError(f"inventory lane-rules {source_name!r} has no rules")

        defaults = 0
        out_rules: list[dict] = []
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise ValueError(
                    f"inventory lane-rules {source_name!r} rule {index} must be an object"
                )
            lane = rule.get("lane")
            if lane not in valid_lanes:
                raise ValueError(
                    f"inventory lane-rules {source_name!r} rule {index} has unknown lane {lane!r}"
                )
            is_default = rule.get("default") is True
            globs = rule.get("path_globs", [])
            if not isinstance(globs, list) or any(
                not isinstance(pattern, str) or not pattern for pattern in globs
            ):
                raise ValueError(
                    f"inventory lane-rules {source_name!r} rule {index} has invalid path_globs"
                )
            if is_default:
                defaults += 1
                if globs:
                    raise ValueError(
                        f"inventory lane-rules {source_name!r} default rule cannot have path_globs"
                    )
            elif not globs:
                raise ValueError(
                    f"inventory lane-rules {source_name!r} rule {index} needs path_globs"
                )
            out_rules.append(
                {
                    "lane": lane,
                    "default": is_default,
                    "path_globs": list(globs),
                }
            )
        if defaults != 1:
            raise ValueError(
                f"inventory lane-rules {source_name!r} requires exactly one default rule"
            )
        normalized[source_name] = out_rules

    result = {
        "format": LANE_RULES_FORMAT,
        "sources": {
            name: {"rules": rules} for name, rules in normalized.items()
        },
    }
    result["rules_sha256"] = canonical_json_sha256(result)
    return result


def classify_path(source_name: str, path: str, lane_rules: dict) -> str:
    source_cfg = lane_rules["sources"].get(source_name)
    if not isinstance(source_cfg, dict):
        raise ValueError(f"no inventory lane rules for source {source_name!r}")
    normalized_path = path.replace("\\", "/").lstrip("./")
    matches: list[str] = []
    default_lane: str | None = None
    for rule in source_cfg["rules"]:
        if rule["default"]:
            default_lane = rule["lane"]
            continue
        if any(
            fnmatch.fnmatchcase(normalized_path, pattern)
            for pattern in rule["path_globs"]
        ):
            matches.append(rule["lane"])
    distinct = sorted(set(matches))
    if len(distinct) > 1:
        raise ValueError(
            f"{source_name}:{path}: ambiguous lane classification {distinct}"
        )
    if distinct:
        return distinct[0]
    assert default_lane is not None
    return default_lane


def _source_inputs(manifest_paths: Iterable[str | Path]) -> list[dict]:
    sources = []
    names: set[str] = set()
    for raw_path in manifest_paths:
        manifest_path = Path(raw_path)
        manifest = _load_json(manifest_path)
        if manifest.get("schema_version") != CORPUS_MANIFEST_SCHEMA:
            raise ValueError(f"{manifest_path}: unsupported source manifest schema")
        source = manifest.get("source")
        if not isinstance(source, dict):
            raise ValueError(f"{manifest_path}: missing source identity")
        name = source.get("name")
        revision = source.get("revision")
        if not isinstance(name, str) or not name:
            raise ValueError(f"{manifest_path}: source name is invalid")
        if name in names:
            raise ValueError(f"duplicate source manifest for {name!r}")
        names.add(name)
        if not isinstance(revision, str) or not revision:
            raise ValueError(f"{manifest_path}: source revision is invalid")

        records = manifest.get("shard_records")
        if not isinstance(records, list) or not records:
            raise ValueError(f"{manifest_path}: missing shard_records")
        shards = []
        for record in sorted(records, key=lambda item: item.get("index", -1)):
            if not isinstance(record, dict):
                raise ValueError(f"{manifest_path}: invalid shard record")
            filename = record.get("filename")
            digest = record.get("sha256")
            byte_count = record.get("bytes")
            document_count = record.get("documents")
            if not isinstance(filename, str) or not filename:
                raise ValueError(f"{manifest_path}: invalid shard filename")
            require_lower_sha256(f"{manifest_path}:{filename}", digest or "")
            if type(byte_count) is not int or byte_count < 0:
                raise ValueError(f"{manifest_path}:{filename}: invalid byte count")
            if type(document_count) is not int or document_count < 0:
                raise ValueError(f"{manifest_path}:{filename}: invalid document count")
            shard_path = manifest_path.parent / filename
            if not shard_path.is_file():
                raise ValueError(f"{manifest_path}: missing shard {shard_path}")
            if shard_path.stat().st_size != byte_count:
                raise ValueError(f"{manifest_path}:{filename}: size mismatch")
            if sha256_file(shard_path) != digest:
                raise ValueError(f"{manifest_path}:{filename}: SHA-256 mismatch")
            shards.append(
                {
                    "path": shard_path,
                    "filename": filename,
                    "sha256": digest,
                    "documents": document_count,
                    "bytes": byte_count,
                }
            )
        sources.append(
            {
                "name": name,
                "revision": revision,
                "manifest": manifest,
                "manifest_sha256": sha256_file(manifest_path),
                "shards": shards,
            }
        )
    return sorted(sources, key=lambda item: item["name"])


def _stats() -> dict:
    return {
        "documents": 0,
        "text_bytes": 0,
        "duplicates": 0,
        "duplicate_text_bytes": 0,
        "exact_tokens": 0,
    }


def _count_tokens(tokenizer, text: str) -> int:
    if tokenizer is None:
        return 0
    return len(tokenizer.encode(text, add_special_tokens=False).ids) + 1


def _token_interval(stats: dict, exact: bool) -> tuple[int, int]:
    if exact:
        value = int(stats["exact_tokens"])
        return value, value
    byte_count = int(stats["text_bytes"])
    documents = int(stats["documents"])
    minimum = math.ceil(byte_count / ESTIMATE_BYTES_PER_TOKEN_MAX) + documents
    maximum = math.ceil(byte_count / ESTIMATE_BYTES_PER_TOKEN_MIN) + documents
    return minimum, maximum


def _public_stats(stats: dict, exact: bool) -> dict:
    minimum, maximum = _token_interval(stats, exact)
    result = {
        "documents": stats["documents"],
        "text_bytes": stats["text_bytes"],
        "duplicates_removed": stats["duplicates"],
        "duplicate_text_bytes_removed": stats["duplicate_text_bytes"],
    }
    if exact:
        result["tokens"] = minimum
    else:
        result["estimated_tokens_min"] = minimum
        result["estimated_tokens_max"] = maximum
    return result


def build_inventory(
    manifest_paths: list[str | Path],
    *,
    curriculum_path: str | Path,
    lane_rules_path: str | Path,
    rights_registry_path: str | Path,
    target_tokens: int = 1_000_000_000,
    tokenizer_path: str | Path | None = None,
    sqlite_path: str | Path | None = None,
) -> dict:
    curriculum = load_curriculum(curriculum_path)
    quotas = allocate_token_budget(target_tokens, curriculum["target_mix_ppm"])
    lane_rules = load_lane_rules(lane_rules_path, set(quotas))
    rights = load_rights_registry(rights_registry_path)
    inputs = _source_inputs(manifest_paths)
    if not inputs:
        raise ValueError("inventory requires at least one source manifest")

    for item in inputs:
        if item["name"] not in lane_rules["sources"]:
            raise ValueError(f"no inventory lane rules for source {item['name']!r}")
        if item["name"] not in rights["sources"]:
            raise ValueError(f"rights registry has no entry for {item['name']!r}")

    tokenizer = None
    tokenizer_sha256 = None
    if tokenizer_path is not None:
        try:
            from .hf_tokenizer import load as load_tokenizer
        except ImportError:
            from hf_tokenizer import load as load_tokenizer
        tokenizer = load_tokenizer(str(tokenizer_path))
        tokenizer_sha256 = sha256_file(tokenizer_path)

    cleanup_db = False
    if sqlite_path is None:
        fd, temp_name = tempfile.mkstemp(
            prefix="ilaria-inventory-", suffix=".sqlite3"
        )
        os.close(fd)
        sqlite_path = temp_name
        cleanup_db = True
    db_path = Path(sqlite_path)

    source_stats = {item["name"]: _stats() for item in inputs}
    source_lane_stats = {
        item["name"]: {lane: _stats() for lane in quotas} for item in inputs
    }
    lane_stats = {lane: _stats() for lane in quotas}
    approved_lane_stats = {lane: _stats() for lane in quotas}
    total = _stats()
    raw_documents = 0
    raw_text_bytes = 0

    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS seen ("
            "document_sha256 TEXT PRIMARY KEY, source TEXT NOT NULL, path TEXT NOT NULL)"
        )
        connection.execute("DELETE FROM seen")
        for item in inputs:
            name = item["name"]
            rights_entry = rights["sources"][name]
            is_approved = (
                rights_entry.get("status") == RIGHTS_APPROVED
                and rights_entry.get("commercial_use_approved") is True
                and bool(str(rights_entry.get("review_ref", "")).strip())
            )
            seen_source_rows = 0
            for shard in item["shards"]:
                seen_shard_rows = 0
                with shard["path"].open(encoding="utf-8") as stream:
                    for line_number, line in enumerate(stream, start=1):
                        if not line.strip():
                            continue
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError as exc:
                            raise ValueError(
                                f"{shard['path']}:{line_number}: invalid JSON"
                            ) from exc
                        if not isinstance(row, dict):
                            raise ValueError(
                                f"{shard['path']}:{line_number}: expected JSON object"
                            )
                        text = row.get("text")
                        document_path = row.get("path")
                        if not isinstance(text, str) or not text:
                            raise ValueError(
                                f"{shard['path']}:{line_number}: missing text"
                            )
                        if not isinstance(document_path, str) or not document_path:
                            raise ValueError(
                                f"{shard['path']}:{line_number}: missing path"
                            )
                        lane = classify_path(name, document_path, lane_rules)
                        if quotas[lane] == 0:
                            raise ValueError(
                                f"{name}:{document_path}: assigned to zero-weight lane {lane!r}"
                            )
                        text_bytes = len(text.encode("utf-8"))
                        raw_documents += 1
                        raw_text_bytes += text_bytes
                        seen_source_rows += 1
                        seen_shard_rows += 1
                        digest = document_sha256(text)
                        cursor = connection.execute(
                            "INSERT OR IGNORE INTO seen(document_sha256, source, path) "
                            "VALUES (?, ?, ?)",
                            (digest, name, document_path),
                        )
                        if cursor.rowcount == 0:
                            for stats in (
                                source_stats[name],
                                source_lane_stats[name][lane],
                                lane_stats[lane],
                                total,
                            ):
                                stats["duplicates"] += 1
                                stats["duplicate_text_bytes"] += text_bytes
                            continue

                        token_count = _count_tokens(tokenizer, text)
                        for stats in (
                            source_stats[name],
                            source_lane_stats[name][lane],
                            lane_stats[lane],
                            total,
                        ):
                            stats["documents"] += 1
                            stats["text_bytes"] += text_bytes
                            stats["exact_tokens"] += token_count
                        if is_approved:
                            approved = approved_lane_stats[lane]
                            approved["documents"] += 1
                            approved["text_bytes"] += text_bytes
                            approved["exact_tokens"] += token_count
                if seen_shard_rows != shard["documents"]:
                    raise ValueError(
                        f"{shard['path']}: row count {seen_shard_rows} != manifest "
                        f"documents {shard['documents']}"
                    )
            declared_docs = item["manifest"].get("docs")
            if type(declared_docs) is int and declared_docs != seen_source_rows:
                raise ValueError(
                    f"{name}: scanned {seen_source_rows} documents, manifest declares "
                    f"{declared_docs}"
                )
        connection.commit()
    finally:
        connection.close()
        if cleanup_db:
            db_path.unlink(missing_ok=True)

    exact = tokenizer is not None
    lane_output = {}
    for lane in sorted(quotas):
        candidate_min, candidate_max = _token_interval(lane_stats[lane], exact)
        approved_min, approved_max = _token_interval(
            approved_lane_stats[lane], exact
        )
        lane_output[lane] = {
            "quota_tokens": quotas[lane],
            "candidate": _public_stats(lane_stats[lane], exact),
            "approved": _public_stats(approved_lane_stats[lane], exact),
            "candidate_best_case_deficit_tokens": max(
                0, quotas[lane] - candidate_max
            ),
            "candidate_conservative_deficit_tokens": max(
                0, quotas[lane] - candidate_min
            ),
            "approved_best_case_deficit_tokens": max(
                0, quotas[lane] - approved_max
            ),
            "approved_conservative_deficit_tokens": max(
                0, quotas[lane] - approved_min
            ),
        }

    source_output = {}
    input_output = []
    for item in inputs:
        name = item["name"]
        rights_entry = rights["sources"][name]
        source_output[name] = {
            "revision": item["revision"],
            "rights_status": rights_entry.get("status"),
            "commercial_use_approved": rights_entry.get(
                "commercial_use_approved"
            )
            is True,
            "stats": _public_stats(source_stats[name], exact),
            "lanes": {
                lane: _public_stats(source_lane_stats[name][lane], exact)
                for lane in sorted(quotas)
                if source_lane_stats[name][lane]["documents"]
                or source_lane_stats[name][lane]["duplicates"]
            },
        }
        input_output.append(
            {
                "source": name,
                "revision": item["revision"],
                "manifest_sha256": item["manifest_sha256"],
                "shards": [
                    {
                        "filename": shard["filename"],
                        "sha256": shard["sha256"],
                        "bytes": shard["bytes"],
                        "documents": shard["documents"],
                    }
                    for shard in item["shards"]
                ],
            }
        )

    result = {
        "format": INVENTORY_FORMAT,
        "policy": "exclusive-lane-global-normalized-dedup-v1",
        "curriculum": {
            "identity_sha256": curriculum["curriculum_sha256"],
            "file_sha256": sha256_file(curriculum_path),
            "target_tokens": target_tokens,
        },
        "lane_rules": {
            "identity_sha256": lane_rules["rules_sha256"],
            "file_sha256": sha256_file(lane_rules_path),
        },
        "rights_registry_sha256": sha256_file(rights_registry_path),
        "counting": {
            "mode": "exact" if exact else "estimated",
            "tokenizer_sha256": tokenizer_sha256,
            "eos_tokens_per_document": 1,
            "estimate_bytes_per_token_min": (
                None if exact else ESTIMATE_BYTES_PER_TOKEN_MIN
            ),
            "estimate_bytes_per_token_max": (
                None if exact else ESTIMATE_BYTES_PER_TOKEN_MAX
            ),
        },
        "dedup": {
            "identity": "NFKC-casefold-whitespace-sha256-v1",
            "ownership": "lexicographic-source-first-v1",
        },
        "inputs": input_output,
        "sources": source_output,
        "lanes": lane_output,
        "totals": {
            "raw_documents": raw_documents,
            "raw_text_bytes": raw_text_bytes,
            **_public_stats(total, exact),
        },
    }
    result["inventory_sha256"] = canonical_json_sha256(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-manifest",
        action="append",
        required=True,
        help="candidate corpus manifest; repeat for every source",
    )
    parser.add_argument("--curriculum", required=True)
    parser.add_argument("--lane-rules", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--target-tokens", type=int, default=1_000_000_000)
    parser.add_argument(
        "--tokenizer",
        help="canonical IlariaLex JSON; enables exact token counting",
    )
    parser.add_argument("--sqlite", help="optional persistent dedup SQLite path")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    report = build_inventory(
        args.source_manifest,
        curriculum_path=args.curriculum,
        lane_rules_path=args.lane_rules,
        rights_registry_path=args.rights,
        target_tokens=args.target_tokens,
        tokenizer_path=args.tokenizer,
        sqlite_path=args.sqlite,
    )
    atomic_write_json(args.out, report)
    print(
        f"[inventory] {report['totals']['documents']} unique documents -> "
        f"{args.out} ({report['counting']['mode']})"
    )
    print(f"[inventory] sha256 {report['inventory_sha256']}")


if __name__ == "__main__":
    main()
