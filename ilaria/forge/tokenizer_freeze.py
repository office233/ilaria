"""Reproducible, rights-gated IlariaLex production freeze manifests."""
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
from hf_tokenizer import (
    EOS,
    ILARIALEX_BASE_VOCAB_SIZE,
    ILARIALEX_FORMAT,
    ILARIALEX_PROTOCOL_RESERVED,
    ILARIALEX_VOCAB_SIZE,
)
from model_manifest import load_tokenizer_identity

SAMPLE_FORMAT = "ilarialex-tokenizer-sample-v1"
FREEZE_FORMAT = "ilarialex-freeze-v1"
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


def _identity_hash(value: dict, hash_field: str) -> str:
    unhashed = dict(value)
    unhashed.pop(hash_field, None)
    return canonical_json_sha256(unhashed)


def build_sample_manifest(
    input_paths: list[str | Path],
    *,
    source_names: list[str],
    coverage: list[str],
    rights_registry_path: str | Path,
    source_lock_path: str | Path | None = None,
    git_source_lock_path: str | Path | None = None,
    coverage_manifest_path: str | Path | None = None,
) -> dict:
    if not input_paths:
        raise ValueError("tokenizer sample requires at least one input")
    sources = sorted(set(source_names))
    if not sources:
        raise ValueError("tokenizer sample requires source identities")

    covered = set(coverage)
    missing_coverage = sorted(REQUIRED_COVERAGE - covered)
    if missing_coverage:
        raise ValueError(
            "tokenizer sample is missing required coverage: "
            + ", ".join(missing_coverage)
        )

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    require_approved_rights(rights, sources)

    registry_evidence = rights.get("evidence")
    if git_source_lock_path is None and isinstance(registry_evidence, dict):
        git_lock_name = registry_evidence.get("git_source_lock_filename")
        if isinstance(git_lock_name, str) and git_lock_name:
            git_source_lock_path = rights_path.parent / git_lock_name

    production_policy = rights.get("policy") == "manual-rights-review-required-v1"
    coverage_evidence = None
    if coverage_manifest_path is not None:
        try:
            from .tokenizer_coverage import validate_coverage_manifest
        except ImportError:
            from tokenizer_coverage import validate_coverage_manifest
        coverage_evidence = validate_coverage_manifest(
            coverage_manifest_path,
            rights_registry_path=rights_path,
        )
        if set(coverage_evidence["sources"]) != set(sources):
            raise ValueError(
                "tokenizer coverage sources differ from tokenizer sample sources"
            )
        if set(coverage_evidence["coverage"]) != covered:
            raise ValueError(
                "tokenizer coverage evidence differs from declared coverage"
            )
    elif production_policy:
        raise ValueError(
            "production tokenizer sample requires content-addressed coverage evidence"
        )

    rights_evidence = rights.get("evidence")
    if rights_evidence is not None:
        if source_lock_path is None:
            raise ValueError(
                "tokenizer sample requires --source-lock when rights evidence is configured"
            )
        try:
            from .rights_evidence import load_and_validate_evidence, require_approved_evidence
        except ImportError:
            from rights_evidence import load_and_validate_evidence, require_approved_evidence
        evidence_filename = rights_evidence.get("filename") if isinstance(rights_evidence, dict) else None
        if not isinstance(evidence_filename, str) or not evidence_filename:
            raise ValueError("rights registry evidence filename is invalid")
        evidence = load_and_validate_evidence(
            rights_path.parent / evidence_filename,
            source_lock_path=source_lock_path,
            rights_registry_path=rights_path,
        )
        require_approved_evidence(rights, evidence, sources)

    records = []
    seen_names: set[str] = set()
    for raw in sorted((Path(p) for p in input_paths), key=lambda p: str(p)):
        if not raw.is_file():
            raise ValueError(f"tokenizer sample input does not exist: {raw}")
        if raw.stat().st_size <= 0:
            raise ValueError(f"tokenizer sample input is empty: {raw}")
        if raw.name in seen_names:
            raise ValueError(f"duplicate tokenizer sample filename: {raw.name}")
        seen_names.add(raw.name)
        records.append(
            {
                "filename": raw.name,
                "sha256": sha256_file(raw),
                "bytes": raw.stat().st_size,
            }
        )

    manifest = {
        "format": SAMPLE_FORMAT,
        "inputs": records,
        "sources": sources,
        "coverage": sorted(covered),
        "rights": {
            "filename": rights_path.name,
            "sha256": sha256_file(rights_path),
            "policy": rights.get("policy", ""),
        },
    }
    if coverage_evidence is not None:
        manifest["coverage_evidence"] = {
            "filename": Path(coverage_manifest_path).name,
            "sha256": coverage_evidence["coverage_sha256"],
        }
    if source_lock_path is not None:
        try:
            from .corpus_source_lock import load_source_lock
            from .prepare_corpus import SOURCES
        except ImportError:
            from corpus_source_lock import load_source_lock
            from prepare_corpus import SOURCES
        lock = load_source_lock(source_lock_path, SOURCES)
        selected_hf = {
            name: dict(lock["sources"][name])
            for name in sources
            if name in lock["sources"]
        }
        if selected_hf:
            manifest["source_lock"] = {
                "identity_sha256": lock["source_lock_sha256"],
                "file_sha256": sha256_file(source_lock_path),
                "sources": selected_hf,
            }

    if git_source_lock_path is not None:
        try:
            from .git_source_lock import load_lock as load_git_source_lock
        except ImportError:
            from git_source_lock import load_lock as load_git_source_lock
        git_lock = load_git_source_lock(git_source_lock_path)
        selected_git = {
            name: dict(git_lock["sources"][name])
            for name in sources
            if name in git_lock["sources"]
        }
        if selected_git:
            manifest["git_source_lock"] = {
                "identity_sha256": git_lock["source_lock_sha256"],
                "file_sha256": sha256_file(git_source_lock_path),
                "sources": selected_git,
            }

    locked_names = set()
    if "source_lock" in manifest:
        locked_names.update(manifest["source_lock"]["sources"])
    if "git_source_lock" in manifest:
        locked_names.update(manifest["git_source_lock"]["sources"])
    if source_lock_path is not None or git_source_lock_path is not None:
        missing = sorted(set(sources) - locked_names)
        if missing:
            raise ValueError(
                f"tokenizer sample source locks are missing sources: {missing}"
            )
    manifest["sample_manifest_sha256"] = _identity_hash(
        manifest, "sample_manifest_sha256"
    )
    return manifest


