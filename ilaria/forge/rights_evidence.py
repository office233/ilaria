"""Validate rights-review evidence against the immutable corpus source lock."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from corpus_source_lock import SOURCE_LOCK_FORMAT
from data_contract import canonical_json_sha256, load_rights_registry, require_lower_sha256
from git_source_lock import LOCK_FORMAT as GIT_SOURCE_LOCK_FORMAT

RIGHTS_EVIDENCE_FORMAT = "ilaria-rights-evidence-v1"


def _identity_hash(packet: dict) -> str:
    payload = dict(packet)
    payload.pop("evidence_sha256", None)
    return canonical_json_sha256(payload)


def load_and_validate_evidence(
    evidence_path: str | Path,
    *,
    source_lock_path: str | Path,
    rights_registry_path: str | Path,
    git_source_lock_path: str | Path | None = None,
) -> dict:
    with Path(evidence_path).open(encoding="utf-8") as stream:
        evidence = json.load(stream)
    if evidence.get("format") != RIGHTS_EVIDENCE_FORMAT:
        raise ValueError("unsupported rights evidence format")
    declared = evidence.get("evidence_sha256", "")
    require_lower_sha256("evidence_sha256", declared)
    if _identity_hash(evidence) != declared:
        raise ValueError("rights evidence identity hash mismatch")

    with Path(source_lock_path).open(encoding="utf-8") as stream:
        lock = json.load(stream)
    if lock.get("format") != SOURCE_LOCK_FORMAT:
        raise ValueError("unsupported corpus source lock format")
    lock_hash = lock.get("source_lock_sha256", "")
    require_lower_sha256("source_lock_sha256", lock_hash)
    lock_payload = dict(lock)
    lock_payload.pop("source_lock_sha256", None)
    if canonical_json_sha256(lock_payload) != lock_hash:
        raise ValueError("corpus source lock identity hash mismatch")
    if evidence.get("source_lock_sha256") != lock_hash:
        raise ValueError("rights evidence points at a different source lock")

    registry = load_rights_registry(rights_registry_path)
    registry_evidence = registry.get("evidence")
    if not isinstance(registry_evidence, dict):
        raise ValueError("rights registry has no evidence identity")
    if git_source_lock_path is None:
        git_lock_name = registry_evidence.get("git_source_lock_filename")
        if isinstance(git_lock_name, str) and git_lock_name:
            git_source_lock_path = Path(rights_registry_path).parent / git_lock_name

    git_lock = None
    git_lock_hash = None
    if git_source_lock_path is not None:
        with Path(git_source_lock_path).open(encoding="utf-8") as stream:
            git_lock = json.load(stream)
        if git_lock.get("format") != GIT_SOURCE_LOCK_FORMAT:
            raise ValueError("unsupported git source lock format")
        git_lock_hash = git_lock.get("source_lock_sha256", "")
        require_lower_sha256("git_source_lock_sha256", git_lock_hash)
        git_lock_payload = dict(git_lock)
        git_lock_payload.pop("source_lock_sha256", None)
        if canonical_json_sha256(git_lock_payload) != git_lock_hash:
            raise ValueError("git source lock identity hash mismatch")
        if evidence.get("git_source_lock_sha256") != git_lock_hash:
            raise ValueError("rights evidence points at a different git source lock")

    if registry_evidence.get("filename") != Path(evidence_path).name:
        raise ValueError("rights registry evidence filename mismatch")
    if registry_evidence.get("sha256") != declared:
        raise ValueError("rights registry evidence hash mismatch")
    if registry_evidence.get("source_lock_sha256") != lock_hash:
        raise ValueError("rights registry source lock hash mismatch")
    if git_lock_hash is not None and registry_evidence.get("git_source_lock_sha256") != git_lock_hash:
        raise ValueError("rights registry git source lock hash mismatch")
    evidence_sources = evidence.get("sources")
    if not isinstance(evidence_sources, dict):
        raise ValueError("rights evidence has no source records")
    expected = set(registry["sources"])
    if set(evidence_sources) != expected:
        raise ValueError("rights evidence source set differs from rights registry")

    locked_sources = lock.get("sources", {})
    git_locked_sources = git_lock.get("sources", {}) if isinstance(git_lock, dict) else {}
    for name in sorted(expected):
        record = evidence_sources[name]
        if not isinstance(record, dict):
            raise ValueError(f"rights evidence record {name!r} is invalid")
        source_kind = record.get("source_kind", "huggingface")
        if source_kind == "huggingface":
            locked = locked_sources.get(name)
            if not isinstance(locked, dict):
                raise ValueError(f"source lock has no entry for {name!r}")
            for field in ("provider", "config", "revision"):
                if record.get(field) != locked.get(field):
                    raise ValueError(f"rights evidence {field} mismatch for {name!r}")
        elif source_kind == "git":
            locked = git_locked_sources.get(name)
            if not isinstance(locked, dict):
                raise ValueError(f"git source lock has no entry for {name!r}")
            for evidence_field, lock_field in (("url", "url"), ("ref", "ref"), ("commit", "commit")):
                if record.get(evidence_field) != locked.get(lock_field):
                    raise ValueError(
                        f"rights evidence {evidence_field} mismatch for {name!r}"
                    )
        else:
            raise ValueError(f"rights evidence source_kind is invalid for {name!r}")
        if not str(record.get("declared_license", "")).strip():
            raise ValueError(f"rights evidence has no declared license for {name!r}")
        urls = record.get("evidence_urls")
        if not isinstance(urls, list) or not urls or not all(
            isinstance(url, str) and url.startswith("https://") for url in urls
        ):
            raise ValueError(f"rights evidence URLs are invalid for {name!r}")
        if record.get("review_state") not in {
            "EVIDENCE_COLLECTED",
            "APPROVED",
            "REJECTED",
        }:
            raise ValueError(f"rights evidence review_state is invalid for {name!r}")
        if not isinstance(record.get("unresolved_obligations"), list):
            raise ValueError(f"rights evidence obligations are invalid for {name!r}")
    return evidence


def require_approved_evidence(registry: dict, evidence: dict, source_names: list[str]) -> None:
    """Ensure every registry-approved source has a fully closed evidence review."""
    registry_sources = registry.get("sources", {})
    evidence_sources = evidence.get("sources", {})
    for name in source_names:
        registry_record = registry_sources.get(name)
        evidence_record = evidence_sources.get(name)
        if not isinstance(registry_record, dict) or not isinstance(evidence_record, dict):
            raise ValueError(f"rights evidence is incomplete for {name!r}")
        if registry_record.get("status") != "APPROVED":
            continue
        if evidence_record.get("review_state") != "APPROVED":
            raise ValueError(
                f"source {name!r} is registry-approved but rights evidence is not APPROVED"
            )
        obligations = evidence_record.get("unresolved_obligations")
        if obligations != []:
            raise ValueError(
                f"source {name!r} is registry-approved with unresolved rights obligations"
            )
        if evidence_record.get("declared_license") != registry_record.get("declared_license"):
            raise ValueError(
                f"source {name!r} declared license differs between registry and evidence"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--source-lock", required=True)
    parser.add_argument("--rights", required=True)
    args = parser.parse_args()
    packet = load_and_validate_evidence(
        args.evidence,
        source_lock_path=args.source_lock,
        rights_registry_path=args.rights,
    )
    print(f"[rights-evidence] valid: {packet['evidence_sha256']}")


if __name__ == "__main__":
    main()
