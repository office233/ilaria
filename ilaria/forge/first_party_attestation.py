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


def validate_attestation(path: str | Path, *, workspace_root: str | Path) -> dict:
    attestation_path = Path(path)
    with attestation_path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict) or data.get("format") != ATTESTATION_FORMAT:
        raise ValueError("unsupported first-party attestation format")
    declared = data.get("attestation_sha256", "")
    require_lower_sha256("attestation_sha256", declared)
    if _identity_hash(data) != declared:
        raise ValueError("first-party attestation identity hash mismatch")
    if data.get("ownership_attested") is not True:
        raise ValueError("first-party ownership is not attested")
    actor = data.get("attested_by")
    if not isinstance(actor, str) or not actor.strip():
        raise ValueError("first-party attestation has no attested_by identity")
    review_ref = data.get("review_ref")
    if not isinstance(review_ref, str) or not review_ref.strip():
        raise ValueError("first-party attestation has no review_ref")

    root = Path(workspace_root).resolve()
    records = data.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("first-party attestation has no files")
    observed: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("first-party attestation file record is invalid")
        relative = record.get("path")
        if not isinstance(relative, str) or not relative or relative in observed:
            raise ValueError("first-party attestation file path is invalid or duplicated")
        observed.add(relative)
        file_path = (root / relative).resolve()
        if root not in file_path.parents:
            raise ValueError("first-party attestation path escapes workspace")
        if not file_path.is_file() or file_path.is_symlink():
            raise ValueError(f"first-party attested file is missing or symlinked: {relative}")
        digest = record.get("sha256", "")
        require_lower_sha256(f"first-party file {relative} sha256", digest)
        if sha256_file(file_path) != digest:
            raise ValueError(f"first-party attested file hash mismatch: {relative}")
    return data


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
