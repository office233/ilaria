"""Owned synthetic provenance/stream fixtures, never the frozen pilot corpus."""
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

import qualified_pilot as pilot
import training_launch_gate as gate
import train_ilaria as trainer
from corpus_source_lock import build_source_lock
from git_source_lock import build_lock
from prepare_corpus import SOURCES
from rights_evidence import RIGHTS_EVIDENCE_FORMAT
from test_tokenizer_freeze import tokenizer_fixture
from test_training_launch_gate import complete_pilot, refresh
from tokenizer_freeze import REQUIRED_COVERAGE, build_sample_manifest, build_freeze_manifest


def put(path, value):
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    return gate.read_metadata(path)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(tmp_path):
    """All approvals here refer solely to this newly generated test fixture."""
    source = {"url": "https://example.invalid/synthetic-zephyr", "ref": "fixture", "commit": "a" * 40}
    hf = build_source_lock({"tinystories": SOURCES["tinystories"]}, {"tinystories": "a" * 40})
    git = build_lock({"zephyr": source})
    put(tmp_path / "source.json", hf)
    put(tmp_path / "git.json", git)
    evidence = gate.seal({"format": RIGHTS_EVIDENCE_FORMAT, "source_lock_sha256": hf["source_lock_sha256"],
                         "git_source_lock_sha256": git["source_lock_sha256"], "sources": {
        "zephyr": dict(source_kind="git", declared_license="MIT", evidence_urls=["https://example.invalid/license"],
                       review_state="APPROVED", unresolved_obligations=[], **source)}}, "evidence_sha256")
    put(tmp_path / "evidence.json", evidence)
    registry = {"schema_version": 1, "policy": "synthetic-fixture-rights-v1", "sources": {
        "zephyr": {"status": "APPROVED", "commercial_use_approved": True, "review_ref": "synthetic human review",
                   "declared_license": "MIT"}}, "evidence": {
        "filename": "evidence.json", "sha256": evidence["evidence_sha256"], "source_lock_sha256": hf["source_lock_sha256"],
        "git_source_lock_filename": "git.json", "git_source_lock_sha256": git["source_lock_sha256"]}}
    put(tmp_path / "rights.json", registry)
    tokenizer = tokenizer_fixture(tmp_path)
    sample = tmp_path / "synthetic-sample.txt"
    sample.write_text("Owned synthetic code math English OS driver protocol example.\n")
    sample_manifest = build_sample_manifest([sample], source_names=["zephyr"], coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=tmp_path / "rights.json", source_lock_path=tmp_path / "source.json",
        git_source_lock_path=tmp_path / "git.json")
    put(tmp_path / "sample.json", sample_manifest)
    freeze = build_freeze_manifest(tokenizer, sample_manifest_path=tmp_path / "sample.json", rights_registry_path=tmp_path / "rights.json")
    put(tmp_path / "freeze.json", freeze)
    value = complete_pilot()
    package = value["dataset"]["value"]
    streams = {}
    for index, split in enumerate(gate.SPLITS):
        tokens = np.arange(index * 32 + 1, index * 32 + 33, dtype=np.uint16)
        raw = tokens.tobytes()
        if split != "sealed":  # no sealed bytes even exist in this fixture
            (tmp_path / f"{split}.bin").write_bytes(raw)
        meta = copy.deepcopy(value["streams"][split]["value"])
        meta.update(tokens=32, tokenizer=tokenizer.name, tokenizer_sha256=sha(tokenizer),
                    stream_sha256=hashlib.sha256(raw).hexdigest())
        streams[split] = put(tmp_path / f"{split}.json", meta)
        package["counts"][split].update(stream_sha256=meta["stream_sha256"],
            stream_metadata_sha256=streams[split]["file_sha256"], stream_metadata_bytes=(tmp_path / f"{split}.json").stat().st_size,
            stream_bytes=64, tokens_including_eos=32)
    pins = {field: sha(tmp_path / name) for field, name in (
        ("registry_file_sha256", "rights.json"), ("evidence_file_sha256", "evidence.json"),
        ("source_lock_file_sha256", "source.json"), ("git_lock_file_sha256", "git.json"))}
    for field, pin in (("rights_registry_sha256", "registry_file_sha256"), ("rights_evidence_sha256", "evidence_file_sha256"),
                       ("corpus_source_lock_sha256", "source_lock_file_sha256"), ("git_source_lock_sha256", "git_lock_file_sha256")):
        package[field] = pins[pin]
    package["tokenizer_sha256"] = sha(tokenizer)
    package["sources"] = {"zephyr": {"revision": source["commit"], "raw_manifest_sha256": "a" * 64,
                                       "licensed_manifest_sha256": "b" * 64}}
    value.update(dataset=put(tmp_path / "dataset.json", gate.seal(package, "package_sha256")),
                 streams=streams, rights_pins=pins, registry=registry, evidence=evidence)
    templates = gate.build_pilot_templates(value["dataset"], streams, pins, producer_sha256="c" * 64)
    value.update(qualification=templates["qualification"], decision=templates["decision"],
                 assignment=templates["group-assignment"])
    value["assignment"]["groups"] = {split: [hashlib.sha256(split.encode()).hexdigest()] for split in gate.SPLITS}
    value["qualification"].update(bounds={"max_steps": 2, "max_train_tokens": 8, "max_wall_seconds": 30},
        trainer_adapter={"format": pilot.FORMAT, "source_sha256": pilot.source_sha256()},
        tokenizer_freeze_sha256=freeze["freeze_sha256"], tokenizer_freeze_file_sha256=sha(tmp_path / "freeze.json"),
        tokenizer_sample_groups=list(value["assignment"]["groups"]["train"]))
    refresh(value)
    launch = {"format": pilot.LAUNCH_FORMAT, "streams": {split: f"{split}.json" for split in gate.SPLITS},
        "dataset": "dataset.json", "qualification": "qualification.json", "decision": "decision.json",
        "assignment": "assignment.json", "validation_receipt": "receipt.json", "rights_registry": "rights.json",
        "rights_evidence": "evidence.json", "source_lock": "source.json", "git_source_lock": "git.json"}
    launch_path = tmp_path / "launch.json"
    put(launch_path, gate.seal(launch, "launch_sha256"))
    save_contract(tmp_path, value)
    args = SimpleNamespace(data=str(tmp_path / "train"), val_data=str(tmp_path / "validation"), tokenizer=str(tokenizer),
        tokenizer_freeze=str(tmp_path / "freeze.json"), dataset_manifest="", allow_unmanifested_data=False,
        allow_internal_val_split=False, init_from="", sample_tokens=0, ctx=4, batch=1, accum=1, steps=2)
    return launch_path, args, value


