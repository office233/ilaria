"""Synthetic metadata regressions; no corpus, tokenizer, tensor or training reads."""
import copy
import hashlib
import json

import pytest

import training_launch_gate as gate


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def record(value):
    raw = json.dumps(value, sort_keys=True).encode()
    return {"value": value, "file_sha256": hashlib.sha256(raw).hexdigest()}


def complete_pilot():
    pins = {field: digest(field) for field in ("registry_file_sha256", "evidence_file_sha256",
                                              "source_lock_file_sha256", "git_lock_file_sha256")}
    sources = {"public_synthetic_git": {"revision": "a" * 40, "raw_manifest_sha256": digest("raw"),
                                       "licensed_manifest_sha256": digest("licensed")}}
    streams, counts = {}, {}
    for split in gate.SPLITS:
        meta = {"format": "ilaria-token-stream-v1", "dtype": "uint16", "tokenizer_format": "ilarialex-v1",
                "tokenizer_sha256": digest("tokenizer"), "tokenizer": "DO-NOT-OPEN-tokenizer.json",
                "vocab_size": 65536, "eos_id": 61440, "protocol_start_id": 61440, "byte_level": True,
                "stream_sha256": digest(split + " stream"), "tokens": 16, "documents": 1}
        streams[split] = record(meta)
        counts[split] = {"jsonl_sha256": digest(split + " text"), "stream_sha256": meta["stream_sha256"],
                         "stream_metadata_sha256": streams[split]["file_sha256"], "stream_metadata_bytes": 1,
                         "stream_bytes": 32, "documents": 1, "tokens_including_eos": 16}
    package = gate.seal({"format": gate.PILOT_FORMAT, "status": gate.PILOT_STATUS,
                         "production_dataset_approved": False, "full_8_lane_quota_satisfied": False,
                         "split_policy": "sha256-connected-module-family-buckets-v1",
                         "split_buckets": {"train": "00-79", "validation": "80-89", "sealed": "90-99"},
                         "tokenizer_sha256": digest("tokenizer"), "eos_id": 61440, "eos_token": "<|ilaria:eos|>",
                         "counts": counts, "sources": sources,
                         "minimum_tokens": dict.fromkeys(gate.SPLITS, 1),
                         "group_counts": {"groups": 3, "split_group_counts": dict.fromkeys(gate.SPLITS, 1)},
                         "rights_registry_sha256": pins["registry_file_sha256"],
                         "rights_evidence_sha256": pins["evidence_file_sha256"],
                         "corpus_source_lock_sha256": pins["source_lock_file_sha256"],
                         "git_source_lock_sha256": pins["git_lock_file_sha256"]}, "package_sha256")
    dataset = record(package)
    templates = gate.build_pilot_templates(dataset, streams, pins, producer_sha256=digest("producer"))
    qualification, decision, assignment = (templates[name] for name in ("qualification", "decision", "group-assignment"))
    qualification["bounds"] = {"max_steps": 2, "max_train_tokens": 16, "max_wall_seconds": 30}
    assignment["groups"] = {split: [digest(split + " actual source module")] for split in gate.SPLITS}
    result = {"mode": "code-only-pilot", "dataset": dataset, "streams": streams,
              "qualification": qualification, "decision": decision, "assignment": assignment,
              "validation_receipt": {}, "rights_pins": pins,
              "registry": {"sources": {"public_synthetic_git": {"status": "APPROVED", "commercial_use_approved": True,
                         "review_ref": "synthetic human rights review", "declared_license": "MIT"}}},
              "evidence": {"sources": {"public_synthetic_git": {"commit": "a" * 40, "review_state": "APPROVED",
                         "declared_license": "MIT", "unresolved_obligations": []}}}}
    refresh(result)
    return result


