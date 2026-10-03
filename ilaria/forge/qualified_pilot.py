"""Admission and cooperative accounting for the canonical NON_PROMOTABLE IMC pilot.

This module confers neither rights approval nor compute allocation authority.
Its hard-wall entry is deliberately closed until a reviewed tree supervisor is
bound to the canonical child. It contains no training loop or platform killer.
"""
from __future__ import annotations

import hashlib
import argparse
import importlib.util
import json
import math
import os
import sys
import time
from pathlib import Path

import training_launch_gate as gate
from data_contract import require_lower_sha256
from model_manifest import load_tokenizer_identity
from rights_evidence import load_and_validate_evidence
from tokenizer_freeze import FREEZE_FORMAT, SAMPLE_FORMAT, validate_freeze_manifest
import qualified_tokenizer_contract as tokenizer_contract
from workspace_paths import benchmark_root

FORMAT = "ilaria-qualified-code-pilot-adapter-v1"
LAUNCH_FORMAT = "ilaria-qualified-code-pilot-launch-v1"
RUN_FORMAT = "ilaria-qualified-code-pilot-run-v1"
SUPERVISION_UNVERIFIED = "qualified pilot hard-wall tree supervision is UNVERIFIED; launch refused"
# Root-reviewed source release, never supplied by launch metadata/environment.
# Linux owned-scope proof is separate from canonical Torch/GPU qualification.
SUPERVISOR_SOURCE_PINS = {
    "probe.py": "b4a8b09d36d45449b440dfc393f1ae20f9ab204747a705d98f961e83e3cdc704",
    "containment.py": "2f211d79b9e92c6e32f864e4d37d1e8bf7568c38fb2f0a0ad41d25278cfd7894",
}


def _shared_supervisor():
    root = benchmark_root(Path(__file__).resolve().parent.parent) / "imc_nccl_bootstrap"
    if set(SUPERVISOR_SOURCE_PINS) != {"probe.py", "containment.py"}:
        raise ValueError(SUPERVISION_UNVERIFIED)
    verified = {}
    for filename, expected in SUPERVISOR_SOURCE_PINS.items():
        require_lower_sha256(filename, expected)
        path = root / filename
        raw = path.read_bytes()
        if path.is_symlink() or hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("qualified pilot supervisor source release differs")
        verified[filename] = raw
    loaded = []
    for name in ("containment", "probe"):
        path = root / (name + ".py")
        existing = sys.modules.get(name)
        if existing is not None and (Path(existing.__file__).resolve() != path.resolve() or
                getattr(existing, "_qualified_pilot_loaded_sha256", None) != SUPERVISOR_SOURCE_PINS[name + ".py"]):
            raise ValueError("qualified pilot supervisor module identity differs; a fresh pinned import is required")
        if existing is None:
            spec = importlib.util.spec_from_file_location(name, path)
            existing = importlib.util.module_from_spec(spec)
            sys.modules[name] = existing
            exec(compile(verified[name + ".py"], str(path), "exec"), existing.__dict__)
            existing._qualified_pilot_loaded_sha256 = SUPERVISOR_SOURCE_PINS[name + ".py"]
        loaded.append(existing)
    return tuple(loaded)