def save_contract(root, value):
    for name, filename in (("qualification", "qualification.json"), ("decision", "decision.json"),
                           ("assignment", "assignment.json"), ("validation_receipt", "receipt.json")):
        put(root / filename, value[name])


def test_real_canonical_bytes_and_freeze_admit_without_opening_sealed(tmp_path):
    launch, args, _ = fixture(tmp_path)
    admission = pilot.admit_metadata(launch, args, 1)
    train, meta = trainer.load_stream(args.data)
    val, val_meta = trainer.load_stream(args.val_data)
    trainer.validate_stream_compatibility(meta, val_meta)
    assert admission.validate_bytes(args, meta, val_meta, sha(Path(args.tokenizer)))
    assert len(train) == len(val) == 32
    assert not (tmp_path / "sealed.bin").exists()
    assert admission.binding["promotable"] is False
    with pytest.raises(ValueError, match="UNVERIFIED"):
        admission.require_supervision()


@pytest.mark.parametrize("fault", ["rights", "provenance", "sealed-overlap", "obsolete-adapter", "unmanifested", "wrong-validation", "global-tokens", "sealed-sample", "invalid-wall"])
def test_metadata_failures_precede_stream_open_and_allocation(tmp_path, monkeypatch, fault):
    launch, args, value = fixture(tmp_path)
    if fault == "rights":
        value["registry"]["sources"]["zephyr"]["review_ref"] = ""
        put(tmp_path / "rights.json", value["registry"])
    elif fault == "provenance": value["qualification"]["producer_sha256"] = ""
    elif fault == "sealed-overlap": value["assignment"]["groups"]["sealed"] = value["assignment"]["groups"]["train"]
    elif fault == "obsolete-adapter": value["qualification"]["trainer_adapter"]["format"] = "old-attempt"
    elif fault == "unmanifested": args.allow_unmanifested_data = True
    elif fault == "wrong-validation": args.val_data = str(tmp_path / "sealed")
    elif fault == "global-tokens": args.accum = 2
    elif fault == "sealed-sample": value["qualification"]["tokenizer_sample_groups"] = value["assignment"]["groups"]["sealed"]
    elif fault == "invalid-wall": value["qualification"]["bounds"]["max_wall_seconds"] = True
    refresh(value)
    save_contract(tmp_path, value)
    monkeypatch.setattr(trainer, "load_stream", lambda *_: pytest.fail("stream opened before rejection"))
    with pytest.raises(ValueError): pilot.admit_metadata(launch, args, 2 if fault == "global-tokens" else 1)