def validate_sample_manifest(
    manifest_path: str | Path,
    *,
    rights_registry_path: str | Path,
) -> dict:
    path = Path(manifest_path)
    with path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict) or manifest.get("format") != SAMPLE_FORMAT:
        raise ValueError("unsupported tokenizer sample manifest format")

    declared = manifest.get("sample_manifest_sha256", "")
    require_lower_sha256("sample_manifest_sha256", declared)
    if _identity_hash(manifest, "sample_manifest_sha256") != declared:
        raise ValueError("tokenizer sample manifest identity hash mismatch")

    sources = manifest.get("sources")
    coverage = manifest.get("coverage")
    inputs = manifest.get("inputs")
    if not isinstance(sources, list) or not sources:
        raise ValueError("tokenizer sample manifest has no sources")
    if not isinstance(coverage, list):
        raise ValueError("tokenizer sample manifest has invalid coverage")
    missing_coverage = sorted(REQUIRED_COVERAGE - set(coverage))
    if missing_coverage:
        raise ValueError(
            "tokenizer sample is missing required coverage: "
            + ", ".join(missing_coverage)
        )
    if not isinstance(inputs, list) or not inputs:
        raise ValueError("tokenizer sample manifest has no inputs")

    locked_source_names: set[str] = set()
    source_lock = manifest.get("source_lock")
    if source_lock is not None:
        if not isinstance(source_lock, dict):
            raise ValueError("tokenizer sample source lock identity is invalid")
        require_lower_sha256(
            "source_lock identity_sha256",
            str(source_lock.get("identity_sha256", "")),
        )
        require_lower_sha256(
            "source_lock file_sha256",
            str(source_lock.get("file_sha256", "")),
        )
        locked_sources = source_lock.get("sources")
        if not isinstance(locked_sources, dict) or not locked_sources:
            raise ValueError("tokenizer sample source lock source set is invalid")
        locked_source_names.update(locked_sources)
        for name, record in locked_sources.items():
            if not isinstance(record, dict):
                raise ValueError(f"tokenizer sample source lock record {name!r} is invalid")
            revision = record.get("revision")
            if not isinstance(revision, str) or len(revision) != 40:
                raise ValueError(f"tokenizer sample source revision is invalid for {name!r}")
            try:
                bytes.fromhex(revision)
            except ValueError as exc:
                raise ValueError(
                    f"tokenizer sample source revision is invalid for {name!r}"
                ) from exc

    git_source_lock = manifest.get("git_source_lock")
    if git_source_lock is not None:
        if not isinstance(git_source_lock, dict):
            raise ValueError("tokenizer sample git source lock identity is invalid")
        require_lower_sha256(
            "git_source_lock identity_sha256",
            str(git_source_lock.get("identity_sha256", "")),
        )
        require_lower_sha256(
            "git_source_lock file_sha256",
            str(git_source_lock.get("file_sha256", "")),
        )
        locked_git_sources = git_source_lock.get("sources")
        if not isinstance(locked_git_sources, dict) or not locked_git_sources:
            raise ValueError("tokenizer sample git source lock source set is invalid")
        locked_source_names.update(locked_git_sources)
        for name, record in locked_git_sources.items():
            if not isinstance(record, dict):
                raise ValueError(
                    f"tokenizer sample git source lock record {name!r} is invalid"
                )
            commit = record.get("commit")
            if not isinstance(commit, str) or len(commit) != 40:
                raise ValueError(
                    f"tokenizer sample git source revision is invalid for {name!r}"
                )
            try:
                bytes.fromhex(commit)
            except ValueError as exc:
                raise ValueError(
                    f"tokenizer sample git source revision is invalid for {name!r}"
                ) from exc

    if locked_source_names and locked_source_names != set(sources):
        raise ValueError("tokenizer sample source lock source set mismatch")

    rights_path = Path(rights_registry_path)
    rights = load_rights_registry(rights_path)
    require_approved_rights(rights, list(sources))
    pinned_rights = manifest.get("rights")
    if not isinstance(pinned_rights, dict):
        raise ValueError("tokenizer sample manifest has no rights identity")
    if pinned_rights.get("sha256") != sha256_file(rights_path):
        raise ValueError("tokenizer sample rights registry hash mismatch")

    production_policy = rights.get("policy") == "manual-rights-review-required-v1"
    coverage_evidence = manifest.get("coverage_evidence")
    if coverage_evidence is None:
        if production_policy:
            raise ValueError(
                "production tokenizer sample has no content-addressed coverage evidence"
            )
    else:
        if not isinstance(coverage_evidence, dict):
            raise ValueError("tokenizer coverage evidence identity is invalid")
        evidence_name = coverage_evidence.get("filename")
        if not isinstance(evidence_name, str) or not evidence_name:
            raise ValueError("tokenizer coverage evidence filename is invalid")
        try:
            from .tokenizer_coverage import validate_coverage_manifest
        except ImportError:
            from tokenizer_coverage import validate_coverage_manifest
        evidence = validate_coverage_manifest(
            path.parent / evidence_name,
            rights_registry_path=rights_path,
        )
        if evidence["coverage_sha256"] != coverage_evidence.get("sha256"):
            raise ValueError("tokenizer coverage evidence hash mismatch")
        if set(evidence["sources"]) != set(sources):
            raise ValueError("tokenizer coverage evidence source set mismatch")
        if set(evidence["coverage"]) != set(coverage):
            raise ValueError("tokenizer coverage evidence category set mismatch")

    for record in inputs:
        if not isinstance(record, dict):
            raise ValueError("tokenizer sample input record is invalid")
        filename = record.get("filename")
        if not isinstance(filename, str) or not filename:
            raise ValueError("tokenizer sample input filename is invalid")
        digest = record.get("sha256", "")
        require_lower_sha256(f"input {filename} sha256", digest)
        input_path = path.parent / filename
        if not input_path.is_file():
            raise ValueError(f"tokenizer sample input is missing: {input_path}")
        if input_path.stat().st_size != int(record.get("bytes", -1)):
            raise ValueError(f"tokenizer sample input size mismatch: {filename}")
        if sha256_file(input_path) != digest:
            raise ValueError(f"tokenizer sample input hash mismatch: {filename}")
    return manifest


