"""Owned synthetic fixtures only; no real tokenizer/corpus/heldout payloads."""
import builtins
import copy
import hashlib
import json
import os
from pathlib import Path

import pytest
import torch

import qualified_pilot as pilot
import qualified_tokenizer_contract as contract
import training_launch_gate as gate
import train_ilaria as trainer
from first_party_attestation import attestation_scope_sha256, build_attestation_template
from git_source_lock import build_lock
from rights_evidence import RIGHTS_EVIDENCE_FORMAT
from test_qualified_pilot import cli, fixture as pilot_fixture, put, save_contract, sha
from test_training_launch_gate import refresh
from tokenizer_coverage import build_coverage_manifest
from tokenizer_freeze import REQUIRED_COVERAGE, build_freeze_manifest, build_sample_manifest


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def pin(path, value=None, field=None):
    result = {"path": path.name, "file_sha256": sha(path)}
    if field:
        result[field] = value[field]
    return result


def fixture(tmp_path):
    launch, args, value = pilot_fixture(tmp_path)
    owned_root = tmp_path / "immutable-source-root"
    owned_root.mkdir()
    source_file = owned_root / "native.swyp"
    source_file.write_text("record OwnedSynthetic { answer: i64 }\n", encoding="utf-8")
    packet = build_attestation_template(owned_root, paths=["native.swyp"])
    packet.update(ownership_attested=True, attested_by="synthetic owner", review_ref="synthetic ownership review")
    packet = gate.seal(packet, "attestation_sha256")
    packet_path = tmp_path / "tokenizer-attestation.json"
    put(packet_path, packet)
    first = {"tokenizer_owned": packet_path}
    source = {"url": "https://example.invalid/owned-tokenizer-fixture", "ref": "synthetic", "commit": "b" * 40}
    git = build_lock({"tokenizer_external": source})
    put(tmp_path / "tokenizer-git.json", git)
    hf = gate.read_metadata(tmp_path / "source.json")["value"]
    evidence = gate.seal({"format": RIGHTS_EVIDENCE_FORMAT, "source_lock_sha256": hf["source_lock_sha256"],
        "git_source_lock_sha256": git["source_lock_sha256"], "sources": {"tokenizer_external":
        dict(source_kind="git", declared_license="MIT", evidence_urls=["https://example.invalid/license"],
             review_state="APPROVED", unresolved_obligations=[], **source)}}, "evidence_sha256")
    put(tmp_path / "tokenizer-evidence.json", evidence)
    registry = {"schema_version": 1, "policy": "synthetic-fixture-rights-v1", "sources": {
        "tokenizer_external": {"status": "APPROVED", "commercial_use_approved": True,
            "review_ref": "synthetic external source review", "declared_license": "MIT"}},
        "evidence": {"filename": "tokenizer-evidence.json", "sha256": evidence["evidence_sha256"],
            "source_lock_sha256": hf["source_lock_sha256"], "git_source_lock_filename": "tokenizer-git.json",
            "git_source_lock_sha256": git["source_lock_sha256"]}}
    rights_path = tmp_path / "tokenizer-rights.json"
    put(rights_path, registry)
    external, owned = tmp_path / "external-input.txt", tmp_path / "owned-input.swyp"
    external.write_text("Owned synthetic English math OS driver hardware protocol sample.\n", encoding="utf-8")
    owned.write_bytes(source_file.read_bytes())
    coverage = build_coverage_manifest({category: [(external, "tokenizer_external"), (owned, "tokenizer_owned")]
        for category in REQUIRED_COVERAGE}, rights_registry_path=rights_path,
        first_party_attestations=first, first_party_root=owned_root)
    put(tmp_path / "tokenizer-coverage.json", coverage)
    sample = build_sample_manifest([external, owned], source_names=["tokenizer_external", "tokenizer_owned"],
        input_sources=["tokenizer_external", "tokenizer_owned"], coverage=sorted(REQUIRED_COVERAGE),
        rights_registry_path=rights_path, source_lock_path=tmp_path / "source.json",
        git_source_lock_path=tmp_path / "tokenizer-git.json", coverage_manifest_path=tmp_path / "tokenizer-coverage.json",
        first_party_attestations=first, first_party_root=owned_root)
    put(tmp_path / "sample.json", sample)
    freeze = build_freeze_manifest(args.tokenizer, sample_manifest_path=tmp_path / "sample.json",
        rights_registry_path=rights_path, first_party_attestations=first, first_party_root=owned_root)
    put(tmp_path / "freeze.json", freeze)
    q = value["qualification"]
    q.pop("tokenizer_sample_groups")
    q.update(tokenizer_freeze_sha256=freeze["freeze_sha256"], tokenizer_freeze_file_sha256=sha(tmp_path / "freeze.json"))
    refresh(value)
    scope = contract.pilot_scope(value["qualification"], value["assignment"])
    packet_pin = pin(packet_path, packet, "attestation_sha256")
    packet_pin["attestation_scope_sha256"] = attestation_scope_sha256(packet)
    metadata = {"format": contract.FORMAT, "scope": "code-only-pilot", "promotable": False,
        "state": "ACCEPT_PRE_EXISTING_TOKENIZER", "reviewed_by": "synthetic tokenizer scope reviewer",
        "review_ref": "synthetic pilot acceptance", "pilot": scope,
        "freeze": pin(tmp_path / "freeze.json", freeze, "freeze_sha256"),
        "sample": pin(tmp_path / "sample.json", sample, "sample_manifest_sha256"),
        "coverage": pin(tmp_path / "tokenizer-coverage.json", coverage, "coverage_sha256"),
        "sources": sample["sources"], "inputs": sample["inputs"], "rights": {
            "registry": pin(rights_path), "evidence": pin(tmp_path / "tokenizer-evidence.json"),
            "source_lock": pin(tmp_path / "source.json"), "git_source_lock": pin(tmp_path / "tokenizer-git.json")},
        "first_party_attestations": {"tokenizer_owned": packet_pin}, "first_party_root": str(owned_root)}
    lineage = {name: copy.deepcopy(metadata[name]) for name in ("freeze", "sample", "coverage", "sources", "inputs",
        "rights", "first_party_attestations", "first_party_root")}
    receipt = {"format": contract.RECEIPT_FORMAT, "state": "VERIFIED_INDEPENDENT", "scope": "code-only-pilot",
        "validation_level": "tokenizer-inputs-and-heldout-provenance-v1",
        "reviewed_by": "synthetic independent lineage reviewer", "review_ref": "synthetic complete exclusions review",
        "pilot": copy.deepcopy(scope), "lineage": lineage, "excluded_groups": {
            "validation": value["assignment"]["groups"]["validation"], "sealed": value["assignment"]["groups"]["sealed"],
            "benchmarks": [digest("synthetic benchmark group")]},
        "benchmark_artifacts": [{"path": "synthetic-benchmark.jsonl", "sha256": digest("synthetic benchmark bytes")}],
        "heldout_artifacts": {split: {kind: {"path": split + suffix,
            "sha256": value["dataset"]["value"]["counts"][split][field]} for kind, suffix, field in
            (("jsonl", ".jsonl", "jsonl_sha256"), ("stream", ".bin", "stream_sha256"),
             ("metadata", ".json", "stream_metadata_sha256"))} for split in ("validation", "sealed")},
        "input_provenance": [{"path": str((tmp_path / item["filename"]).resolve()), "input": item,
                              "groups": [digest("synthetic tokenizer group " + item["source"])]} for item in sample["inputs"]]}
    result = {"launch": launch, "args": args, "value": value, "contract": metadata, "receipt": receipt,
              "sample": sample, "coverage": coverage, "freeze": freeze, "packet": packet,
              "external": external, "owned": owned, "source_file": source_file}
    save(tmp_path, result)
    return result


