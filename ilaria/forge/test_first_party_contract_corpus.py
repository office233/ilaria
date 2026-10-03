from __future__ import annotations

import json
from pathlib import Path

import pytest

from first_party_attestation import build_attestation_template
from first_party_contract_corpus import SOURCE_NAME, build_candidate_corpus


def _fixture(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "protocol.go").write_text("package protocol\n\ntype ToolCall struct{}\n", encoding="utf-8")
    (root / "spec.swyp").write_text("component ToolProtocol {}\n", encoding="utf-8")
    attestation = build_attestation_template(
        root,
        paths=["protocol.go", "spec.swyp"],
    )
    attestation_path = tmp_path / "attestation.json"
    attestation_path.write_text(
        json.dumps(attestation, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return root, attestation_path


def test_build_candidate_corpus_is_bound_to_unsigned_attestation(tmp_path: Path):
    root, attestation = _fixture(tmp_path)
    output = tmp_path / "out"
    manifest = build_candidate_corpus(
        attestation_path=attestation,
        workspace_root=root,
        out_dir=output,
    )
    assert manifest["source"]["name"] == SOURCE_NAME
    assert manifest["docs"] == 2
    assert manifest["pipeline"]["rights_basis"] == "first_party_attestation"
    assert manifest["pipeline"]["ownership_attested"] is False
    rows = [
        json.loads(line)
        for line in (output / f"{SOURCE_NAME}-00000.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert {row["path"] for row in rows} == {"protocol.go", "spec.swyp"}


def test_build_candidate_corpus_rejects_workspace_drift(tmp_path: Path):
    root, attestation = _fixture(tmp_path)
    (root / "protocol.go").write_text("package protocol\n// drift\n", encoding="utf-8")
    with pytest.raises(ValueError, match="hash mismatch"):
        build_candidate_corpus(
            attestation_path=attestation,
            workspace_root=root,
            out_dir=tmp_path / "out",
        )


def test_build_candidate_corpus_refuses_overwrite(tmp_path: Path):
    root, attestation = _fixture(tmp_path)
    output = tmp_path / "out"
    build_candidate_corpus(
        attestation_path=attestation,
        workspace_root=root,
        out_dir=output,
    )
    with pytest.raises(ValueError, match="refuses to overwrite"):
        build_candidate_corpus(
            attestation_path=attestation,
            workspace_root=root,
            out_dir=output,
        )