def build_freeze_manifest(
    tokenizer_path: str | Path,
    *,
    sample_manifest_path: str | Path,
    rights_registry_path: str | Path,
) -> dict:
    tokenizer_path = Path(tokenizer_path)
    sample = validate_sample_manifest(
        sample_manifest_path, rights_registry_path=rights_registry_path
    )
    identity = load_tokenizer_identity(tokenizer_path)
    if identity["format"] != ILARIALEX_FORMAT:
        raise ValueError("tokenizer format is not canonical IlariaLex")
    if identity["vocab_size"] != ILARIALEX_VOCAB_SIZE:
        raise ValueError("tokenizer vocabulary is not canonical")
    if identity["base_vocab_size"] != ILARIALEX_BASE_VOCAB_SIZE:
        raise ValueError("tokenizer learned vocabulary is not canonical")
    if identity["protocol_reserved"] != ILARIALEX_PROTOCOL_RESERVED:
        raise ValueError("tokenizer protocol reserve is not canonical")
    if identity["protocol_start_id"] != ILARIALEX_BASE_VOCAB_SIZE:
        raise ValueError("tokenizer protocol start ID is not canonical")
    if identity["eos_token"] != EOS or identity["eos_id"] != ILARIALEX_BASE_VOCAB_SIZE:
        raise ValueError("tokenizer EOS identity is not canonical")

    hf_path = tokenizer_path.with_suffix(".hf.json")
    if not hf_path.is_file():
        raise ValueError(f"tokenizer companion is missing: {hf_path}")

    freeze = {
        "format": FREEZE_FORMAT,
        "tokenizer": {
            **identity,
            "filename": tokenizer_path.name,
            "hf_filename": hf_path.name,
            "hf_sha256": sha256_file(hf_path),
        },
        "sample": {
            "filename": Path(sample_manifest_path).name,
            "sha256": sample["sample_manifest_sha256"],
            "sources": sample["sources"],
            "coverage": sample["coverage"],
            **({"source_lock": sample["source_lock"]} if "source_lock" in sample else {}),
            **(
                {"git_source_lock": sample["git_source_lock"]}
                if "git_source_lock" in sample
                else {}
            ),
            **(
                {"coverage_evidence": sample["coverage_evidence"]}
                if "coverage_evidence" in sample
                else {}
            ),
        },
        "rights": dict(sample["rights"]),
    }
    freeze["freeze_sha256"] = _identity_hash(freeze, "freeze_sha256")
    return freeze