def supervise_canonical(canonical_args, *, world_size, deadline, log_path):
    """Own an exact canonical invocation through the reviewed shared supervisor.

    Returns its full cleanup receipt. It grants no data/rights/GPU/allocation
    approval. Qualified resume is refused until a prior full-scope receipt is
    part of the reviewed launch contract.
    """
    if os.name != "posix" or type(world_size) is not int or not 1 <= world_size <= 64:
        raise ValueError("qualified pilot supervised entry requires reviewed Linux containment")
    if not isinstance(canonical_args, list) or not all(isinstance(arg, str) and "\0" not in arg for arg in canonical_args):
        raise ValueError("canonical trainer arguments must be an explicit string list")
    parser = argparse.ArgumentParser(add_help=False)
    for name in ("data", "out", "qualified-pilot"):
        parser.add_argument("--" + name, required=True)
    for name in ("val-data", "tokenizer", "tokenizer-freeze", "dataset-manifest", "resume", "init-from"):
        parser.add_argument("--" + name, default="")
    for name in ("allow-unmanifested-data", "allow-internal-val-split"):
        parser.add_argument("--" + name, action="store_true")
    for name, default in (("ctx", 512), ("batch", 16), ("accum", 1), ("steps", 3000), ("target-tokens", 0), ("sample-tokens", 30)):
        parser.add_argument("--" + name, type=int, default=default)
    args, _ = parser.parse_known_args(canonical_args)
    if min(args.ctx, args.batch, args.accum, args.steps) <= 0 or args.target_tokens < 0:
        raise ValueError("qualified pilot token geometry/horizon must be positive")
    if args.target_tokens:
        args.steps = math.ceil(args.target_tokens / (args.ctx * args.batch * args.accum * world_size))
    admission = admit_metadata(args.qualified_pilot, args, world_size)
    containment, probe = _shared_supervisor()
    worker = Path(__file__).with_name("train_ilaria.py").resolve()
    binding = {"config_identity_sha256": admission.binding["launch_sha256"], "worker_source_path": str(worker),
               "worker_source_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
               "worker_argv_sha256": _argv_sha256([sys.executable, "-u", str(worker), *canonical_args])}
    remaining = admission.binding["bounds"]["max_wall_seconds"] - admission.check()
    limits = probe.Limits(deadline=deadline, max_wall_seconds=remaining, phase_timeout_seconds=remaining,
                          teardown_seconds=min(10.0, remaining / 4))
    supervisor = probe.Supervisor(limits, containment_binding=binding)
    if supervisor.remaining() <= limits.teardown_seconds:
        raise ValueError("qualified pilot deadline has no remaining launch/cleanup allowance")
    capability = supervisor.strict_capability()
    if (capability.get("format") != "imc-supervisor-capability-v1" or
            capability.get("capability_version") != "linux-subreaper-pidfd-v1" or
            capability.get("source_sha256") != SUPERVISOR_SOURCE_PINS or capability.get("readiness_verified") is not True):
        raise ValueError(SUPERVISION_UNVERIFIED)
    argv = [sys.executable, "-m", "torch.distributed.run", "--standalone", "--nnodes=1",
            f"--nproc-per-node={world_size}", str(worker), *canonical_args]
    return supervisor.run(argv, cwd=str(worker.parent), log_path=log_path)


