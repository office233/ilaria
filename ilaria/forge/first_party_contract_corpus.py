"""Materialize attested first-party protocol/contracts as candidate corpus data.

This builder validates the content-addressed attestation packet and every pinned
workspace file, but deliberately does *not* require or grant ownership approval.
The output is therefore suitable for tokenizer development / review preparation
while remaining fail-closed for production until the attestation is explicitly
signed by a human reviewer.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

try:
    from .data_contract import CORPUS_MANIFEST_SCHEMA, atomic_write_json, sha256_file
    from .first_party_attestation import attestation_scope_sha256, inspect_attestation
except ImportError:  # direct script execution
    from data_contract import CORPUS_MANIFEST_SCHEMA, atomic_write_json, sha256_file
    from first_party_attestation import attestation_scope_sha256, inspect_attestation


SOURCE_NAME = "first_party_contracts"
PIPELINE_NAME = "first-party-contract-corpus-v1"


def build_candidate_corpus(
    *,
    attestation_path: str | Path,
    workspace_root: str | Path,
    out_dir: str | Path,
) -> dict:
    root = Path(workspace_root).resolve()
    attestation_path = Path(attestation_path).resolve()
    attestation = inspect_attestation(attestation_path, workspace_root=root)
    scope_sha256 = attestation_scope_sha256(attestation)

    output = Path(out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / f"{SOURCE_NAME}.manifest.json"
    shard_path = output / f"{SOURCE_NAME}-00000.jsonl"
    if manifest_path.exists() or shard_path.exists():
        raise ValueError("first-party contract corpus refuses to overwrite existing artifacts")

    temporary = shard_path.with_suffix(shard_path.suffix + ".tmp")
    docs = 0
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        for record in attestation["files"]:
            relative = record["path"]
            source_path = (root / relative).resolve()
            text = source_path.read_text(encoding="utf-8", errors="strict").strip()
            if not text:
                continue
            row = {
                "text": f"[FIRST_PARTY_CONTRACT {relative}]\n{text}",
                "path": relative,
                "file_sha256": record["sha256"],
            }
            stream.write(
                json.dumps(
                    row,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )
            docs += 1
        stream.flush()
        os.fsync(stream.fileno())
    if docs == 0:
        temporary.unlink(missing_ok=True)
        raise ValueError("first-party contract corpus produced no documents")
    os.replace(temporary, shard_path)

    required_files = [
        {"path": record["path"], "sha256": record["sha256"]}
        for record in attestation["files"]
    ]
    manifest = {
        "schema_version": CORPUS_MANIFEST_SCHEMA,
        "source": {
            "name": SOURCE_NAME,
            "provider": "ilaria-first-party",
            "config": None,
            "revision": scope_sha256,
            "language": "en",
        },
        "pipeline": {
            "name": PIPELINE_NAME,
            "rights_basis": "first_party_attestation",
            "attestation_scope_sha256": scope_sha256,
            "attestation_required_files": required_files,
            "attestation_file_sha256": sha256_file(attestation_path),
            "ownership_attested": attestation.get("ownership_attested") is True,
        },
        "docs": docs,
        "shards": 1,
        "shard_docs": docs,
        "complete": [0],
        "raw_rows": docs,
        "shard_records": [
            {
                "index": 0,
                "filename": shard_path.name,
                "sha256": sha256_file(shard_path),
                "bytes": shard_path.stat().st_size,
                "documents": docs,
            }
        ],
    }
    atomic_write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--attestation",
        default=str(config / "first_party_tools_protocol.attestation.json"),
    )
    parser.add_argument("--workspace-root", default=str(root))
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    manifest = build_candidate_corpus(
        attestation_path=args.attestation,
        workspace_root=args.workspace_root,
        out_dir=args.out_dir,
    )
    print(
        f"[first-party-contracts] docs={manifest['docs']} "
        f"scope={manifest['pipeline']['attestation_scope_sha256']}"
    )


if __name__ == "__main__":
    main()