def validate_freeze_manifest(
    freeze_path: str | Path,
    *,
    rights_registry_path: str | Path,
) -> dict:
    path = Path(freeze_path)
    with path.open(encoding="utf-8") as stream:
        freeze = json.load(stream)
    if not isinstance(freeze, dict) or freeze.get("format") != FREEZE_FORMAT:
        raise ValueError("unsupported IlariaLex freeze manifest format")
    declared = freeze.get("freeze_sha256", "")
    require_lower_sha256("freeze_sha256", declared)
    if _identity_hash(freeze, "freeze_sha256") != declared:
        raise ValueError("IlariaLex freeze manifest identity hash mismatch")

    sample_info = freeze.get("sample")
    tokenizer_info = freeze.get("tokenizer")
    if not isinstance(sample_info, dict) or not isinstance(tokenizer_info, dict):
        raise ValueError("IlariaLex freeze manifest references are incomplete")
    sample_path = path.parent / str(sample_info.get("filename", ""))
    sample = validate_sample_manifest(
        sample_path, rights_registry_path=rights_registry_path
    )
    if sample["sample_manifest_sha256"] != sample_info.get("sha256"):
        raise ValueError("IlariaLex freeze sample hash mismatch")

    tokenizer_path = path.parent / str(tokenizer_info.get("filename", ""))
    rebuilt = build_freeze_manifest(
        tokenizer_path,
        sample_manifest_path=sample_path,
        rights_registry_path=rights_registry_path,
    )
    if rebuilt != freeze:
        raise ValueError("IlariaLex freeze manifest differs from reconstructed artifacts")
    return freeze


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    sample_parser = sub.add_parser("sample-manifest")
    sample_parser.add_argument("--input", action="append", required=True)
    sample_parser.add_argument("--source", action="append", required=True)
    sample_parser.add_argument("--coverage", action="append", required=True)
    sample_parser.add_argument("--rights", required=True)
    sample_parser.add_argument("--source-lock", default="")
    sample_parser.add_argument("--git-source-lock", default="")
    sample_parser.add_argument("--coverage-manifest", default="")
    sample_parser.add_argument("--out", required=True)

    freeze_parser = sub.add_parser("freeze")
    freeze_parser.add_argument("--tokenizer", required=True)
    freeze_parser.add_argument("--sample-manifest", required=True)
    freeze_parser.add_argument("--rights", required=True)
    freeze_parser.add_argument("--out", required=True)

    validate_parser = sub.add_parser("validate")
    validate_parser.add_argument("--freeze", required=True)
    validate_parser.add_argument("--rights", required=True)

    args = parser.parse_args()
    if args.command == "sample-manifest":
        manifest = build_sample_manifest(
            args.input,
            source_names=args.source,
            coverage=args.coverage,
            rights_registry_path=args.rights,
            source_lock_path=args.source_lock or None,
            git_source_lock_path=args.git_source_lock or None,
            coverage_manifest_path=args.coverage_manifest or None,
        )
        atomic_write_json(args.out, manifest)
        print(
            f"[ilarialex] sample manifest {args.out}: "
            f"sha256={manifest['sample_manifest_sha256']}"
        )
    elif args.command == "freeze":
        manifest = build_freeze_manifest(
            args.tokenizer,
            sample_manifest_path=args.sample_manifest,
            rights_registry_path=args.rights,
        )
        atomic_write_json(args.out, manifest)
        print(
            f"[ilarialex] frozen {args.tokenizer}: "
            f"sha256={manifest['tokenizer']['sha256']} "
            f"freeze={manifest['freeze_sha256']}"
        )
    else:
        manifest = validate_freeze_manifest(
            args.freeze, rights_registry_path=args.rights
        )
        print(f"[ilarialex] freeze valid: {manifest['freeze_sha256']}")


if __name__ == "__main__":
    main()
