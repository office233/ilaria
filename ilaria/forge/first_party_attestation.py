"""Content-addressed ownership/provenance attestation for first-party corpus lanes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from data_contract import canonical_json_sha256, require_lower_sha256, sha256_file

ATTESTATION_FORMAT = "ilaria-first-party-attestation-v1"


def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("attestation_sha256", None)
    return canonical_json_sha256(payload)


def validate_attestation_packet(data: dict, *, require_ownership: bool = True) -> dict:
    """Validate the content-addressed decision packet without touching workspace files."""
    if not isinstance(data, dict) or data.get("format") != ATTESTATION_FORMAT:
        raise ValueError("unsupported first-party attestation format")
    declared = data.get("attestation_sha256", "")
    require_lower_sha256("attestation_sha256", declared)
    if _identity_hash(data) != declared:
        raise ValueError("first-party attestation identity hash mismatch")
    records = data.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("first-party attestation has no files")
    observed: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("first-party attestation file record is invalid")
        relative = record.get("path")
        if not isinstance(relative, str) or not relative or relative in observed:
            raise ValueError(
                "first-party attestation file path is invalid or duplicated"
            )
        observed.add(relative)
        require_lower_sha256(
            f"first-party file {relative} sha256", record.get("sha256", "")
        )
    if require_ownership:
        if data.get("ownership_attested") is not True:
            raise ValueError("first-party ownership is not attested")
        actor = data.get("attested_by")
        if not isinstance(actor, str) or not actor.strip():
            raise ValueError("first-party attestation has no attested_by identity")
        review_ref = data.get("review_ref")
        if not isinstance(review_ref, str) or not review_ref.strip():
            raise ValueError("first-party attestation has no review_ref")
    return data


def attestation_scope_sha256(data: dict) -> str:
    """Hash only the pinned file set, independent of the human decision fields."""
    records = data.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("first-party attestation has no files")
    return canonical_json_sha256({"files": records})


def inspect_attestation(path: str | Path, *, workspace_root: str | Path) -> dict:
    """Validate identity and pinned file hashes without granting ownership."""
    attestation_path = Path(path)
    with attestation_path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    validate_attestation_packet(data, require_ownership=False)

    root = Path(workspace_root).resolve()
    records = data.get("files")
    for record in records:
        relative = record.get("path")
        file_path = (root / relative).resolve()
        if root not in file_path.parents:
            raise ValueError("first-party attestation path escapes workspace")
        if not file_path.is_file() or file_path.is_symlink():
            raise ValueError(f"first-party attested file is missing or symlinked: {relative}")
        digest = record["sha256"]
        if sha256_file(file_path) != digest:
            raise ValueError(f"first-party attested file hash mismatch: {relative}")
    return data


def match_attested_file(
    data: dict,
    candidate_path: str | Path,
    *,
    workspace_root: str | Path,
) -> str:
    """Return the attested workspace path matching a candidate file by content.

    The candidate may be the workspace file itself or a byte-identical copy used
    in a production artifact directory. Digest matching is accepted only when it
    identifies exactly one attested file; duplicate-content ambiguity fails
    closed instead of guessing provenance.
    """
    root = Path(workspace_root).resolve()
    candidate = Path(candidate_path).resolve()
    if not candidate.is_file() or candidate.is_symlink():
        raise ValueError(f"first-party candidate file is missing or symlinked: {candidate}")
    digest = sha256_file(candidate)
    records = data.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("first-party attestation has no files")

    exact: list[str] = []
    by_digest: list[str] = []
    for record in records:
        relative = record.get("path")
        if not isinstance(relative, str) or not relative:
            continue
        attested = (root / relative).resolve()
        if record.get("sha256") == digest:
            by_digest.append(relative)
            if attested == candidate:
                exact.append(relative)
    if len(exact) == 1:
        return exact[0]
    if len(by_digest) == 1:
        return by_digest[0]
    if not by_digest:
        raise ValueError("first-party candidate content is not present in the attestation")
    raise ValueError("first-party candidate content matches multiple attested files")


def validate_attestation(path: str | Path, *, workspace_root: str | Path) -> dict:
    data = inspect_attestation(path, workspace_root=workspace_root)
    validate_attestation_packet(data, require_ownership=True)
    return data


def evaluate_source_attestation(
    source_manifest: dict,
    attestation_path: str | Path,
    *,
    workspace_root: str | Path,
    require_approved: bool = False,
) -> dict:
    """Bind a raw source manifest to first-party provenance and ownership evidence."""
    source = source_manifest.get("source")
    source_name = source.get("name") if isinstance(source, dict) else None
    if not isinstance(source_name, str) or not source_name:
        raise ValueError("first-party source manifest has no source name")
    inspected = inspect_attestation(attestation_path, workspace_root=workspace_root)
    pipeline = source_manifest.get("pipeline")
    if (
        not isinstance(pipeline, dict)
        or pipeline.get("rights_basis") != "first_party_attestation"
    ):
        raise ValueError(
            f"first-party source {source_name!r} lacks a first-party rights basis"
        )
    scope_sha256 = attestation_scope_sha256(inspected)
    if pipeline.get("attestation_scope_sha256") != scope_sha256:
        raise ValueError(
            f"first-party source {source_name!r} attestation scope mismatch"
        )
    required_files = pipeline.get("attestation_required_files")
    if not isinstance(required_files, list) or not required_files:
        raise ValueError(
            f"first-party source {source_name!r} has no attestation-required file set"
        )
    pinned_files = {
        (record["path"], record["sha256"])
        for record in inspected["files"]
    }
    for record in required_files:
        if not isinstance(record, dict):
            raise ValueError(
                f"first-party source {source_name!r} has invalid attestation-required file"
            )
        pair = (record.get("path"), record.get("sha256"))
        if pair not in pinned_files:
            raise ValueError(
                f"first-party source {source_name!r} required file is not attested: {pair[0]!r}"
            )
    generator_sha256 = pipeline.get("generator_sha256")
    if generator_sha256 is not None:
        require_lower_sha256(
            f"first-party source {source_name!r} generator_sha256",
            generator_sha256,
        )
        if not any(
            record.get("sha256") == generator_sha256
            for record in required_files
            if isinstance(record, dict)
        ):
            raise ValueError(
                f"first-party source {source_name!r} generator is not in the attested file set"
            )

    status = "OWNERSHIP_ATTESTATION_REQUIRED"
    error = None
    if inspected.get("ownership_attested") is True:
        try:
            validate_attestation(attestation_path, workspace_root=workspace_root)
            status = "ATTESTED_FIRST_PARTY"
        except ValueError as exc:
            status = "ATTESTATION_INVALID"
            error = str(exc)
    report = {
        "status": status,
        "production_eligible": status == "ATTESTED_FIRST_PARTY",
        "filename": Path(attestation_path).name,
        "file_sha256": sha256_file(attestation_path),
        "attestation_sha256": inspected["attestation_sha256"],
        "attestation_scope_sha256": scope_sha256,
        "error": error,
    }
    if require_approved and not report["production_eligible"]:
        detail = f": {error}" if error else ""
        raise ValueError(
            f"first-party source {source_name!r} is not approved: {status}{detail}"
        )
    return report


def build_attestation_template(
    workspace_root: str | Path,
    *,
    paths: list[str],
) -> dict:
    """Build an unsigned template; ownership must be explicitly attested later."""
    root = Path(workspace_root).resolve()
    if not paths:
        raise ValueError("first-party attestation template requires files")
    records = []
    for relative in sorted(set(paths)):
        file_path = (root / relative).resolve()
        if root not in file_path.parents:
            raise ValueError("first-party attestation path escapes workspace")
        if not file_path.is_file() or file_path.is_symlink():
            raise ValueError(f"first-party template file is missing or symlinked: {relative}")
        records.append({"path": relative, "sha256": sha256_file(file_path)})
    data = {
        "format": ATTESTATION_FORMAT,
        "ownership_attested": False,
        "attested_by": "",
        "review_ref": "",
        "files": records,
    }
    data["attestation_sha256"] = _identity_hash(data)
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    template = sub.add_parser("template")
    template.add_argument("--root", required=True)
    template.add_argument("--path", action="append", required=True)
    template.add_argument("--out", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("--root", required=True)
    validate.add_argument("--attestation", required=True)
    args = parser.parse_args()
    if args.command == "template":
        data = build_attestation_template(args.root, paths=args.path)
        Path(args.out).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"[first-party] unsigned template: {data['attestation_sha256']}")
    else:
        data = validate_attestation(args.attestation, workspace_root=args.root)
        print(f"[first-party] valid: {data['attestation_sha256']}")


if __name__ == "__main__":
    main()