def refresh(value):
    q = value["qualification"]
    assignment = gate.seal(value["assignment"], "assignment_sha256")
    value["assignment"] = assignment
    q["group_assignment_sha256"] = assignment["assignment_sha256"]
    receipt = {"format": gate.VALIDATION_FORMAT, "validation_level": "artifact-bytes-and-group-provenance",
               "dataset_identity_sha256": value["dataset"]["value"]["package_sha256"],
               "dataset_file_sha256": value["dataset"]["file_sha256"], "producer_sha256": q["producer_sha256"],
               "sources": q["sources"], "rights": value["rights_pins"], "streams": q["streams"],
               "group_assignment_sha256": assignment["assignment_sha256"], "scope": "code-only-pilot",
               "reviewed_by": "synthetic independent reviewer", "review_ref": "synthetic separate byte/group review"}
    value["validation_receipt"] = gate.seal(receipt, "validation_sha256")
    q["validation_receipt_sha256"] = value["validation_receipt"]["validation_sha256"]
    value["qualification"] = gate.seal(q, "qualification_sha256")
    decision = value["decision"]
    decision.update(qualification_sha256=value["qualification"]["qualification_sha256"], state="APPROVE_PILOT",
                    reviewed_by="synthetic authorized reviewer", review_ref="synthetic bounded pilot review")
    value["decision"] = gate.seal(decision, "decision_sha256")


def test_reviewed_bounded_pilot_needs_no_production_lanes_and_remains_nonpromotable():
    value = complete_pilot()
    result = gate.assess_launch(**value)
    assert result["data_qualified"] is True
    assert result["promotable"] is False
    assert result["launch_ready"] is False
    assert result["allocation_authorized"] is False
    assert result["trainer_adapter_ready"] is False
    assert result["blockers"] == ["trainer:qualified-pilot-adapter-not-integrated; canonical trainer rejects custom package"]


def test_pilot_cannot_bypass_production_scope_even_with_valid_hashes():
    value = complete_pilot()
    value["mode"] = "production"
    result = gate.assess_launch(**value)
    assert not result["data_qualified"]
    assert "pilot cannot satisfy production" in result["blockers"][0]


def test_template_never_creates_an_approved_decision_or_group_proof():
    value = complete_pilot()
    templates = gate.build_pilot_templates(value["dataset"], value["streams"], value["rights_pins"], producer_sha256=digest("producer"))
    assert templates["decision"]["state"] == "PENDING"
    assert templates["qualification"]["validation_receipt_sha256"] == templates["validation-receipt"]["validation_sha256"]
    assert templates["validation-receipt"]["validation_level"] == "PENDING"
    assert templates["group-assignment"]["groups"] == dict.fromkeys(gate.SPLITS, [])
    value.update(qualification=templates["qualification"], decision=templates["decision"], assignment=templates["group-assignment"])
    assert "state=PENDING" in gate.assess_launch(**value)["blockers"][0]


@pytest.mark.parametrize("fault", ["missing-registry", "unapproved", "commercial", "review-ref", "missing-evidence", "unapproved-evidence", "obligations", "license"])
def test_hashes_and_qualification_booleans_cannot_grant_rights(fault):
    value = complete_pilot()
    q = value["qualification"]
    q["rights_approved"] = True  # no authority is conferred by this claim
    refresh(value)
    reg = value["registry"]["sources"]["public_synthetic_git"]
    ev = value["evidence"]["sources"]["public_synthetic_git"]
    if fault == "missing-registry": value["registry"]["sources"] = {}
    elif fault == "unapproved": reg["status"] = "REVIEW_REQUIRED"
    elif fault == "commercial": reg["commercial_use_approved"] = False
    elif fault == "review-ref": reg["review_ref"] = ""
    elif fault == "missing-evidence": value["evidence"]["sources"] = {}
    elif fault == "unapproved-evidence": ev["review_state"] = "EVIDENCE_COLLECTED"
    elif fault == "obligations": ev["unresolved_obligations"] = ["unresolved notice"]
    elif fault == "license": ev["declared_license"] = "different"
    assert not gate.assess_launch(**value)["data_qualified"]


