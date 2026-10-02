"""Content-addressed coverage evidence for production IlariaLex samples."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from data_contract import (
    atomic_write_json,
    canonical_json_sha256,
    load_rights_registry,
    require_approved_rights,
    require_lower_sha256,
    sha256_file,
)
from first_party_attestation import (
    attestation_scope_sha256,
    match_attested_file,
    validate_attestation,
)

COVERAGE_FORMAT = "ilarialex-coverage-v1"
REQUIRED_COVERAGE = frozenset(
    {
        "english",
        "code",
        "math_science",
        "os_drivers",
        "hardware",
        "tools_protocol",
    }
)


def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("coverage_sha256", None)
    return canonical_json_sha256(payload)


def build_coverage_manifest(
    entries: dict[str, list[tuple[str | Path, str]]],
    *,
    rights_registry_path: str | Path,
    first_party_attestations: dict[str, str | Path] | None = None,
    first_party_root: str | Path | None = None,
) -> dict:
    """Pin dedicated evidence files for every required tokenizer coverage class.

    ``entries`` maps coverage class -> ``[(path, source_name), ...]``. A source
    must already be approved in the rights registry; this module never grants
    rights itself.
    """
    if set(entries) != REQUIRED_COVERAGE:
        missing = sorted(REQUIRED_COVERAGE - set(entries))
        extra = sorted(set(entries) - REQUIRED_COVERAGE)
        raise ValueError(
            f"tokenizer coverage set mismatch: missing={missing}, extra={extra}"
        )

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    all_sources = sorted(
        {source for records in entries.values() for _, source in records}
    )
    first_party_attestations = dict(first_party_attestations or {})
    unused_first_party = sorted(set(first_party_attestations) - set(all_sources))
    if unused_first_party:
        raise ValueError(
            "unused first-party tokenizer coverage attestations: "
            + ", ".join(unused_first_party)
        )
    ambiguous = sorted(set(first_party_attestations) & set(rights["sources"]))
    if ambiguous:
        raise ValueError(
            "tokenizer coverage sources have ambiguous external and first-party rights bases: "
            + ", ".join(ambiguous)
        )
    external_sources = sorted(set(all_sources) - set(first_party_attestations))
    require_approved_rights(rights, external_sources)
    if first_party_attestations and first_party_root is None:
        raise ValueError("first-party tokenizer coverage requires first_party_root")
    first_party_packets: dict[str, dict] = {}
    first_party_records: dict[str, dict] = {}
    for source, attestation_path in sorted(first_party_attestations.items()):
        packet = validate_attestation(attestation_path, workspace_root=first_party_root)
        first_party_packets[source] = packet
        first_party_records[source] = {
            "filename": Path(attestation_path).name,
            "file_sha256": sha256_file(attestation_path),
            "attestation_sha256": packet["attestation_sha256"],
            "attestation_scope_sha256": attestation_scope_sha256(packet),
        }

    coverage: dict[str, dict] = {}
    for category in sorted(REQUIRED_COVERAGE):
        records = entries[category]
        if not records:
            raise ValueError(f"tokenizer coverage category {category!r} is empty")
        files = []
        total_bytes = 0
        seen_paths: set[str] = set()
        for raw_path, source in sorted(records, key=lambda item: str(item[0])):
            path = Path(raw_path)
            if not path.is_file():
                raise ValueError(f"tokenizer coverage input does not exist: {path}")
            size = path.stat().st_size
            if size <= 0:
                raise ValueError(f"tokenizer coverage input is empty: {path}")
            resolved = str(path.resolve())
            if resolved in seen_paths:
                raise ValueError(
                    f"duplicate tokenizer coverage input in {category!r}: {path}"
                )
            seen_paths.add(resolved)
            files.append(
                {
                    "filename": path.name,
                    "sha256": sha256_file(path),
                    "bytes": size,
                    "source": source,
                    **(
                        {
                            "attested_path": match_attested_file(
                                first_party_packets[source],
                                path,
                                workspace_root=first_party_root,
                            )
                        }
                        if source in first_party_packets
                        else {}
                    ),
                }
            )
            total_bytes += size
        coverage[category] = {
            "bytes": total_bytes,
            "files": files,
        }

    manifest = {
        "format": COVERAGE_FORMAT,
        "coverage": coverage,
        "sources": all_sources,
        "rights": {
            "filename": rights_path.name,
            "sha256": sha256_file(rights_path),
            "policy": rights.get("policy", ""),
        },
        **(
            {"first_party_attestations": first_party_records}
            if first_party_records
            else {}
        ),
    }
    manifest["coverage_sha256"] = _identity_hash(manifest)
    return manifest


def validate_coverage_manifest(
    path: str | Path,
    *,
    rights_registry_path: str | Path,
    first_party_attestations: dict[str, str | Path] | None = None,
    first_party_root: str | Path | None = None,
) -> dict:
    manifest_path = Path(path)
    with manifest_path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict) or manifest.get("format") != COVERAGE_FORMAT:
        raise ValueError("unsupported tokenizer coverage manifest format")
    declared = manifest.get("coverage_sha256", "")
    require_lower_sha256("coverage_sha256", declared)
    if _identity_hash(manifest) != declared:
        raise ValueError("tokenizer coverage manifest identity hash mismatch")

    coverage = manifest.get("coverage")
    if not isinstance(coverage, dict) or set(coverage) != REQUIRED_COVERAGE:
        raise ValueError("tokenizer coverage manifest category set mismatch")

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("tokenizer coverage manifest has no sources")
    first_party_identity = manifest.get("first_party_attestations", {})
    if not isinstance(first_party_identity, dict):
        raise ValueError("tokenizer coverage first-party identity is invalid")
    first_party_attestations = dict(first_party_attestations or {})
    if set(first_party_attestations) != set(first_party_identity):
        raise ValueError("tokenizer coverage first-party attestation set mismatch")
    ambiguous = sorted(set(first_party_identity) & set(rights["sources"]))
    if ambiguous:
        raise ValueError(
            "tokenizer coverage sources have ambiguous external and first-party rights bases: "
            + ", ".join(ambiguous)
        )
    external_sources = sorted(set(sources) - set(first_party_identity))
    require_approved_rights(rights, external_sources)
    if first_party_identity and first_party_root is None:
        raise ValueError("first-party tokenizer coverage requires first_party_root")
    first_party_packets: dict[str, dict] = {}
    for source, identity in sorted(first_party_identity.items()):
        if not isinstance(identity, dict):
            raise ValueError(f"tokenizer coverage first-party identity {source!r} is invalid")
        attestation_path = first_party_attestations[source]
        packet = validate_attestation(attestation_path, workspace_root=first_party_root)
        expected = {
            "filename": Path(attestation_path).name,
            "file_sha256": sha256_file(attestation_path),
            "attestation_sha256": packet["attestation_sha256"],
            "attestation_scope_sha256": attestation_scope_sha256(packet),
        }
        if identity != expected:
            raise ValueError(f"tokenizer coverage first-party identity mismatch for {source!r}")
        first_party_packets[source] = packet
    pinned_rights = manifest.get("rights")
    if not isinstance(pinned_rights, dict) or pinned_rights.get("sha256") != sha256_file(rights_path):
        raise ValueError("tokenizer coverage rights registry hash mismatch")

    observed_sources: set[str] = set()
    for category in sorted(REQUIRED_COVERAGE):
        record = coverage[category]
        if not isinstance(record, dict):
            raise ValueError(f"tokenizer coverage record {category!r} is invalid")
        files = record.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError(f"tokenizer coverage category {category!r} is empty")
        total = 0
        for file_record in files:
            if not isinstance(file_record, dict):
                raise ValueError(f"tokenizer coverage file record {category!r} is invalid")
            filename = file_record.get("filename")
            source = file_record.get("source")
            digest = file_record.get("sha256", "")
            require_lower_sha256(f"coverage {category} sha256", digest)
            if not isinstance(filename, str) or not filename:
                raise ValueError(f"tokenizer coverage filename {category!r} is invalid")
            if not isinstance(source, str) or not source:
                raise ValueError(f"tokenizer coverage source {category!r} is invalid")
            input_path = manifest_path.parent / filename
            if not input_path.is_file():
                raise ValueError(f"tokenizer coverage input is missing: {input_path}")
            size = input_path.stat().st_size
            if size != int(file_record.get("bytes", -1)):
                raise ValueError(f"tokenizer coverage input size mismatch: {filename}")
            if sha256_file(input_path) != digest:
                raise ValueError(f"tokenizer coverage input hash mismatch: {filename}")
            if source in first_party_packets:
                attested_path = file_record.get("attested_path")
                if not isinstance(attested_path, str) or not attested_path:
                    raise ValueError(
                        f"tokenizer coverage first-party input lacks attested_path: {filename}"
                    )
                matched = match_attested_file(
                    first_party_packets[source],
                    input_path,
                    workspace_root=first_party_root,
                )
                if matched != attested_path:
                    raise ValueError(
                        f"tokenizer coverage first-party provenance mismatch: {filename}"
                    )
            total += size
            observed_sources.add(source)
        if total != int(record.get("bytes", -1)):
            raise ValueError(f"tokenizer coverage byte total mismatch: {category}")
    if observed_sources != set(sources):
        raise ValueError("tokenizer coverage source set differs from file provenance")
    return manifest


def _parse_entry(value: str) -> tuple[str, Path, str]:
    category, sep, rest = value.partition("=")
    path_text, sep2, source = rest.rpartition("@")
    if not sep or not sep2 or category not in REQUIRED_COVERAGE or not path_text or not source:
        raise ValueError("coverage input must be CATEGORY=PATH@SOURCE")
    return category, Path(path_text), source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--rights", required=True)
    parser.add_argument("--first-party-attestation", action="append", default=[])
    parser.add_argument("--first-party-root", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    entries = {category: [] for category in REQUIRED_COVERAGE}
    for raw in args.input:
        category, path, source = _parse_entry(raw)
        entries[category].append((path, source))
    first_party_attestations = {}
    for raw in args.first_party_attestation:
        source, sep, path = raw.partition("=")
        if not sep or not source or not path or source in first_party_attestations:
            raise ValueError("first-party attestation must be unique SOURCE=PATH")
        first_party_attestations[source] = path
    manifest = build_coverage_manifest(
        entries,
        rights_registry_path=args.rights,
        first_party_attestations=first_party_attestations,
        first_party_root=args.first_party_root or None,
    )
    atomic_write_json(args.out, manifest)
    print(f"[ilarialex] coverage manifest {args.out}: {manifest['coverage_sha256']}")


if __name__ == "__main__":
    main()
