"""Materialize an exact-token curriculum stream from canonical lane streams."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np

try:
    from .atomic_io import atomic_binary_writer
    from .concat_streams import _COMPAT_KEYS, _meta
    from .data_contract import (
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        canonical_json_sha256,
        require_lower_sha256,
        sha256_file,
    )
except ImportError:  # direct script execution
    from atomic_io import atomic_binary_writer
    from concat_streams import _COMPAT_KEYS, _meta
    from data_contract import (
        TOKEN_STREAM_FORMAT,
        atomic_write_json,
        canonical_json_sha256,
        require_lower_sha256,
        sha256_file,
    )

CURRICULUM_FORMAT = "imc-125m-curriculum-v1"
STREAM_CURRICULUM_FORMAT = "ilaria-curriculum-stream-v1"
PPM_TOTAL = 1_000_000
REQUIRED_LANES = frozenset(
    {
        "general_knowledge",
        "code",
        "mathematics",
        "science_technical_reasoning",
        "os_hardware_drivers_standards",
        "agent_tool_trajectories",
        "romanian_multilingual",
        "world_device_trajectories",
    }
)
_DTYPES = {"uint16": np.dtype("<u2"), "uint32": np.dtype("<u4")}


def _identity_hash(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def load_curriculum(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        config = json.load(stream)
    if not isinstance(config, dict) or config.get("format") != CURRICULUM_FORMAT:
        raise ValueError("unsupported IMC-125M curriculum format")
    if config.get("policy") != "exact-token-budget-v1":
        raise ValueError("unsupported IMC-125M curriculum policy")
    if config.get("boundary_policy") != "replace-final-lane-token-with-eos-v1":
        raise ValueError("unsupported IMC-125M curriculum boundary policy")
    mix = config.get("target_mix_ppm")
    if not isinstance(mix, dict) or set(mix) != REQUIRED_LANES:
        raise ValueError("IMC-125M curriculum lane set mismatch")
    if any(type(value) is not int or value < 0 for value in mix.values()):
        raise ValueError("IMC-125M curriculum weights must be non-negative integer ppm")
    if not any(value > 0 for value in mix.values()):
        raise ValueError("IMC-125M curriculum requires at least one positive lane weight")
    if sum(mix.values()) != PPM_TOTAL:
        raise ValueError("IMC-125M curriculum weights must sum to 1,000,000 ppm")
    config = dict(config)
    config["curriculum_sha256"] = canonical_json_sha256(config)
    return config


def allocate_token_budget(total_tokens: int, weights_ppm: dict[str, int]) -> dict[str, int]:
    """Largest-remainder allocation whose lane quotas sum exactly to total_tokens."""
    if type(total_tokens) is not int or total_tokens < 1:
        raise ValueError("curriculum total_tokens must be a positive integer")
    if not weights_ppm or sum(weights_ppm.values()) != PPM_TOTAL:
        raise ValueError("curriculum weights must sum to 1,000,000 ppm")
    raw = {
        lane: total_tokens * ppm
        for lane, ppm in weights_ppm.items()
    }
    quotas = {lane: value // PPM_TOTAL for lane, value in raw.items()}
    remaining = total_tokens - sum(quotas.values())
    remainders = sorted(
        ((value % PPM_TOTAL, lane) for lane, value in raw.items()),
        key=lambda item: (-item[0], item[1]),
    )
    for _, lane in remainders[:remaining]:
        quotas[lane] += 1
    if sum(quotas.values()) != total_tokens:
        raise AssertionError("curriculum token allocation does not sum to target")
    return quotas


def _compatible_lane_inputs(
    lanes: dict[str, list[str]],
    weights_ppm: dict[str, int],
) -> tuple[dict, dict[str, list[dict]]]:
    if set(lanes) != REQUIRED_LANES:
        raise ValueError("curriculum input lane set mismatch")
    lane_metas: dict[str, list[dict]] = {}
    reference = None
    for lane in sorted(REQUIRED_LANES):
        prefixes = lanes[lane]
        if not isinstance(prefixes, list):
            raise ValueError(f"curriculum lane {lane!r} inputs must be a list")
        if weights_ppm[lane] > 0 and not prefixes:
            raise ValueError(f"curriculum lane {lane!r} has no token streams")
        if weights_ppm[lane] == 0 and prefixes:
            raise ValueError(
                f"curriculum lane {lane!r} has zero weight but token streams were supplied"
            )
        metas = [_meta(prefix) for prefix in prefixes]
        lane_metas[lane] = metas
        for prefix, meta in zip(prefixes, metas):
            if reference is None:
                reference = meta
            for key in _COMPAT_KEYS:
                if meta.get(key) != reference.get(key):
                    raise ValueError(
                        f"curriculum stream {prefix}: {key} differs from tokenizer contract"
                    )
    if reference is None:
        raise ValueError("curriculum has no positive-weight token stream")
    return reference, lane_metas


def build_curriculum_stream(
    curriculum_path: str | Path,
    *,
    lanes: dict[str, list[str]],
    out_prefix: str,
    target_tokens: int,
) -> dict:
    config = load_curriculum(curriculum_path)
    quotas = allocate_token_budget(target_tokens, config["target_mix_ppm"])
    reference, lane_metas = _compatible_lane_inputs(
        lanes, config["target_mix_ppm"]
    )
    dtype = _DTYPES[reference["dtype"]]
    eos = int(reference["eos_id"])

    availability = {
        lane: sum(meta["tokens"] for meta in lane_metas[lane])
        for lane in REQUIRED_LANES
    }
    insufficient = {
        lane: {"required": quotas[lane], "available": availability[lane]}
        for lane in REQUIRED_LANES
        if availability[lane] < quotas[lane]
    }
    if insufficient:
        raise ValueError(f"curriculum lane token budget is insufficient: {insufficient}")

    os.makedirs(os.path.dirname(os.path.abspath(out_prefix)), exist_ok=True)
    lane_records = []
    documents = 0
    with atomic_binary_writer(out_prefix + ".bin") as out:
        for lane in sorted(REQUIRED_LANES):
            remaining = quotas[lane]
            input_records = []
            lane_documents = 0
            for prefix, meta in zip(lanes[lane], lane_metas[lane]):
                if remaining <= 0:
                    break
                take = min(remaining, int(meta["tokens"]))
                array = np.memmap(prefix + ".bin", dtype=dtype, mode="r", shape=(meta["tokens"],))
                final_piece = take == remaining
                if final_piece:
                    if take > 1:
                        body = np.asarray(array[: take - 1], dtype=dtype)
                        out.write(body.tobytes(order="C"))
                        lane_documents += int(np.count_nonzero(body == eos))
                    out.write(np.asarray([eos], dtype=dtype).tobytes(order="C"))
                    lane_documents += 1
                else:
                    body = np.asarray(array[:take], dtype=dtype)
                    out.write(body.tobytes(order="C"))
                    lane_documents += int(np.count_nonzero(body == eos))
                input_records.append(
                    {
                        "prefix": os.path.basename(prefix),
                        "bin_sha256": sha256_file(prefix + ".bin"),
                        "meta_sha256": sha256_file(prefix + ".json"),
                        "available_tokens": int(meta["tokens"]),
                        "tokens_used": take,
                    }
                )
                remaining -= take
            if remaining != 0:
                raise AssertionError(f"curriculum lane {lane} was not fully materialized")
            documents += lane_documents
            lane_records.append(
                {
                    "lane": lane,
                    "target_ppm": config["target_mix_ppm"][lane],
                    "tokens": quotas[lane],
                    "available_tokens": availability[lane],
                    "documents": lane_documents,
                    "inputs": input_records,
                    "boundary_eos_replacement": quotas[lane] > 0,
                }
            )

    stream_path = out_prefix + ".bin"
    curriculum_meta = {
        "format": STREAM_CURRICULUM_FORMAT,
        "config_filename": Path(curriculum_path).name,
        "config_file_sha256": sha256_file(curriculum_path),
        "config_identity_sha256": config["curriculum_sha256"],
        "policy": config["policy"],
        "boundary_policy": config["boundary_policy"],
        "target_tokens": target_tokens,
        "lanes": lane_records,
    }
    curriculum_meta["curriculum_stream_sha256"] = _identity_hash(
        curriculum_meta, "curriculum_stream_sha256"
    )
    metadata = {
        "format": TOKEN_STREAM_FORMAT,
        "vocab_size": reference["vocab_size"],
        "eos_id": eos,
        "dtype": reference["dtype"],
        "tokens": target_tokens,
        "documents": documents,
        "tokenizer": reference["tokenizer"],
        "tokenizer_sha256": reference["tokenizer_sha256"],
        "tokenizer_format": reference["tokenizer_format"],
        "protocol_start_id": reference["protocol_start_id"],
        "byte_level": True,
        "stream_sha256": sha256_file(stream_path),
        "stream_bytes": os.path.getsize(stream_path),
        "curriculum": curriculum_meta,
    }
    atomic_write_json(out_prefix + ".json", metadata)
    return metadata


def validate_curriculum_stream(
    prefix: str,
    *,
    curriculum_path: str | Path,
) -> dict:
    meta = _meta(prefix)
    if sha256_file(prefix + ".bin") != meta.get("stream_sha256"):
        raise ValueError("curriculum stream binary hash mismatch")
    curriculum = meta.get("curriculum")
    if not isinstance(curriculum, dict) or curriculum.get("format") != STREAM_CURRICULUM_FORMAT:
        raise ValueError("token stream has no canonical curriculum metadata")
    declared = curriculum.get("curriculum_stream_sha256", "")
    require_lower_sha256("curriculum_stream_sha256", declared)
    if _identity_hash(curriculum, "curriculum_stream_sha256") != declared:
        raise ValueError("curriculum stream metadata identity hash mismatch")
    config = load_curriculum(curriculum_path)
    if curriculum.get("config_identity_sha256") != config["curriculum_sha256"]:
        raise ValueError("curriculum stream references a different curriculum config")
    if curriculum.get("config_file_sha256") != sha256_file(curriculum_path):
        raise ValueError("curriculum stream curriculum file hash mismatch")
    lane_records = curriculum.get("lanes")
    if not isinstance(lane_records, list) or {r.get("lane") for r in lane_records if isinstance(r, dict)} != REQUIRED_LANES:
        raise ValueError("curriculum stream lane set mismatch")
    quotas = allocate_token_budget(meta["tokens"], config["target_mix_ppm"])
    for record in lane_records:
        lane = record["lane"]
        if record.get("tokens") != quotas[lane]:
            raise ValueError(f"curriculum stream token quota mismatch for {lane!r}")
        if record.get("target_ppm") != config["target_mix_ppm"][lane]:
            raise ValueError(f"curriculum stream ppm mismatch for {lane!r}")
    return meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--curriculum", required=True)
    parser.add_argument("--lane", action="append", required=True, help="LANE=PREFIX")
    parser.add_argument("--target-tokens", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    lanes = {lane: [] for lane in REQUIRED_LANES}
    for raw in args.lane:
        lane, sep, prefix = raw.partition("=")
        if not sep or lane not in lanes or not prefix:
            raise ValueError("--lane must be REQUIRED_LANE=PREFIX")
        lanes[lane].append(prefix)
    meta = build_curriculum_stream(
        args.curriculum,
        lanes=lanes,
        out_prefix=args.out,
        target_tokens=args.target_tokens,
    )
    print(
        f"[curriculum-stream] {meta['tokens']:,} tokens "
        f"sha256={meta['stream_sha256']} -> {args.out}.bin"
    )


if __name__ == "__main__":
    main()