def source_sha256():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _argv_sha256(argv):
    return hashlib.sha256(json.dumps(argv, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _path(root, value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("pilot metadata requires an explicit path")
    target = Path(value)
    if not target.is_absolute():
        target = root / target
    return target.resolve()


def _identity(value, field, expected):
    if value.get("format") != expected or gate.identity(value, field) != value.get(field):
        raise ValueError(f"unsupported or obsolete {expected} identity")


def admit_metadata(launch_path, args, world, *, monotonic=time.monotonic):
    """Read JSON provenance before opening token streams or acquiring compute."""
    started = monotonic()
    launch_path = Path(launch_path).resolve()
    launch = gate.read_metadata(launch_path)["value"]
    _identity(launch, "launch_sha256", LAUNCH_FORMAT)
    root = launch_path.parent
    names = ("dataset", "qualification", "decision", "assignment", "validation_receipt",
             "rights_registry", "rights_evidence", "source_lock", "git_source_lock")
    paths = {name: _path(root, launch.get(name)) for name in names}
    paths["streams"] = {split: _path(root, launch.get("streams", {}).get(split)) for split in gate.SPLITS}
    all_paths = list(paths["streams"].values())
    if len(set(all_paths)) != 3:
        raise ValueError("pilot train, validation and sealed metadata paths must be distinct")
    records = {name: gate.read_metadata(paths[name]) for name in names}
    streams = {split: gate.read_metadata(path) for split, path in paths["streams"].items()}
    rights_pins = {field: records[name]["file_sha256"] for field, name in (
        ("registry_file_sha256", "rights_registry"), ("evidence_file_sha256", "rights_evidence"),
        ("source_lock_file_sha256", "source_lock"), ("git_lock_file_sha256", "git_source_lock"))}
    evidence = load_and_validate_evidence(
        paths["rights_evidence"], source_lock_path=paths["source_lock"],
        rights_registry_path=paths["rights_registry"], git_source_lock_path=paths["git_source_lock"])
    report = gate.assess_launch(
        mode="code-only-pilot", dataset=records["dataset"], streams=streams,
        qualification=records["qualification"]["value"], decision=records["decision"]["value"],
        assignment=records["assignment"]["value"], validation_receipt=records["validation_receipt"]["value"],
        registry=records["rights_registry"]["value"], evidence=evidence, rights_pins=rights_pins)
    if not report["data_qualified"]:
        raise ValueError("qualified pilot data rejected: " + "; ".join(report["blockers"]))
    expected_placeholder = ["trainer:qualified-pilot-adapter-not-integrated; canonical trainer rejects custom package"]
    if (report.get("promotable") is not False or report.get("allocation_authorized") is not False or
            report.get("blockers") != expected_placeholder):
        raise ValueError("qualified pilot metadata gate has an unresolved or unsupported admission blocker")
    if args.dataset_manifest or args.allow_unmanifested_data or args.allow_internal_val_split or args.init_from:
        raise ValueError("qualified pilot cannot combine production, unmanifested, internal split or warm-start admission")
    if getattr(args, "resume", ""):
        raise ValueError("qualified pilot resume requires a completed prior owned-scope receipt; cumulative hard-wall authority is unavailable")
    if not args.val_data or not args.tokenizer or not args.tokenizer_freeze:
        raise ValueError("qualified pilot requires explicit validation, tokenizer and freeze paths")
    for split, prefix in (("train", args.data), ("validation", args.val_data)):
        if Path(str(prefix) + ".json").resolve() != paths["streams"][split]:
            raise ValueError(f"CLI {split} stream does not match qualified metadata")
    # Resolve aliases before either canonical load_stream opens a binary.
    binaries = [path.with_suffix(".bin").resolve() for path in all_paths]
    if len(set(binaries)) != 3:
        raise ValueError("sealed/train/validation stream binary paths overlap")
    q = records["qualification"]["value"]
    expected_adapter = {"format": FORMAT, "source_sha256": source_sha256()}
    if q.get("trainer_adapter") != expected_adapter:
        raise ValueError("obsolete or unbound qualified pilot trainer adapter")
    contract_binding = q.get("pre_existing_tokenizer")
    if "pre_existing_tokenizer" in q or "pre_existing_tokenizer" in launch:
        if not isinstance(contract_binding, dict) or launch.get("pre_existing_tokenizer") != contract_binding:
            raise ValueError("qualification/launch pre-existing tokenizer contract binding differs")
    else:
        sample_groups = q.get("tokenizer_sample_groups")
        train_groups = records["assignment"]["value"]["groups"]["train"]
        if (not isinstance(sample_groups, list) or not sample_groups or
                len(set(sample_groups)) != len(sample_groups) or not set(sample_groups) <= set(train_groups)):
            raise ValueError("tokenizer sample must have reviewed train-only group provenance")
    for field in ("tokenizer_freeze_sha256", "tokenizer_freeze_file_sha256"):
        require_lower_sha256(field, q.get(field, ""))
    freeze_path = Path(args.tokenizer_freeze).resolve()
    freeze = gate.read_metadata(freeze_path)
    _identity(freeze["value"], "freeze_sha256", FREEZE_FORMAT)
    if (freeze["file_sha256"] != q["tokenizer_freeze_file_sha256"] or
            freeze["value"].get("freeze_sha256") != q["tokenizer_freeze_sha256"]):
        raise ValueError("qualified tokenizer freeze identity differs")
    sample_path = _path(freeze_path.parent, freeze["value"].get("sample", {}).get("filename"))
    sample = gate.read_metadata(sample_path)["value"]
    _identity(sample, "sample_manifest_sha256", SAMPLE_FORMAT)
    if sample["sample_manifest_sha256"] != freeze["value"]["sample"].get("sha256"):
        raise ValueError("qualified tokenizer sample identity differs before sample bytes are opened")
    sealed = records["dataset"]["value"]["counts"]["sealed"]
    forbidden = {sealed["jsonl_sha256"], sealed["stream_sha256"]}
    for entry in sample.get("inputs", []):
        input_path = _path(sample_path.parent, entry.get("filename"))
        if entry.get("sha256") in forbidden or input_path in {binaries[2], all_paths[2].with_suffix(".jsonl")}:
            raise ValueError("sealed artifact cannot be opened for tokenizer training/selection")
    bounds = q["bounds"]
    per_step = args.ctx * args.batch * args.accum * world
    if args.steps > bounds["max_steps"] or args.steps * per_step > bounds["max_train_tokens"]:
        raise ValueError("resolved global training horizon exceeds qualified steps/tokens budget")
    if args.sample_tokens:
        raise ValueError("qualified pilot disables post-training sampling outside the reviewed budget")
    pre_existing = None
    if contract_binding is not None:
        context = (contract_binding, root, q, records["assignment"]["value"],
                   records["dataset"]["value"], paths["streams"])
        contract_pin, _ = tokenizer_contract.admit_contract(
            context[0], context[1], args, *context[2:])
        pre_existing = (context, contract_pin)
    binding = {"format": FORMAT, "status": gate.PILOT_STATUS, "promotable": False,
               "launch_sha256": launch["launch_sha256"], "qualification_sha256": q["qualification_sha256"],
               "decision_sha256": records["decision"]["value"]["decision_sha256"],
               "dataset_identity_sha256": records["dataset"]["value"]["package_sha256"],
               "adapter_source_sha256": source_sha256(), "bounds": dict(bounds),
               "world_size": world, "tokens_per_step": per_step}
    if pre_existing is not None:
        binding["pre_existing_tokenizer"] = pre_existing[1]
    return Admission(paths, streams, q, binding, started, monotonic, pre_existing=pre_existing)


class Admission:
    def __init__(self, paths, streams, qualification, binding, started, monotonic, *, pre_existing=None):
        self.paths, self.streams, self.qualification = paths, streams, qualification
        self.binding, self.started, self.monotonic = binding, started, monotonic
        self.prior_wall_seconds = 0.0
        self.pre_existing = pre_existing

    def check(self, *, step=0, tokens=0, reserve_tokens=0):
        elapsed = self.prior_wall_seconds + self.monotonic() - self.started
        bounds = self.binding["bounds"]
        if not math.isfinite(elapsed) or elapsed < 0 or elapsed >= bounds["max_wall_seconds"]:
            raise ValueError("qualified pilot cooperative wall budget exhausted")
        if (type(step) is not int or type(tokens) is not int or type(reserve_tokens) is not int or
                min(step, tokens, reserve_tokens) < 0 or step > bounds["max_steps"] or
                tokens + reserve_tokens > bounds["max_train_tokens"]):
            raise ValueError("qualified pilot global steps/tokens budget exhausted")
        return elapsed

    def validate_bytes(self, args, train_meta, val_meta, tokenizer_sha256):
        for split, actual in (("train", train_meta), ("validation", val_meta)):
            if actual != self.streams[split]["value"]:
                raise ValueError(f"canonical {split} stream metadata changed after qualification")
        if tokenizer_sha256 != self.qualification["tokenizer_sha256"]:
            raise ValueError("qualified tokenizer byte identity differs")
        identity = load_tokenizer_identity(args.tokenizer)
        if identity["sha256"] != tokenizer_sha256:
            raise ValueError("canonical tokenizer identity differs")
        if self.pre_existing is not None:
            context, pin = self.pre_existing
            current_pin, freeze = tokenizer_contract.admit_contract(
                context[0], context[1], args, *context[2:])
            if current_pin != pin:
                raise ValueError("pre-existing tokenizer launch binding changed after admission")
            self.check()
            return freeze["freeze_sha256"]
        freeze = validate_freeze_manifest(args.tokenizer_freeze, rights_registry_path=self.paths["rights_registry"])
        if freeze["freeze_sha256"] != self.qualification["tokenizer_freeze_sha256"]:
            raise ValueError("canonical tokenizer freeze identity differs")
        # Source locks in the freeze must be the same reviewed identities, not an unrelated freeze.
        sample = freeze.get("sample", {})
        covered = set()
        for name in ("source_lock", "git_source_lock"):
            record = sample.get(name)
            if record is None:
                continue
            expected = gate.read_metadata(self.paths[name])["value"]["source_lock_sha256"]
            if record.get("identity_sha256") != expected:
                raise ValueError(f"tokenizer freeze {name} differs from reviewed qualification")
            covered.update(record.get("sources", {}))
        if not set(self.qualification["sources"]) <= covered:
            raise ValueError("tokenizer freeze has no reviewed pilot source lock")
        self.check()
        return freeze["freeze_sha256"]

    def validate_resume(self, checkpoint):
        # Internal compatibility/accounting check only. It cannot confer resume
        # admission: full completed-scope elapsed/cleanup receipt is required.
        if (not isinstance(checkpoint, dict) or checkpoint.get("qualified_pilot", {}).get("binding") != self.binding or
                checkpoint.get("signature", {}).get("qualified_pilot") != self.binding):
            raise ValueError("obsolete/unmanifested or incompatible qualified pilot checkpoint")
        step, tokens = checkpoint.get("step"), checkpoint.get("tokens_seen")
        if type(step) is not int or type(tokens) is not int or tokens != step * self.binding["tokens_per_step"]:
            raise ValueError("qualified pilot checkpoint global token/step counters differ")
        elapsed = checkpoint["qualified_pilot"].get("wall_seconds")
        if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
            raise ValueError("qualified pilot checkpoint wall accounting is invalid")
        self.prior_wall_seconds = float(elapsed)
        self.check(step=step, tokens=tokens)

    def checkpoint_metadata(self, step, tokens):
        return {"binding": self.binding, "wall_seconds": self.check(step=step, tokens=tokens)}

    def require_supervision(self):
        if os.name != "posix":
            raise ValueError(SUPERVISION_UNVERIFIED + "; reviewed Linux containment required")
        containment, _ = _shared_supervisor()
        worker = Path(__file__).with_name("train_ilaria.py").resolve()
        try:
            receipt = containment.assert_current_containment(
                expected_config_identity=self.binding["launch_sha256"], expected_source_sha256=SUPERVISOR_SOURCE_PINS,
                expected_worker_source_sha256=hashlib.sha256(worker.read_bytes()).hexdigest(),
                expected_worker_source_path=str(worker), required_remaining_seconds=0)
        except (OSError, ValueError) as exc:
            raise ValueError(SUPERVISION_UNVERIFIED + "; " + str(exc)) from exc
        if receipt.get("capability_version") != "linux-subreaper-pidfd-v1":
            raise ValueError(SUPERVISION_UNVERIFIED)
        if receipt.get("worker_argv_sha256") != _argv_sha256([sys.executable, "-u", str(worker), *sys.argv[1:]]):
            raise ValueError("qualified pilot supervised worker argv differs")
        self.check()
        return receipt
