import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from data_audit import audit  # noqa: E402
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
    validate_dataset_manifest_file,
)
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