def save(root, f, *, update_lineage=True):
    if update_lineage:
        f["receipt"]["lineage"] = {name: copy.deepcopy(f["contract"][name]) for name in f["receipt"]["lineage"]}
    receipt = gate.seal(f["receipt"], "exclusion_sha256")
    put(root / "tokenizer-exclusions.json", receipt)
    f["contract"]["exclusion_receipt"] = pin(root / "tokenizer-exclusions.json", receipt, "exclusion_sha256")
    metadata = gate.seal(f["contract"], "contract_sha256")
    put(root / "tokenizer-contract.json", metadata)
    binding = {**pin(root / "tokenizer-contract.json", metadata, "contract_sha256"),
               "format": contract.FORMAT, "source_sha256": contract.source_sha256()}
    f["value"]["qualification"]["pre_existing_tokenizer"] = binding
    refresh(f["value"])
    save_contract(root, f["value"])
    launch = gate.read_metadata(f["launch"])["value"]
    launch["pre_existing_tokenizer"] = binding
    put(f["launch"], gate.seal(launch, "launch_sha256"))


def save_artifact_metadata(root, f):
    """Reseal synthetic metadata for adversarial fixtures, never real artifacts."""
    sample = gate.seal(f["sample"], "sample_manifest_sha256")
    coverage = gate.seal(f["coverage"], "coverage_sha256")
    put(root / "tokenizer-coverage.json", coverage)
    sample["coverage_evidence"]["sha256"] = coverage["coverage_sha256"]
    sample = gate.seal(sample, "sample_manifest_sha256")
    put(root / "sample.json", sample)
    f["freeze"]["sample"] = {**f["freeze"]["sample"], "sha256": sample["sample_manifest_sha256"],
        "sources": sample["sources"], "coverage_evidence": sample["coverage_evidence"],
        "first_party_attestations": sample["first_party_attestations"]}
    freeze = gate.seal(f["freeze"], "freeze_sha256")
    put(root / "freeze.json", freeze)
    f["contract"].update(freeze=pin(root / "freeze.json", freeze, "freeze_sha256"),
        sample=pin(root / "sample.json", sample, "sample_manifest_sha256"),
        coverage=pin(root / "tokenizer-coverage.json", coverage, "coverage_sha256"),
        sources=sample["sources"], inputs=sample["inputs"])
    f["value"]["qualification"].update(tokenizer_freeze_sha256=freeze["freeze_sha256"],
        tokenizer_freeze_file_sha256=sha(root / "freeze.json"))
    f["receipt"]["input_provenance"] = [{"path": str((root / item["filename"]).resolve()), "input": item,
        "groups": [digest("synthetic tokenizer group " + item["source"])]} for item in sample["inputs"]]
    save(root, f)


