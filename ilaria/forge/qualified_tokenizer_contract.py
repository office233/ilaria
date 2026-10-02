"""Explicit reviewed pre-existing IlariaLex admission for a NON_PROMOTABLE pilot.

Hashes bind a reviewed receipt; they do not establish rights or prove semantic
independence. Existing rights/attestation validators remain authoritative. The
external reviewer must verify input lineage and the complete benchmark inventory.
No template, caller readiness flag, or train-group fallback confers acceptance.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import training_launch_gate as gate
from data_contract import require_approved_rights, require_lower_sha256
from first_party_attestation import (
    attestation_scope_sha256, validate_attestation, validate_attestation_packet,
)
from rights_evidence import load_and_validate_evidence, require_approved_evidence
from tokenizer_coverage import COVERAGE_FORMAT
from tokenizer_freeze import FREEZE_FORMAT, SAMPLE_FORMAT, REQUIRED_COVERAGE, validate_freeze_manifest

FORMAT = "ilaria-qualified-pre-existing-tokenizer-v1"
RECEIPT_FORMAT = "ilaria-qualified-tokenizer-exclusion-receipt-v1"
PILOT_FIELDS = (
    "dataset", "tokenizer_sha256", "sources", "rights", "producer_sha256",
    "group_assignment_sha256", "validation_receipt_sha256", "sealed_use", "bounds",
)


def source_sha256():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def pilot_scope(qualification, assignment):
    return {**{name: qualification[name] for name in PILOT_FIELDS},
            "groups": assignment["groups"]}


def _path(root, value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("pre-existing tokenizer requires an explicit path")
    path = Path(value)
    return (path if path.is_absolute() else root / path).resolve()


def _identity(value, field, format_name):
    if not isinstance(value, dict) or value.get("format") != format_name:
        raise ValueError("unsupported pre-existing tokenizer metadata format")
    require_lower_sha256(field, value.get(field, ""))
    if gate.identity(value, field) != value[field]:
        raise ValueError("pre-existing tokenizer metadata identity differs")


def _record(root, pin, field=None, format_name=None):
    if not isinstance(pin, dict):
        raise ValueError("pre-existing tokenizer metadata pin is missing")
    path = _path(root, pin.get("path"))
    require_lower_sha256("file_sha256", pin.get("file_sha256", ""))
    record = gate.read_metadata(path)
    if record["file_sha256"] != pin["file_sha256"]:
        raise ValueError("pre-existing tokenizer metadata file pin differs")
    if field:
        _identity(record["value"], field, format_name)
        if record["value"][field] != pin.get(field):
            raise ValueError("pre-existing tokenizer metadata identity pin differs")
    return path, record["value"]


def _review(value, state):
    if value.get("state") != state:
        raise ValueError("pre-existing tokenizer requires explicit reviewed acceptance/verification")
    for field in ("reviewed_by", "review_ref"):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError("pre-existing tokenizer review is missing " + field)


def _groups(values):
    if not isinstance(values, list) or len(set(values)) != len(values):
        raise ValueError("pre-existing tokenizer group provenance is invalid")
    for value in values:
        require_lower_sha256("tokenizer group identity", value)
    return set(values)


def _alias(candidate, forbidden):
    if candidate in forbidden:
        return True
    # resolve handles symlinks; samefile additionally rejects hard-link aliases.
    for path in forbidden:
        if candidate.exists() and path.exists() and os.path.samefile(candidate, path):
            return True
    return False


def _admit(binding, launch_root, args, qualification, assignment, dataset, stream_paths):
    if not isinstance(binding, dict) or binding.get("format") != FORMAT:
        raise ValueError("unsupported pre-existing tokenizer contract; no v1 fallback")
    if binding.get("source_sha256") != source_sha256():
        raise ValueError("obsolete pre-existing tokenizer contract validator source")
    contract_path, contract = _record(launch_root, binding, "contract_sha256", FORMAT)
    root = contract_path.parent
    scope = pilot_scope(qualification, assignment)
    if (contract.get("scope") != "code-only-pilot" or contract.get("promotable") is not False or
            contract.get("pilot") != scope):
        raise ValueError("pre-existing tokenizer acceptance scope differs from this pilot")
    _review(contract, "ACCEPT_PRE_EXISTING_TOKENIZER")
    if "tokenizer_sample_groups" in qualification:
        raise ValueError("pre-existing tokenizer contract cannot claim pilot train-group sampling")
    freeze_path, freeze = _record(root, contract.get("freeze"), "freeze_sha256", FREEZE_FORMAT)
    sample_path, sample = _record(root, contract.get("sample"), "sample_manifest_sha256", SAMPLE_FORMAT)
    coverage_path, coverage = _record(root, contract.get("coverage"), "coverage_sha256", COVERAGE_FORMAT)
    if (freeze_path != Path(args.tokenizer_freeze).resolve() or
            contract["freeze"]["file_sha256"] != qualification["tokenizer_freeze_file_sha256"] or
            freeze["freeze_sha256"] != qualification["tokenizer_freeze_sha256"] or
            _path(freeze_path.parent, freeze["sample"]["filename"]) != sample_path or
            freeze["sample"]["sha256"] != sample["sample_manifest_sha256"] or
            _path(sample_path.parent, sample["coverage_evidence"]["filename"]) != coverage_path or
            sample["coverage_evidence"]["sha256"] != coverage["coverage_sha256"]):
        raise ValueError("pre-existing tokenizer freeze/sample/coverage binding differs")
    tokenizer = freeze["tokenizer"]
    if (_path(freeze_path.parent, tokenizer["filename"]) != Path(args.tokenizer).resolve() or
            tokenizer.get("sha256") != qualification["tokenizer_sha256"]):
        raise ValueError("pre-existing tokenizer CLI/payload identity differs")
    sources = sample.get("sources")
    if (not isinstance(sources, list) or not sources or len(set(sources)) != len(sources) or
            freeze["sample"].get("sources") != sources or coverage.get("sources") != sources or
            contract.get("sources") != sources or contract.get("inputs") != sample.get("inputs")):
        raise ValueError("pre-existing tokenizer exact source/sample input set differs")
    if (set(coverage.get("coverage", {})) != REQUIRED_COVERAGE or
            set(sample.get("coverage", [])) != REQUIRED_COVERAGE or
            {entry.get("source") for entry in sample["inputs"]} != set(sources)):
        raise ValueError("pre-existing tokenizer coverage/per-input source provenance is incomplete")

    rights = contract["rights"]
    rights_path, registry = _record(root, rights["registry"])
    evidence_path, _ = _record(root, rights["evidence"])
    lock_path, lock = _record(root, rights["source_lock"])
    git_path, git = _record(root, rights["git_source_lock"])
    evidence = load_and_validate_evidence(evidence_path, rights_registry_path=rights_path,
        source_lock_path=lock_path, git_source_lock_path=git_path)
    if (sample["rights"].get("sha256") != rights["registry"]["file_sha256"] or
            freeze.get("rights") != sample["rights"] or coverage.get("rights") != sample["rights"]):
        raise ValueError("pre-existing tokenizer rights binding differs")
    attestations = contract["first_party_attestations"]
    if not isinstance(attestations, dict) or set(attestations) != set(sample.get("first_party_attestations", {})):
        raise ValueError("pre-existing tokenizer explicit first-party attestation set differs")
    first_root = _path(root, contract.get("first_party_root")) if attestations else None
    if not attestations and contract.get("first_party_root") is not None:
        raise ValueError("unused pre-existing tokenizer first-party source root")
    packets, attestation_paths = {}, {}
    for source, pin in attestations.items():
        path, packet = _record(root, pin)
        validate_attestation_packet(packet)
        identity = {"filename": path.name, "file_sha256": pin["file_sha256"],
                    "attestation_sha256": packet["attestation_sha256"],
                    "attestation_scope_sha256": attestation_scope_sha256(packet)}
        if (any(pin.get(field) != identity[field] for field in ("attestation_sha256", "attestation_scope_sha256")) or
                sample["first_party_attestations"][source] != identity or
                coverage.get("first_party_attestations", {}).get(source) != identity):
            raise ValueError("pre-existing tokenizer first-party attestation identity differs")
        packets[source], attestation_paths[source] = packet, path
    if set(attestations) - set(sources) or set(attestations) & set(registry["sources"]):
        raise ValueError("pre-existing tokenizer unknown/ambiguous attestation source")
    external = sorted(set(sources) - set(attestations))
    require_approved_rights(registry, external)
    require_approved_evidence(registry, evidence, external)
    accounted = set(attestations)
    for name, current, pin in (("source_lock", lock, rights["source_lock"]),
                               ("git_source_lock", git, rights["git_source_lock"])):
        selected = {source: current["sources"][source] for source in sources if source in current["sources"]}
        expected = {"identity_sha256": current["source_lock_sha256"],
                    "file_sha256": pin["file_sha256"], "sources": selected}
        if selected and (sample.get(name) != expected or freeze["sample"].get(name) != expected):
            raise ValueError("pre-existing tokenizer source lock binding differs")
        if not selected and (name in sample or name in freeze["sample"]):
            raise ValueError("pre-existing tokenizer has an unrelated source lock")
        accounted.update(selected)
    if accounted != set(sources):
        raise ValueError("pre-existing tokenizer source lacks reviewed lock/attestation")

    _, receipt = _record(root, contract.get("exclusion_receipt"), "exclusion_sha256", RECEIPT_FORMAT)
    _review(receipt, "VERIFIED_INDEPENDENT")
    lineage = {name: contract[name] for name in ("freeze", "sample", "coverage", "sources", "inputs",
                                                "rights", "first_party_attestations", "first_party_root")}
    if (receipt.get("scope") != "code-only-pilot" or receipt.get("pilot") != scope or
            receipt.get("lineage") != lineage or receipt.get("validation_level") !=
            "tokenizer-inputs-and-heldout-provenance-v1"):
        raise ValueError("independent tokenizer exclusion/provenance receipt binding differs")
    excluded = receipt["excluded_groups"]
    if (set(excluded) != {"validation", "sealed", "benchmarks"} or
            excluded["validation"] != assignment["groups"]["validation"] or
            excluded["sealed"] != assignment["groups"]["sealed"]):
        raise ValueError("tokenizer exclusion receipt heldout group scope differs")
    forbidden_groups = set().union(*(_groups(excluded[name]) for name in excluded))
    forbidden_paths, forbidden_hashes = set(), set()
    heldout = receipt["heldout_artifacts"]
    if not isinstance(heldout, dict) or set(heldout) != {"validation", "sealed"}:
        raise ValueError("tokenizer exclusion receipt requires exact heldout artifact inventory")
    for split in ("validation", "sealed"):
        meta = stream_paths[split]
        forbidden_paths.update(path.resolve() for path in (meta, meta.with_suffix(".bin"), meta.with_suffix(".jsonl")))
        count = dataset["counts"][split]
        forbidden_hashes.update(count[field] for field in ("jsonl_sha256", "stream_sha256", "stream_metadata_sha256"))
        if not isinstance(heldout[split], dict) or set(heldout[split]) != {"jsonl", "stream", "metadata"}:
            raise ValueError("tokenizer exclusion receipt heldout artifact set differs")
        for kind, field in (("jsonl", "jsonl_sha256"), ("stream", "stream_sha256"), ("metadata", "stream_metadata_sha256")):
            entry = heldout[split][kind]
            path = _path(root, entry["path"])
            if entry.get("sha256") != count[field]:
                raise ValueError("tokenizer exclusion receipt heldout artifact identity differs")
            if kind != "jsonl" and path != (meta if kind == "metadata" else meta.with_suffix(".bin")).resolve():
                raise ValueError("tokenizer exclusion receipt heldout stream path differs")
            forbidden_paths.add(path)
    benchmarks = receipt["benchmark_artifacts"]
    if not isinstance(benchmarks, list):
        raise ValueError("tokenizer exclusion receipt requires an explicit complete benchmark inventory")
    for entry in benchmarks:
        forbidden_paths.add(_path(root, entry["path"]))
        require_lower_sha256("benchmark artifact sha256", entry.get("sha256", ""))
        forbidden_hashes.add(entry["sha256"])
    # Match build_freeze_manifest: derive the companion from the unresolved
    # tokenizer path first, then resolve aliases. Resolving the tokenizer first
    # could silently check a different companion when the tokenizer is a link.
    tokenizer_path = freeze_path.parent / tokenizer["filename"]
    companion_path = tokenizer_path.with_suffix(".hf.json")
    if tokenizer.get("hf_filename") != companion_path.name:
        raise ValueError("pre-existing tokenizer canonical companion filename pin differs")
    for path, pinned_sha in ((tokenizer_path, tokenizer.get("sha256")),
                             (companion_path, tokenizer.get("hf_sha256"))):
        require_lower_sha256("tokenizer payload/companion sha256", pinned_sha)
        if _alias(path.resolve(), forbidden_paths) or pinned_sha in forbidden_hashes:
            raise ValueError("tokenizer payload/companion aliases or matches an excluded heldout/sealed/benchmark artifact")
    entries = [(sample_path.parent, entry) for entry in sample["inputs"]]
    for category in coverage["coverage"].values():
        entries.extend((coverage_path.parent, entry) for entry in category["files"])
    expected_inputs = []
    observed = set()
    for parent, entry in entries:
        path = _path(parent, entry["filename"])
        if entry.get("source") not in sources:
            raise ValueError("pre-existing tokenizer input references unknown source")
        require_lower_sha256("tokenizer input sha256", entry.get("sha256", ""))
        if _alias(path, forbidden_paths) or entry["sha256"] in forbidden_hashes:
            raise ValueError("heldout/sealed/benchmark artifact cannot be opened for tokenizer validation")
        key = str(path)
        record = {"path": key, "input": entry}
        if key not in observed:
            expected_inputs.append(record)
            observed.add(key)
        elif record not in expected_inputs:
            raise ValueError("tokenizer input alias has conflicting source provenance")
    provenance = receipt["input_provenance"]
    if (not isinstance(provenance, list) or len(provenance) != len(expected_inputs) or
            [{"path": item.get("path"), "input": item.get("input")} for item in provenance] != expected_inputs):
        raise ValueError("independent tokenizer exact input provenance differs")
    for item in provenance:
        if not item.get("groups") or _groups(item["groups"]) & forbidden_groups:
            raise ValueError("tokenizer input provenance overlaps heldout/sealed/benchmark groups")
    # All metadata/exclusion checks precede opening any attested source/sample.
    for source, packet in packets.items():
        for entry in packet["files"]:
            path = _path(first_root, entry["path"])
            if first_root not in path.parents or _alias(path, forbidden_paths) or entry["sha256"] in forbidden_hashes:
                raise ValueError("first-party source root/attested path escapes or aliases an excluded artifact")
        validate_attestation(attestation_paths[source], workspace_root=first_root)
    validated = validate_freeze_manifest(freeze_path, rights_registry_path=rights_path,
        first_party_attestations=attestation_paths, first_party_root=first_root)
    if validated != freeze:
        raise ValueError("pre-existing tokenizer freeze changed during canonical validation")
    return {"format": FORMAT, "source_sha256": source_sha256(), "contract_path": str(contract_path),
            "contract_file_sha256": binding["file_sha256"], "contract_sha256": contract["contract_sha256"],
            "exclusion_receipt": contract["exclusion_receipt"], "lineage": lineage,
            "resolved_first_party_root": str(first_root) if first_root else None,
            "resolved_first_party_attestations": {source: str(path) for source, path in attestation_paths.items()}}, validated


def admit_contract(binding, launch_root, args, qualification, assignment, dataset, stream_paths):
    """Reject metadata/lineage failures before canonical stream/model/CUDA access.

    On accepted metadata, canonical freeze validation verifies the exact artifact
    bytes and first-party source root. Call again before compute for drift checks.
    """
    try:
        return _admit(binding, launch_root, args, qualification, assignment, dataset, stream_paths)
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError("pre-existing tokenizer contract is incomplete or malformed") from exc
