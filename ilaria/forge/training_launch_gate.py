"""Metadata qualification for an explicit IMC experiment; never allocates compute.

Artifact-byte/provenance verification remains a separate, recorded operation.
This gate reads only explicitly supplied JSON metadata and creates pending templates.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from data_contract import canonical_json_sha256, require_approved_rights, require_lower_sha256
from rights_evidence import load_and_validate_evidence, require_approved_evidence
from curriculum_stream import REQUIRED_LANES, load_curriculum
from hf_tokenizer import EOS, ILARIALEX_BASE_VOCAB_SIZE, ILARIALEX_FORMAT, ILARIALEX_VOCAB_SIZE

QUALIFICATION_FORMAT = "ilaria-training-data-qualification-v1"
DECISION_FORMAT = "ilaria-training-data-launch-decision-v1"
ASSIGNMENT_FORMAT = "ilaria-training-group-assignment-v1"
VALIDATION_FORMAT = "ilaria-training-data-validation-receipt-v1"
REPORT_FORMAT = "ilaria-training-data-launch-gate-v1"
PILOT_FORMAT = "ilaria-licensed-code-scale-validation-v1"
PILOT_STATUS = "NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION"
SPLITS = ("train", "validation", "sealed")
MAX_METADATA_BYTES = 1 << 20


def identity(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def seal(value: dict, field: str) -> dict:
    value = dict(value)
    value[field] = identity(value, field)
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate metadata key: {key}")
        result[key] = value
    return result


def read_metadata(path: str | Path) -> dict:
    target = Path(path)
    if target.suffix != ".json":
        raise ValueError("only explicit .json metadata inputs are allowed")
    with target.open("rb") as stream:
        raw = stream.read(MAX_METADATA_BYTES + 1)
    if len(raw) > MAX_METADATA_BYTES:
        raise ValueError("metadata byte limit exceeded")
    def nonfinite(value):
        raise ValueError(f"non-finite metadata value: {value}")
    value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)
    if not isinstance(value, dict):
        raise ValueError("metadata must be an object")
    return {"value": value, "file_sha256": hashlib.sha256(raw).hexdigest()}


def _hash(field, value):
    require_lower_sha256(field, value)


def _identity(value, field, expected_format):
    if not isinstance(value, dict) or value.get("format") != expected_format:
        raise ValueError(f"unsupported {expected_format} format")
    _hash(field, value.get(field, ""))
    if identity(value, field) != value[field]:
        raise ValueError(f"{field} identity mismatch")


def _positive(name, value):
    if type(value) is not int or value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def _stream_binding(record):
    meta = record["value"]
    return {"file_sha256": record["file_sha256"], "stream_sha256": meta.get("stream_sha256"),
            "tokens": meta.get("tokens"), "documents": meta.get("documents")}


def _pilot(package, streams):
    _identity(package, "package_sha256", PILOT_FORMAT)
    if (package.get("status") != PILOT_STATUS or package.get("production_dataset_approved") is not False
            or package.get("full_8_lane_quota_satisfied") is not False):
        raise ValueError("pilot must retain its explicit NON_PROMOTABLE code-only scope")
    if set(streams) != set(SPLITS) or set(package.get("counts", {})) != set(SPLITS):
        raise ValueError("pilot requires distinct train, validation and sealed metadata")
    if (package.get("split_policy") != "sha256-connected-module-family-buckets-v1"
            or package.get("split_buckets") != {"train": "00-79", "validation": "80-89", "sealed": "90-99"}):
        raise ValueError("pilot grouped split policy mismatch")
    for split in SPLITS:
        entry, record = package["counts"][split], streams[split]
        meta = record["value"]
        _hash(f"{split}:metadata", record["file_sha256"])
        for field in ("jsonl_sha256", "stream_sha256", "stream_metadata_sha256"):
            _hash(f"{split}:{field}", entry.get(field, ""))
        for field in ("documents", "tokens_including_eos", "stream_bytes", "stream_metadata_bytes"):
            _positive(f"{split}:{field}", entry.get(field))
        if (record["file_sha256"] != entry["stream_metadata_sha256"] or
                meta.get("format") != "ilaria-token-stream-v1" or meta.get("dtype") != "uint16" or
                meta.get("tokenizer_format") != ILARIALEX_FORMAT or
                meta.get("tokenizer_sha256") != package.get("tokenizer_sha256") or
                type(meta.get("vocab_size")) is not int or meta["vocab_size"] != ILARIALEX_VOCAB_SIZE or
                type(meta.get("eos_id")) is not int or meta["eos_id"] != ILARIALEX_BASE_VOCAB_SIZE or
                meta.get("protocol_start_id") != ILARIALEX_BASE_VOCAB_SIZE or meta.get("byte_level") is not True or
                meta.get("stream_sha256") != entry["stream_sha256"] or
                meta.get("tokens") != entry["tokens_including_eos"] or
                meta.get("documents") != entry["documents"] or
                entry["stream_bytes"] != 2 * entry["tokens_including_eos"]):
            raise ValueError(f"{split}:canonical stream metadata binding mismatch")
        minimum = package.get("minimum_tokens", {}).get(split)
        _positive(f"{split}:minimum_tokens", minimum)
        if entry["tokens_including_eos"] < minimum:
            raise ValueError(f"{split}:token minimum unmet")
    if (package.get("eos_id") != ILARIALEX_BASE_VOCAB_SIZE or package.get("eos_token") != EOS):
        raise ValueError("pilot canonical EOS mismatch")
    _hash("tokenizer_sha256", package.get("tokenizer_sha256", ""))
    for field in ("jsonl_sha256", "stream_sha256", "stream_metadata_sha256"):
        if len({package["counts"][split][field] for split in SPLITS}) != 3:
            raise ValueError("sealed/train/validation artifact identities overlap")


def _groups(assignment, dataset_identity, expected_counts=None):
    _identity(assignment, "assignment_sha256", ASSIGNMENT_FORMAT)
    if assignment.get("dataset_identity_sha256") != dataset_identity:
        raise ValueError("group assignment points at another dataset")
    if assignment.get("group_identity_scheme") != "sha256-utf8-source-group-v1":
        raise ValueError("unsupported group identity scheme")
    groups = assignment.get("groups")
    if not isinstance(groups, dict) or set(groups) != set(SPLITS):
        raise ValueError("group assignment requires train/validation/sealed")
    seen = set()
    for split in SPLITS:
        values = groups[split]
        if not isinstance(values, list) or not values:
            raise ValueError(f"group assignment missing actual {split} group identities")
        for value in values:
            _hash(f"{split}:group_identity", value)
        if len(values) != len(set(values)) or seen.intersection(values):
            raise ValueError("group identity overlap across train/validation/sealed")
        seen.update(values)
        if expected_counts is not None and len(values) != expected_counts.get(split):
            raise ValueError(f"{split}:group count differs from frozen package")
        if expected_counts is not None:
            _positive(f"{split}:group count", expected_counts.get(split))
    return len(seen)


def build_pilot_templates(dataset, streams, rights_pins, *, producer_sha256):
    package = dataset["value"]
    _pilot(package, streams)
    _hash("producer_sha256", producer_sha256)
    assignment = seal({"format": ASSIGNMENT_FORMAT, "dataset_identity_sha256": package["package_sha256"],
                       "group_identity_scheme": "sha256-utf8-source-group-v1",
                       "groups": {split: [] for split in SPLITS}}, "assignment_sha256")
    qualification = seal({"format": QUALIFICATION_FORMAT, "scope": "code-only-pilot", "promotable": False,
                          "dataset": {"format": PILOT_FORMAT, "identity_sha256": package["package_sha256"],
                                      "file_sha256": dataset["file_sha256"]},
                          "tokenizer_sha256": package["tokenizer_sha256"],
                          "streams": {split: _stream_binding(streams[split]) for split in SPLITS},
                          "sources": package["sources"], "rights": dict(rights_pins),
                          "producer_sha256": producer_sha256,
                          "group_assignment_sha256": assignment["assignment_sha256"],
                          "validation_receipt_sha256": "", "sealed_use": "evaluation-only",
                          "bounds": {"max_steps": None, "max_train_tokens": None, "max_wall_seconds": None}},
                         "qualification_sha256")
    validation = seal({"format": VALIDATION_FORMAT, "scope": "code-only-pilot", "validation_level": "PENDING",
                       "dataset_identity_sha256": package["package_sha256"], "dataset_file_sha256": dataset["file_sha256"],
                       "producer_sha256": producer_sha256, "sources": package["sources"], "rights": dict(rights_pins),
                       "streams": qualification["streams"], "group_assignment_sha256": assignment["assignment_sha256"],
                       "reviewed_by": "", "review_ref": ""}, "validation_sha256")
    qualification["validation_receipt_sha256"] = validation["validation_sha256"]
    qualification = seal(qualification, "qualification_sha256")
    decision = seal({"format": DECISION_FORMAT, "qualification_sha256": qualification["qualification_sha256"],
                     "scope": "code-only-pilot", "state": "PENDING", "promotable": False,
                     "reviewed_by": "", "review_ref": ""}, "decision_sha256")
    return {"qualification": qualification, "decision": decision, "group-assignment": assignment,
            "validation-receipt": validation}


def assess_launch(*, mode, dataset, streams, qualification, decision, assignment,
                  validation_receipt, registry, evidence, rights_pins, training_splits=("train",),
                  readiness=None, curriculum=None):
    report = {"format": REPORT_FORMAT, "scope": mode, "data_qualified": False, "promotable": False,
              "allocation_authorized": False, "trainer_adapter_ready": False, "launch_ready": False,
              "blockers": [], "limitations": ["metadata bindings do not recompute artifact bytes or source quality",
                  "remote export, deletion, allocation window, Brev terms and cost remain separate gates"]}
    try:
        if mode not in {"code-only-pilot", "production"}:
            raise ValueError("explicit code-only-pilot or production scope required")
        _identity(qualification, "qualification_sha256", QUALIFICATION_FORMAT)
        _identity(decision, "decision_sha256", DECISION_FORMAT)
        if qualification.get("scope") != mode or decision.get("scope") != mode:
            raise ValueError("qualification/decision scope mismatch; pilot cannot satisfy production")
        if decision.get("qualification_sha256") != qualification["qualification_sha256"]:
            raise ValueError("decision points at another qualification")
        expected_state = "APPROVE_PILOT" if mode == "code-only-pilot" else "APPROVE_PRODUCTION"
        if decision.get("state") != expected_state:
            raise ValueError(f"explicit reviewed {expected_state} decision required (state={decision.get('state')})")
        for field in ("reviewed_by", "review_ref"):
            if not isinstance(decision.get(field), str) or not decision[field].strip():
                raise ValueError(f"launch decision missing {field}")
        if mode == "code-only-pilot" and (qualification.get("promotable") is not False or decision.get("promotable") is not False):
            raise ValueError("bounded pilot must remain NON_PROMOTABLE")
        value = dataset["value"]
        key = "package_sha256" if mode == "code-only-pilot" else "dataset_manifest_sha256"
        expected_format = PILOT_FORMAT if mode == "code-only-pilot" else "ilaria-dataset-manifest-v1"
        _identity(value, key, expected_format)
        if qualification.get("dataset") != {"format": expected_format, "identity_sha256": value[key], "file_sha256": dataset["file_sha256"]}:
            raise ValueError("qualification dataset identity/file binding mismatch")
        for record in (dataset, *streams.values()):
            _hash("metadata file hash", record["file_sha256"])
        sources = qualification.get("sources")
        if not isinstance(sources, dict) or not sources:
            raise ValueError("qualification has no source provenance")
        require_approved_rights(registry, sorted(sources))
        require_approved_evidence(registry, evidence, sorted(sources))
        if qualification.get("rights") != rights_pins:
            raise ValueError("current reviewed rights/evidence/lock hashes differ from qualification")
        for name, source in sources.items():
            if (not isinstance(source, dict) or source.get("revision") != evidence["sources"][name].get("commit")):
                raise ValueError(f"{name}:source revision differs from reviewed evidence")
            for field in ("raw_manifest_sha256", "licensed_manifest_sha256"):
                _hash(f"{name}:{field}", source.get(field, ""))
        if qualification.get("sealed_use") != "evaluation-only" or tuple(training_splits) != ("train",):
            raise ValueError("sealed and validation groups cannot be selected for training")
        if qualification.get("streams") != {split: _stream_binding(record) for split, record in streams.items()}:
            raise ValueError("qualification stream metadata binding mismatch")
        if qualification.get("tokenizer_sha256") != next(iter(streams.values()))["value"].get("tokenizer_sha256"):
            raise ValueError("qualification tokenizer identity mismatch")
        _hash("producer_sha256", qualification.get("producer_sha256", ""))
        if mode == "code-only-pilot":
            _pilot(value, streams)
            if qualification["sources"] != value["sources"]:
                raise ValueError("pilot source provenance differs from frozen package")
            for field, pin in (("rights_registry_sha256", "registry_file_sha256"),
                               ("rights_evidence_sha256", "evidence_file_sha256"),
                               ("corpus_source_lock_sha256", "source_lock_file_sha256"),
                               ("git_source_lock_sha256", "git_lock_file_sha256")):
                if value.get(field) != rights_pins.get(pin):
                    raise ValueError(f"pilot current {field} binding mismatch")
            groups = value.get("group_counts", {})
            total = _groups(assignment, value[key], groups.get("split_group_counts", {}))
            if total != groups.get("groups"):
                raise ValueError("total group count differs from frozen package")
        else:
            if readiness is None or curriculum is None:
                raise ValueError("production requires pinned canonical readiness and curriculum metadata")
            ready = readiness["value"]
            if (ready.get("format") != "ilaria-production-readiness-v1" or ready.get("ready") is not True or ready.get("blockers") != []):
                raise ValueError("canonical production readiness remains blocked")
            if qualification.get("readiness_file_sha256") != readiness["file_sha256"]:
                raise ValueError("canonical readiness file hash mismatch")
            config = curriculum["value"]
            mix = config.get("target_mix_ppm", {})
            if (config.get("format") != "imc-125m-curriculum-v1" or
                    config.get("policy") != "exact-token-budget-v1" or
                    config.get("boundary_policy") != "replace-final-lane-token-with-eos-v1" or
                    set(mix) != REQUIRED_LANES or any(type(v) is not int or v < 0 for v in mix.values()) or
                    sum(mix.values()) != 1_000_000 or
                    identity(config, "curriculum_sha256") != config.get("curriculum_sha256")):
                raise ValueError("production requires canonical eight-lane curriculum")
            if qualification.get("curriculum_file_sha256") != curriculum["file_sha256"]:
                raise ValueError("canonical curriculum file hash mismatch")
            for section, fields in (("curated_corpus", ("file_sha256", "identity_sha256")),
                                    ("post_curation_audit", ("file_sha256", "audit_sha256"))):
                for field in fields:
                    _hash(f"canonical dataset {section}:{field}", value.get(section, {}).get(field, ""))
            if (value.get("rights", {}).get("sha256") != rights_pins.get("registry_file_sha256") or
                    value.get("tokenizer", {}).get("sha256") != qualification.get("tokenizer_sha256")):
                raise ValueError("canonical dataset rights/tokenizer binding mismatch")
            _hash("production tokenizer freeze", qualification.get("tokenizer_freeze_sha256", ""))
            _groups(assignment, value[key])
            for split in ("train", "validation"):
                if streams[split]["value"].get("curriculum", {}).get("config_identity_sha256") != config["curriculum_sha256"]:
                    raise ValueError("production stream lacks matching canonical curriculum")
                if value["streams"][split]["stream_sha256"] != streams[split]["value"]["stream_sha256"]:
                    raise ValueError("canonical dataset stream identity mismatch")
        if qualification.get("group_assignment_sha256") != assignment["assignment_sha256"]:
            raise ValueError("qualification group assignment identity mismatch")
        _identity(validation_receipt, "validation_sha256", VALIDATION_FORMAT)
        if qualification.get("validation_receipt_sha256") != validation_receipt["validation_sha256"]:
            raise ValueError("missing or mismatched independent artifact/provenance validation receipt")
        expected = {"dataset_identity_sha256": value[key], "dataset_file_sha256": dataset["file_sha256"],
                    "producer_sha256": qualification["producer_sha256"], "sources": sources,
                    "rights": rights_pins, "streams": qualification["streams"],
                    "group_assignment_sha256": assignment["assignment_sha256"], "scope": mode}
        if any(validation_receipt.get(field) != expected_value for field, expected_value in expected.items()):
            raise ValueError("artifact/provenance validation receipt exact binding mismatch")
        level = "artifact-bytes-and-group-provenance" if mode == "code-only-pilot" else "canonical-dataset-freeze-and-group-provenance"
        if validation_receipt.get("validation_level") != level:
            raise ValueError("canonical artifact bytes and group provenance were not independently verified")
        if mode == "production":
            _hash("canonical dataset validator source", validation_receipt.get("canonical_dataset_validator_sha256", ""))
            if validation_receipt.get("tokenizer_freeze_sha256") != qualification["tokenizer_freeze_sha256"]:
                raise ValueError("production canonical tokenizer freeze validation receipt mismatch")
        for field in ("reviewed_by", "review_ref"):
            if not isinstance(validation_receipt.get(field), str) or not validation_receipt[field].strip():
                raise ValueError(f"independent validation receipt missing {field}")
        for field in ("max_steps", "max_train_tokens", "max_wall_seconds"):
            _positive(field, qualification.get("bounds", {}).get(field))
        if qualification["bounds"]["max_train_tokens"] > streams["train"]["value"]["tokens"]:
            raise ValueError("bounded experiment token limit exceeds qualified train split")
        report.update(data_qualified=True, qualification_sha256=qualification["qualification_sha256"],
                      decision_sha256=decision["decision_sha256"], bounds=qualification["bounds"])
        if mode == "code-only-pilot":
            report["blockers"].append("trainer:qualified-pilot-adapter-not-integrated; canonical trainer rejects custom package")
        else:
            report["blockers"].append("launcher:canonical byte validators and allocation approvals still required")
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        report["blockers"].append(str(exc))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("command", choices=("template", "assess"))
    parser.add_argument("--scope", required=True, choices=("code-only-pilot", "production"))
    for name in ("dataset", "train-metadata", "validation-metadata", "sealed-metadata", "rights", "evidence", "source-lock", "git-lock"):
        parser.add_argument("--" + name, required=True)
    for name in ("qualification", "decision", "group-assignment", "validation-receipt", "readiness", "curriculum", "out", "producer-sha256"):
        parser.add_argument("--" + name)
    parser.add_argument("--training-split", action="append")
    args = parser.parse_args(argv)
    dataset = read_metadata(args.dataset)
    streams = {split: read_metadata(getattr(args, split + "_metadata")) for split in SPLITS}
    registry_record = read_metadata(args.rights)
    evidence_record = read_metadata(args.evidence)
    locks = {"source_lock_file_sha256": read_metadata(args.source_lock)["file_sha256"],
             "git_lock_file_sha256": read_metadata(args.git_lock)["file_sha256"]}
    evidence = load_and_validate_evidence(args.evidence, source_lock_path=args.source_lock,
                                          rights_registry_path=args.rights, git_source_lock_path=args.git_lock)
    pins = {"registry_file_sha256": registry_record["file_sha256"], "evidence_file_sha256": evidence_record["file_sha256"], **locks}
    if args.command == "template":
        if args.scope != "code-only-pilot" or not args.out or not args.producer_sha256:
            parser.error("template requires code-only-pilot, --out and --producer-sha256")
        destination = Path(args.out)
        destination.mkdir(parents=False, exist_ok=False)
        templates = build_pilot_templates(dataset, streams, pins, producer_sha256=args.producer_sha256)
        for name, value in templates.items():
            with (destination / (name + ".json")).open("x", encoding="utf-8") as stream:
                json.dump(value, stream, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False)
                stream.write("\n")
        print(json.dumps({"status": "PENDING", "out": str(destination), "launch_ready": False}))
        return 0
    required = (args.qualification, args.decision, args.group_assignment, args.validation_receipt)
    if not all(required):
        parser.error("assess requires qualification, decision, group assignment and validation receipt")
    curriculum = read_metadata(args.curriculum) if args.curriculum else None
    if curriculum is not None:
        curriculum["value"] = load_curriculum(args.curriculum)
    report = assess_launch(mode=args.scope, dataset=dataset, streams=streams,
                           qualification=read_metadata(args.qualification)["value"], decision=read_metadata(args.decision)["value"],
                           assignment=read_metadata(args.group_assignment)["value"], validation_receipt=read_metadata(args.validation_receipt)["value"],
                           registry=registry_record["value"], evidence=evidence, rights_pins=pins,
                           training_splits=args.training_split or ("train",),
                           readiness=read_metadata(args.readiness) if args.readiness else None, curriculum=curriculum)
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    return 0 if report["data_qualified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
