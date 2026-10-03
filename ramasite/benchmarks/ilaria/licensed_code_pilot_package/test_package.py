import json
import hashlib
from pathlib import Path
import struct

import pytest

from package import (
    STATUS,
    canonical_json_sha256,
    family_key,
    group_components,
    split_for_group,
    validate_package_manifest,
)


def _alias(source, revision, path, digest):
    return {
        "source": source,
        "revision": revision,
        "path": path,
        "body_byte_sha256": digest,
    }


def test_alias_body_edges_transitively_join_module_families_into_one_split():
    body_one = "1" * 64
    body_two = "2" * 64
    aliases = [
        _alias("repo-a", "rev-a", "subsys/net/one.c", body_one),
        _alias("repo-b", "rev-b", "drivers/gpio/two.c", body_one),
        _alias("repo-b", "rev-b", "drivers/gpio/three.c", body_two),
        _alias("repo-c", "rev-c", "kernel/sched/four.c", body_two),
        _alias("repo-a", "rev-a", "subsys/net/five.c", "3" * 64),
    ]
    groups = group_components(aliases)
    assert groups[body_one] == groups[body_two]
    assert groups["3" * 64] == groups[body_one]
    seed = "test-seed"
    assert split_for_group(groups[body_one], seed) == split_for_group(groups[body_two], seed)
    assert family_key(aliases[0]) == family_key(aliases[4])


def test_unsafe_repository_paths_fail_closed():
    with pytest.raises(ValueError, match="unsafe"):
        family_key(_alias("repo", "rev", "../outside.c", "a" * 64))


def _valid_package(tmp_path: Path) -> Path:
    counts = {}
    split_groups = {}
    tokenizer_sha = "c" * 64
    for split in ("train", "validation", "sealed"):
        body = str({"train": 1, "validation": 2, "sealed": 3}[split]) * 64
        row = {
            "schema": "ilaria-licensed-code-scale-validation-row-v1",
            "text": "synthetic code",
            "source_group": f"group-{split}",
            "split": split,
            "body_byte_sha256": body,
            "source_provenance": [{
                "source": "synthetic", "revision": "revision",
                "path": f"{split}/file.c", "spdx": "MIT",
                "file_sha256": "a" * 64,
            }],
            "tokens_including_eos": 2,
        }
        stream_bytes = struct.pack("<HH", 23, 61440)
        stream_meta = {
            "format": "ilaria-token-stream-v1",
            "vocab_size": 65536,
            "eos_id": 61440,
            "dtype": "uint16",
            "tokens": 2,
            "documents": 1,
            "stream_sha256": hashlib.sha256(stream_bytes).hexdigest(),
            "tokenizer": "ilarialex.json",
            "tokenizer_sha256": tokenizer_sha,
            "tokenizer_format": "ilarialex-v1",
            "protocol_start_id": 61440,
            "byte_level": True,
        }
        artifacts = {
            f"{split}.jsonl": (json.dumps(row) + "\n").encode(),
            f"{split}.tokens.bin": stream_bytes,
            f"{split}.tokens.json": json.dumps(stream_meta).encode(),
        }
        for name, payload in artifacts.items():
            (tmp_path / name).write_bytes(payload)
        counts[split] = {
            "documents": 1,
            "tokens_including_eos": 2,
            "jsonl_sha256": hashlib.sha256(artifacts[f"{split}.jsonl"]).hexdigest(),
            "jsonl_bytes": len(artifacts[f"{split}.jsonl"]),
            "stream_sha256": hashlib.sha256(artifacts[f"{split}.tokens.bin"]).hexdigest(),
            "stream_bytes": len(artifacts[f"{split}.tokens.bin"]),
            "stream_metadata_sha256": hashlib.sha256(artifacts[f"{split}.tokens.json"]).hexdigest(),
            "stream_metadata_bytes": len(artifacts[f"{split}.tokens.json"]),
        }
        split_groups[split] = 1
    manifest = {
        "format": "ilaria-licensed-code-scale-validation-v1",
        "status": STATUS,
        "production_dataset_approved": False,
        "tokenizer_sha256": tokenizer_sha,
        "eos_id": 61440,
        "eos_token": "<|ilaria:eos|>",
        "minimum_tokens": {"train": 1, "validation": 1, "sealed": 1},
        "counts": counts,
        "group_counts": {"split_group_counts": split_groups},
    }
    manifest["package_sha256"] = canonical_json_sha256(manifest)
    (tmp_path / "code-only-pilot-package.json").write_text(
        json.dumps(manifest), encoding="utf-8")
    return tmp_path


def test_package_manifest_detects_stream_tampering(tmp_path):
    package = _valid_package(tmp_path)
    assert validate_package_manifest(package)["status"] == STATUS
    with (package / "validation.tokens.bin").open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="hash/size mismatch"):
        validate_package_manifest(package)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("dtype", "uint32", "dtype/vocabulary mismatch"),
        ("tokenizer_sha256", "d" * 64, "tokenizer contract mismatch"),
        ("tokens", 3, "metadata/accounting mismatch"),
    ],
)
def test_package_rejects_resealed_noncanonical_stream_metadata(tmp_path, field, value, message):
    package = _valid_package(tmp_path)
    manifest_path = package / "code-only-pilot-package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    metadata_path = package / "train.tokens.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata[field] = value
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    entry = manifest["counts"]["train"]
    entry["stream_metadata_sha256"] = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
    entry["stream_metadata_bytes"] = metadata_path.stat().st_size
    manifest.pop("package_sha256")
    manifest["package_sha256"] = canonical_json_sha256(manifest)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        validate_package_manifest(package)


def test_manifest_tampering_fails_closed(tmp_path):
    package = _valid_package(tmp_path)
    manifest_path = package / "code-only-pilot-package.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["production_dataset_approved"] = True
    manifest_path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="manifest hash mismatch"):
        validate_package_manifest(package)
