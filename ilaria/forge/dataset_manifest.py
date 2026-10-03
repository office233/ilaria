"""Build the immutable training dataset manifest from the curated corpus.

Canonical chain:
raw source manifests -> rights-gated curation -> post-curation audit ->
IlariaLex encoding -> train/validation token streams -> dataset manifest.

The manifest refuses mixed tokenizer identities, altered curated shards,
incomplete audit coverage, unapproved rights, or train/validation artifact
tampering.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

try:
    from .curate_corpus import (
        CURATED_FORMAT,
        CURATED_SCHEMA_VERSION,
        PROVENANCE_FORMAT,
        PROVENANCE_SCHEMA_VERSION,
    )
    from .curriculum_stream import REQUIRED_LANES, STREAM_CURRICULUM_FORMAT
    from .data_audit import (
        AUDIT_SCHEMA_VERSION,
        document_sha256 as normalized_document_sha256,
    )
    from .data_contract import (
        DATASET_MANIFEST_SCHEMA,
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        canonical_json_bytes,
        load_rights_registry,
        require_approved_rights,
        require_lower_sha256,
        sha256_file,
    )
    from .first_party_attestation import (
        attestation_scope_sha256,
        validate_attestation,
        validate_attestation_packet,
    )
except ImportError:
    from curate_corpus import (
        CURATED_FORMAT,
        CURATED_SCHEMA_VERSION,
        PROVENANCE_FORMAT,
        PROVENANCE_SCHEMA_VERSION,
    )
    from curriculum_stream import REQUIRED_LANES, STREAM_CURRICULUM_FORMAT
    from data_audit import (
        AUDIT_SCHEMA_VERSION,
        document_sha256 as normalized_document_sha256,
    )
    from data_contract import (
        DATASET_MANIFEST_SCHEMA,
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        canonical_json_bytes,
        load_rights_registry,
        require_approved_rights,
        require_lower_sha256,
        sha256_file,
    )
    from first_party_attestation import (
        attestation_scope_sha256,
        validate_attestation,
        validate_attestation_packet,
    )


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


_PROVENANCE_VERIFICATION = "input-metadata-only; not item-rights approval"
_PROVENANCE_VALIDATION_SCOPE = "manifest-bindings"
_PROVENANCE_MAX_RECORD_BYTES = 256 * 1024
_PROVENANCE_ITEM_FIELDS = frozenset({
    "id", "identifier", "record_id", "source_id", "url", "source_url",
    "path", "license", "license_expression", "language", "revision",
    "date", "creator",
})
_PROVENANCE_REQUIRED_FIELDS = frozenset({
    "license", "identifier", "revision", "language", "date", "creator",
})


def _provenance_field_value(fields: dict, name: str) -> str:
    field = fields.get(name)
    if (not isinstance(field, dict) or field.get("status") != "available"
            or field.get("verified") is not False
            or not isinstance(field.get("value"), str)
            or not field["value"].strip()):
        raise ValueError(f"provenance source field {name!r} is invalid")
    return field["value"]


def _safe_sidecar_path(root: Path, filename: object) -> Path:
    if (not isinstance(filename, str) or not filename
            or Path(filename).name != filename or filename in {".", ".."}):
        raise ValueError("curated provenance shard filename is invalid")
    candidate = root / filename
    if candidate.is_symlink() or candidate.resolve().parent != root.resolve():
        raise ValueError("curated provenance shard path escapes the corpus directory")
    return candidate


def _safe_curated_shard_path(root: Path, filename: object) -> Path:
    if (not isinstance(filename, str) or not filename
            or Path(filename).name != filename or filename in {".", ".."}):
        raise ValueError("curated shard filename is invalid")
    candidate = root / filename
    if candidate.is_symlink() or candidate.resolve().parent != root.resolve():
        raise ValueError("curated shard path escapes the corpus directory")
    return candidate


def _validate_provenance(
    path: Path,
    curated: dict,
    curated_records: list[dict],
) -> dict | None:
    if "provenance" not in curated:
        return None
    provenance = curated["provenance"]
    if not isinstance(provenance, dict):
        raise ValueError(f"{path}: curated provenance metadata is invalid")
    if (provenance.get("schema_version") != PROVENANCE_SCHEMA_VERSION
            or provenance.get("format") != PROVENANCE_FORMAT
            or provenance.get("verification") != _PROVENANCE_VERIFICATION):
        raise ValueError(f"{path}: unsupported curated provenance format")

    sources = curated.get("sources")
    if not isinstance(sources, list):
        raise ValueError(f"{path}: curated provenance source lineage is invalid")
    source_records = {}
    for source_record in sources:
        source = source_record.get("source") if isinstance(source_record, dict) else None
        if not isinstance(source, dict) or not isinstance(source.get("name"), str):
            raise ValueError(f"{path}: curated provenance source identity is invalid")
        name = source["name"]
        if name in source_records:
            raise ValueError(f"{path}: duplicate curated provenance source {name!r}")
        require_lower_sha256(
            f"{path}:source:{name}:manifest_sha256",
            source_record.get("manifest_sha256", ""),
        )
        revision = source.get("revision")
        if not isinstance(revision, str) or not revision.strip():
            raise ValueError(f"{path}: curated provenance source revision is missing")
        source_records[name] = source_record

    retained = provenance.get("retained_item_fields")
    required = provenance.get("required_fields")
    if not isinstance(retained, dict) or not isinstance(required, dict):
        raise ValueError(f"{path}: curated provenance field policies are invalid")
    if set(retained) != set(source_records) or set(required) - set(source_records):
        raise ValueError(f"{path}: curated provenance policy references unknown sources")
    retained_by_source: dict[str, set[str]] = {}
    required_by_source: dict[str, set[str]] = {}
    for name in source_records:
        retained_fields = retained.get(name, [])
        required_fields = required.get(name, [])
        if (not isinstance(retained_fields, list)
                or any(not isinstance(field, str)
                       or field not in _PROVENANCE_ITEM_FIELDS
                       for field in retained_fields)
                or len(set(retained_fields)) != len(retained_fields)):
            raise ValueError(f"{path}: retained provenance fields for {name!r} are invalid")
        if (not isinstance(required_fields, list)
                or any(not isinstance(field, str)
                       or field not in _PROVENANCE_REQUIRED_FIELDS
                       for field in required_fields)
                or len(set(required_fields)) != len(required_fields)):
            raise ValueError(f"{path}: required provenance fields for {name!r} are invalid")
        retained_by_source[name] = set(retained_fields)
        required_by_source[name] = set(required_fields)

    input_shards = curated.get("input_shards")
    if not isinstance(input_shards, list):
        raise ValueError(f"{path}: curated provenance input shard inventory is invalid")
    input_membership: dict[tuple[str, str], int] = {}
    for record in input_shards:
        if not isinstance(record, dict):
            raise ValueError(f"{path}: curated provenance input shard record is invalid")
        source_name = record.get("source_name")
        if not isinstance(source_name, str) or source_name not in source_records:
            raise ValueError(f"{path}: curated provenance input shard source is invalid")
        require_lower_sha256(
            f"{path}:input_shard:sha256", record.get("sha256", "")
        )
        line_count = record.get("lines")
        valid_rows = record.get("documents")
        input_bytes = record.get("bytes")
        if (not isinstance(line_count, int) or isinstance(line_count, bool)
                or line_count < 0
                or not isinstance(valid_rows, int) or isinstance(valid_rows, bool)
                or valid_rows < 0 or valid_rows > line_count
                or not isinstance(input_bytes, int) or isinstance(input_bytes, bool)
                or input_bytes < line_count):
            raise ValueError(
                f"{path}: provenance input shard counts are invalid"
            )
        input_key = (source_name, record["sha256"])
        previous_line_count = input_membership.get(input_key)
        if previous_line_count is not None and previous_line_count != line_count:
            raise ValueError(f"{path}: duplicate input shard hash has conflicting line counts")
        input_membership[input_key] = line_count

    shard_records = provenance.get("shards")
    if not isinstance(shard_records, list) or not shard_records:
        raise ValueError(f"{path}: curated provenance shard records are missing")

    # SQLite keeps the document-to-sidecar join bounded in memory for large corpora.
    connection = sqlite3.connect("")
    try:
        connection.execute(
            "CREATE TABLE expected ("
            "provenance_sha256 TEXT PRIMARY KEY, document_sha256 TEXT NOT NULL UNIQUE, "
            "source TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE TABLE seen_inputs (source TEXT NOT NULL, shard TEXT NOT NULL, "
            "line INTEGER NOT NULL, PRIMARY KEY (source, shard, line)) WITHOUT ROWID"
        )
        observed_rows = 0
        for curated_record in curated_records:
            shard_path = path.parent / curated_record["filename"]
            with shard_path.open(encoding="utf-8") as stream:
                shard_rows = 0
                for line_no, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise ValueError(
                            f"{shard_path}:{line_no}: invalid curated JSONL row"
                        ) from exc
                    if not isinstance(row, dict):
                        raise ValueError(f"{shard_path}:{line_no}: invalid curated row")
                    text = row.get("text")
                    if not isinstance(text, str) or not text.strip():
                        raise ValueError(f"{shard_path}:{line_no}: curated text is invalid")
                    provenance_sha256 = row.get("provenance_sha256")
                    document_sha256 = row.get("document_sha256")
                    source_name = row.get("source")
                    require_lower_sha256(
                        f"{shard_path}:{line_no}:provenance_sha256",
                        provenance_sha256 or "",
                    )
                    require_lower_sha256(
                        f"{shard_path}:{line_no}:document_sha256",
                        document_sha256 or "",
                    )
                    if normalized_document_sha256(text) != row["document_sha256"]:
                        raise ValueError(
                            f"{shard_path}:{line_no}: curated document hash does not match normalized text"
                        )
                    if not isinstance(source_name, str) or source_name not in source_records:
                        raise ValueError(f"{shard_path}:{line_no}: curated source is invalid")
                    try:
                        connection.execute(
                            "INSERT INTO expected VALUES (?, ?, ?)",
                            (provenance_sha256, document_sha256, source_name),
                        )
                    except sqlite3.IntegrityError as exc:
                        raise ValueError(
                            "curated rows contain duplicate provenance/document bindings"
                        ) from exc
                    shard_rows += 1
                    observed_rows += 1
                if shard_rows != curated_record["documents"]:
                    raise ValueError(
                        f"{shard_path}: curated row count differs from manifest"
                    )

        totals = curated.get("totals")
        kept_documents = totals.get("kept_documents") if isinstance(totals, dict) else None
        if (not isinstance(kept_documents, int) or isinstance(kept_documents, bool)
                or observed_rows != kept_documents):
            raise ValueError(f"{path}: curated provenance document count mismatch")

        seen_filenames: set[str] = set()
        total_sidecar_documents = 0
        for expected_index, shard_record in enumerate(shard_records):
            if not isinstance(shard_record, dict):
                raise ValueError(f"{path}: curated provenance shard record is invalid")
            filename = shard_record.get("filename")
            if filename in seen_filenames:
                raise ValueError(f"{path}: duplicate curated provenance shard filename")
            seen_filenames.add(filename)
            index = shard_record.get("index")
            if (not isinstance(index, int) or isinstance(index, bool)
                    or index != expected_index):
                raise ValueError(f"{path}: curated provenance shard order is invalid")
            digest = shard_record.get("sha256")
            require_lower_sha256(f"{path}:provenance:{filename}:sha256", digest or "")
            if filename != f"provenance-{digest}.jsonl":
                raise ValueError(f"{path}: curated provenance filename/hash mismatch")
            declared_bytes = shard_record.get("bytes")
            declared_documents = shard_record.get("documents")
            if (not isinstance(declared_bytes, int) or isinstance(declared_bytes, bool)
                    or declared_bytes <= 0
                    or not isinstance(declared_documents, int)
                    or isinstance(declared_documents, bool)
                    or declared_documents <= 0):
                raise ValueError(f"{path}: curated provenance shard size/count is invalid")
            sidecar_path = _safe_sidecar_path(path.parent, filename)
            if not sidecar_path.is_file():
                raise ValueError(f"{path}: missing curated provenance shard {filename}")
            if (sidecar_path.stat().st_size != declared_bytes
                    or sha256_file(sidecar_path) != digest):
                raise ValueError(f"{path}:{filename}: provenance shard hash/size mismatch")

            shard_documents = 0
            with sidecar_path.open(encoding="utf-8") as stream:
                for line_no, line in enumerate(stream, 1):
                    if not line.strip():
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: blank provenance record"
                        )
                    if len(line.encode("utf-8")) > _PROVENANCE_MAX_RECORD_BYTES:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: provenance record exceeds size limit"
                        )
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: invalid provenance JSONL row"
                        ) from exc
                    if not isinstance(record, dict):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: invalid provenance record"
                        )
                    if set(record) != {
                        "schema_version", "format", "document_sha256",
                        "source_provenance", "input", "item_metadata",
                        "item_fields", "identifier_field", "verification",
                    }:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: unexpected provenance record fields"
                        )
                    record_sha256 = hashlib.sha256(
                        canonical_json_bytes(record)
                    ).hexdigest()
                    if (record.get("schema_version") != PROVENANCE_SCHEMA_VERSION
                            or record.get("format") != PROVENANCE_FORMAT
                            or record.get("verification") != _PROVENANCE_VERIFICATION):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: unsupported provenance record"
                        )
                    document_sha256 = record.get("document_sha256")
                    require_lower_sha256(
                        f"{sidecar_path}:{line_no}:document_sha256",
                        document_sha256 or "",
                    )
                    source_provenance = record.get("source_provenance")
                    if (not isinstance(source_provenance, dict)
                            or set(source_provenance)
                            != {"fields", "manifest_sha256", "rights_refs"}
                            or not isinstance(source_provenance.get("rights_refs"), dict)):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: source provenance is missing"
                        )
                    require_lower_sha256(
                        f"{sidecar_path}:{line_no}:source manifest_sha256",
                        source_provenance.get("manifest_sha256", ""),
                    )
                    fields = source_provenance.get("fields")
                    if (not isinstance(fields, dict)
                            or set(fields) != {
                                "name", "provider", "config", "revision",
                                "language", "license",
                            }):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: source provenance fields are invalid"
                        )
                    source_name = _provenance_field_value(fields, "name")
                    if source_name not in source_records:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: unknown provenance source"
                        )
                    curated_source = source_records[source_name]
                    if (source_provenance["manifest_sha256"]
                            != curated_source["manifest_sha256"]
                            or _provenance_field_value(fields, "revision")
                            != curated_source["source"].get("revision")):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: source manifest/revision binding mismatch"
                        )
                    for field_name, source_field in fields.items():
                        source_value = curated_source["source"].get(field_name)
                        available = source_value is not None and source_value != ""
                        if (not isinstance(source_field, dict)
                                or source_field.get("verified") is not False
                                or source_field.get("status")
                                != ("available" if available else "unavailable")
                                or (available and (
                                    not isinstance(source_value, str)
                                    or not isinstance(source_field.get("value"), str)
                                    or source_field["value"] != source_value
                                ))
                                or (not available and "value" in source_field)):
                            raise ValueError(
                                f"{sidecar_path}:{line_no}: source metadata is invalid"
                            )

                    input_record = record.get("input")
                    if (not isinstance(input_record, dict)
                            or set(input_record) != {"shard_sha256", "line"}):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: provenance input reference is invalid"
                        )
                    input_sha256 = input_record.get("shard_sha256")
                    require_lower_sha256(
                        f"{sidecar_path}:{line_no}:input shard_sha256",
                        input_sha256 or "",
                    )
                    source_line = input_record.get("line")
                    if (not isinstance(source_line, int) or isinstance(source_line, bool)
                            or source_line < 1
                            or source_line > input_membership.get(
                                (source_name, input_sha256), 0
                            )):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: input shard/line is not in curated lineage"
                        )
                    input_binding = (source_name, input_sha256, source_line)
                    try:
                        connection.execute(
                            "INSERT INTO seen_inputs VALUES (?, ?, ?)", input_binding
                        )
                    except sqlite3.IntegrityError as exc:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: duplicate input shard/line binding"
                        ) from exc

                    item_metadata = record.get("item_metadata")
                    item_fields = record.get("item_fields")
                    if not isinstance(item_metadata, dict) or not isinstance(item_fields, dict):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: item provenance is invalid"
                        )
                    retained_fields = retained_by_source[source_name]
                    if (set(item_metadata) - retained_fields
                            or any(not isinstance(key, str) or not isinstance(value, str)
                                   for key, value in item_metadata.items())):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: item metadata exceeds retained fields"
                        )
                    identifier_field = record.get("identifier_field")
                    expected_identifier = next((key for key in (
                        "identifier", "id", "record_id", "source_id", "url",
                        "source_url", "path",
                    ) if key in item_metadata), None)
                    if identifier_field != expected_identifier:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: item identifier binding is invalid"
                        )
                    expected_status = {
                        "license": "available" if {
                            "license", "license_expression"
                        } & set(item_metadata) else "unavailable",
                        "identifier": "available" if {
                            "identifier", "id", "record_id", "source_id", "url",
                            "source_url", "path",
                        } & set(item_metadata) else "unavailable",
                        "language": "available" if "language" in item_metadata else "unavailable",
                        "date": "available" if "date" in item_metadata else "unavailable",
                        "creator": "available" if "creator" in item_metadata else "unavailable",
                    }
                    if set(item_fields) != set(expected_status):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: item provenance field set is invalid"
                        )
                    for field_name, status in expected_status.items():
                        field = item_fields.get(field_name)
                        if (not isinstance(field, dict) or field.get("status") != status
                                or field.get("verified") is not False):
                            raise ValueError(
                                f"{sidecar_path}:{line_no}: item provenance is not unverified"
                            )
                    available_groups = {
                        "license": expected_status["license"] == "available",
                        "identifier": expected_status["identifier"] == "available",
                        "revision": True,
                        "language": expected_status["language"] == "available",
                        "date": expected_status["date"] == "available",
                        "creator": expected_status["creator"] == "available",
                    }
                    if any(not available_groups[field]
                           for field in required_by_source[source_name]):
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: required item provenance is unavailable"
                        )

                    cursor = connection.execute(
                        "DELETE FROM expected WHERE provenance_sha256 = ? "
                        "AND document_sha256 = ? AND source = ?",
                        (record_sha256, document_sha256, source_name),
                    )
                    if cursor.rowcount != 1:
                        raise ValueError(
                            f"{sidecar_path}:{line_no}: provenance does not bind to one curated row"
                        )
                    shard_documents += 1
                    total_sidecar_documents += 1
            if shard_documents != declared_documents:
                raise ValueError(
                    f"{sidecar_path}: provenance record count differs from manifest"
                )

        remaining = connection.execute(
            "SELECT COUNT(*) FROM expected"
        ).fetchone()[0]
        if total_sidecar_documents != observed_rows or remaining != 0:
            raise ValueError(f"{path}: curated provenance bindings are incomplete")
    finally:
        connection.close()

    return {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "format": PROVENANCE_FORMAT,
        "verification": _PROVENANCE_VERIFICATION,
        "validation_scope": _PROVENANCE_VALIDATION_SCOPE,
        "documents": total_sidecar_documents,
        "shards": shard_records,
    }


def _validate_curated(path: Path) -> tuple[dict, list[dict], dict | None]:
    data = _load_json(path)
    if data.get("schema_version") != CURATED_SCHEMA_VERSION:
        raise ValueError(f"{path}: unsupported curated manifest schema")
    if data.get("format") != CURATED_FORMAT:
        raise ValueError(f"{path}: unsupported curated corpus format")
    declared = data.get("curated_manifest_sha256")
    require_lower_sha256("curated_manifest_sha256", declared or "")
    unhashed = dict(data)
    del unhashed["curated_manifest_sha256"]
    actual_identity = hashlib.sha256(
        canonical_json_bytes(unhashed)
    ).hexdigest()
    if actual_identity != declared:
        raise ValueError(f"{path}: curated manifest identity hash mismatch")

    split_map = data.get("splits")
    if not isinstance(split_map, dict):
        raise ValueError(f"{path}: curated split records missing")
    records = []
    for split in ("train", "validation"):
        split_records = split_map.get(split)
        if not isinstance(split_records, list) or not split_records:
            raise ValueError(f"{path}: curated {split} split is empty")
        for record in split_records:
            if not isinstance(record, dict):
                raise ValueError(f"{path}:{split}: curated shard record is invalid")
            filename = record.get("filename")
            digest = record.get("sha256")
            require_lower_sha256(
                f"{path}:{split}:{filename}:sha256", digest or ""
            )
            shard = (
                _safe_curated_shard_path(path.parent, filename)
                if "provenance" in data
                else path.parent / filename
            )
            if not shard.is_file():
                raise ValueError(f"{path}: missing curated shard {shard}")
            if shard.stat().st_size != int(record.get("bytes", -1)):
                raise ValueError(f"{path}:{filename}: curated shard size mismatch")
            if sha256_file(shard) != digest:
                raise ValueError(f"{path}:{filename}: curated shard hash mismatch")
            records.append(
                {
                    "split": split,
                    "filename": filename,
                    "sha256": digest,
                    "bytes": int(record["bytes"]),
                    "documents": int(record["documents"]),
                }
            )
    provenance = _validate_provenance(path, data, records)
    return data, records, provenance


def _validate_audit(path: Path, curated_records: list[dict]) -> dict:
    audit = _load_json(path)
    if audit.get("schema_version") != AUDIT_SCHEMA_VERSION:
        raise ValueError(f"{path}: unsupported audit schema")
    if audit.get("passed") is not True:
        raise ValueError(f"{path}: post-curation audit did not pass")
    totals = audit.get("totals")
    if not isinstance(totals, dict):
        raise ValueError(f"{path}: audit totals missing")
    if int(totals.get("duplicate_documents", -1)) != 0:
        raise ValueError(f"{path}: curated duplicates remain")
    if int(totals.get("contaminated_documents", -1)) != 0:
        raise ValueError(f"{path}: curated benchmark contamination remains")
    require_lower_sha256("audit_sha256", audit.get("audit_sha256", ""))

    expected = {
        (record["filename"], record["sha256"]) for record in curated_records
    }
    observed = set()
    for record in audit.get("shards", []):
        filename = record.get("filename")
        digest = record.get("sha256")
        require_lower_sha256(
            f"audit:{filename}:sha256", digest or ""
        )
        observed.add((filename, digest))
    if observed != expected:
        raise ValueError(
            "post-curation audit coverage differs from curated shards"
        )
    return audit


def _validate_stream(meta_path: Path, tokenizer_path: Path) -> dict:
    meta = _load_json(meta_path)
    if meta.get("format") != TOKEN_STREAM_FORMAT:
        raise ValueError(f"{meta_path}: unsupported token stream format")
    for field in ("stream_sha256", "tokenizer_sha256"):
        require_lower_sha256(field, meta.get(field, ""))

    binary = meta_path.with_suffix(".bin")
    if not binary.is_file():
        raise ValueError(f"{meta_path}: stream binary is missing")
    if sha256_file(binary) != meta["stream_sha256"]:
        raise ValueError(f"{meta_path}: stream hash mismatch")
    if not tokenizer_path.is_file():
        raise ValueError(f"tokenizer is missing: {tokenizer_path}")
    tokenizer_hash = sha256_file(tokenizer_path)
    if tokenizer_hash != meta["tokenizer_sha256"]:
        raise ValueError(f"{meta_path}: tokenizer hash mismatch")

    curriculum = meta.get("curriculum")
    curriculum_record = None
    if curriculum is not None:
        if not isinstance(curriculum, dict) or curriculum.get("format") != STREAM_CURRICULUM_FORMAT:
            raise ValueError(f"{meta_path}: invalid curriculum metadata")
        declared = curriculum.get("curriculum_stream_sha256", "")
        require_lower_sha256("curriculum_stream_sha256", declared)
        unhashed = dict(curriculum)
        del unhashed["curriculum_stream_sha256"]
        actual = hashlib.sha256(canonical_json_bytes(unhashed)).hexdigest()
        if actual != declared:
            raise ValueError(f"{meta_path}: curriculum metadata identity hash mismatch")
        if int(curriculum.get("target_tokens", -1)) != int(meta["tokens"]):
            raise ValueError(f"{meta_path}: curriculum target differs from stream tokens")
        lanes = curriculum.get("lanes")
        if not isinstance(lanes, list):
            raise ValueError(f"{meta_path}: curriculum lanes are invalid")
        observed_lanes = {
            record.get("lane") for record in lanes if isinstance(record, dict)
        }
        if observed_lanes != REQUIRED_LANES or len(lanes) != len(REQUIRED_LANES):
            raise ValueError(f"{meta_path}: curriculum lane set mismatch")
        require_lower_sha256(
            "curriculum config_identity_sha256",
            str(curriculum.get("config_identity_sha256", "")),
        )
        require_lower_sha256(
            "curriculum config_file_sha256",
            str(curriculum.get("config_file_sha256", "")),
        )
        curriculum_record = dict(curriculum)

    record = {
        "metadata_filename": meta_path.name,
        "metadata_sha256": sha256_file(meta_path),
        "binary_filename": binary.name,
        "stream_sha256": meta["stream_sha256"],
        "stream_bytes": binary.stat().st_size,
        "tokens": int(meta["tokens"]),
        "documents": int(meta.get("documents", 0)),
        "vocab_size": int(meta["vocab_size"]),
        "eos_id": int(meta["eos_id"]),
        "dtype": meta["dtype"],
        "tokenizer_sha256": tokenizer_hash,
        "tokenizer_format": meta["tokenizer_format"],
        "protocol_start_id": int(meta["protocol_start_id"]),
    }
    if curriculum_record is not None:
        record["curriculum"] = curriculum_record
    return record


def _validate_source_eligibility(
    curated: dict,
    *,
    rights_path: Path,
    first_party_attestations: dict[str, str | Path] | None,
    first_party_root: str | Path | None,
    verify_attested_files: bool,
) -> tuple[list[str], dict[str, dict]]:
    source_names = sorted(
        record["source"]["name"] for record in curated.get("sources", [])
    )
    if not source_names:
        raise ValueError("curated manifest has no source lineage")

    rights = load_rights_registry(rights_path)
    curated_rights = curated.get("rights")
    if not isinstance(curated_rights, dict):
        raise ValueError("curated manifest has no rights evidence")
    if sha256_file(rights_path) != curated_rights.get("sha256"):
        raise ValueError("rights registry differs from the one used for curation")

    pinned_first_party = curated_rights.get("first_party_attestations", {})
    if not isinstance(pinned_first_party, dict):
        raise ValueError("curated first-party attestation evidence is invalid")
    first_party_names = set(pinned_first_party)
    unknown = sorted(first_party_names - set(source_names))
    if unknown:
        raise ValueError(
            "curated first-party evidence references unknown sources: "
            + ", ".join(unknown)
        )
    external_sources = sorted(set(source_names) - first_party_names)
    require_approved_rights(rights, external_sources)

    supplied = dict(first_party_attestations or {})
    missing = sorted(first_party_names - set(supplied))
    extra = sorted(set(supplied) - first_party_names)
    if missing or extra:
        raise ValueError(
            f"first-party attestation mapping mismatch: missing={missing}, extra={extra}"
        )
    if first_party_names and verify_attested_files and first_party_root is None:
        raise ValueError("first-party dataset sources require first_party_root")

    verified: dict[str, dict] = {}
    for source_name in sorted(first_party_names):
        expected = pinned_first_party[source_name]
        if not isinstance(expected, dict):
            raise ValueError(
                f"curated first-party evidence for {source_name!r} is invalid"
            )
        path = Path(supplied[source_name])
        if not path.is_file():
            raise ValueError(
                f"first-party attestation is missing for {source_name!r}: {path}"
            )
        if sha256_file(path) != expected.get("file_sha256"):
            raise ValueError(
                f"first-party attestation file differs from curation for {source_name!r}"
            )
        with path.open(encoding="utf-8") as stream:
            packet = json.load(stream)
        if verify_attested_files:
            packet = validate_attestation(path, workspace_root=first_party_root)
        else:
            validate_attestation_packet(packet, require_ownership=True)
        if packet.get("attestation_sha256") != expected.get("attestation_sha256"):
            raise ValueError(
                f"first-party attestation identity differs from curation for {source_name!r}"
            )
        if attestation_scope_sha256(packet) != expected.get(
            "attestation_scope_sha256"
        ):
            raise ValueError(
                f"first-party attestation scope differs from curation for {source_name!r}"
            )
        if (
            expected.get("status") != "ATTESTED_FIRST_PARTY"
            or expected.get("production_eligible") is not True
        ):
            raise ValueError(
                f"curated first-party source {source_name!r} was not production eligible"
            )
        verified[source_name] = dict(expected)
    return external_sources, verified


def build_dataset_manifest(
    curated_manifest_path: str,
    *,
    audit_path: str,
    rights_registry_path: str,
    train_stream_meta_path: str,
    validation_stream_meta_path: str,
    tokenizer_path: str,
    first_party_attestations: dict[str, str | Path] | None = None,
    first_party_root: str | Path | None = None,
    _verify_attested_files: bool = True,
) -> dict:
    curated_path = Path(curated_manifest_path)
    curated, curated_records, provenance_validation = _validate_curated(curated_path)

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    source_names = sorted(
        record["source"]["name"] for record in curated.get("sources", [])
    )
    external_sources, verified_first_party = _validate_source_eligibility(
        curated,
        rights_path=rights_path,
        first_party_attestations=first_party_attestations,
        first_party_root=first_party_root,
        verify_attested_files=_verify_attested_files,
    )

    audit_file = Path(audit_path)
    audit = _validate_audit(audit_file, curated_records)

    tokenizer = Path(tokenizer_path)
    train_stream = _validate_stream(
        Path(train_stream_meta_path), tokenizer
    )
    validation_stream = _validate_stream(
        Path(validation_stream_meta_path), tokenizer
    )
    compatibility = (
        "vocab_size",
        "eos_id",
        "dtype",
        "tokenizer_sha256",
        "tokenizer_format",
        "protocol_start_id",
    )
    for key in compatibility:
        if train_stream[key] != validation_stream[key]:
            raise ValueError(
                f"train/validation stream mismatch for {key}"
            )
    train_curriculum = train_stream.get("curriculum")
    validation_curriculum = validation_stream.get("curriculum")
    if (train_curriculum is None) != (validation_curriculum is None):
        raise ValueError(
            "train/validation stream mismatch for curriculum presence"
        )
    if train_curriculum is not None:
        if (
            train_curriculum.get("config_identity_sha256")
            != validation_curriculum.get("config_identity_sha256")
        ):
            raise ValueError(
                "train/validation stream mismatch for curriculum identity"
            )

    payload = {
        "schema_version": DATASET_MANIFEST_SCHEMA,
        "format": "ilaria-dataset-manifest-v1",
        "curated_corpus": {
            "filename": curated_path.name,
            "file_sha256": sha256_file(curated_path),
            "identity_sha256": curated["curated_manifest_sha256"],
            "policy": curated["policy"],
            "sources": curated["sources"],
            "totals": curated["totals"],
            "shards": curated_records,
            **({"provenance": provenance_validation}
               if provenance_validation is not None else {}),
        },
        "post_curation_audit": {
            "filename": audit_file.name,
            "file_sha256": sha256_file(audit_file),
            "audit_sha256": audit["audit_sha256"],
            "documents": audit["totals"]["documents"],
        },
        "rights": {
            "filename": rights_path.name,
            "sha256": sha256_file(rights_path),
            "policy": rights.get("policy", ""),
            "approved_sources": source_names,
            "external_approved_sources": external_sources,
            "first_party_attestations": verified_first_party,
        },
        "tokenizer": {
            "filename": tokenizer.name,
            "sha256": train_stream["tokenizer_sha256"],
            "format": train_stream["tokenizer_format"],
            "vocab_size": train_stream["vocab_size"],
            "protocol_start_id": train_stream["protocol_start_id"],
            "eos_id": train_stream["eos_id"],
        },
        "streams": {
            "train": train_stream,
            "validation": validation_stream,
        },
    }
    payload["dataset_manifest_sha256"] = hashlib.sha256(
        canonical_json_bytes(payload)
    ).hexdigest()
    return payload


def validate_dataset_manifest_file(path: str | Path) -> dict:
    manifest_path = Path(path)
    manifest = _load_json(manifest_path)
    declared = manifest.get("dataset_manifest_sha256", "")
    require_lower_sha256("dataset_manifest_sha256", declared)
    unhashed = dict(manifest)
    del unhashed["dataset_manifest_sha256"]
    actual = hashlib.sha256(canonical_json_bytes(unhashed)).hexdigest()
    if actual != declared:
        raise ValueError("dataset manifest identity hash mismatch")
    if manifest.get("format") != "ilaria-dataset-manifest-v1":
        raise ValueError("unsupported dataset manifest format")

    root = manifest_path.parent
    try:
        curated_name = manifest["curated_corpus"]["filename"]
        audit_name = manifest["post_curation_audit"]["filename"]
        rights_name = manifest["rights"]["filename"]
        train_meta_name = manifest["streams"]["train"]["metadata_filename"]
        val_meta_name = manifest["streams"]["validation"]["metadata_filename"]
        tokenizer_name = manifest["tokenizer"]["filename"]
    except (KeyError, TypeError) as exc:
        raise ValueError("dataset manifest artifact references are incomplete") from exc

    pinned_first_party = manifest.get("rights", {}).get(
        "first_party_attestations", {}
    )
    if not isinstance(pinned_first_party, dict):
        raise ValueError("dataset manifest first-party evidence is invalid")
    first_party_paths = {}
    for source_name, record in pinned_first_party.items():
        if not isinstance(record, dict):
            raise ValueError("dataset manifest first-party record is invalid")
        filename = record.get("filename")
        if not isinstance(filename, str) or not filename:
            raise ValueError("dataset manifest first-party filename is invalid")
        first_party_paths[source_name] = root / filename

    rebuilt = build_dataset_manifest(
        str(root / curated_name),
        audit_path=str(root / audit_name),
        rights_registry_path=str(root / rights_name),
        train_stream_meta_path=str(root / train_meta_name),
        validation_stream_meta_path=str(root / val_meta_name),
        tokenizer_path=str(root / tokenizer_name),
        first_party_attestations=first_party_paths,
        _verify_attested_files=False,
    )
    if rebuilt != manifest:
        raise ValueError("dataset manifest differs from reconstructed artifacts")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--curated-manifest", required=True)
    parser.add_argument("--audit", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--train-stream-meta", required=True)
    parser.add_argument("--validation-stream-meta", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument(
        "--first-party-attestation",
        action="append",
        default=[],
        metavar="SOURCE=PATH",
    )
    parser.add_argument("--first-party-root", default="")
    parser.add_argument("--out", required=True)
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

    manifest = build_dataset_manifest(
        args.curated_manifest,
        audit_path=args.audit,
        rights_registry_path=args.rights,
        train_stream_meta_path=args.train_stream_meta,
        validation_stream_meta_path=args.validation_stream_meta,
        tokenizer_path=args.tokenizer,
        first_party_attestations=first_party_attestations,
        first_party_root=args.first_party_root or None,
    )
    atomic_write_json(args.out, manifest)
    print(
        f"[dataset_manifest] "
        f"train_tokens={manifest['streams']['train']['tokens']:,} "
        f"validation_tokens={manifest['streams']['validation']['tokens']:,} "
        f"sha256={manifest['dataset_manifest_sha256']}"
    )


if __name__ == "__main__":
    main()
