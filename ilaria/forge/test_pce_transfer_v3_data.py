import hashlib
import json
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1] / "bench" / "myriad" / "pce_transfer_v3"
TUNER = Path(__file__).resolve().parent / "pce_transfer_v3.py"


def sha256(name):
    return hashlib.sha256((BENCH / name).read_bytes()).hexdigest()


def rows(name):
    return [
        json.loads(line)
        for line in (BENCH / name).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_v3_manifest_pins_all_frozen_artifacts():
    manifest = json.loads((BENCH / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 2
    assert manifest["benchmark"] == "pce-transfer-v3"
    assert manifest["test_status"] == "sealed"
    assert manifest["skill_count"] == 16
    assert manifest["anchor_count"] == 8
    assert manifest["skills_trainval_sha256"] == sha256("skills_trainval.jsonl")
    assert manifest["skills_test_sha256"] == sha256("skills_test.jsonl")
    assert manifest["anchors_trainval_sha256"] == sha256("anchors_trainval.jsonl")
    assert manifest["anchors_test_sha256"] == sha256("anchors_test.jsonl")
    assert manifest["policy_sha256"] == sha256("policy.json")


def test_v3_trainval_has_two_distinct_validation_views():
    skills = rows("skills_trainval.jsonl")
    assert len(skills) == 16
    assert len({x["id"] for x in skills}) == 16
    assert len({x["skill_key"] for x in skills}) == 16
    for item in skills:
        assert item["train_state"] != item["val_prompt_a"]
        assert item["train_state"] != item["val_prompt_b"]
        assert item["val_prompt_a"] != item["val_prompt_b"]


def test_v3_test_is_physically_separate_and_id_aligned():
    train_ids = [x["id"] for x in rows("skills_trainval.jsonl")]
    test = rows("skills_test.jsonl")
    assert [x["id"] for x in test] == train_ids
    assert all(set(x) == {"id", "test_prompt"} for x in test)


def test_tuner_source_has_no_sealed_test_filename():
    source = TUNER.read_text(encoding="utf-8")
    assert "skills_test.jsonl" not in source
    assert "anchors_test.jsonl" not in source
