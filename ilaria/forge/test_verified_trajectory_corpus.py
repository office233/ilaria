from __future__ import annotations

import json
from pathlib import Path

from data_contract import canonical_json_sha256, sha256_file
from first_party_attestation import build_attestation_template
from verified_trajectory_corpus import (
    LANES,
    SOURCE_NAME,
    evaluate_quality,
    load_generation_config,
    write_candidate_corpus,
)


def _fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    config = tmp_path / "generation.json"
    config.write_text(
        json.dumps(
            {
                "format": "imc-125m-verified-trajectory-generation-v1",
                "language": "en",
                "quality_gate": {
                    "maximum_family_share_ppm": 250_000,
                    "minimum_families": {
                        "agent_tool_trajectories": 12,
                        "world_device_trajectories": 10,
                    },
                    "minimum_unique_evidence_ratio_ppm": 990_000,
                    "minimum_unique_text_ratio_ppm": 990_000,
                    "sample_documents_per_lane": 512,
                },
                "seed": 17,
                "shard_docs": 3,
                "source_name": SOURCE_NAME,
                "target_text_bytes": {
                    "agent_tool_trajectories": 1800,
                    "world_device_trajectories": 1800,
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    repo_root = Path(__file__).resolve().parents[1]
    attestation = build_attestation_template(
        repo_root,
        paths=["forge/verified_trajectory_corpus.py", "forge/hf_tokenizer.py"],
    )
    attestation_path = tmp_path / "attestation.json"
    attestation_path.write_text(json.dumps(attestation), encoding="utf-8")
    return config, attestation_path, repo_root


def test_quality_gate_covers_all_families_without_duplicates(tmp_path):
    config, _, _ = _fixture(tmp_path)
    report = evaluate_quality(load_generation_config(config))
    assert len(report["lanes"]["agent_tool_trajectories"]["task_families"]) == 12
    assert len(report["lanes"]["world_device_trajectories"]["task_families"]) == 10
    for lane in LANES:
        record = report["lanes"][lane]
        assert record["unique_text_ratio_ppm"] >= 990_000
        assert record["unique_evidence_ratio_ppm"] >= 990_000


def test_verified_trajectory_corpus_is_deterministic_and_manifested(tmp_path):
    config, attestation, root = _fixture(tmp_path)
    first = write_candidate_corpus(
        config_path=config,
        attestation_path=attestation,
        workspace_root=root,
        out_dir=tmp_path / "out-a",
    )
    second = write_candidate_corpus(
        config_path=config,
        attestation_path=attestation,
        workspace_root=root,
        out_dir=tmp_path / "out-b",
    )
    assert first["source"] == second["source"]
    assert first["pipeline"] == second["pipeline"]
    assert first["lane_stats"] == second["lane_stats"]
    assert [r["sha256"] for r in first["shard_records"]] == [
        r["sha256"] for r in second["shard_records"]
    ]
    for lane in LANES:
        assert (
            first["lane_stats"][lane]["text_bytes"]
            >= first["target_text_bytes"][lane]
        )

    rows = []
    for record in first["shard_records"]:
        shard = tmp_path / "out-a" / record["filename"]
        assert sha256_file(shard) == record["sha256"]
        rows.extend(
            json.loads(line)
            for line in shard.read_text(encoding="utf-8").splitlines()
        )
    assert len(rows) == first["docs"]
    assert len({row["task_id"] for row in rows}) == len(rows)
    assert all(len(row["verifier_evidence_hash"]) == 64 for row in rows)
    assert any(
        row["path"].startswith("agent_tool_trajectories/") for row in rows
    )
    assert any(
        row["path"].startswith("world_device_trajectories/") for row in rows
    )


def test_verified_trajectory_resume_is_idempotent(tmp_path):
    config, attestation, root = _fixture(tmp_path)
    out = tmp_path / "out"
    first = write_candidate_corpus(
        config_path=config,
        attestation_path=attestation,
        workspace_root=root,
        out_dir=out,
    )
    second = write_candidate_corpus(
        config_path=config,
        attestation_path=attestation,
        workspace_root=root,
        out_dir=out,
    )
    assert first == second
    assert canonical_json_sha256(first) == canonical_json_sha256(second)
