"""Stream exact selection receipts for new production tokenizer inputs.

Receipts contain hashes, offsets and canonical scalar provenance, never text.
They establish reproducible selection, not independent alias-component review,
item rights, evaluation exclusions or model promotion. Memory is bounded by
source metadata and one document, not the number of selected documents.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath

from atomic_io import atomic_binary_writer
from corpus_source_lock import load_source_lock
from curate_corpus import _document_provenance, _source_provenance, _ITEM_METADATA
from data_audit import document_sha256
from data_contract import (
    CORPUS_MANIFEST_SCHEMA, atomic_write_json, canonical_json_bytes,
    canonical_json_sha256, require_lower_sha256, sha256_file,
)
from first_party_attestation import (
    attestation_scope_sha256, validate_attestation, validate_attestation_packet,
)
from git_source_lock import load_lock as load_git_lock
from prepare_corpus import SOURCES, validate_tokenizer_sample_rights

FORMAT = "ilarialex-production-selection-v1"
LEDGER_FORMAT = "ilarialex-production-selection-row-v1"
GENERATOR_FORMAT = "ilarialex-production-selection-generator-v1"
NORMALIZATION = "replace-cr-lf-with-space-strip-append-lf-v1"
SELECTION = "ordered-whole-documents-until-byte-target-v1"


def validate_limits(value):
    if (not isinstance(value, dict) or set(value) != {"max_row_bytes", "max_document_bytes", "max_ledger_row_bytes", "max_metadata_bytes"} or
            any(type(limit) is not int or limit < 1 for limit in value.values())):
        raise ValueError("explicit positive tokenizer materialization limits are required")
    return dict(value)


def generator_identity():
    root = Path(__file__).parent
    names = ("production_tokenizer_pipeline.py", "production_tokenizer_lineage.py",
             "data_audit.py", "curate_corpus.py", "atomic_io.py")
    return {"format": GENERATOR_FORMAT, "source_sha256": {name: sha256_file(root / name) for name in names}}


def load_metadata(path, max_bytes=None):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate tokenizer lineage metadata key")
            result[key] = value
        return result
    def nonfinite(_):
        raise ValueError("non-finite tokenizer lineage metadata")
    with Path(path).open("rb") as stream:
        raw = stream.read(max_bytes + 1) if max_bytes is not None else stream.read()
    if max_bytes is not None and len(raw) > max_bytes:
        raise ValueError("tokenizer metadata exceeds explicit byte limit")
    result = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
    if not isinstance(result, dict):
        raise ValueError("tokenizer lineage metadata must be an object")
    return result


def safe_input_path(root, filename):
    # Cross-platform spelling checks reject Windows paths even on Linux.
    if (not isinstance(filename, str) or not filename or "\\" in filename or ":" in filename or
            PurePosixPath(filename).is_absolute() or
            any(part in ("", ".", "..") for part in filename.split("/"))):
        raise ValueError("unsafe tokenizer lineage input path")
    root = Path(root).resolve()
    path = root / filename
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root):
        raise ValueError("tokenizer lineage input symlink is forbidden")
    resolved = path.resolve()
    if root not in resolved.parents:
        raise ValueError("tokenizer lineage input path escapes source root")
    return resolved


def prepare_external_sources(source_manifests, *, rights_registry_path, source_lock_path, git_source_lock_path, materialization_limits):
    """Validate all declared source identities/paths before opening any shard."""
    limits = validate_limits(materialization_limits)
    names = sorted(source_manifests)
    rights = validate_tokenizer_sample_rights(rights_registry_path, names, source_lock_path=source_lock_path)
    hf = load_source_lock(source_lock_path, SOURCES)
    git = load_git_lock(git_source_lock_path)
    configured = rights.get("evidence")
    if configured is not None and configured.get("git_source_lock_sha256") != git["source_lock_sha256"]:
        raise ValueError("explicit tokenizer Git source lock differs from rights evidence")
    contexts = {}
    for name in names:
        path = Path(source_manifests[name]).resolve()
        manifest = load_metadata(path, limits["max_metadata_bytes"])
        source = manifest.get("source")
        if (manifest.get("schema_version") != CORPUS_MANIFEST_SCHEMA or
                not isinstance(source, dict) or source.get("name") != name):
            raise ValueError("tokenizer source manifest identity mismatch")
        if name in hf["sources"]:
            locked = hf["sources"][name]
            if any(source.get(field) != locked[field] for field in ("provider", "config", "revision")):
                raise ValueError("tokenizer source identity differs from HF lock")
        elif name in git["sources"]:
            locked = git["sources"][name]
            if (source.get("provider") != locked["url"] or source.get("config") is not None or
                    source.get("revision") != locked["commit"]):
                raise ValueError("tokenizer source identity differs from Git lock")
        else:
            raise ValueError("tokenizer source has no immutable source lock")
        records = manifest.get("shard_records")
        if not isinstance(records, list) or not records:
            raise ValueError("tokenizer source manifest has no shards")
        seen, indices = set(), set()
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("invalid tokenizer source shard record")
            shard = safe_input_path(path.parent, record.get("filename"))
            require_lower_sha256("source shard sha256", record.get("sha256", ""))
            if (type(record.get("index")) is not int or record["index"] < 0 or
                    type(record.get("bytes")) is not int or record["bytes"] < 0 or
                    type(record.get("documents")) is not int or record["documents"] < 0 or
                    shard in seen or record["index"] in indices):
                raise ValueError("invalid/duplicate tokenizer source shard metadata")
            seen.add(shard)
            indices.add(record["index"])
        provenance = _source_provenance({"manifest": manifest, "path": path}, rights,
                                       sha256_file(rights_registry_path), {})
        contexts[name] = {"manifest_path": path, "manifest": manifest,
            "origin": {"kind": "external-jsonl", "source": name,
                "source_identity_sha256": canonical_json_sha256(source),
                "source_manifest": {"filename": path.name, "sha256": sha256_file(path)},
                "source_provenance": provenance}}
    return contexts


def prepare_first_party(attestation_path, source_root, materialization_limits, *, attested_path=None):
    """Approve the existing packet and check every path before source reads."""
    limits = validate_limits(materialization_limits)
    packet = load_metadata(attestation_path, limits["max_metadata_bytes"])
    validate_attestation_packet(packet)
    if attested_path is not None and not any(record["path"] == attested_path for record in packet["files"]):
        raise ValueError("first-party tokenizer path is not attested")
    for record in packet["files"]:
        path = safe_input_path(source_root, record["path"])
        if path.is_file() and path.stat().st_size > limits["max_document_bytes"]:
            raise ValueError("first-party document exceeds explicit byte limit")
    return validate_attestation(attestation_path, workspace_root=source_root)


def _external_rows(context, target_bytes, limits):
    written = 0
    manifest_path = context["manifest_path"]
    provenance = context["origin"]["source_provenance"]
    for shard_record in context["manifest"]["shard_records"]:  # preserve manifest order
        shard = safe_input_path(manifest_path.parent, shard_record["filename"])
        if not shard.is_file() or shard.stat().st_size != shard_record["bytes"]:
            raise ValueError("tokenizer source shard size mismatch")
        if sha256_file(shard) != shard_record["sha256"]:
            raise ValueError("tokenizer source shard hash mismatch")
        offset = 0
        with shard.open("rb") as stream:
            line_no = 0
            while True:
                raw = stream.readline(limits["max_row_bytes"] + 1)
                if not raw:
                    break
                if len(raw) > limits["max_row_bytes"]:
                    raise ValueError("tokenizer source row exceeds explicit byte limit")
                line_no += 1
                start, offset = offset, offset + len(raw)
                line = raw.decode("utf-8")
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"invalid tokenizer source JSONL line {line_no}") from exc
                text = row.get("text") if isinstance(row, dict) else None
                if not isinstance(text, str) or not text.strip():
                    continue
                emitted = (text.replace("\r", " ").replace("\n", " ").strip() + "\n").encode("utf-8")
                if len(emitted) > limits["max_document_bytes"]:
                    raise ValueError("tokenizer emitted document exceeds explicit byte limit")
                doc_hash = document_sha256(text)
                item = _document_provenance(row, doc_hash, provenance, shard_record["sha256"],
                                            line_no, [], sorted(_ITEM_METADATA))
                origin = {"source_identity_sha256": context["origin"]["source_identity_sha256"],
                    "source_manifest_sha256": context["origin"]["source_manifest"]["sha256"],
                    "shard": {"filename": shard_record["filename"], "index": shard_record["index"],
                              "sha256": shard_record["sha256"]},
                    "line": line_no, "byte_start": start, "byte_end": offset,
                    "row_sha256": canonical_json_sha256(row), "raw_line_sha256": hashlib.sha256(raw).hexdigest()}
                record = {"format": LEDGER_FORMAT, "input": origin,
                    "row_identity_sha256": canonical_json_sha256(origin), "document_sha256": doc_hash,
                    "item_metadata": item["item_metadata"], "identifier_field": item["identifier_field"],
                    "emitted": {"sha256": hashlib.sha256(emitted).hexdigest(), "bytes": len(emitted),
                                "byte_start": written, "byte_end": written + len(emitted)}}
                yield emitted, record
                written += len(emitted)
                if written >= target_bytes:
                    return


def _first_party_rows(source_path, relative, packet, limits):
    # The existing pipeline copies each attested file byte-for-byte as one doc.
    # Canonical normalization/hash needs one decoded document, as for a JSONL row.
    expected = next((record for record in packet["files"] if record["path"] == relative), None)
    if expected is None:
        raise ValueError("first-party tokenizer path is not attested")
    with Path(source_path).open("rb") as stream:
        raw = stream.read(limits["max_document_bytes"] + 1)
    if len(raw) > limits["max_document_bytes"]:
        raise ValueError("first-party document exceeds explicit byte limit")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected["sha256"]:
        raise ValueError("first-party tokenizer sample differs from attested file")
    identity = {"attestation_sha256": packet["attestation_sha256"], "attested_path": relative,
                "file_sha256": digest}
    yield raw, {"format": LEDGER_FORMAT, "input": identity,
        "row_identity_sha256": canonical_json_sha256(identity), "document_sha256": document_sha256(raw.decode("utf-8")),
        "item_metadata": {"path": relative}, "identifier_field": "path",
        "emitted": {"sha256": digest, "bytes": len(raw), "byte_start": 0, "byte_end": len(raw)}}


def _publish(destination, origin, rows, target_bytes, normalization, limits):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink() or any(destination.parent.glob(destination.name + ".selection.*")):
        raise ValueError("tokenizer sample/selection artifacts already exist")
    ledger_staging = destination.with_name(destination.name + ".selection.pending.jsonl")
    sample_hash, ledger_hash = hashlib.sha256(), hashlib.sha256()
    written = documents = ledger_bytes = 0
    with atomic_binary_writer(ledger_staging) as ledger, atomic_binary_writer(destination) as sample:
        for emitted, record in rows:
            encoded = canonical_json_bytes(record) + b"\n"
            if len(encoded) > limits["max_ledger_row_bytes"]:
                raise ValueError("tokenizer ledger row exceeds explicit byte limit")
            sample.write(emitted)
            ledger.write(encoded)
            sample_hash.update(emitted)
            ledger_hash.update(encoded)
            written += len(emitted)
            ledger_bytes += len(encoded)
            documents += 1
        if documents == 0:
            raise ValueError("tokenizer source sample is empty")
        # Deterministic receipt refusals must precede publication of either stream.
        ledger_path = destination.with_name(destination.name + ".selection." + ledger_hash.hexdigest() + ".jsonl")
        if ledger_path.exists():
            raise ValueError("tokenizer selection ledger already exists")
        metadata = {"format": FORMAT, "generator": generator_identity(), "origin": origin,
            "selection_policy": SELECTION if target_bytes is not None else "whole-attested-file-v1",
            "normalization": normalization, "target_bytes": target_bytes, "materialization_limits": limits,
            "sample": {"filename": destination.name, "sha256": sample_hash.hexdigest(), "bytes": written, "documents": documents},
            "ledger": {"filename": ledger_path.name, "sha256": ledger_hash.hexdigest(), "bytes": ledger_bytes, "documents": documents},
            "verification": "exact selection only; not alias-component, item-rights, exclusion or promotion approval"}
        metadata["selection_sha256"] = canonical_json_sha256(metadata)
        if len(canonical_json_bytes(metadata)) + 1 > limits["max_metadata_bytes"]:
            raise ValueError("tokenizer selection metadata exceeds explicit byte limit")
        metadata_path = destination.with_name(destination.name + ".selection." + metadata["selection_sha256"] + ".json")
        if metadata_path.exists():
            raise ValueError("tokenizer selection metadata already exists")
    ledger_staging.rename(ledger_path)
    atomic_write_json(metadata_path, metadata, pretty=False)
    return {"source": origin["source"], **metadata["sample"], "selection": {
        "format": FORMAT, "filename": metadata_path.name, "file_sha256": sha256_file(metadata_path),
        "selection_sha256": metadata["selection_sha256"], "ledger": metadata["ledger"]}}


def write_external_sample(manifest_path, destination, target_bytes, *, source_name,
                          rights_registry_path, source_lock_path, git_source_lock_path, materialization_limits):
    """Public rights-gated writer; no caller ready flag replaces canonical review."""
    if type(target_bytes) is not int or target_bytes < 1:
        raise ValueError("tokenizer target bytes must be positive")
    limits = validate_limits(materialization_limits)
    context = prepare_external_sources({source_name: manifest_path}, rights_registry_path=rights_registry_path,
        source_lock_path=source_lock_path, git_source_lock_path=git_source_lock_path, materialization_limits=limits)[source_name]
    result = _publish(destination, context["origin"], _external_rows(context, target_bytes, limits), target_bytes, NORMALIZATION, limits)
    result.update(source_manifest=context["origin"]["source_manifest"]["filename"],
        source_manifest_sha256=context["origin"]["source_manifest"]["sha256"],
        revision=context["manifest"]["source"]["revision"])
    return result


def write_first_party_sample(destination, *, source_name, attested_path, attestation_path, source_root, materialization_limits):
    limits = validate_limits(materialization_limits)
    packet = prepare_first_party(attestation_path, source_root, limits, attested_path=attested_path)
    source_path = safe_input_path(source_root, attested_path)
    origin = {"kind": "attested-file", "source": source_name, "attested_path": attested_path,
        "source_root": str(Path(source_root).resolve()), "attestation": {"filename": Path(attestation_path).name,
            "file_sha256": sha256_file(attestation_path), "attestation_sha256": packet["attestation_sha256"],
            "attestation_scope_sha256": attestation_scope_sha256(packet)}}
    result = _publish(destination, origin, _first_party_rows(source_path, attested_path, packet, limits), None, "byte-identical-attested-file-v1", limits)
    result["attested_path"] = attested_path
    return result


def validate_selection(metadata_path, *, expected_input=None, source_manifest_path=None,
                       rights_registry_path=None, source_lock_path=None, git_source_lock_path=None,
                       attestation_path=None, source_root=None, materialization_limits):
    """Stream independent replay from caller-supplied source authority/metadata.

    Recomputes every row identity, emitted fragment, ledger and sample binding.
    It does not trust a rehashed ledger as proof of the actual source selection.
    """
    metadata_path = Path(metadata_path)
    limits = validate_limits(materialization_limits)
    metadata = load_metadata(metadata_path, limits["max_metadata_bytes"])
    identity = dict(metadata)
    declared = identity.pop("selection_sha256", "")
    require_lower_sha256("selection_sha256", declared)
    if metadata.get("format") != FORMAT or canonical_json_sha256(identity) != declared:
        raise ValueError("tokenizer selection metadata identity mismatch")
    if metadata.get("generator") != generator_identity():
        raise ValueError("tokenizer selection generator source identity mismatch")
    if metadata.get("materialization_limits") != limits:
        raise ValueError("tokenizer selection materialization limits differ")
    sample, ledger, origin = metadata["sample"], metadata["ledger"], metadata["origin"]
    if expected_input is not None and (expected_input.get("source") != origin["source"] or
        any(expected_input.get(field) != sample[field] for field in ("filename", "sha256", "bytes", "documents")) or
        expected_input.get("selection") != {"format": FORMAT, "filename": metadata_path.name,
            "file_sha256": sha256_file(metadata_path), "selection_sha256": declared, "ledger": ledger}):
        raise ValueError("tokenizer selection report/input binding mismatch")
    sample_path = safe_input_path(metadata_path.parent, sample["filename"])
    ledger_path = safe_input_path(metadata_path.parent, ledger["filename"])
    if origin["kind"] == "external-jsonl":
        context = prepare_external_sources({origin["source"]: source_manifest_path}, rights_registry_path=rights_registry_path,
            source_lock_path=source_lock_path, git_source_lock_path=git_source_lock_path, materialization_limits=limits)[origin["source"]]
        if (context["origin"] != origin or metadata["normalization"] != NORMALIZATION or
                metadata["selection_policy"] != SELECTION or type(metadata["target_bytes"]) is not int or metadata["target_bytes"] < 1):
            raise ValueError("tokenizer selection exact source/policy binding mismatch")
        rows = _external_rows(context, metadata["target_bytes"], limits)
    elif origin["kind"] == "attested-file":
        if origin["source_root"] != str(Path(source_root).resolve()) or origin["attestation"].get("file_sha256") != sha256_file(attestation_path):
            raise ValueError("tokenizer selection first-party binding mismatch")
        packet = prepare_first_party(attestation_path, source_root, limits, attested_path=origin["attested_path"])
        expected = {"filename": Path(attestation_path).name, "file_sha256": sha256_file(attestation_path),
            "attestation_sha256": packet["attestation_sha256"], "attestation_scope_sha256": attestation_scope_sha256(packet)}
        if (origin["attestation"] != expected or origin["source_root"] != str(Path(source_root).resolve()) or
                metadata["normalization"] != "byte-identical-attested-file-v1" or
                metadata["selection_policy"] != "whole-attested-file-v1" or metadata["target_bytes"] is not None):
            raise ValueError("tokenizer selection first-party binding mismatch")
        rows = _first_party_rows(safe_input_path(source_root, origin["attested_path"]), origin["attested_path"], packet, limits)
    else:
        raise ValueError("unsupported tokenizer selection origin")
    sample_hash, ledger_hash = hashlib.sha256(), hashlib.sha256()
    documents = written = ledger_bytes = 0
    with sample_path.open("rb") as sample_stream, ledger_path.open("rb") as ledger_stream:
        for emitted, record in rows:
            encoded = canonical_json_bytes(record) + b"\n"
            actual = ledger_stream.readline(limits["max_ledger_row_bytes"] + 1)
            if len(actual) > limits["max_ledger_row_bytes"]:
                raise ValueError("tokenizer ledger row exceeds explicit byte limit")
            if actual != encoded or sample_stream.read(len(emitted)) != emitted:
                raise ValueError("tokenizer selection ledger/sample differs from exact source replay")
            sample_hash.update(emitted)
            ledger_hash.update(actual)
            documents += 1
            written += len(emitted)
            ledger_bytes += len(actual)
        if sample_stream.read(1) or ledger_stream.read(1):
            raise ValueError("tokenizer selection has trailing unselected bytes/rows")
    if (documents == 0 or sample != {"filename": sample_path.name, "sha256": sample_hash.hexdigest(), "bytes": written, "documents": documents} or
            ledger != {"filename": ledger_path.name, "sha256": ledger_hash.hexdigest(), "bytes": ledger_bytes, "documents": documents}):
        raise ValueError("tokenizer selection sample/ledger hash/count mismatch")
    return metadata
