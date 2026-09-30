from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from curriculum_stream import (
    REQUIRED_LANES,
    allocate_token_budget,
    build_curriculum_stream,
    load_curriculum,
    validate_curriculum_stream,
)
from data_contract import TOKEN_STREAM_FORMAT, atomic_write_json, sha256_file


TOKENIZER_HASH = "a" * 64


def write_stream(tmp_path: Path, name: str, tokens: int):
    prefix = tmp_path / name
    values = np.arange(tokens, dtype=np.uint16) % 100
    values[9::10] = 61_440
    values.tofile(str(prefix) + ".bin")
    atomic_write_json(
        str(prefix) + ".json",
        {
            "format": TOKEN_STREAM_FORMAT,
            "vocab_size": 65_536,
            "eos_id": 61_440,
            "dtype": "uint16",
            "tokens": tokens,
            "documents": int(np.count_nonzero(values == 61_440)),
            "tokenizer": "ilarialex.json",
            "tokenizer_sha256": TOKENIZER_HASH,
            "tokenizer_format": "ilarialex-v1",
            "protocol_start_id": 61_440,
            "byte_level": True,
        },
    )
    return str(prefix)


def curriculum_path():
    return Path(__file__).resolve().parent / "config" / "imc_125m_curriculum.json"


def test_canonical_curriculum_is_exact_100_percent():
    config = load_curriculum(curriculum_path())
    assert set(config["target_mix_ppm"]) == REQUIRED_LANES
    assert sum(config["target_mix_ppm"].values()) == 1_000_000
    assert config["target_mix_ppm"]["general_knowledge"] == 300_000
    assert config["target_mix_ppm"]["code"] == 220_000
    assert config["target_mix_ppm"]["romanian_multilingual"] == 0


def test_token_allocator_is_exact_for_arbitrary_total():
    config = load_curriculum(curriculum_path())
    quotas = allocate_token_budget(101, config["target_mix_ppm"])
    assert sum(quotas.values()) == 101
    assert quotas["romanian_multilingual"] == 0
    assert all(
        value > 0
        for lane, value in quotas.items()
        if lane != "romanian_multilingual"
    )


def test_curriculum_stream_materializes_exact_mix_and_hash(tmp_path):
    lanes = {
        lane: ([] if lane == "romanian_multilingual" else [write_stream(tmp_path, lane, 100)])
        for lane in REQUIRED_LANES
    }
    out = str(tmp_path / "mixed")
    meta = build_curriculum_stream(
        curriculum_path(), lanes=lanes, out_prefix=out, target_tokens=100
    )
    validated = validate_curriculum_stream(out, curriculum_path=curriculum_path())
    assert validated == meta
    assert meta["tokens"] == 100
    assert meta["stream_sha256"] == sha256_file(out + ".bin")
    quotas = allocate_token_budget(100, load_curriculum(curriculum_path())["target_mix_ppm"])
    observed = {record["lane"]: record["tokens"] for record in meta["curriculum"]["lanes"]}
    assert observed == quotas
    mixed = np.fromfile(out + ".bin", dtype=np.uint16)
    assert len(mixed) == 100
    offset = 0
    for lane in sorted(REQUIRED_LANES):
        if quotas[lane] == 0:
            continue
        offset += quotas[lane]
        assert mixed[offset - 1] == 61_440


def test_curriculum_stream_rejects_insufficient_lane(tmp_path):
    lanes = {
        lane: ([] if lane == "romanian_multilingual" else [write_stream(tmp_path, lane, 100)])
        for lane in REQUIRED_LANES
    }
    lanes["general_knowledge"] = [write_stream(tmp_path, "tiny-general", 5)]
    with pytest.raises(ValueError, match="insufficient"):
        build_curriculum_stream(
            curriculum_path(),
            lanes=lanes,
            out_prefix=str(tmp_path / "mixed"),
            target_tokens=100,
        )


def test_curriculum_stream_rejects_tokenizer_drift(tmp_path):
    lanes = {
        lane: ([] if lane == "romanian_multilingual" else [write_stream(tmp_path, lane, 100)])
        for lane in REQUIRED_LANES
    }
    bad_prefix = lanes["code"][0]
    meta = json.loads(Path(bad_prefix + ".json").read_text(encoding="utf-8"))
    meta["tokenizer_sha256"] = "b" * 64
    atomic_write_json(bad_prefix + ".json", meta)
    with pytest.raises(ValueError, match="tokenizer_sha256"):
        build_curriculum_stream(
            curriculum_path(),
            lanes=lanes,
            out_prefix=str(tmp_path / "mixed"),
            target_tokens=100,
        )


def test_zero_weight_lane_rejects_accidental_input(tmp_path):
    lanes = {
        lane: ([] if lane == "romanian_multilingual" else [write_stream(tmp_path, lane, 100)])
        for lane in REQUIRED_LANES
    }
    lanes["romanian_multilingual"] = [write_stream(tmp_path, "romanian-unexpected", 100)]
    with pytest.raises(ValueError, match="zero weight"):
        build_curriculum_stream(
            curriculum_path(),
            lanes=lanes,
            out_prefix=str(tmp_path / "mixed"),
            target_tokens=100,
        )
