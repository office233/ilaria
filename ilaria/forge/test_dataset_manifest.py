import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_audit import audit, document_sha256  # noqa: E402
from data_contract import (  # noqa: E402
    RIGHTS_APPROVED,
    TOKEN_STREAM_FORMAT,
    atomic_write_json,
    canonical_json_bytes,
    canonical_json_sha256,
    sha256_file,
)
from dataset_manifest import (  # noqa: E402
    build_dataset_manifest,
    _validate_curated,
    validate_dataset_manifest_file,
)
from curate_corpus import curate  # noqa: E402
from first_party_attestation import (  # noqa: E402
    attestation_scope_sha256,
    build_attestation_template,
)


def fixture(tmp_path, rights_status=RIGHTS_APPROVED):
    source_name = "fixture_source"
    rights = tmp_path / "rights.json"
    atomic_write_json(
        rights,
        {
            "schema_version": 1,
            "policy": "fixture",
            "sources": {
                source_name: {
                    "status": rights_status,
                    "commercial_use_approved": rights_status == RIGHTS_APPROVED,
                    "review_ref": "legal-review-fixture"
                    if rights_status == RIGHTS_APPROVED
                    else "",
                }
            },
        },
    )

    train = tmp_path / "train-00000.jsonl"
    validation = tmp_path / "validation-00000.jsonl"
    train.write_text(
        json.dumps(
            {
                "text": "clean synthetic training document",
                "source": source_name,
                "document_sha256": "a" * 64,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    validation.write_text(
        json.dumps(
            {
                "text": "separate synthetic validation document",
                "source": source_name,
                "document_sha256": "b" * 64,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    curated = {
        "schema_version": 1,
        "format": "ilaria-curated-corpus-v1",
        "policy": {
            "dedup": "exact-normalized-sha256",
            "contamination": "hashed-word-shingles",
            "shingle_width": 12,
            "split": "normalized-document-sha256-v1",
            "split_salt": "ilaria-validation-v1",
            "validation_fraction": 0.1,
            "precedence": "source-name-then-manifest-path",
        },
        "rights": {
            "filename": rights.name,
            "sha256": sha256_file(rights),
            "policy": "fixture",
            "approved_sources": [source_name],
        },
        "sources": [
            {
                "source": {
                    "name": source_name,
                    "provider": "fixture/provider",
                    "revision": "v1",
                    "language": "en",
                },
                "manifest_filename": "fixture-source.manifest.json",
                "manifest_sha256": "c" * 64,
            }
        ],
        "input_shards": [],
        "benchmarks": [],
        "totals": {
            "input_documents": 2,
            "kept_documents": 2,
            "duplicates_removed": 0,
            "contamination_removed": 0,
            "train_documents": 1,
            "validation_documents": 1,
        },
        "by_source": {
            source_name: {
                "input_documents": 2,
                "kept_documents": 2,
                "duplicates_removed": 0,
                "contamination_removed": 0,
            }
        },
        "splits": {
            "train": [
                {
                    "index": 0,
                    "filename": train.name,
                    "sha256": sha256_file(train),
                    "bytes": train.stat().st_size,
                    "documents": 1,
                }
            ],
            "validation": [
                {
                    "index": 0,
                    "filename": validation.name,
                    "sha256": sha256_file(validation),
                    "bytes": validation.stat().st_size,
                    "documents": 1,
                }
            ],
        },
    }
    curated["curated_manifest_sha256"] = hashlib.sha256(
        canonical_json_bytes(curated)
    ).hexdigest()
    curated_path = tmp_path / "curated.manifest.json"
    atomic_write_json(curated_path, curated)

    audit_report = audit(
        [str(train), str(validation)], [], shingle_width=6
    )
    audit_path = tmp_path / "audit.json"
    atomic_write_json(audit_path, audit_report)

    tokenizer = tmp_path / "ilarialex.json"
    tokenizer.write_text('{"fixture":"tokenizer"}\n', encoding="utf-8")
    tok_hash = sha256_file(tokenizer)

    def stream(name, values, documents):
        binary = tmp_path / f"{name}.bin"
        np.asarray(values, dtype=np.uint16).tofile(binary)
        meta_path = tmp_path / f"{name}.json"
        atomic_write_json(
            meta_path,
            {
                "format": TOKEN_STREAM_FORMAT,
                "vocab_size": 65_536,
                "eos_id": 61_440,
                "dtype": "uint16",
                "tokens": len(values),
                "documents": documents,
                "tokenizer": tokenizer.name,
                "tokenizer_sha256": tok_hash,
                "tokenizer_format": "ilarialex-v1",
                "protocol_start_id": 61_440,
                "byte_level": True,
                "stream_sha256": sha256_file(binary),
                "stream_bytes": binary.stat().st_size,
                "shards": 1,
                "shard_records": [],
            },
        )
        return meta_path

    train_meta = stream("train_stream", [1, 2, 61_440], 1)
    val_meta = stream("validation_stream", [3, 4, 61_440], 1)
    return {
        "curated": curated_path,
        "audit": audit_path,
        "rights": rights,
        "tokenizer": tokenizer,
        "train_meta": train_meta,
        "val_meta": val_meta,
        "train_shard": train,
    }


def build(paths):
    return build_dataset_manifest(
        str(paths["curated"]),
        audit_path=str(paths["audit"]),
        rights_registry_path=str(paths["rights"]),
        train_stream_meta_path=str(paths["train_meta"]),
        validation_stream_meta_path=str(paths["val_meta"]),
        tokenizer_path=str(paths["tokenizer"]),
    )


def make_first_party(paths, tmp_path):
    source_name = "fixture_source"
    rights = {
        "schema_version": 1,
        "policy": "fixture",
        "sources": {
            "unrelated_external": {
                "status": RIGHTS_APPROVED,
                "commercial_use_approved": True,
                "review_ref": "fixture-review",
            }
        },
    }
    atomic_write_json(paths["rights"], rights)

    owned = tmp_path / "owned-generator.py"
    owned.write_text("# first-party generator fixture\n", encoding="utf-8")
    attestation = build_attestation_template(tmp_path, paths=[owned.name])
    attestation.update(
        {
            "ownership_attested": True,
            "attested_by": "fixture-owner",
            "review_ref": "fixture-first-party-review",
        }
    )
    payload = dict(attestation)
    payload.pop("attestation_sha256", None)
    attestation["attestation_sha256"] = canonical_json_sha256(payload)
    attestation_path = tmp_path / "first-party.attestation.json"
    atomic_write_json(attestation_path, attestation)

    curated = json.loads(paths["curated"].read_text(encoding="utf-8"))
    curated.pop("curated_manifest_sha256", None)
    curated["rights"] = {
        "filename": paths["rights"].name,
        "sha256": sha256_file(paths["rights"]),
        "policy": "fixture",
        "approved_sources": [source_name],
        "external_approved_sources": [],
        "first_party_attestations": {
            source_name: {
                "status": "ATTESTED_FIRST_PARTY",
                "production_eligible": True,
                "filename": attestation_path.name,
                "file_sha256": sha256_file(attestation_path),
                "attestation_sha256": attestation["attestation_sha256"],
                "attestation_scope_sha256": attestation_scope_sha256(attestation),
                "error": None,
            }
        },
    }
    curated["curated_manifest_sha256"] = hashlib.sha256(
        canonical_json_bytes(curated)
    ).hexdigest()
    atomic_write_json(paths["curated"], curated)
    return attestation_path


def test_manifest_pins_curated_audit_rights_and_both_streams(tmp_path):
    paths = fixture(tmp_path)
    a = build(paths)
    b = build(paths)
    assert a == b
    assert len(a["dataset_manifest_sha256"]) == 64
    assert a["rights"]["approved_sources"] == ["fixture_source"]
    assert a["streams"]["train"]["tokens"] == 3
    assert a["streams"]["validation"]["tokens"] == 3
    assert (
        a["tokenizer"]["sha256"]
        == a["streams"]["train"]["tokenizer_sha256"]
    )


def test_manifest_rejects_unapproved_rights(tmp_path):
    paths = fixture(tmp_path, rights_status="REVIEW_REQUIRED")
    with pytest.raises(ValueError, match="not approved"):
        build(paths)


def test_manifest_accepts_attested_first_party_and_offline_validation(tmp_path):
    paths = fixture(tmp_path)
    attestation = make_first_party(paths, tmp_path)
    manifest = build_dataset_manifest(
        str(paths["curated"]),
        audit_path=str(paths["audit"]),
        rights_registry_path=str(paths["rights"]),
        train_stream_meta_path=str(paths["train_meta"]),
        validation_stream_meta_path=str(paths["val_meta"]),
        tokenizer_path=str(paths["tokenizer"]),
        first_party_attestations={"fixture_source": str(attestation)},
        first_party_root=str(tmp_path),
    )
    record = manifest["rights"]["first_party_attestations"]["fixture_source"]
    assert record["status"] == "ATTESTED_FIRST_PARTY"
    assert manifest["rights"]["external_approved_sources"] == []
    manifest_path = tmp_path / "dataset.manifest.json"
    atomic_write_json(manifest_path, manifest)
    assert validate_dataset_manifest_file(manifest_path) == manifest


def test_manifest_rejects_failed_post_curation_audit(tmp_path):
    paths = fixture(tmp_path)
    report = json.loads(paths["audit"].read_text())
    report["passed"] = False
    atomic_write_json(paths["audit"], report)
    with pytest.raises(ValueError, match="audit did not pass"):
        build(paths)


def test_manifest_rejects_curated_shard_tampering(tmp_path):
    paths = fixture(tmp_path)
    with paths["train_shard"].open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"text": "tamper"}) + "\n")
    with pytest.raises(ValueError, match="size mismatch|hash mismatch"):
        build(paths)


def test_manifest_rejects_validation_tokenizer_mismatch(tmp_path):
    paths = fixture(tmp_path)
    meta = json.loads(paths["val_meta"].read_text())
    meta["tokenizer_sha256"] = "d" * 64
    atomic_write_json(paths["val_meta"], meta)
    with pytest.raises(ValueError, match="tokenizer hash mismatch"):
        build(paths)


def test_manifest_rejects_train_validation_curriculum_presence_mismatch(tmp_path):
    paths = fixture(tmp_path)
    meta = json.loads(paths["train_meta"].read_text())
    lanes = []
    for lane in sorted({
        "general_knowledge", "code", "mathematics", "science_technical_reasoning",
        "os_hardware_drivers_standards", "agent_tool_trajectories",
        "romanian_multilingual", "world_device_trajectories",
    }):
        lanes.append(
            {
                "lane": lane,
                "target_ppm": 125000,
                "tokens": 1,
                "available_tokens": 1,
                "documents": 1,
                "inputs": [],
                "boundary_eos_replacement": True,
            }
        )
    curriculum = {
        "format": "ilaria-curriculum-stream-v1",
        "config_filename": "curriculum.json",
        "config_file_sha256": "e" * 64,
        "config_identity_sha256": "f" * 64,
        "policy": "exact-token-budget-v1",
        "boundary_policy": "replace-final-lane-token-with-eos-v1",
        "target_tokens": meta["tokens"],
        "lanes": lanes,
    }
    curriculum["curriculum_stream_sha256"] = hashlib.sha256(
        canonical_json_bytes(curriculum)
    ).hexdigest()
    meta["curriculum"] = curriculum
    atomic_write_json(paths["train_meta"], meta)
    with pytest.raises(ValueError, match="curriculum presence"):
        build(paths)

def test_file_validator_reconstructs_every_artifact(tmp_path):
    paths = fixture(tmp_path)
    manifest = build(paths)
    path = tmp_path / "dataset.manifest.json"
    atomic_write_json(path, manifest)
    assert validate_dataset_manifest_file(path) == manifest


def test_file_validator_detects_rights_registry_change(tmp_path):
    paths = fixture(tmp_path)
    manifest = build(paths)
    path = tmp_path / "dataset.manifest.json"
    atomic_write_json(path, manifest)
    rights = json.loads(paths["rights"].read_text())
    rights["policy"] = "tampered-after-build"
    atomic_write_json(paths["rights"], rights)
    with pytest.raises(ValueError, match="rights registry differs|differs from reconstructed"):
        validate_dataset_manifest_file(path)


def _attach_provenance(paths, *, records=None):
    curated_path = paths["curated"]
    curated = json.loads(curated_path.read_text(encoding="utf-8"))
    curated.pop("curated_manifest_sha256", None)
    source_name = curated["sources"][0]["source"]["name"]

    source_manifest = curated_path.parent / "fixture-source.manifest.json"
    source_manifest.write_text(
        json.dumps({"source": source_name, "revision": "v1"}) + "\n",
        encoding="utf-8",
    )
    manifest_sha256 = sha256_file(source_manifest)
    curated["sources"][0]["manifest_filename"] = source_manifest.name
    curated["sources"][0]["manifest_sha256"] = manifest_sha256

    raw_input = curated_path.parent / "raw-source.jsonl"
    raw_rows = [
        {"text": "synthetic source row one"},
        {"text": "synthetic source row two"},
    ]
    raw_input.write_text(
        "".join(json.dumps(row) + "\n" for row in raw_rows), encoding="utf-8"
    )
    curated["input_shards"] = [{
        "source_name": source_name,
        "filename": raw_input.name,
        "sha256": sha256_file(raw_input),
        "bytes": raw_input.stat().st_size,
        "lines": len(raw_rows),
        "documents": len(raw_rows),
    }]

    retained_fields = ["license", "identifier", "language"]
    required_fields = ["license", "identifier", "language"]
    if records is None:
        records = []
        document_hashes = []
        for split in ("train", "validation"):
            curated_record = curated["splits"][split][0]
            curated_shard = curated_path.parent / curated_record["filename"]
            row = json.loads(curated_shard.read_text(encoding="utf-8"))
            row["document_sha256"] = document_sha256(row["text"])
            curated_shard.write_text(json.dumps(row) + "\n", encoding="utf-8")
            curated_record["sha256"] = sha256_file(curated_shard)
            curated_record["bytes"] = curated_shard.stat().st_size
            document_hashes.append(row["document_sha256"])
        for index, document_hash in enumerate(document_hashes, 1):
            source_meta = curated["sources"][0]["source"]
            source_fields = {}
            for key in ("name", "provider", "config", "revision", "language", "license"):
                value = source_meta.get(key)
                source_fields[key] = (
                    {"status": "available", "verified": False, "value": value}
                    if value is not None and value != ""
                    else {"status": "unavailable", "verified": False}
                )
            item_metadata = {
                "license": "Public Domain",
                "identifier": f"synthetic-{index}",
                "language": "en",
            }
            records.append({
                "schema_version": 1,
                "format": "ilaria-document-provenance-v1",
                "document_sha256": document_hash,
                "source_provenance": {
                    "fields": source_fields,
                    "manifest_sha256": manifest_sha256,
                    "rights_refs": {},
                },
                "input": {
                    "shard_sha256": curated["input_shards"][0]["sha256"],
                    "line": index,
                },
                "item_metadata": item_metadata,
                "item_fields": {
                    "license": {"status": "available", "verified": False},
                    "identifier": {"status": "available", "verified": False},
                    "language": {"status": "available", "verified": False},
                    "date": {"status": "unavailable", "verified": False},
                    "creator": {"status": "unavailable", "verified": False},
                },
                "identifier_field": "identifier",
                "verification": "input-metadata-only; not item-rights approval",
            })

    curated["provenance"] = {
        "schema_version": 1,
        "format": "ilaria-document-provenance-v1",
        "verification": "input-metadata-only; not item-rights approval",
        "required_fields": {source_name: required_fields},
        "retained_item_fields": {source_name: retained_fields},
        "shards": [],
    }

    # Bind each curated row to the canonical sidecar record digest.
    for split, record in zip(("train", "validation"), records):
        document_hash = record["document_sha256"]
        curated_record = curated["splits"][split][0]
        curated_shard = curated_path.parent / curated_record["filename"]
        row = json.loads(curated_shard.read_text(encoding="utf-8"))
        assert row["document_sha256"] == document_hash
        row["provenance_sha256"] = canonical_json_sha256(record)
        curated_shard.write_text(json.dumps(row) + "\n", encoding="utf-8")
        curated_record["sha256"] = sha256_file(curated_shard)
        curated_record["bytes"] = curated_shard.stat().st_size

    sidecar_bytes = "".join(
        json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        for record in records
    ).encode("utf-8")
    sidecar_sha256 = hashlib.sha256(sidecar_bytes).hexdigest()
    sidecar_name = f"provenance-{sidecar_sha256}.jsonl"
    (curated_path.parent / sidecar_name).write_bytes(sidecar_bytes)
    curated["provenance"]["shards"] = [{
        "index": 0,
        "filename": sidecar_name,
        "sha256": sidecar_sha256,
        "bytes": len(sidecar_bytes),
        "documents": len(records),
    }]
    audit_report = audit(
        [str(paths["train_shard"]),
         str(curated_path.parent / curated["splits"]["validation"][0]["filename"])],
        [],
        shingle_width=6,
    )
    atomic_write_json(paths["audit"], audit_report)
    curated["rights"]["sha256"] = sha256_file(paths["rights"])
    curated["curated_manifest_sha256"] = canonical_json_sha256(curated)
    atomic_write_json(curated_path, curated)
    return records, sidecar_name


def test_manifest_validates_provenance_bindings_and_pins_scope(tmp_path):
    paths = fixture(tmp_path)
    _attach_provenance(paths)
    manifest = build(paths)
    receipt = manifest["curated_corpus"]["provenance"]
    assert receipt["validation_scope"] == "manifest-bindings"
    assert receipt["verification"] == "input-metadata-only; not item-rights approval"
    assert receipt["documents"] == 2
    manifest_path = tmp_path / "dataset.manifest.json"
    atomic_write_json(manifest_path, manifest)
    assert validate_dataset_manifest_file(manifest_path) == manifest


@pytest.mark.parametrize("failure", ["missing", "truncated", "path_escape", "duplicate", "cross_link"])
def test_manifest_rejects_invalid_provenance_sidecar(tmp_path, failure):
    paths = fixture(tmp_path)
    records, sidecar_name = _attach_provenance(paths)
    curated = json.loads(paths["curated"].read_text(encoding="utf-8"))
    sidecar_path = tmp_path / sidecar_name

    if failure == "missing":
        sidecar_path.unlink()
        expected_error = "missing curated provenance shard"
    elif failure == "truncated":
        sidecar_path.write_bytes(sidecar_path.read_bytes()[:-3])
        expected_error = "provenance shard hash/size mismatch"
    elif failure == "path_escape":
        curated["provenance"]["shards"][0]["filename"] = "../" + sidecar_name
        expected_error = "filename/hash mismatch"
    elif failure == "duplicate":
        duplicate = records[0]
        content = (json.dumps(duplicate, sort_keys=True, separators=(",", ":"))
                   + "\n" + json.dumps(duplicate, sort_keys=True,
                                        separators=(",", ":")) + "\n")
        sidecar_path.unlink()
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        sidecar_path = tmp_path / f"provenance-{digest}.jsonl"
        sidecar_path.write_bytes(content.encode("utf-8"))
        curated["provenance"]["shards"] = [{
            "index": 0, "filename": sidecar_path.name, "sha256": digest,
            "bytes": sidecar_path.stat().st_size, "documents": 2,
        }]
        expected_error = "duplicate input shard/line binding"
    else:
        changed = dict(records[0])
        changed["document_sha256"] = "f" * 64
        content = (json.dumps(changed, sort_keys=True, separators=(",", ":")) + "\n"
                   + json.dumps(records[1], sort_keys=True, separators=(",", ":")) + "\n")
        sidecar_path.unlink()
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        sidecar_path = tmp_path / f"provenance-{digest}.jsonl"
        sidecar_path.write_bytes(content.encode("utf-8"))
        curated["provenance"]["shards"] = [{
            "index": 0, "filename": sidecar_path.name, "sha256": digest,
            "bytes": sidecar_path.stat().st_size, "documents": 2,
        }]
        expected_error = "does not bind to one curated row"

    curated.pop("curated_manifest_sha256", None)
    curated["curated_manifest_sha256"] = canonical_json_sha256(curated)
    atomic_write_json(paths["curated"], curated)
    with pytest.raises(ValueError, match=expected_error):
        build(paths)


def test_item_license_metadata_does_not_approve_unapproved_source(tmp_path):
    paths = fixture(tmp_path, rights_status="REVIEW_REQUIRED")
    _attach_provenance(paths)
    with pytest.raises(ValueError, match="not approved"):
        build(paths)


def test_manifest_rejects_text_tampering_after_shard_and_manifest_rehash(tmp_path):
    paths = fixture(tmp_path)
    _attach_provenance(paths)
    curated = json.loads(paths["curated"].read_text(encoding="utf-8"))
    row = json.loads(paths["train_shard"].read_text(encoding="utf-8"))
    row["text"] = "tampered but fully rehashed text"
    paths["train_shard"].write_text(json.dumps(row) + "\n", encoding="utf-8")
    curated["splits"]["train"][0].update(
        sha256=sha256_file(paths["train_shard"]),
        bytes=paths["train_shard"].stat().st_size,
    )
    validation_shard = tmp_path / curated["splits"]["validation"][0]["filename"]
    audit_report = audit(
        [str(paths["train_shard"]), str(validation_shard)], [], shingle_width=6
    )
    atomic_write_json(paths["audit"], audit_report)
    curated.pop("curated_manifest_sha256", None)
    curated["curated_manifest_sha256"] = canonical_json_sha256(curated)
    atomic_write_json(paths["curated"], curated)

    with pytest.raises(ValueError, match="document hash does not match normalized text"):
        build(paths)


def test_manifest_rejects_curated_shard_path_escape_with_provenance(tmp_path):
    paths = fixture(tmp_path)
    _attach_provenance(paths)
    curated = json.loads(paths["curated"].read_text(encoding="utf-8"))
    curated["splits"]["train"][0]["filename"] = "../outside-train.jsonl"
    curated.pop("curated_manifest_sha256", None)
    curated["curated_manifest_sha256"] = canonical_json_sha256(curated)
    atomic_write_json(paths["curated"], curated)

    with pytest.raises(ValueError, match="curated shard filename is invalid|curated shard path escapes"):
        build(paths)


@pytest.mark.parametrize("binding", ["manifest_hash", "revision", "input_hash", "line"])
def test_manifest_rejects_provenance_source_and_input_mismatch(tmp_path, binding):
    paths = fixture(tmp_path)
    records, old_sidecar_name = _attach_provenance(paths)
    changed = json.loads(json.dumps(records[0]))
    if binding == "manifest_hash":
        changed["source_provenance"]["manifest_sha256"] = "0" * 64
        expected_error = "source manifest/revision binding mismatch"
    elif binding == "revision":
        changed["source_provenance"]["fields"]["revision"]["value"] = "v2"
        expected_error = "source manifest/revision binding mismatch"
    elif binding == "input_hash":
        changed["input"]["shard_sha256"] = "0" * 64
        expected_error = "input shard/line is not in curated lineage"
    else:
        changed["input"]["line"] = 3
        expected_error = "input shard/line is not in curated lineage"

    records[0] = changed
    content = "".join(
        json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        for record in records
    ).encode("utf-8")
    digest = hashlib.sha256(content).hexdigest()
    new_sidecar_name = f"provenance-{digest}.jsonl"
    (tmp_path / old_sidecar_name).unlink()
    (tmp_path / new_sidecar_name).write_bytes(content)
    curated = json.loads(paths["curated"].read_text(encoding="utf-8"))
    curated.pop("curated_manifest_sha256", None)
    curated["provenance"]["shards"] = [{
        "index": 0, "filename": new_sidecar_name, "sha256": digest,
        "bytes": len(content), "documents": len(records),
    }]
    curated["curated_manifest_sha256"] = canonical_json_sha256(curated)
    atomic_write_json(paths["curated"], curated)
    with pytest.raises(ValueError, match=expected_error):
        build(paths)


def _curator_round_trip(tmp_path, source_names, *, required_fields=None):
    paths = fixture(tmp_path)
    rights_sources = {
        name: {
            "status": RIGHTS_APPROVED,
            "commercial_use_approved": True,
            "review_ref": "synthetic-review",
        }
        for name in source_names
    }
    atomic_write_json(paths["rights"], {
        "schema_version": 1,
        "policy": "synthetic-fixture-only",
        "sources": rights_sources,
    })

    manifests = []
    for source_name in source_names:
        raw_shard = tmp_path / f"{source_name}-raw.jsonl"
        rows = []
        for index in range(32):
            row = {
                "text": f"{source_name} synthetic training record number {index} with enough words",
                "language": "en",
                "identifier": f"{source_name}-record-{index}",
            }
            if source_name == "alpha":
                row["license"] = "CC0-1.0"
            rows.append(row)
        raw_shard.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        manifest_path = tmp_path / f"{source_name}.manifest.json"
        atomic_write_json(manifest_path, {
            "schema_version": 2,
            "source": {
                "name": source_name,
                "provider": "synthetic/provider",
                "revision": "synthetic-revision-1",
                "language": "en",
            },
            "pipeline": {"name": "synthetic-source"},
            "docs": len(rows),
            "shards": 1,
            "complete": [0],
            "raw_rows": len(rows),
            "shard_records": [{
                "index": 0,
                "filename": raw_shard.name,
                "sha256": sha256_file(raw_shard),
                "bytes": raw_shard.stat().st_size,
                "documents": len(rows),
            }],
        })
        manifests.append(str(manifest_path))

    output = tmp_path / "producer-curated"
    curated = curate(
        manifests,
        rights_registry_path=str(paths["rights"]),
        benchmark_paths=[],
        out_dir=str(output),
        validation_fraction=0.5,
        preserve_provenance=True,
        provenance_policy=required_fields,
    )
    split_paths = [
        str(output / shard["filename"])
        for split in ("train", "validation")
        for shard in curated["splits"][split]
    ]
    atomic_write_json(paths["audit"], audit(split_paths, [], shingle_width=6))
    paths["curated"] = output / "curated.manifest.json"
    return paths, curated


def test_curator_default_preserve_provenance_round_trips_into_dataset_manifest(tmp_path):
    paths, curated = _curator_round_trip(tmp_path, ["fixture_source"])
    assert curated["provenance"]["required_fields"] == {}
    validated, _, receipt = _validate_curated(paths["curated"])
    assert validated["provenance"]["retained_item_fields"] == {
        "fixture_source": ["language", "license", "license_expression"]
    }
    assert receipt["validation_scope"] == "manifest-bindings"
    assert build(paths)["curated_corpus"]["provenance"]["documents"] == 32


def test_curator_partial_provenance_policy_round_trips_for_multiple_sources(tmp_path):
    paths, curated = _curator_round_trip(
        tmp_path, ["alpha", "beta"], required_fields={"alpha": ["license"]}
    )
    assert curated["provenance"]["required_fields"] == {"alpha": ["license"]}
    assert build(paths)["curated_corpus"]["provenance"]["documents"] == 64
