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
from pathlib import Path

try:
    from .curate_corpus import CURATED_FORMAT, CURATED_SCHEMA_VERSION
    from .curriculum_stream import REQUIRED_LANES, STREAM_CURRICULUM_FORMAT
    from .data_audit import AUDIT_SCHEMA_VERSION
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
    from curate_corpus import CURATED_FORMAT, CURATED_SCHEMA_VERSION
    from curriculum_stream import REQUIRED_LANES, STREAM_CURRICULUM_FORMAT
    from data_audit import AUDIT_SCHEMA_VERSION
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


def _validate_curated(path: Path) -> tuple[dict, list[dict]]:
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
            filename = record.get("filename")
            digest = record.get("sha256")
            require_lower_sha256(
                f"{path}:{split}:{filename}:sha256", digest or ""
            )
            shard = path.parent / filename
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
    return data, records


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
    curated, curated_records = _validate_curated(curated_path)

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
