import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pce_replay import REPLAY_ARTIFACT_FORMAT, artifact_sha256  # noqa: E402
from pce_transfer_v2 import bind_verified_replays, skill_train_prompt  # noqa: E402

BENCH = Path(__file__).resolve().parents[1] / "bench" / "myriad" / "pce_transfer_v2"


def rows(name):
    return [
        json.loads(line)
        for line in (BENCH / name).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def sha256(name):
    return hashlib.sha256((BENCH / name).read_bytes()).hexdigest()


def test_v2_skill_dataset_is_frozen_and_disjoint():
    items = rows("tasks.jsonl")
    assert len(items) == 12
    assert len({x["id"] for x in items}) == len(items)
    assert len({x["skill_key"] for x in items}) == len(items)
    for item in items:
        assert item["train_state"] != item["val_prompt"]
        assert item["train_state"] != item["test_prompt"]
        assert item["val_prompt"] != item["test_prompt"]
        assert item["skill_key"]
        assert item["action"]
        assert item["result"]


def test_v2_anchor_dataset_is_frozen_and_disjoint():
    items = rows("anchors.jsonl")
    assert len(items) == 8
    assert len({x["id"] for x in items}) == len(items)
    assert len({x["skill_key"] for x in items}) == len(items)
    for item in items:
        assert item["train_state"] != item["val_prompt"]
        assert item["train_state"] != item["test_prompt"]
        assert item["val_prompt"] != item["test_prompt"]
        assert item["skill_key"]
        assert item["action"]


def test_skill_and_anchor_keys_do_not_overlap():
    skill_keys = {x["skill_key"] for x in rows("tasks.jsonl")}
    anchor_keys = {x["skill_key"] for x in rows("anchors.jsonl")}
    assert skill_keys.isdisjoint(anchor_keys)


def test_frozen_manifest_matches_benchmark_bytes():
    manifest = json.loads((BENCH / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["benchmark"] == "pce-transfer-v2"
    assert manifest["task_count"] == len(rows("tasks.jsonl")) == 12
    assert manifest["anchor_count"] == len(rows("anchors.jsonl")) == 8
    assert manifest["tasks_sha256"] == sha256("tasks.jsonl")
    assert manifest["anchors_sha256"] == sha256("anchors.jsonl")


def test_replay_views_are_state_only_and_do_not_leak_results():
    item = rows("tasks.jsonl")[0]
    prompts = [skill_train_prompt(item, variant) for variant in range(3)]
    assert len(set(prompts)) == 3
    for prompt in prompts:
        assert item["train_state"] in prompt
        assert item["skill_key"] in prompt
        assert item["result"] not in prompt
        assert item["val_prompt"] not in prompt
        assert item["test_prompt"] not in prompt


def _signed_replay_artifact_for(item):
    data = {
        "format": REPLAY_ARTIFACT_FORMAT,
        "protocol_version": 1,
        "artifact_sha256": "0" * 64,
        "capsule_hash": "1" * 64,
        "ancestry_hash": "2" * 64,
        "domain": item["domain"],
        "decision_prompt": (
            "<|pce:start|>\n"
            f"domain: {item['domain']}\n"
            f"state: {item['train_state']}\n"
        ),
        "action_target": item["action"],
        "verifier_evidence_hash": "3" * 64,
        "signer_key_id": "cell-a-key-1",
    }
    data["artifact_sha256"] = artifact_sha256(data)
    return data


def test_signed_replay_artifact_is_bound_into_collective_sleep_input(tmp_path):
    item = rows("tasks.jsonl")[0]
    data = _signed_replay_artifact_for(item)
    (tmp_path / f"{data['artifact_sha256']}.json").write_text(
        json.dumps(data), encoding="utf-8"
    )
    bound, hashes = bind_verified_replays([item], tmp_path)
    assert hashes == [data["artifact_sha256"]]
    assert bound[0]["verified_replay_prompt"] == data["decision_prompt"]
    prompt = skill_train_prompt(bound[0], 0)
    assert data["decision_prompt"] in prompt
    assert item["result"] not in prompt


def test_signed_replay_binding_rejects_domain_action_mismatch(tmp_path):
    item = rows("tasks.jsonl")[0]
    data = _signed_replay_artifact_for(item)
    data["action_target"] = "different action"
    data["artifact_sha256"] = artifact_sha256(data)
    (tmp_path / f"{data['artifact_sha256']}.json").write_text(
        json.dumps(data), encoding="utf-8"
    )
    try:
        bind_verified_replays([item], tmp_path)
    except ValueError as exc:
        assert "missing signed replay artifact" in str(exc)
    else:
        raise AssertionError("mismatched signed replay artifact was accepted")