@pytest.mark.parametrize("fault", ["sources", "producer", "receipt", "reviewer", "revision", "raw-lineage"])
def test_valid_hashes_without_provenance_are_rejected(fault):
    value = complete_pilot()
    if fault == "sources": value["qualification"]["sources"] = {}
    elif fault == "producer": value["qualification"]["producer_sha256"] = ""
    elif fault == "revision": value["qualification"]["sources"]["public_synthetic_git"]["revision"] = "b" * 40
    elif fault == "raw-lineage": value["qualification"]["sources"]["public_synthetic_git"].pop("raw_manifest_sha256")
    refresh(value)
    if fault == "receipt": value["validation_receipt"] = {}
    elif fault == "reviewer":
        value["validation_receipt"]["reviewed_by"] = ""
        value["validation_receipt"] = gate.seal(value["validation_receipt"], "validation_sha256")
        value["qualification"]["validation_receipt_sha256"] = value["validation_receipt"]["validation_sha256"]
        value["qualification"] = gate.seal(value["qualification"], "qualification_sha256")
        value["decision"]["qualification_sha256"] = value["qualification"]["qualification_sha256"]
        value["decision"] = gate.seal(value["decision"], "decision_sha256")
    assert not gate.assess_launch(**value)["data_qualified"]


@pytest.mark.parametrize("other", ["train", "validation"])
def test_rehashed_sealed_group_overlap_is_rejected(other):
    value = complete_pilot()
    value["assignment"]["groups"]["sealed"] = list(value["assignment"]["groups"][other])
    refresh(value)
    result = gate.assess_launch(**value)
    assert not result["data_qualified"]
    assert "group identity overlap" in result["blockers"][0]


def test_manifest_counts_alone_do_not_prove_group_separation():
    value = complete_pilot()
    value["assignment"]["groups"] = dict.fromkeys(gate.SPLITS, [])
    refresh(value)
    assert "missing actual train group identities" in gate.assess_launch(**value)["blockers"][0]


@pytest.mark.parametrize("split", ["sealed", "validation"])
def test_heldout_split_cannot_be_selected_for_training(split):
    value = complete_pilot()
    value["training_splits"] = (split,)
    assert "cannot be selected for training" in gate.assess_launch(**value)["blockers"][0]


@pytest.mark.parametrize("field", ["max_steps", "max_train_tokens", "max_wall_seconds"])
def test_bounded_pilot_requires_strict_positive_integer_limits(field):
    value = complete_pilot()
    value["qualification"]["bounds"][field] = True
    refresh(value)
    assert not gate.assess_launch(**value)["data_qualified"]


def test_metadata_only_reader_rejects_duplicate_nonfinite_and_nonmetadata_inputs(tmp_path):
    for index, raw in enumerate(('{}', '{"a":1,"a":2}', '{"a":NaN}', '[]')):
        path = tmp_path / f"metadata-{index}.json"
        path.write_text(raw)
        if index == 0: assert gate.read_metadata(path)["value"] == {}
        else:
            with pytest.raises(ValueError): gate.read_metadata(path)
    text_path = tmp_path / "DO-NOT-READ.jsonl"
    with pytest.raises(ValueError, match="only explicit .json"):
        gate.read_metadata(text_path)


def test_metadata_read_never_follows_referenced_corpus_paths(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"text_file": "DO-NOT-READ.jsonl", "tensor_file": "DO-NOT-READ.bin"}))
    result = gate.read_metadata(path)
    assert result["value"]["tensor_file"] == "DO-NOT-READ.bin"


def test_stream_file_drift_and_shared_sealed_identity_reject_even_rehashed_qualification():
    value = complete_pilot()
    value["streams"]["sealed"]["file_sha256"] = digest("metadata drift")
    assert not gate.assess_launch(**value)["data_qualified"]
    value = complete_pilot()
    package = copy.deepcopy(value["dataset"]["value"])
    package["counts"]["sealed"]["jsonl_sha256"] = package["counts"]["train"]["jsonl_sha256"]
    package = gate.seal(package, "package_sha256")
    with pytest.raises(ValueError, match="artifact identities overlap"):
        gate.build_pilot_templates(record(package), value["streams"], value["rights_pins"], producer_sha256=digest("producer"))