def guard_payloads(monkeypatch, root, f, *, extra_paths=()):
    original = Path.open
    original_builtin = builtins.open
    blocked = {f["external"].resolve(), f["owned"].resolve(), Path(f["args"].tokenizer).resolve(),
        Path(f["args"].tokenizer).with_suffix(".hf.json").resolve(), *(root / (split + ".bin") for split in gate.SPLITS),
        *(path.resolve() for path in extra_paths)}
    def check(path):
        if isinstance(path, (str, os.PathLike)) and Path(path).resolve() in blocked:
            pytest.fail("payload opened before metadata rejection: " + str(path))
    def guarded(path, *args, **kwargs):
        check(path)
        return original(path, *args, **kwargs)
    def guarded_builtin(path, *args, **kwargs):
        check(path)
        return original_builtin(path, *args, **kwargs)
    monkeypatch.setattr(Path, "open", guarded)
    monkeypatch.setattr(builtins, "open", guarded_builtin)


def test_independent_sources_admit_through_canonical_validator_and_bind_checkpoint(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    calls = []
    canonical = contract.validate_freeze_manifest
    def observe(*args, **kwargs):
        calls.append(kwargs)
        return canonical(*args, **kwargs)
    monkeypatch.setattr(contract, "validate_freeze_manifest", observe)
    admission = pilot.admit_metadata(f["launch"], f["args"], 1)
    assert set(f["contract"]["sources"]).isdisjoint(f["value"]["qualification"]["sources"])
    assert "tokenizer_sample_groups" not in f["value"]["qualification"]
    assert calls[0]["first_party_root"] == f["source_file"].parent
    assert calls[0]["first_party_attestations"] == {"tokenizer_owned": tmp_path / "tokenizer-attestation.json"}
    _, train_meta = trainer.load_stream(f["args"].data)
    _, val_meta = trainer.load_stream(f["args"].val_data)
    assert admission.validate_bytes(f["args"], train_meta, val_meta, sha(Path(f["args"].tokenizer)))
    checkpoint = {"qualified_pilot": admission.checkpoint_metadata(1, 4),
        "signature": {"qualified_pilot": admission.binding}, "step": 1, "tokens_seen": 4}
    admission.validate_resume(checkpoint)
    wrong = copy.deepcopy(checkpoint)
    wrong["signature"]["qualified_pilot"]["pre_existing_tokenizer"]["resolved_first_party_root"] = "wrong-root"
    with pytest.raises(ValueError, match="incompatible"):
        admission.validate_resume(wrong)
    assert admission.binding["pre_existing_tokenizer"]["lineage"]["freeze"] == f["contract"]["freeze"]
    assert admission.binding["promotable"] is False
    assert not (tmp_path / "sealed.bin").exists()


@pytest.mark.parametrize("fault", ["pending-acceptance", "unreviewed-acceptance", "pending-receipt", "unreviewed-receipt",
    "missing-receipt", "receipt-binding", "receipt-file-pin", "wrong-pilot", "wrong-attestation", "wrong-root",
    "missing-benchmark-inventory", "validation-groups", "sealed-groups", "benchmark-groups", "benchmark-hash",
    "stale-validator", "launch-binding", "unknown-version", "null-contract", "v1-groups", "wrong-cli",
    "missing-provenance", "caller-ready", "missing-heldout-inventory", "stale-heldout-inventory", "raw-heldout-path"])
def test_metadata_rejection_precedes_payload_access(tmp_path, monkeypatch, fault):
    f = fixture(tmp_path)
    metadata, receipt = f["contract"], f["receipt"]
    if fault == "pending-acceptance": metadata["state"] = "PENDING"
    elif fault == "unreviewed-acceptance": metadata["review_ref"] = ""
    elif fault == "pending-receipt": receipt["state"] = "PENDING"
    elif fault == "unreviewed-receipt": receipt["reviewed_by"] = ""
    elif fault == "wrong-pilot": metadata["pilot"]["bounds"]["max_steps"] = 99
    elif fault == "wrong-attestation": metadata["first_party_attestations"]["tokenizer_owned"]["attestation_sha256"] = "0" * 64
    elif fault == "wrong-root":
        wrong_root = tmp_path / "wrong-root"
        wrong_root.mkdir()
        metadata["first_party_root"] = str(wrong_root)
    elif fault == "missing-benchmark-inventory": receipt.pop("benchmark_artifacts")
    elif fault == "missing-heldout-inventory": receipt.pop("heldout_artifacts")
    elif fault == "stale-heldout-inventory": receipt["heldout_artifacts"]["sealed"]["jsonl"]["sha256"] = "0" * 64
    elif fault == "raw-heldout-path": receipt["heldout_artifacts"]["validation"]["jsonl"]["path"] = f["external"].name
    elif fault in ("validation-groups", "sealed-groups", "benchmark-groups"):
        split = fault.split("-")[0]
        receipt["input_provenance"][0]["groups"] = receipt["excluded_groups"]["benchmarks" if split == "benchmark" else split]
    elif fault == "benchmark-hash": receipt["benchmark_artifacts"][0]["sha256"] = f["sample"]["inputs"][0]["sha256"]
    elif fault == "v1-groups": f["value"]["qualification"]["tokenizer_sample_groups"] = f["value"]["assignment"]["groups"]["train"]
    elif fault == "wrong-cli": f["args"].tokenizer = str(tmp_path / "caller-substituted.json")
    elif fault == "missing-provenance": receipt["input_provenance"].pop()
    elif fault == "caller-ready":
        metadata["state"] = "PENDING"
        metadata["ready"] = True
        metadata["rights_approved"] = True
        monkeypatch.setenv("IMC_TOKENIZER_READY", "true")
    elif fault == "receipt-binding": receipt["lineage"]["first_party_root"] = "stale-root"
    save(tmp_path, f, update_lineage=fault != "receipt-binding")
    if fault in ("missing-receipt", "receipt-file-pin"):
        if fault == "missing-receipt": (tmp_path / "tokenizer-exclusions.json").unlink()
        else: (tmp_path / "tokenizer-exclusions.json").write_text("{}\n")
    if fault in ("stale-validator", "unknown-version", "null-contract", "launch-binding"):
        q = f["value"]["qualification"]
        if fault == "stale-validator": q["pre_existing_tokenizer"]["source_sha256"] = "0" * 64
        elif fault == "unknown-version": q["pre_existing_tokenizer"]["format"] = "unreviewed-v2"
        elif fault == "null-contract": q["pre_existing_tokenizer"] = None
        refresh(f["value"])
        save_contract(tmp_path, f["value"])
        if fault != "launch-binding":
            launch = gate.read_metadata(f["launch"])["value"]
            launch["pre_existing_tokenizer"] = q["pre_existing_tokenizer"]
            put(f["launch"], gate.seal(launch, "launch_sha256"))
        else:
            launch = gate.read_metadata(f["launch"])["value"]
            launch.pop("pre_existing_tokenizer")
            put(f["launch"], gate.seal(launch, "launch_sha256"))
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises((ValueError, OSError)):
        pilot.admit_metadata(f["launch"], f["args"], 1)


@pytest.mark.parametrize("fault", ["unknown-source", "sealed-path", "validation-hash", "benchmark-path", "unattested-ownership", "attested-source-alias"])
def test_resealed_contaminated_lineage_is_rejected_before_input_open(tmp_path, monkeypatch, fault):
    f = fixture(tmp_path)
    if fault == "unknown-source":
        f["sample"]["sources"][0] = "unknown"
        f["coverage"]["sources"][0] = "unknown"
        f["sample"]["inputs"][0]["source"] = "unknown"
        for category in f["coverage"]["coverage"].values(): category["files"][0]["source"] = "unknown"
    elif fault in ("unattested-ownership", "attested-source-alias"):
        packet = copy.deepcopy(f["packet"])
        if fault == "unattested-ownership": packet["ownership_attested"] = False
        else:
            packet["files"] = [{"path": "validation.bin", "sha256": f["value"]["dataset"]["value"]["counts"]["validation"]["stream_sha256"]}]
            f["contract"]["first_party_root"] = str(tmp_path)
        packet = gate.seal(packet, "attestation_sha256")
        put(tmp_path / "tokenizer-attestation.json", packet)
        identity = {"filename": "tokenizer-attestation.json", "file_sha256": sha(tmp_path / "tokenizer-attestation.json"),
            "attestation_sha256": packet["attestation_sha256"], "attestation_scope_sha256": attestation_scope_sha256(packet)}
        f["sample"]["first_party_attestations"]["tokenizer_owned"] = identity
        f["coverage"]["first_party_attestations"]["tokenizer_owned"] = identity
        f["contract"]["first_party_attestations"]["tokenizer_owned"] = {"path": identity["filename"], **{k: v for k, v in identity.items() if k != "filename"}}
    else:
        entry = f["sample"]["inputs"][0]
        if fault == "sealed-path": entry["filename"] = "sealed.bin"
        elif fault == "validation-hash": entry["sha256"] = f["value"]["dataset"]["value"]["counts"]["validation"]["jsonl_sha256"]
        elif fault == "benchmark-path": entry["filename"] = "synthetic-benchmark.jsonl"
        for category in f["coverage"]["coverage"].values(): category["files"][0].update(entry)
    save_artifact_metadata(tmp_path, f)
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises(ValueError): pilot.admit_metadata(f["launch"], f["args"], 1)


def test_hardlink_alias_to_sealed_payload_rejected_without_open(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    sealed = tmp_path / "sealed.bin"
    sealed.write_bytes(f["external"].read_bytes())
    f["external"].unlink()
    os.link(sealed, f["external"])
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises(ValueError, match="artifact cannot be opened"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


def test_symlink_alias_to_validation_payload_rejected_without_open(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    f["external"].unlink()
    f["external"].symlink_to(tmp_path / "validation.bin")
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises(ValueError, match="artifact cannot be opened"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


@pytest.mark.parametrize("artifact", ["ilarialex.json", "ilarialex.hf.json"])
@pytest.mark.parametrize("fault", ["benchmark-hardlink", "benchmark-hash", "heldout-alias"])
def test_tokenizer_and_companion_exclusions_precede_all_payload_reads(tmp_path, monkeypatch, artifact, fault):
    f = fixture(tmp_path)
    path = tmp_path / artifact
    benchmark = tmp_path / "inventoried-benchmark.jsonl"
    if fault == "heldout-alias":
        path.unlink()
        path.symlink_to(tmp_path / "validation.bin")
    else:
        if fault == "benchmark-hardlink": os.link(path, benchmark)
        else: benchmark.write_bytes(path.read_bytes())
        f["receipt"]["benchmark_artifacts"].append({"path": benchmark.name, "sha256": sha(benchmark)})
    save(tmp_path, f)
    guard_payloads(monkeypatch, tmp_path, f, extra_paths=(f["source_file"], benchmark))
    with pytest.raises(ValueError, match="tokenizer payload/companion.*excluded"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


def test_implicit_companion_is_derived_before_resolving_tokenizer_alias(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    tokenizer_alias = tmp_path / "tokenizer-link.json"
    tokenizer_alias.symlink_to(tmp_path / "ilarialex.json")
    companion = tokenizer_alias.with_suffix(".hf.json")
    companion.write_bytes((tmp_path / "ilarialex.hf.json").read_bytes())
    benchmark = tmp_path / "aliased-companion-benchmark.jsonl"
    os.link(companion, benchmark)
    f["freeze"]["tokenizer"].update(filename=tokenizer_alias.name, hf_filename=companion.name)
    f["args"].tokenizer = str(tokenizer_alias)
    f["receipt"]["benchmark_artifacts"].append({"path": benchmark.name, "sha256": sha(benchmark)})
    save_artifact_metadata(tmp_path, f)
    guard_payloads(monkeypatch, tmp_path, f, extra_paths=(f["source_file"], companion, benchmark))
    with pytest.raises(ValueError, match="tokenizer payload/companion.*excluded"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


@pytest.mark.parametrize("fault", ["pending-rights", "pending-evidence", "obligations", "commercial-use"])
def test_tokenizer_source_approvals_remain_authoritative(tmp_path, monkeypatch, fault):
    f = fixture(tmp_path)
    registry = gate.read_metadata(tmp_path / "tokenizer-rights.json")["value"]
    evidence = gate.read_metadata(tmp_path / "tokenizer-evidence.json")["value"]
    if fault == "pending-rights": registry["sources"]["tokenizer_external"]["status"] = "REVIEW_REQUIRED"
    elif fault == "commercial-use": registry["sources"]["tokenizer_external"]["commercial_use_approved"] = False
    elif fault == "pending-evidence": evidence["sources"]["tokenizer_external"]["review_state"] = "EVIDENCE_COLLECTED"
    elif fault == "obligations": evidence["sources"]["tokenizer_external"]["unresolved_obligations"] = ["synthetic unresolved notice"]
    evidence = gate.seal(evidence, "evidence_sha256")
    put(tmp_path / "tokenizer-evidence.json", evidence)
    registry["evidence"]["sha256"] = evidence["evidence_sha256"]
    put(tmp_path / "tokenizer-rights.json", registry)
    f["contract"]["rights"]["registry"] = pin(tmp_path / "tokenizer-rights.json")
    f["contract"]["rights"]["evidence"] = pin(tmp_path / "tokenizer-evidence.json")
    f["sample"]["rights"]["sha256"] = sha(tmp_path / "tokenizer-rights.json")
    f["coverage"]["rights"] = copy.deepcopy(f["sample"]["rights"])
    f["freeze"]["rights"] = copy.deepcopy(f["sample"]["rights"])
    save_artifact_metadata(tmp_path, f)
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises(ValueError, match="not approved|not APPROVED|unresolved rights obligations"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


def test_mutated_attested_source_rejected_before_sample_or_tokenizer_open(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    f["source_file"].write_text("record MutatedSynthetic {}\n")
    guard_payloads(monkeypatch, tmp_path, f)
    with pytest.raises(ValueError, match="attested file hash mismatch"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


@pytest.mark.parametrize("artifact", ["external-input.txt", "ilarialex.json", "ilarialex.hf.json"])
def test_artifact_drift_between_admission_and_compute_is_rejected(tmp_path, artifact):
    f = fixture(tmp_path)
    admission = pilot.admit_metadata(f["launch"], f["args"], 1)
    path = tmp_path / artifact
    path.write_bytes(path.read_bytes() + b"mutated")
    with pytest.raises((ValueError, json.JSONDecodeError)):
        admission.validate_bytes(f["args"], admission.streams["train"]["value"],
            admission.streams["validation"]["value"], f["value"]["qualification"]["tokenizer_sha256"])


def test_canonical_result_must_still_match_preflight_freeze(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    canonical = contract.validate_freeze_manifest
    def substitute(*args, **kwargs):
        result = canonical(*args, **kwargs)
        return gate.seal(dict(result, unexpected="synthetic replacement"), "freeze_sha256")
    monkeypatch.setattr(contract, "validate_freeze_manifest", substitute)
    with pytest.raises(ValueError, match="changed during canonical validation"):
        pilot.admit_metadata(f["launch"], f["args"], 1)


def test_pending_contract_fails_canonical_entry_before_stream_cuda_ddp_model(tmp_path, monkeypatch, capsys):
    f = fixture(tmp_path)
    f["receipt"]["state"] = "PENDING"
    save(tmp_path, f)
    monkeypatch.setattr("sys.argv", cli(f["launch"], f["args"], tmp_path / "out"))
    monkeypatch.setattr(trainer, "load_stream", lambda *_: pytest.fail("stream opened"))
    monkeypatch.setattr(torch.cuda, "is_available", lambda: pytest.fail("CUDA queried"))
    monkeypatch.setattr(torch.distributed, "init_process_group", lambda *a, **k: pytest.fail("DDP initialized"))
    monkeypatch.setattr(trainer, "ImcTransformer", lambda *_: pytest.fail("model allocated"))
    with pytest.raises(SystemExit) as raised: trainer.main()
    assert raised.value.code == 2
    assert "explicit reviewed" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


def test_v1_remains_train_group_only_and_unknown_contract_never_falls_back(tmp_path):
    launch, args, value = pilot_fixture(tmp_path)
    assert "pre_existing_tokenizer" not in pilot.admit_metadata(launch, args, 1).binding
    value["qualification"].pop("tokenizer_sample_groups")
    refresh(value)
    save_contract(tmp_path, value)
    with pytest.raises(ValueError, match="train-only group provenance"):
        pilot.admit_metadata(launch, args, 1)


def test_canonical_cpu_loop_persists_pre_existing_pins_without_resume_authority(tmp_path, monkeypatch):
    f = fixture(tmp_path)
    out = tmp_path / "out"
    monkeypatch.setattr("sys.argv", cli(f["launch"], f["args"], out))
    monkeypatch.setattr(pilot.Admission, "require_supervision", lambda self: None)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    torch.set_num_threads(1)
    trainer.main()
    checkpoint = torch.load(out / "checkpoint.pt", map_location="cpu", weights_only=True)
    pin_record = checkpoint["signature"]["qualified_pilot"]["pre_existing_tokenizer"]
    assert pin_record == checkpoint["qualified_pilot"]["binding"]["pre_existing_tokenizer"]
    assert pin_record["resolved_first_party_root"] == str(f["source_file"].parent)
    assert pin_record["lineage"]["freeze"] == f["contract"]["freeze"]
    f["args"].resume = str(out / "checkpoint.pt")
    with pytest.raises(ValueError, match="completed prior owned-scope receipt"):
        pilot.admit_metadata(f["launch"], f["args"], 1)
