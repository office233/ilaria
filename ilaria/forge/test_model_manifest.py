import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hf_tokenizer import (  # noqa: E402
    EOS,
    ILARIALEX_BASE_VOCAB_SIZE,
    ILARIALEX_FORMAT,
    ILARIALEX_PROTOCOL_RESERVED,
    ILARIALEX_VOCAB_SIZE,
)
from imc_model import ImcConfig  # noqa: E402
from model_manifest import (  # noqa: E402
    build_manifest,
    load_tokenizer_identity,
    validate_architecture_manifest_file,
    write_manifest,
)

HASH_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
HASH_B = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"


def tokenizer_identity():
    return {
        "format": ILARIALEX_FORMAT,
        "vocab_size": ILARIALEX_VOCAB_SIZE,
        "base_vocab_size": ILARIALEX_BASE_VOCAB_SIZE,
        "protocol_reserved": ILARIALEX_PROTOCOL_RESERVED,
        "protocol_start_id": ILARIALEX_BASE_VOCAB_SIZE,
        "eos_id": ILARIALEX_BASE_VOCAB_SIZE,
        "eos_token": EOS,
        "sha256": HASH_A,
    }


def manifest(max_seq_len=2048):
    identity = tokenizer_identity()
    cfg = ImcConfig.preset(
        "imc-1b",
        vocab_size=identity["vocab_size"],
        max_seq_len=max_seq_len,
        eos_token_id=identity["eos_id"],
        ternary=True,
    )
    return build_manifest(
        cfg,
        preset="imc-1b",
        tokenizer_identity=identity,
        source_sha256=HASH_B,
    )


def test_imc_1b_manifest_is_exact_and_deterministic():
    a = manifest()
    b = manifest()
    assert a == b
    assert a["parameter_count"] == 1_000_555_520
    assert a["model_family"] == "IMC"
    assert a["architecture_version"] == "ilaria-microcortex-v1"
    assert a["config"]["ternary"] is True
    assert a["config"]["eos_token_id"] == 61_440
    assert a["tokenizer"]["protocol_start_id"] == 61_440
    assert len(a["architecture_hash"]) == 64


def test_architecture_change_changes_hash():
    assert (
        manifest(2048)["architecture_hash"]
        != manifest(4096)["architecture_hash"]
    )


def test_manifest_write_is_stable(tmp_path):
    path = tmp_path / "architecture.json"
    first = manifest()
    write_manifest(path, first)
    raw1 = path.read_bytes()
    write_manifest(path, first)
    raw2 = path.read_bytes()
    assert raw1 == raw2
    assert json.loads(raw2) == first


def test_model_manifest_rejects_tokenizer_eos_drift():
    identity = tokenizer_identity()
    cfg = ImcConfig.preset(
        "imc-1b",
        vocab_size=ILARIALEX_VOCAB_SIZE,
        eos_token_id=3,
        ternary=True,
    )
    with pytest.raises(ValueError, match="EOS"):
        build_manifest(
            cfg,
            preset="imc-1b",
            tokenizer_identity=identity,
            source_sha256=HASH_B,
        )


def test_load_tokenizer_identity_pins_canonical_layout(tmp_path):
    path = tmp_path / "ilarialex.json"
    path.write_text(
        json.dumps(
            {
                "format": ILARIALEX_FORMAT,
                "vocab_size": ILARIALEX_VOCAB_SIZE,
                "base_vocab_size": ILARIALEX_BASE_VOCAB_SIZE,
                "protocol_reserved": ILARIALEX_PROTOCOL_RESERVED,
                "protocol_start_id": ILARIALEX_BASE_VOCAB_SIZE,
                "eos_id": ILARIALEX_BASE_VOCAB_SIZE,
                "eos_token": EOS,
            }
        ),
        encoding="utf-8",
    )
    identity = load_tokenizer_identity(path)
    assert identity["vocab_size"] == 65_536
    assert identity["eos_id"] == 61_440
    assert len(identity["sha256"]) == 64


def test_load_tokenizer_identity_rejects_noncanonical_vocab(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(
        json.dumps(
            {
                "format": ILARIALEX_FORMAT,
                "vocab_size": 32_000,
                "base_vocab_size": 31_000,
                "protocol_reserved": 1_000,
                "protocol_start_id": 31_000,
                "eos_id": 31_000,
                "eos_token": EOS,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="65536"):
        load_tokenizer_identity(path)


@pytest.mark.parametrize("field,value", [
    ("base_vocab_size", 61439), ("protocol_start_id", 61439),
    ("eos_id", 3), ("eos_token", "<wrong:eos>"), ("vocab_size", "65536"),
])
def test_load_tokenizer_identity_rejects_protocol_layout_drift(tmp_path, field, value):
    data = tokenizer_identity()
    data[field] = value
    path = tmp_path / "tokenizer.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match=field):
        load_tokenizer_identity(path)


@pytest.mark.parametrize("field,value", [
    ("parameter_count", 1), ("config_sha256", "c" * 64),
    ("source_sha256", "ab" * 31 + "  "),
])
def test_architecture_validator_rejects_semantic_tampering_even_with_recomputed_identity(tmp_path, field, value):
    from data_contract import canonical_json_sha256

    data = manifest()
    data[field] = value
    data.pop("architecture_hash")
    data["architecture_hash"] = canonical_json_sha256(data)
    path = tmp_path / "architecture.json"
    write_manifest(path, data)
    with pytest.raises(ValueError):
        validate_architecture_manifest_file(path)


def test_architecture_validator_accepts_reconstructed_contract(tmp_path):
    path = tmp_path / "architecture.json"
    write_manifest(path, manifest())
    assert validate_architecture_manifest_file(path) == manifest()


def test_architecture_manifest_rejects_incorrect_preset_label():
    identity = tokenizer_identity()
    cfg = ImcConfig.preset("imc-125m", vocab_size=identity["vocab_size"], eos_token_id=identity["eos_id"])
    with pytest.raises(ValueError, match="preset"):
        build_manifest(cfg, preset="imc-1b", tokenizer_identity=identity, source_sha256=HASH_B)
