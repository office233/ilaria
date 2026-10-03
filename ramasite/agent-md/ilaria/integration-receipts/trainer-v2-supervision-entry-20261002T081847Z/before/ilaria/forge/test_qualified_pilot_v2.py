"""Synthetic clean-v2 adapter regressions; no real corpus or cloud allocation."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from corpus_source_lock import build_source_lock
from git_source_lock import build_lock
from prepare_corpus import SOURCES
import qualified_pilot_v2 as v2
from rights_evidence import RIGHTS_EVIDENCE_FORMAT
from test_tokenizer_freeze import tokenizer_fixture
import training_launch_gate as gate
import train_ilaria as trainer


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def put(path: Path, value: dict) -> dict:
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    return gate.read_metadata(path)


def pin(path: Path, value: dict | None = None, field: str | None = None) -> dict:
    result = {"path": path.name, "file_sha256": sha(path)}
    if field is not None:
        if value is None:
            raise ValueError("identity field requires metadata value")
        result[field] = value[field]
    return result


def fixture(tmp_path: Path):
    source = {"url": "https://example.invalid/synthetic-zephyr", "ref": "fixture", "commit": "a" * 40}
    hf = build_source_lock({"tinystories": SOURCES["tinystories"]}, {"tinystories": "a" * 40})
    git = build_lock({"zephyr": source})
    put(tmp_path / "source.json", hf)
    put(tmp_path / "git.json", git)
    evidence = gate.seal({
        "format": RIGHTS_EVIDENCE_FORMAT,
        "source_lock_sha256": hf["source_lock_sha256"],
        "git_source_lock_sha256": git["source_lock_sha256"],
        "sources": {"zephyr": dict(
            source_kind="git", declared_license="MIT",
            evidence_urls=["https://example.invalid/license"], review_state="APPROVED",
            unresolved_obligations=[], **source)},
    }, "evidence_sha256")
    put(tmp_path / "evidence.json", evidence)
    registry = {
        "schema_version": 1, "policy": "synthetic-fixture-rights-v1",
        "sources": {"zephyr": {
            "status": "APPROVED", "commercial_use_approved": True,
            "review_ref": "synthetic rights review", "declared_license": "MIT",
        }},
        "evidence": {
            "filename": "evidence.json", "sha256": evidence["evidence_sha256"],
            "source_lock_sha256": hf["source_lock_sha256"],
            "git_source_lock_filename": "git.json",
            "git_source_lock_sha256": git["source_lock_sha256"],
        },
    }
    put(tmp_path / "rights.json", registry)

    tokenizer = tokenizer_fixture(tmp_path)
    companion = tokenizer.with_suffix(".hf.json")
    stream_records, package_counts, corpus_counts = {}, {}, {}
    for index, split in enumerate(v2.SPLITS):
        tokens = np.arange(index * 32 + 1, index * 32 + 33, dtype=np.uint16)
        raw = tokens.tobytes()
        prefix = tmp_path / f"{split}.tokens"
        Path(str(prefix) + ".bin").write_bytes(raw)
        meta = {
            "format": "ilaria-token-stream-v1", "dtype": "uint16",
            "tokenizer_format": "ilarialex-v1", "tokenizer": tokenizer.name,
            "tokenizer_sha256": sha(tokenizer), "vocab_size": 65536,
            "eos_id": 61440, "protocol_start_id": 61440, "byte_level": True,
            "stream_sha256": hashlib.sha256(raw).hexdigest(), "tokens": 32, "documents": 1,
        }
        stream_records[split] = put(Path(str(prefix) + ".json"), meta)
        package_counts[split] = {
            "byte_level": True, "documents": 1, "dtype": "uint16", "eos_id": 61440,
            "format": "ilaria-token-stream-v1", "metadata_sha256": stream_records[split]["file_sha256"],
            "protocol_start_id": 61440, "stream_bytes": len(raw),
            "stream_sha256": meta["stream_sha256"], "tokenizer": tokenizer.name,
            "tokenizer_format": "ilarialex-v1", "tokenizer_sha256": sha(tokenizer),
            "tokens": 32, "vocab_size": 65536,
        }
        corpus_counts[split] = {"bytes": 100 + index, "documents": 1, "sha256": digest(split + "-jsonl")}

    sources = {"zephyr": {
        "revision": source["commit"], "raw_manifest_sha256": digest("raw"),
        "licensed_manifest_sha256": digest("licensed"),
    }}
    groups = {split: [f"zephyr@{source['commit']}:{split}/module"] for split in v2.SPLITS}
    corpus = gate.seal({
        "format": v2.CORPUS_FORMAT, "status": v2.STATUS,
        "production_dataset_approved": False, "historical_tokenizer_used": False,
        "tokenizer_trained": False, "producer_sha256": digest("producer"),
        "sources": sources, "counts": corpus_counts, "groups": groups,
        "benchmark_groups_excluded": [f"zephyr@{source['commit']}:excluded/module"],
        "rights": {
            "rights_sha256": sha(tmp_path / "rights.json"),
            "evidence_sha256": sha(tmp_path / "evidence.json"),
            "source_lock_sha256": sha(tmp_path / "source.json"),
            "git_lock_sha256": sha(tmp_path / "git.json"),
        },
    }, "corpus_sha256")
    corpus_record = put(tmp_path / "clean-corpus.json", corpus)
    binding = gate.seal({
        "format": v2.TOKENIZER_BINDING_FORMAT, "status": v2.STATUS, "scope": "code-only-pilot",
        "mocked": False, "model_training": False, "production_coverage_freeze": False,
        "independent_qualification": "PENDING_VERSION_SPECIFIC_REPLAY",
        "corpus_sha256": corpus["corpus_sha256"], "corpus_manifest_sha256": corpus_record["file_sha256"],
        "tokenizer_sha256": sha(tokenizer), "companion_sha256": sha(companion),
        "vocabulary": 65536, "protocol_reserved": 4096, "protocol_start_id": 61440,
        "sample_groups": groups["train"],
        "selections": [{
            "source": "zephyr", "revision": source["commit"], "documents": 1,
            "sha256": digest("selection-bytes"), "source_manifest_sha256": digest("selection-manifest"),
        }],
    }, "binding_sha256")
    binding_record = put(tmp_path / "binding.json", binding)
    package = gate.seal({
        "format": v2.PACKAGE_FORMAT, "status": v2.STATUS,
        "production_dataset_approved": False, "full_8_lane_quota_satisfied": False,
        "training_performed": False,
        "trainer_admission": "V2_REQUIRES_EXPLICIT_ADAPTER_MIGRATION; old freeze is not substituted",
        "corpus_sha256": corpus["corpus_sha256"], "corpus_manifest_sha256": corpus_record["file_sha256"],
        "tokenizer_binding_sha256": binding["binding_sha256"], "tokenizer_sha256": sha(tokenizer),
        "producer_sha256": corpus["producer_sha256"], "sources": sources,
        "group_counts": {split: 1 for split in v2.SPLITS},
        "minimum_tokens": {split: 1 for split in v2.SPLITS},
        "counts": package_counts,
    }, "package_sha256")
    package_record = put(tmp_path / "package.json", package)
    replay = {
        "format": v2.REPLAY_FORMAT, "status": "VERIFIED_BYTES_GROUPS_TOKENIZER_HELDOUT_SEPARATION",
        "scope": v2.STATUS, "package_sha256": package["package_sha256"],
        "tokenizer_sha256": sha(tokenizer),
        "counts": {split: {"documents": 1, "tokens": 32} for split in v2.SPLITS},
        "stream_pins": {split: package_counts[split]["stream_sha256"] for split in v2.SPLITS},
        "sample_heldout_exact_overlap": 0, "normalized_body_overlap": 0,
        "complete_raw_provenance": True, "canonical_streams_reencoded": True,
        "allocation_authorized": False, "production_promotion": False,
        "six_category_coverage_freeze": False,
        "source_quality_or_general_reasoning_certified": False,
    }
    replay_record = put(tmp_path / "replay.json", replay)
    decision = gate.seal({
        "format": v2.DECISION_FORMAT, "scope": "code-only-pilot",
        "state": v2.APPROVED_LOCAL_STATE, "promotable": False, "allocation_authorized": False,
        "reviewed_by": "synthetic fixture reviewer", "review_ref": "synthetic v2 test",
        "package_sha256": package["package_sha256"], "corpus_sha256": corpus["corpus_sha256"],
        "tokenizer_binding_sha256": binding["binding_sha256"],
        "independent_replay_file_sha256": replay_record["file_sha256"],
        "adapter": {"format": v2.FORMAT, "source_sha256": v2.source_sha256()},
    }, "decision_sha256")
    put(tmp_path / "decision.json", decision)
    launch = gate.seal({
        "format": v2.LAUNCH_FORMAT,
        "package": pin(tmp_path / "package.json", package, "package_sha256"),
        "corpus": pin(tmp_path / "clean-corpus.json", corpus, "corpus_sha256"),
        "tokenizer_binding": pin(tmp_path / "binding.json", binding, "binding_sha256"),
        "independent_replay": pin(tmp_path / "replay.json"),
        "decision": pin(tmp_path / "decision.json", decision, "decision_sha256"),
        "streams": {split: f"{split}.tokens.json" for split in v2.SPLITS},
        "tokenizer": pin(tokenizer), "tokenizer_companion": pin(companion),
        "rights_registry": pin(tmp_path / "rights.json"),
        "rights_evidence": pin(tmp_path / "evidence.json"),
        "source_lock": pin(tmp_path / "source.json"), "git_source_lock": pin(tmp_path / "git.json"),
        "bounds": {"max_steps": 2, "max_train_tokens": 8, "max_wall_seconds": 30},
    }, "launch_sha256")
    launch_path = tmp_path / "launch-v2.json"
    put(launch_path, launch)
    args = SimpleNamespace(
        data=str(tmp_path / "train.tokens"), val_data=str(tmp_path / "validation.tokens"),
        tokenizer=str(tokenizer), tokenizer_freeze="", dataset_manifest="",
        allow_unmanifested_data=False, allow_internal_val_split=False, init_from="", resume="",
        sample_tokens=0, ctx=4, batch=1, accum=1, steps=2,
    )
    return launch_path, args, {
        "package": package, "corpus": corpus, "binding": binding, "replay": replay,
        "decision": decision, "tokenizer": tokenizer,
    }


def cli(launch: Path, args, out: Path):
    return [
        "train_ilaria.py", "--qualified-pilot-v2", str(launch),
        "--data", args.data, "--val-data", args.val_data, "--out", str(out),
        "--tokenizer", args.tokenizer, "--embed-dim", "8", "--heads", "2",
        "--kv-heads", "1", "--layers", "1", "--ffn-dim", "16",
        "--ctx", "4", "--max-seq-len", "8", "--batch", "1", "--accum", "1",
        "--steps", "2", "--eval-every", "2", "--eval-iters", "1",
        "--sample-tokens", "0", "--precision", "fp32",
    ]


def reseal_launch(root: Path, launch: dict):
    put(root / "launch-v2.json", gate.seal(launch, "launch_sha256"))


def test_clean_v2_admits_exact_synthetic_bytes_without_legacy_freeze(tmp_path):
    launch, args, values = fixture(tmp_path)
    admission = v2.admit_metadata(launch, args, 1)
    train, train_meta = trainer.load_stream(args.data)
    validation, validation_meta = trainer.load_stream(args.val_data)
    trainer.validate_stream_compatibility(train_meta, validation_meta)
    assert len(train) == len(validation) == 32
    assert admission.validate_bytes(args, train_meta, validation_meta, sha(values["tokenizer"])) == "CLEAN-V2-NO-LEGACY-FREEZE"
    assert admission.binding["promotable"] is False
    assert admission.binding["allocation_authorized"] is False
    assert admission.binding["dataset_identity_sha256"] == values["package"]["package_sha256"]


@pytest.mark.parametrize("fault", [
    "replay-overlap", "rights-drift", "sealed-alias", "legacy-freeze",
    "decision-promotion", "group-overlap", "tokenizer-drift", "budget",
])
def test_clean_v2_faults_fail_closed(tmp_path, fault):
    launch_path, args, _ = fixture(tmp_path)
    launch = gate.read_metadata(launch_path)["value"]
    if fault == "replay-overlap":
        replay = gate.read_metadata(tmp_path / "replay.json")["value"]
        replay["sample_heldout_exact_overlap"] = 1
        put(tmp_path / "replay.json", replay)
        launch["independent_replay"]["file_sha256"] = sha(tmp_path / "replay.json")
    elif fault == "rights-drift":
        (tmp_path / "rights.json").write_text("{}\n", encoding="utf-8")
        launch["rights_registry"]["file_sha256"] = sha(tmp_path / "rights.json")
    elif fault == "sealed-alias":
        sealed = tmp_path / "sealed.tokens.bin"
        sealed.unlink()
        try:
            sealed.hardlink_to(tmp_path / "train.tokens.bin")
        except (OSError, NotImplementedError):
            pytest.skip("hard links unavailable")
    elif fault == "legacy-freeze":
        args.tokenizer_freeze = str(tmp_path / "legacy-freeze.json")
    elif fault == "decision-promotion":
        decision = gate.read_metadata(tmp_path / "decision.json")["value"]
        decision["promotable"] = True
        decision = gate.seal(decision, "decision_sha256")
        put(tmp_path / "decision.json", decision)
        launch["decision"] = pin(tmp_path / "decision.json", decision, "decision_sha256")
    elif fault == "group-overlap":
        corpus = gate.read_metadata(tmp_path / "clean-corpus.json")["value"]
        corpus["groups"]["sealed"] = list(corpus["groups"]["train"])
        corpus = gate.seal(corpus, "corpus_sha256")
        put(tmp_path / "clean-corpus.json", corpus)
        launch["corpus"] = pin(tmp_path / "clean-corpus.json", corpus, "corpus_sha256")
    elif fault == "tokenizer-drift":
        values = json.loads((tmp_path / "ilarialex.json").read_text())
        values["fixture_drift"] = True
        (tmp_path / "ilarialex.json").write_text(json.dumps(values, sort_keys=True) + "\n")
        launch["tokenizer"]["file_sha256"] = sha(tmp_path / "ilarialex.json")
    elif fault == "budget":
        launch["bounds"]["max_train_tokens"] = 4
    reseal_launch(tmp_path, launch)
    with pytest.raises((ValueError, json.JSONDecodeError)):
        v2.admit_metadata(launch_path, args, 1)


def test_clean_v2_trainer_reaches_supervision_before_cuda_or_model(tmp_path, monkeypatch, capsys):
    launch, args, _ = fixture(tmp_path)
    monkeypatch.setattr("sys.argv", cli(launch, args, tmp_path / "out"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CUDA queried before v2 supervision"))
    monkeypatch.setattr(trainer, "ImcTransformer", lambda *_: pytest.fail("model allocated before v2 supervision"))
    with pytest.raises(SystemExit) as raised:
        trainer.main()
    assert raised.value.code == 2
    assert "UNVERIFIED" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


def test_v1_v2_are_mutually_exclusive_before_payload_or_cuda(tmp_path, monkeypatch, capsys):
    launch, args, _ = fixture(tmp_path)
    argv = cli(launch, args, tmp_path / "out") + ["--qualified-pilot", str(launch)]
    monkeypatch.setattr("sys.argv", argv)
    monkeypatch.setattr(trainer, "load_stream", lambda *_: pytest.fail("stream opened"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CUDA queried"))
    with pytest.raises(SystemExit) as raised:
        trainer.main()
    assert raised.value.code == 2
    assert "mutually exclusive" in capsys.readouterr().err


def test_clean_v2_existing_loop_binds_checkpoint_and_run_metadata(tmp_path, monkeypatch):
    launch, args, _ = fixture(tmp_path)
    out = tmp_path / "out"
    monkeypatch.setattr("sys.argv", cli(launch, args, out))
    monkeypatch.setattr(v2.CleanV2Admission, "require_supervision", lambda self: None)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    torch.set_num_threads(1)
    trainer.main()
    checkpoint = torch.load(out / "checkpoint.pt", map_location="cpu", weights_only=True)
    metadata = json.loads((out / "qualified-pilot-run.json").read_text())
    assert checkpoint["step"] == 2 and checkpoint["tokens_seen"] == 8
    assert checkpoint["qualified_pilot"]["binding"] == checkpoint["signature"]["qualified_pilot"]
    assert checkpoint["qualified_pilot"]["binding"]["format"] == v2.FORMAT
    assert metadata["format"] == v2.RUN_FORMAT
    assert metadata["promotable"] is False and metadata["allocation_authorized"] is False
