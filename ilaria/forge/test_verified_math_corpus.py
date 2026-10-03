from __future__ import annotations

import json
from pathlib import Path

from data_contract import atomic_write_json, sha256_file
from first_party_attestation import build_attestation_template
from verified_math_corpus import (
    FAMILIES,
    _row,
    evaluate_quality,
    load_config,
    write_corpus,
)


def test_verified_math_rows_are_deterministic_and_diverse():
    a = _row(1250017, 12345)
    b = _row(1250017, 12345)
    assert a == b
    assert a["task_family"] in FAMILIES
    assert a["path"].startswith("mathematics/")
    assert len(a["verifier_evidence_hash"]) == 64
    assert "Verified answer:" in a["text"]


def test_canonical_quality_gate_recomputes():
    config = Path(__file__).resolve().parent / "config" / "imc_125m_math_generation.json"
    report = evaluate_quality(load_config(config))
    assert len(report["task_families"]) == 32
    assert report["unique_text_ratio_ppm"] >= 999_000
    assert report["unique_evidence_ratio_ppm"] >= 999_000
    assert report["maximum_family_share_ppm"] <= 40_000


def test_small_candidate_is_bound_to_unsigned_attestation(tmp_path: Path):
    workspace = tmp_path / "workspace"
    (workspace / "forge" / "config").mkdir(parents=True)
    generator_source = Path(__file__).resolve().parent / "verified_math_corpus.py"
    generator = workspace / "forge" / "verified_math_corpus.py"
    generator.write_bytes(generator_source.read_bytes())
    config_path = workspace / "forge" / "config" / "imc_125m_math_generation.json"
    config = {
        "format": "imc-125m-verified-math-generation-v1",
        "language": "en",
        "quality_gate": {
            "sample_documents": 1000,
            "minimum_families": 32,
            "minimum_unique_text_ratio_ppm": 990000,
            "minimum_unique_evidence_ratio_ppm": 990000,
            "maximum_family_share_ppm": 50000,
        },
        "seed": 1250017,
        "shard_docs": 100,
        "source_name": "first_party_math",
        "target_text_bytes": 20_000,
    }
    atomic_write_json(config_path, config)
    attestation = build_attestation_template(
        workspace,
        paths=[
            "forge/verified_math_corpus.py",
            "forge/config/imc_125m_math_generation.json",
        ],
    )
    attestation_path = workspace / "forge" / "config" / "first_party_math.attestation.json"
    atomic_write_json(attestation_path, attestation)
    out = tmp_path / "out"
    manifest = write_corpus(
        config_path=config_path,
        attestation_path=attestation_path,
        workspace_root=workspace,
        out_dir=out,
    )
    assert manifest["source"]["name"] == "first_party_math"
    assert manifest["pipeline"]["rights_basis"] == "first_party_attestation"
    assert manifest["text_bytes"] >= 20_000
    assert manifest["docs"] > 0
    for record in manifest["shard_records"]:
        shard = out / record["filename"]
        assert sha256_file(shard) == record["sha256"]