@pytest.mark.parametrize("artifact", ["train.bin", "validation.bin", "ilarialex.json", "ilarialex.hf.json", "synthetic-sample.txt"])
def test_canonical_byte_validation_rejects_drift(tmp_path, artifact):
    launch, args, _ = fixture(tmp_path)
    admission = pilot.admit_metadata(launch, args, 1)
    target = tmp_path / artifact
    target.write_bytes(target.read_bytes() + b"x")
    with pytest.raises((ValueError, json.JSONDecodeError)):
        _, train_meta = trainer.load_stream(args.data)
        _, val_meta = trainer.load_stream(args.val_data)
        admission.validate_bytes(args, train_meta, val_meta, sha(Path(args.tokenizer)))


def test_resume_binding_counters_and_cumulative_wall_are_strict(tmp_path):
    launch, args, _ = fixture(tmp_path)
    clock = [10.0]
    admission = pilot.admit_metadata(launch, args, 1, monotonic=lambda: clock[0])
    checkpoint = {"qualified_pilot": {"binding": admission.binding, "wall_seconds": 4.0},
                  "signature": {"qualified_pilot": admission.binding}, "step": 1, "tokens_seen": 4}
    admission.validate_resume(checkpoint)
    for field, value in (("step", True), ("tokens_seen", 5)):
        wrong = copy.deepcopy(checkpoint)
        wrong[field] = value
        with pytest.raises(ValueError): admission.validate_resume(wrong)
    old = copy.deepcopy(checkpoint)
    del old["qualified_pilot"]
    with pytest.raises(ValueError, match="obsolete"): admission.validate_resume(old)
    clock[0] = 36.0
    with pytest.raises(ValueError, match="wall budget"): admission.check()


def test_obsolete_resume_fails_before_cuda_or_model(tmp_path, monkeypatch, capsys):
    launch, args, _ = fixture(tmp_path)
    obsolete = tmp_path / "owned-obsolete.pt"
    torch.save({"signature": {}, "step": 0, "tokens_seen": 0}, obsolete)
    monkeypatch.setattr("sys.argv", cli(launch, args, tmp_path / "out") + ["--resume", str(obsolete)])
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CUDA queried before obsolete resume rejection"))
    with pytest.raises(SystemExit) as raised: trainer.main()
    assert raised.value.code == 2
    assert "completed prior owned-scope receipt" in capsys.readouterr().err


def test_sealed_hash_in_renamed_tokenizer_sample_is_rejected_without_open(tmp_path):
    launch, args, value = fixture(tmp_path)
    sample = gate.read_metadata(tmp_path / "sample.json")["value"]
    sample["inputs"][0]["filename"] = "absent-renamed-sealed.jsonl"
    sample["inputs"][0]["sha256"] = value["dataset"]["value"]["counts"]["sealed"]["jsonl_sha256"]
    sample = gate.seal(sample, "sample_manifest_sha256")
    put(tmp_path / "sample.json", sample)
    freeze = gate.read_metadata(tmp_path / "freeze.json")["value"]
    freeze["sample"]["sha256"] = sample["sample_manifest_sha256"]
    freeze = gate.seal(freeze, "freeze_sha256")
    put(tmp_path / "freeze.json", freeze)
    value["qualification"].update(tokenizer_freeze_sha256=freeze["freeze_sha256"],
        tokenizer_freeze_file_sha256=sha(tmp_path / "freeze.json"))
    refresh(value)
    save_contract(tmp_path, value)
    with pytest.raises(ValueError, match="sealed artifact"):
        pilot.admit_metadata(launch, args, 1)


def test_rehashed_sample_drift_is_rejected_before_sample_bytes_open(tmp_path):
    launch, args, _ = fixture(tmp_path)
    sample = gate.read_metadata(tmp_path / "sample.json")["value"]
    sample["inputs"][0]["filename"] = "absent-renamed-sealed.jsonl"
    put(tmp_path / "sample.json", gate.seal(sample, "sample_manifest_sha256"))
    with pytest.raises(ValueError, match="sample identity differs before"):
        pilot.admit_metadata(launch, args, 1)


