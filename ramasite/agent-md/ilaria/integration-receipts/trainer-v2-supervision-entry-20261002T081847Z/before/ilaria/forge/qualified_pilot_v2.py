"""Admission for the clean split-before-tokenizer NON_PROMOTABLE code pilot.

This adapter is deliberately versioned separately from qualified_pilot v1.  It
does not reinterpret the historical tokenizer freeze and it never grants
production promotion or cloud/GPU allocation authority.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

from data_contract import require_approved_rights, require_lower_sha256
from model_manifest import load_tokenizer_identity
from qualified_pilot import Admission
from rights_evidence import load_and_validate_evidence, require_approved_evidence
import training_launch_gate as gate


FORMAT = "ilaria-qualified-clean-code-pilot-adapter-v2"
LAUNCH_FORMAT = "ilaria-qualified-clean-code-pilot-launch-v2"
DECISION_FORMAT = "ilaria-qualified-clean-code-pilot-decision-v1"
RUN_FORMAT = "ilaria-qualified-clean-code-pilot-run-v2"
PACKAGE_FORMAT = "ilaria-clean-code-pilot-v2"
CORPUS_FORMAT = "ilaria-clean-code-split-before-tokenizer-v1"
TOKENIZER_BINDING_FORMAT = "ilarialex-clean-code-pilot-binding-v1"
REPLAY_FORMAT = "ilaria-clean-code-v2-independent-replay-v1"
STATUS = "NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION"
SPLITS = ("train", "validation", "sealed")
APPROVED_LOCAL_STATE = "APPROVE_NONPROMOTABLE_LOCAL_SCALE_VALIDATION"
MAX_METADATA_BYTES = 1 << 20


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_sha256() -> str:
    return _sha256_file(Path(__file__))


def _path(root: Path, value) -> Path:
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("clean pilot requires an explicit path")
    path = Path(value)
    return (path if path.is_absolute() else root / path).resolve()


def _identity(value: dict, field: str, expected_format: str) -> None:
    if not isinstance(value, dict) or value.get("format") != expected_format:
        raise ValueError(f"unsupported {expected_format} metadata")
    require_lower_sha256(field, value.get(field, ""))
    if gate.identity(value, field) != value[field]:
        raise ValueError(f"{field} identity mismatch")


def _read(path: Path) -> dict:
    record = gate.read_metadata(path)
    if path.stat().st_size > MAX_METADATA_BYTES:
        raise ValueError("clean pilot metadata byte limit exceeded")
    return record


def _record(root: Path, pin, *, identity_field=None, expected_format=None):
    if not isinstance(pin, dict):
        raise ValueError("clean pilot metadata pin is missing")
    path = _path(root, pin.get("path"))
    require_lower_sha256("file_sha256", pin.get("file_sha256", ""))
    record = _read(path)
    if record["file_sha256"] != pin["file_sha256"]:
        raise ValueError("clean pilot metadata file pin differs")
    if identity_field is not None:
        if not isinstance(expected_format, str):
            raise ValueError("clean pilot metadata identity format is missing")
        _identity(record["value"], identity_field, expected_format)
        if pin.get(identity_field) != record["value"][identity_field]:
            raise ValueError("clean pilot metadata identity pin differs")
    return path, record


def _distinct(paths, message: str) -> None:
    resolved = [Path(path).resolve() for path in paths]
    if len(set(resolved)) != len(resolved):
        raise ValueError(message)
    for index, left in enumerate(resolved):
        for right in resolved[index + 1:]:
            if left.exists() and right.exists() and os.path.samefile(left, right):
                raise ValueError(message)


def _validate_groups(corpus: dict, package: dict, binding: dict) -> None:
    groups = corpus.get("groups")
    if not isinstance(groups, dict) or set(groups) != set(SPLITS):
        raise ValueError("clean pilot requires explicit train/validation/sealed groups")
    seen = set()
    for split in SPLITS:
        values = groups[split]
        if not isinstance(values, list) or not values or len(values) != len(set(values)):
            raise ValueError(f"clean pilot {split} group inventory is invalid")
        if seen.intersection(values):
            raise ValueError("clean pilot group identities overlap across splits")
        seen.update(values)
        if package.get("group_counts", {}).get(split) != len(values):
            raise ValueError(f"clean pilot {split} group count differs")
    excluded = corpus.get("benchmark_groups_excluded")
    if not isinstance(excluded, list) or len(excluded) != len(set(excluded)):
        raise ValueError("clean pilot benchmark exclusion inventory is invalid")
    if seen.intersection(excluded):
        raise ValueError("benchmark-excluded group remains in a train/heldout split")
    if binding.get("sample_groups") != groups["train"]:
        raise ValueError("tokenizer sample groups are not exactly the clean train groups")


def _validate_streams(package: dict, corpus: dict, stream_records: dict, stream_paths: dict) -> None:
    counts = package.get("counts")
    if not isinstance(counts, dict) or set(counts) != set(SPLITS):
        raise ValueError("clean pilot package split inventory differs")
    corpus_counts = corpus.get("counts")
    if not isinstance(corpus_counts, dict) or set(corpus_counts) != set(SPLITS):
        raise ValueError("clean corpus split inventory differs")
    metadata_paths = [stream_paths[split] for split in SPLITS]
    binary_paths = [stream_paths[split].with_suffix(".bin") for split in SPLITS]
    _distinct(metadata_paths, "clean pilot stream metadata paths overlap")
    _distinct(binary_paths, "clean pilot stream binary paths overlap")
    stream_hashes = set()
    metadata_hashes = set()
    for split in SPLITS:
        entry = counts[split]
        meta_record = stream_records[split]
        meta = meta_record["value"]
        for field in ("stream_sha256", "metadata_sha256", "tokenizer_sha256"):
            require_lower_sha256(f"{split}:{field}", entry.get(field, ""))
        for field in ("documents", "tokens", "stream_bytes", "vocab_size", "eos_id", "protocol_start_id"):
            if type(entry.get(field)) is not int or entry[field] <= 0:
                raise ValueError(f"{split}:{field} must be a positive integer")
        if (entry["tokenizer_sha256"] != package.get("tokenizer_sha256") or
                meta_record["file_sha256"] != entry["metadata_sha256"] or
                meta.get("format") != "ilaria-token-stream-v1" or
                meta.get("dtype") != "uint16" or meta.get("byte_level") is not True or
                meta.get("tokenizer_sha256") != entry["tokenizer_sha256"] or
                meta.get("stream_sha256") != entry["stream_sha256"] or
                meta.get("tokens") != entry["tokens"] or
                meta.get("documents") != entry["documents"] or
                meta.get("vocab_size") != entry["vocab_size"] or
                meta.get("eos_id") != entry["eos_id"] or
                meta.get("protocol_start_id") != entry["protocol_start_id"] or
                entry["stream_bytes"] != 2 * entry["tokens"]):
            raise ValueError(f"{split}:clean stream metadata binding mismatch")
        if corpus_counts[split].get("documents") != entry["documents"]:
            raise ValueError(f"{split}:corpus/package document count differs")
        minimum = package.get("minimum_tokens", {}).get(split)
        if type(minimum) is not int or minimum <= 0 or entry["tokens"] < minimum:
            raise ValueError(f"{split}:clean token minimum is invalid or unmet")
        binary = stream_paths[split].with_suffix(".bin")
        if not binary.is_file() or binary.stat().st_size != entry["stream_bytes"]:
            raise ValueError(f"{split}:clean token stream bytes differ")
        # The training process must never ingest the sealed payload.  Its exact
        # bytes are certified by the separately pinned replay receipt; here we
        # only establish a distinct path/inode and expected size.
        if split != "sealed" and _sha256_file(binary) != entry["stream_sha256"]:
            raise ValueError(f"{split}:clean token stream hash differs")
        stream_hashes.add(entry["stream_sha256"])
        metadata_hashes.add(entry["metadata_sha256"])
    if len(stream_hashes) != 3 or len(metadata_hashes) != 3:
        raise ValueError("clean train/validation/sealed stream identities overlap")


def _validate_rights(corpus: dict, source_names, rights_paths: dict, rights_records: dict) -> None:
    expected = corpus.get("rights")
    if not isinstance(expected, dict):
        raise ValueError("clean corpus rights binding is missing")
    mapping = {
        "rights_registry": "rights_sha256",
        "rights_evidence": "evidence_sha256",
        "source_lock": "source_lock_sha256",
        "git_source_lock": "git_lock_sha256",
    }
    for name, field in mapping.items():
        if rights_records[name]["file_sha256"] != expected.get(field):
            raise ValueError(f"clean corpus {name} file hash differs")
    evidence = load_and_validate_evidence(
        rights_paths["rights_evidence"],
        source_lock_path=rights_paths["source_lock"],
        rights_registry_path=rights_paths["rights_registry"],
        git_source_lock_path=rights_paths["git_source_lock"],
    )
    registry = rights_records["rights_registry"]["value"]
    require_approved_rights(registry, sorted(source_names))
    require_approved_evidence(registry, evidence, sorted(source_names))
    for name in source_names:
        source = corpus["sources"][name]
        if source.get("revision") != evidence["sources"][name].get("commit"):
            raise ValueError(f"{name}:clean source revision differs from reviewed evidence")


def validate_artifacts(*, package_path, corpus_path, binding_path, replay_path,
                       stream_metadata, tokenizer_path, tokenizer_companion_path,
                       rights_registry, rights_evidence, source_lock, git_source_lock) -> dict:
    """Revalidate immutable clean-v2 metadata and bytes without granting launch authority."""
    package_path, corpus_path, binding_path, replay_path = map(
        lambda p: Path(p).resolve(), (package_path, corpus_path, binding_path, replay_path))
    package_record, corpus_record = _read(package_path), _read(corpus_path)
    binding_record, replay_record = _read(binding_path), _read(replay_path)
    package, corpus = package_record["value"], corpus_record["value"]
    binding, replay = binding_record["value"], replay_record["value"]
    _identity(package, "package_sha256", PACKAGE_FORMAT)
    _identity(corpus, "corpus_sha256", CORPUS_FORMAT)
    _identity(binding, "binding_sha256", TOKENIZER_BINDING_FORMAT)
    if (package.get("status") != STATUS or package.get("production_dataset_approved") is not False or
            package.get("full_8_lane_quota_satisfied") is not False or package.get("training_performed") is not False):
        raise ValueError("clean v2 package lost NON_PROMOTABLE code-only scope")
    if package.get("trainer_admission") != "V2_REQUIRES_EXPLICIT_ADAPTER_MIGRATION; old freeze is not substituted":
        raise ValueError("clean v2 package trainer migration provenance differs")
    if (corpus.get("status") != STATUS or corpus.get("production_dataset_approved") is not False or
            corpus.get("historical_tokenizer_used") is not False or corpus.get("tokenizer_trained") is not False):
        raise ValueError("clean corpus scope/lineage is not the split-before-tokenizer v2 scope")
    if (binding.get("status") != STATUS or binding.get("scope") != "code-only-pilot" or
            binding.get("mocked") is not False or binding.get("model_training") is not False or
            binding.get("production_coverage_freeze") is not False or
            binding.get("independent_qualification") != "PENDING_VERSION_SPECIFIC_REPLAY"):
        raise ValueError("clean tokenizer binding lost NON_PROMOTABLE code-only scope")
    if (package.get("corpus_sha256") != corpus["corpus_sha256"] or
            package.get("corpus_manifest_sha256") != corpus_record["file_sha256"] or
            package.get("tokenizer_binding_sha256") != binding["binding_sha256"] or
            package.get("tokenizer_sha256") != binding.get("tokenizer_sha256") or
            package.get("producer_sha256") != corpus.get("producer_sha256") or
            package.get("sources") != corpus.get("sources")):
        raise ValueError("clean package/corpus/tokenizer exact binding differs")
    if (binding.get("corpus_sha256") != corpus["corpus_sha256"] or
            binding.get("corpus_manifest_sha256") != corpus_record["file_sha256"] or
            binding.get("vocabulary") != 65536 or binding.get("protocol_reserved") != 4096 or
            binding.get("protocol_start_id") != 61440):
        raise ValueError("clean tokenizer/corpus canonical binding differs")
    selections = binding.get("selections")
    if (not isinstance(selections, list) or not selections or
            sum(item.get("documents", 0) for item in selections if isinstance(item, dict)) !=
            package["counts"]["train"]["documents"]):
        raise ValueError("clean tokenizer selection inventory is incomplete")
    for selection in selections:
        source = selection.get("source")
        if (source not in corpus["sources"] or selection.get("revision") != corpus["sources"][source].get("revision") or
                type(selection.get("documents")) is not int or selection["documents"] <= 0):
            raise ValueError("clean tokenizer selection source provenance differs")
        for field in ("sha256", "source_manifest_sha256"):
            require_lower_sha256(f"tokenizer selection {field}", selection.get(field, ""))
    _validate_groups(corpus, package, binding)
    paths = {split: Path(stream_metadata[split]).resolve() for split in SPLITS}
    records = {split: _read(paths[split]) for split in SPLITS}
    _validate_streams(package, corpus, records, paths)
    tokenizer_path = Path(tokenizer_path).resolve()
    companion_path = Path(tokenizer_companion_path).resolve()
    _distinct([tokenizer_path, companion_path, *paths.values(),
               *(paths[s].with_suffix(".bin") for s in SPLITS)],
              "clean tokenizer aliases a train/heldout artifact")
    if (_sha256_file(tokenizer_path) != package["tokenizer_sha256"] or
            _sha256_file(companion_path) != binding.get("companion_sha256")):
        raise ValueError("clean tokenizer payload/companion hash differs")
    identity = load_tokenizer_identity(tokenizer_path)
    if identity["sha256"] != package["tokenizer_sha256"]:
        raise ValueError("clean tokenizer canonical identity differs")
    source_names = set(corpus.get("sources", {}))
    if not source_names:
        raise ValueError("clean corpus source provenance is empty")
    rights_paths = {
        "rights_registry": Path(rights_registry).resolve(),
        "rights_evidence": Path(rights_evidence).resolve(),
        "source_lock": Path(source_lock).resolve(),
        "git_source_lock": Path(git_source_lock).resolve(),
    }
    rights_records = {name: _read(path) for name, path in rights_paths.items()}
    _validate_rights(corpus, source_names, rights_paths, rights_records)
    if (replay.get("format") != REPLAY_FORMAT or
            replay.get("status") != "VERIFIED_BYTES_GROUPS_TOKENIZER_HELDOUT_SEPARATION" or
            replay.get("scope") != STATUS or replay.get("package_sha256") != package["package_sha256"] or
            replay.get("tokenizer_sha256") != package["tokenizer_sha256"] or
            replay.get("sample_heldout_exact_overlap") != 0 or replay.get("normalized_body_overlap") != 0 or
            replay.get("complete_raw_provenance") is not True or replay.get("canonical_streams_reencoded") is not True or
            replay.get("allocation_authorized") is not False or replay.get("production_promotion") is not False or
            replay.get("six_category_coverage_freeze") is not False or
            replay.get("source_quality_or_general_reasoning_certified") is not False):
        raise ValueError("clean v2 independent replay binding/limitations differ")
    expected_counts = {split: {"documents": package["counts"][split]["documents"],
                               "tokens": package["counts"][split]["tokens"]} for split in SPLITS}
    if replay.get("counts") != expected_counts:
        raise ValueError("clean v2 replay counts differ from package")
    if replay.get("stream_pins") != {split: package["counts"][split]["stream_sha256"] for split in SPLITS}:
        raise ValueError("clean v2 replay stream pins differ")
    return {
        "package": package_record, "corpus": corpus_record, "binding": binding_record,
        "replay": replay_record, "streams": records, "stream_paths": paths,
        "tokenizer_path": tokenizer_path, "tokenizer_companion_path": companion_path,
        "rights_paths": rights_paths,
    }


def admit_metadata(launch_path, args, world, *, monotonic=None):
    if type(world) is not int or world <= 0:
        raise ValueError("clean pilot world size must be a positive integer")
    launch_path = Path(launch_path).resolve()
    launch_record = _read(launch_path)
    launch = launch_record["value"]
    _identity(launch, "launch_sha256", LAUNCH_FORMAT)
    root = launch_path.parent
    pins = {}
    for name, field, fmt in (
        ("package", "package_sha256", PACKAGE_FORMAT),
        ("corpus", "corpus_sha256", CORPUS_FORMAT),
        ("tokenizer_binding", "binding_sha256", TOKENIZER_BINDING_FORMAT),
    ):
        pins[name] = _record(root, launch.get(name), identity_field=field, expected_format=fmt)[0]
    replay_path, replay_record = _record(root, launch.get("independent_replay"))
    decision_path, decision_record = _record(
        root, launch.get("decision"), identity_field="decision_sha256", expected_format=DECISION_FORMAT)
    stream_paths = {split: _path(root, launch.get("streams", {}).get(split)) for split in SPLITS}
    tokenizer_path = _path(root, launch.get("tokenizer", {}).get("path"))
    companion_path = _path(root, launch.get("tokenizer_companion", {}).get("path"))
    rights = {name: _path(root, launch.get(name, {}).get("path")) for name in
              ("rights_registry", "rights_evidence", "source_lock", "git_source_lock")}
    artifacts = validate_artifacts(
        package_path=pins["package"], corpus_path=pins["corpus"], binding_path=pins["tokenizer_binding"],
        replay_path=replay_path, stream_metadata=stream_paths, tokenizer_path=tokenizer_path,
        tokenizer_companion_path=companion_path, rights_registry=rights["rights_registry"],
        rights_evidence=rights["rights_evidence"], source_lock=rights["source_lock"],
        git_source_lock=rights["git_source_lock"])
    for name, path in rights.items():
        expected = launch[name]
        require_lower_sha256("file_sha256", expected.get("file_sha256", ""))
        if _sha256_file(path) != expected["file_sha256"]:
            raise ValueError(f"clean pilot launch {name} pin differs")
    for name, path in (("tokenizer", tokenizer_path), ("tokenizer_companion", companion_path),
                       ("independent_replay", replay_path)):
        pin = launch[name]
        require_lower_sha256("file_sha256", pin.get("file_sha256", ""))
        if _sha256_file(path) != pin["file_sha256"]:
            raise ValueError(f"clean pilot launch {name} pin differs")
    decision = decision_record["value"]
    package, corpus, binding = (artifacts[name]["value"] for name in ("package", "corpus", "binding"))
    expected_decision = {
        "package_sha256": package["package_sha256"], "corpus_sha256": corpus["corpus_sha256"],
        "tokenizer_binding_sha256": binding["binding_sha256"],
        "independent_replay_file_sha256": replay_record["file_sha256"],
        "adapter": {"format": FORMAT, "source_sha256": source_sha256()},
    }
    if (decision.get("scope") != "code-only-pilot" or decision.get("state") != APPROVED_LOCAL_STATE or
            decision.get("promotable") is not False or decision.get("allocation_authorized") is not False or
            any(decision.get(key) != value for key, value in expected_decision.items())):
        raise ValueError("clean pilot requires an exact reviewed NON_PROMOTABLE local decision")
    for field in ("reviewed_by", "review_ref"):
        if not isinstance(decision.get(field), str) or not decision[field].strip():
            raise ValueError("clean pilot decision is missing " + field)
    if (args.dataset_manifest or args.allow_unmanifested_data or args.allow_internal_val_split or
            args.init_from or getattr(args, "resume", "")):
        raise ValueError("clean pilot v2 cannot combine production/smoke/warm-start/resume admission")
    if args.tokenizer_freeze:
        raise ValueError("clean pilot v2 does not accept or substitute the historical tokenizer freeze")
    if not args.val_data or not args.tokenizer:
        raise ValueError("clean pilot v2 requires explicit validation and tokenizer paths")
    if (Path(str(args.data) + ".json").resolve() != stream_paths["train"] or
            Path(str(args.val_data) + ".json").resolve() != stream_paths["validation"]):
        raise ValueError("clean pilot v2 CLI streams differ from reviewed metadata")
    if Path(args.tokenizer).resolve() != tokenizer_path:
        raise ValueError("clean pilot v2 CLI tokenizer differs from reviewed payload")
    bounds = launch.get("bounds")
    if not isinstance(bounds, dict):
        raise ValueError("clean pilot v2 bounds are missing")
    for field in ("max_steps", "max_train_tokens", "max_wall_seconds"):
        if type(bounds.get(field)) is not int or bounds[field] <= 0:
            raise ValueError(f"clean pilot v2 {field} must be a positive integer")
    per_step = args.ctx * args.batch * args.accum * world
    if per_step <= 0 or args.steps > bounds["max_steps"] or args.steps * per_step > bounds["max_train_tokens"]:
        raise ValueError("clean pilot v2 resolved global horizon exceeds reviewed bounds")
    if bounds["max_train_tokens"] > package["counts"]["train"]["tokens"]:
        raise ValueError("clean pilot v2 token budget exceeds the clean train split")
    if args.sample_tokens:
        raise ValueError("clean pilot v2 disables post-training sampling")
    started = monotonic() if monotonic is not None else __import__("time").monotonic()
    clock = monotonic if monotonic is not None else __import__("time").monotonic
    qualification = {"tokenizer_sha256": package["tokenizer_sha256"]}
    binding_value = {
        "format": FORMAT, "status": STATUS, "promotable": False, "allocation_authorized": False,
        "launch_sha256": launch["launch_sha256"], "decision_sha256": decision["decision_sha256"],
        "dataset_identity_sha256": package["package_sha256"], "corpus_sha256": corpus["corpus_sha256"],
        "tokenizer_binding_sha256": binding["binding_sha256"], "adapter_source_sha256": source_sha256(),
        "independent_replay_file_sha256": replay_record["file_sha256"], "bounds": dict(bounds),
        "world_size": world, "tokens_per_step": per_step,
    }
    return CleanV2Admission(
        {"rights_registry": rights["rights_registry"]}, artifacts["streams"], qualification,
        binding_value, started, clock, tokenizer_path=tokenizer_path,
        tokenizer_sha256=package["tokenizer_sha256"])


class CleanV2Admission(Admission):
    run_format = RUN_FORMAT

    def __init__(self, *args, tokenizer_path: Path, tokenizer_sha256: str, **kwargs):
        super().__init__(*args, **kwargs)
        self._tokenizer_path = tokenizer_path
        self._tokenizer_sha256 = tokenizer_sha256

    def validate_bytes(self, args, train_meta, val_meta, tokenizer_sha256):
        for split, actual in (("train", train_meta), ("validation", val_meta)):
            if actual != self.streams[split]["value"]:
                raise ValueError(f"canonical {split} stream metadata changed after clean-v2 admission")
        if tokenizer_sha256 != self._tokenizer_sha256 or Path(args.tokenizer).resolve() != self._tokenizer_path:
            raise ValueError("clean-v2 tokenizer byte identity differs")
        identity = load_tokenizer_identity(args.tokenizer)
        if identity["sha256"] != self._tokenizer_sha256:
            raise ValueError("clean-v2 canonical tokenizer identity differs")
        self.check()
        # There is intentionally no legacy freeze identity in v2.
        return "CLEAN-V2-NO-LEGACY-FREEZE"