def complete_production():
    value = complete_pilot()
    config = gate.seal({"format": "imc-125m-curriculum-v1", "policy": "exact-token-budget-v1",
                        "boundary_policy": "replace-final-lane-token-with-eos-v1",
                        "target_mix_ppm": {lane: (1_000_000 if lane == "code" else 0) for lane in gate.REQUIRED_LANES}},
                       "curriculum_sha256")
    for split in ("train", "validation"):
        meta = copy.deepcopy(value["streams"][split]["value"])
        meta["curriculum"] = {"config_identity_sha256": config["curriculum_sha256"]}
        value["streams"][split] = record(meta)
    manifest = gate.seal({"format": "ilaria-dataset-manifest-v1",
                          "curated_corpus": {"file_sha256": digest("curated file"), "identity_sha256": digest("curated identity")},
                          "post_curation_audit": {"file_sha256": digest("audit file"), "audit_sha256": digest("audit identity")},
                          "rights": {"sha256": value["rights_pins"]["registry_file_sha256"]},
                          "tokenizer": {"sha256": digest("tokenizer")},
                          "streams": {split: {"stream_sha256": value["streams"][split]["value"]["stream_sha256"]}
                                      for split in ("train", "validation")}}, "dataset_manifest_sha256")
    value.update(mode="production", dataset=record(manifest), curriculum=record(config),
                 readiness=record({"format": "ilaria-production-readiness-v1", "ready": True, "blockers": []}))
    q = value["qualification"]
    q.update(scope="production", dataset={"format": manifest["format"], "identity_sha256": manifest["dataset_manifest_sha256"],
             "file_sha256": value["dataset"]["file_sha256"]}, streams={split: gate._stream_binding(meta) for split, meta in value["streams"].items()},
             curriculum_file_sha256=value["curriculum"]["file_sha256"], readiness_file_sha256=value["readiness"]["file_sha256"],
             tokenizer_freeze_sha256=digest("canonical tokenizer freeze"))
    value["assignment"]["dataset_identity_sha256"] = manifest["dataset_manifest_sha256"]
    value["assignment"] = gate.seal(value["assignment"], "assignment_sha256")
    q["group_assignment_sha256"] = value["assignment"]["assignment_sha256"]
    receipt = value["validation_receipt"]
    receipt.update(scope="production", dataset_identity_sha256=manifest["dataset_manifest_sha256"],
                   validation_level="canonical-dataset-freeze-and-group-provenance",
                   canonical_dataset_validator_sha256=digest("canonical validator source"),
                   tokenizer_freeze_sha256=q["tokenizer_freeze_sha256"],
                   dataset_file_sha256=value["dataset"]["file_sha256"], streams=q["streams"],
                   group_assignment_sha256=q["group_assignment_sha256"])
    value["validation_receipt"] = gate.seal(receipt, "validation_sha256")
    q["validation_receipt_sha256"] = value["validation_receipt"]["validation_sha256"]
    value["qualification"] = gate.seal(q, "qualification_sha256")
    decision = value["decision"]
    decision.update(scope="production", state="APPROVE_PRODUCTION", qualification_sha256=value["qualification"]["qualification_sha256"])
    value["decision"] = gate.seal(decision, "decision_sha256")
    return value


def test_production_metadata_keeps_canonical_readiness_curriculum_and_launcher_requirements():
    value = complete_production()
    report = gate.assess_launch(**value)
    assert report["data_qualified"] is True
    assert report["launch_ready"] is False
    assert report["allocation_authorized"] is False
    assert report["blockers"] == ["launcher:canonical byte validators and allocation approvals still required"]


@pytest.mark.parametrize("fault", ["readiness", "missing-lane", "wrong-stream-curriculum"])
def test_production_cannot_use_pilot_readiness_or_partial_curriculum(fault):
    value = complete_production()
    if fault == "readiness":
        value["readiness"]["value"].update(ready=False, blockers=["production lane unavailable"])
    elif fault == "missing-lane":
        value["curriculum"]["value"]["target_mix_ppm"].pop("general_knowledge")
        value["curriculum"]["value"] = gate.seal(value["curriculum"]["value"], "curriculum_sha256")
    else:
        value["streams"]["train"]["value"]["curriculum"]["config_identity_sha256"] = digest("wrong curriculum")
    assert not gate.assess_launch(**value)["data_qualified"]