def test_cooperative_budget_counts_actual_global_microbatch_tokens(tmp_path):
    launch, args, value = fixture(tmp_path)
    value["qualification"]["bounds"]["max_train_tokens"] = 32
    refresh(value)
    save_contract(tmp_path, value)
    args.batch, args.accum = 2, 2
    args.steps = 1
    admission = pilot.admit_metadata(launch, args, 2)
    assert admission.binding["tokens_per_step"] == 32
    admission.check(step=0, tokens=0, reserve_tokens=32)
    with pytest.raises(ValueError, match="tokens budget"): admission.check(step=1, tokens=32, reserve_tokens=16)


def cli(launch, args, out):
    return ["train_ilaria.py", "--qualified-pilot", str(launch), "--data", args.data, "--val-data", args.val_data,
        "--out", str(out), "--tokenizer", args.tokenizer, "--tokenizer-freeze", args.tokenizer_freeze,
        "--embed-dim", "8", "--heads", "2", "--kv-heads", "1", "--layers", "1", "--ffn-dim", "16",
        "--ctx", "4", "--max-seq-len", "8", "--batch", "1", "--accum", "1", "--steps", "2",
        "--eval-every", "2", "--eval-iters", "1", "--sample-tokens", "0", "--precision", "fp32"]


def test_raw_pilot_launch_rejects_before_cuda_ddp_model_or_optimizer(tmp_path, monkeypatch, capsys):
    launch, args, _ = fixture(tmp_path)
    monkeypatch.setattr("sys.argv", cli(launch, args, tmp_path / "out"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CUDA queried before hardwall admission"))
    monkeypatch.setattr(trainer, "ImcTransformer", lambda *_: pytest.fail("model allocated"))
    with pytest.raises(SystemExit) as raised: trainer.main()
    assert raised.value.code == 2
    assert "hard-wall tree supervision is UNVERIFIED" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


def test_unreviewed_release_and_caller_ready_flags_cannot_enable_launch(tmp_path, monkeypatch):
    fixture(tmp_path)
    monkeypatch.setenv("IMC_CONTAINMENT_READY", "true")
    monkeypatch.setenv("IMC_CONTAINMENT_SOCKET", str(tmp_path / "caller-claimed.sock"))
    monkeypatch.setattr(pilot, "SUPERVISOR_SOURCE_PINS", {})
    with pytest.raises(ValueError, match="UNVERIFIED"):
        pilot._shared_supervisor()


def test_reviewed_shared_source_import_and_wrong_pin_rejection(monkeypatch):
    # Source import only: no capability bootstrap, subprocess, or allocation.
    for name in ("containment", "probe"):
        monkeypatch.delitem(pilot.sys.modules, name, raising=False)
    containment, probe = pilot._shared_supervisor()
    assert containment.VERSION == "linux-subreaper-pidfd-v1"
    assert callable(probe.Supervisor)
    wrong = dict(pilot.SUPERVISOR_SOURCE_PINS, **{"probe.py": "0" * 64})
    monkeypatch.setattr(pilot, "SUPERVISOR_SOURCE_PINS", wrong)
    with pytest.raises(ValueError, match="source release differs"):
        pilot._shared_supervisor()


def test_supervised_entry_refuses_windows_without_spawning():
    if pilot.os.name != "nt":
        pytest.skip("native Windows refusal regression")
    with pytest.raises(ValueError, match="reviewed Linux containment"):
        pilot.supervise_canonical([], world_size=8, deadline=None, log_path="unused-owned.log")


def test_existing_loop_binds_tiny_checkpoint_and_run_metadata(tmp_path, monkeypatch):
    # This tests the canonical CPU loop with injected admission. It is not a
    # hard-wall, GPU, DDP or actual-package qualification receipt.
    launch, args, _ = fixture(tmp_path)
    out = tmp_path / "out"
    monkeypatch.setattr("sys.argv", cli(launch, args, out))
    monkeypatch.setattr(pilot.Admission, "require_supervision", lambda self: None)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    torch.set_num_threads(1)
    trainer.main()
    checkpoint = torch.load(out / "checkpoint.pt", map_location="cpu", weights_only=True)
    metadata = json.loads((out / "qualified-pilot-run.json").read_text())
    assert checkpoint["step"] == 2 and checkpoint["tokens_seen"] == 8
    assert checkpoint["qualified_pilot"]["binding"] == checkpoint["signature"]["qualified_pilot"]
    assert metadata["promotable"] is False and metadata["status"] == gate.PILOT_STATUS
    assert checkpoint["qualified_pilot"]["binding"]["promotable"] is False
