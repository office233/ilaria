from __future__ import annotations

import json

import pytest

from pce_replay import (
    REPLAY_ARTIFACT_FORMAT,
    artifact_sha256,
    load_replay_artifact,
    load_replay_artifact_dir,
    validate_replay_artifact,
)

HASH_A = "0123456789abcdef" * 4
HASH_B = "abcdef0123456789" * 4
HASH_C = "0011223344556677" * 4


def artifact() -> dict:
    data = {
        "format": REPLAY_ARTIFACT_FORMAT,
        "protocol_version": 1,
        "artifact_sha256": "0" * 64,
        "capsule_hash": HASH_A,
        "ancestry_hash": HASH_B,
        "domain": "automotive.diagnostics",
        "decision_prompt": (
            "<|pce:start|>\n"
            "domain: automotive.diagnostics\n"
            "state: single-cylinder misfire pattern\n"
        ),
        "action_target": "inspect cylinder 1",
        "verifier_evidence_hash": HASH_C,
        "signer_key_id": "cell-a-key-1",
    }
    data["artifact_sha256"] = artifact_sha256(data)
    return data


def test_valid_artifact_becomes_collective_sleep_state_action(tmp_path):
    data = artifact()
    path = tmp_path / "replay.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    replay = load_replay_artifact(path)
    item = replay.collective_sleep_item()

    assert item["train_state"] == data["decision_prompt"]
    assert item["action"] == data["action_target"]
    assert item["capsule_hash"] == data["capsule_hash"]
    assert "misfire confirmed" not in item["train_state"]
    assert "<|obs:result|>" not in item["train_state"]


def test_artifact_tampering_fails_closed():
    data = artifact()
    data["action_target"] = "tampered action"
    with pytest.raises(ValueError, match="content hash mismatch"):
        validate_replay_artifact(data)


def test_post_action_marker_is_rejected_even_with_recomputed_hash():
    data = artifact()
    data["decision_prompt"] += "<|obs:result|>\nsecret result"
    data["artifact_sha256"] = artifact_sha256(data)
    with pytest.raises(ValueError, match="post-action material"):
        validate_replay_artifact(data)


def test_schema_is_exact():
    data = artifact()
    data["unexpected"] = "field"
    with pytest.raises(ValueError, match="schema mismatch"):
        validate_replay_artifact(data)


def test_hash_uses_utf8_byte_lengths():
    data = artifact()
    data["domain"] = "diag.română"
    data["artifact_sha256"] = artifact_sha256(data)
    replay = validate_replay_artifact(data)
    assert replay.domain == "diag.română"


def test_content_addressed_directory_loads_valid_artifacts(tmp_path):
    data = artifact()
    path = tmp_path / f"{data['artifact_sha256']}.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    decisions = load_replay_artifact_dir(tmp_path)
    assert len(decisions) == 1
    assert decisions[0].artifact_sha256 == data["artifact_sha256"]


def test_content_addressed_directory_rejects_wrong_filename(tmp_path):
    data = artifact()
    (tmp_path / "wrong-name.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="filename must equal artifact_sha256"):
        load_replay_artifact_dir(tmp_path)


def test_content_addressed_directory_rejects_duplicate_capsule(tmp_path):
    first = artifact()
    second = artifact()
    second["signer_key_id"] = "cell-a-key-2"
    second["artifact_sha256"] = artifact_sha256(second)
    (tmp_path / f"{first['artifact_sha256']}.json").write_text(
        json.dumps(first), encoding="utf-8"
    )
    (tmp_path / f"{second['artifact_sha256']}.json").write_text(
        json.dumps(second), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="duplicate PCE replay capsule hash"):
        load_replay_artifact_dir(tmp_path)
