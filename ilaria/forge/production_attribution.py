"""Build content-addressed attribution/provenance evidence for production sources."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from data_contract import atomic_write_json, canonical_json_bytes, sha256_file
from production_review_decision import load_review_packet

FORMAT = "imc-125m-production-attribution-v1"

def _identity_hash(value: dict) -> str:
    payload = dict(value)
    payload.pop("attribution_sha256", None)
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()

def _revision_from_manifest(manifest: dict) -> str:
    source = manifest.get("source")
    if not isinstance(source, dict):
        raise ValueError("source manifest has no source identity")
    revision = source.get("revision")
    if not isinstance(revision, str) or not revision:
        raise ValueError("source manifest has no revision")
    return revision

def _expected_revision(review_record: dict) -> str:
    revision = review_record.get("revision")
    if not isinstance(revision, dict):
        raise ValueError("review record has no revision")
    value = revision.get("revision") or revision.get("commit")
    if not isinstance(value, str) or not value:
        raise ValueError("review revision is invalid")
    return value

def build_attribution(packet_path: str | Path, *, source_manifests: dict[str, str | Path]) -> dict:
    packet_path = Path(packet_path)
    packet = load_review_packet(packet_path)
    required = set(packet["external_sources"])
    supplied = set(source_manifests)
    if supplied != required:
        raise ValueError(f"attribution source set mismatch: required={sorted(required)}, supplied={sorted(supplied)}")
    sources = {}
    for name in sorted(required):
        path = Path(source_manifests[name]).resolve()
        if not path.is_file():
            raise ValueError(f"source manifest missing for {name}: {path}")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        source = manifest.get("source")
        if not isinstance(source, dict) or source.get("name") != name:
            raise ValueError(f"source manifest identity mismatch for {name}")
        observed_revision = _revision_from_manifest(manifest)
        expected_revision = _expected_revision(packet["external_sources"][name])
        if observed_revision != expected_revision:
            raise ValueError(f"source revision mismatch for {name}: {observed_revision}!={expected_revision}")
        review = packet["external_sources"][name]
        sources[name] = {
            "declared_license": review.get("declared_license"),
            "revision": dict(review["revision"]),
            "manifest_filename": path.name,
            "manifest_sha256": sha256_file(path),
            "documents": int(manifest.get("docs", 0)),
            "pipeline": dict(manifest.get("pipeline", {})),
            "evidence_urls": list(review.get("evidence_urls", [])),
            "review_obligations": list(review.get("unresolved_obligations", [])),
        }
    first_party = {
        name: {
            "attestation_sha256": record["attestation_sha256"],
            "attestation_scope_sha256": record["attestation_scope_sha256"],
            "files": [dict(item) for item in record["files"]],
        }
        for name, record in sorted(packet["first_party_sources"].items())
    }
    value = {
        "format": FORMAT,
        "review_packet": {"filename": packet_path.name, "sha256": packet["review_packet_sha256"]},
        "external_sources": sources,
        "first_party_sources": first_party,
    }
    value["attribution_sha256"] = _identity_hash(value)
    return value

def render_markdown(value: dict) -> str:
    lines = [
        "# IMC-125M production attribution & provenance",
        "",
        "Attribution manifest: `" + value["attribution_sha256"] + "`",
        "Review packet: `" + value["review_packet"]["sha256"] + "`",
        "",
        "This document records exact source revisions, declared licenses and provenance evidence. It does not itself grant training rights.",
        "",
        "## External sources",
        "",
    ]
    for name, record in sorted(value["external_sources"].items()):
        lines.extend([
            f"### {name}",
            "",
            f"- Declared license: {record['declared_license']}",
            f"- Revision: `{_expected_revision(record)}`",
            f"- Source manifest SHA-256: `{record['manifest_sha256']}`",
            f"- Candidate documents: {record['documents']:,}",
            "- Evidence:",
            *[f"  - {url}" for url in record["evidence_urls"]],
            "- Review obligations:",
            *[f"  - {item}" for item in record["review_obligations"]],
            "",
        ])
    lines.extend(["## First-party provenance", ""])
    for name, record in sorted(value["first_party_sources"].items()):
        lines.extend([
            f"### {name}",
            "",
            f"- Attestation identity: `{record['attestation_sha256']}`",
            f"- Attestation scope: `{record['attestation_scope_sha256']}`",
            f"- Pinned files: {len(record['files'])}",
            "",
        ])
    return "\n".join(lines)

def _parse_source(value: str) -> tuple[str, str]:
    name, sep, path = value.partition("=")
    if not sep or not name or not path:
        raise ValueError("--source-manifest must be SOURCE=PATH")
    return name, path

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", required=True)
    parser.add_argument("--source-manifest", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--markdown-out", default="")
    args = parser.parse_args()
    mapping = dict(_parse_source(raw) for raw in args.source_manifest)
    value = build_attribution(args.packet, source_manifests=mapping)
    atomic_write_json(args.out, value)
    if args.markdown_out:
        Path(args.markdown_out).write_text(render_markdown(value), encoding="utf-8", newline="\n")
    print(f"[attribution] {args.out}: {value['attribution_sha256']}")

if __name__ == "__main__":
    main()
