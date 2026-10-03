"""Deterministic verifier-backed first-party trajectories for IMC Genesis.

The output is candidate data, never an implicit ownership approval. Each row is
synthetic, content-addressed, bound to an attested generator/config file set and
contains a verifier-evidence hash. Shards use the canonical raw-corpus schema so
they can enter ``corpus_inventory.py`` without a bespoke ingestion path.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
import re
from pathlib import Path

try:
    from .data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from .first_party_attestation import attestation_scope_sha256, inspect_attestation
    from .hf_tokenizer import protocol_tokens
except ImportError:  # direct script execution
    from data_contract import (
        CORPUS_MANIFEST_SCHEMA,
        atomic_write_json,
        canonical_json_sha256,
        sha256_file,
    )
    from first_party_attestation import attestation_scope_sha256, inspect_attestation
    from hf_tokenizer import protocol_tokens


GENERATION_FORMAT = "imc-125m-verified-trajectory-generation-v1"
QUALITY_FORMAT = "imc-125m-verified-trajectory-quality-v1"
PIPELINE_NAME = "verified-first-party-trajectories-v1"
SOURCE_NAME = "first_party_trajectories"
LANES = ("agent_tool_trajectories", "world_device_trajectories")
_CONTROL_TOKEN_RE = re.compile(r"<\|[^>\n]+\|>")
_ALLOWED_PROTOCOL_TOKENS = frozenset(protocol_tokens())


def _u64(seed: int, lane: str, sequence: int, salt: str) -> int:
    raw = f"{seed}:{lane}:{sequence}:{salt}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big")


def _evidence_hash(value: dict) -> str:
    return canonical_json_sha256(value)


def _assert_protocol_text(text: str) -> None:
    unknown = sorted(set(_CONTROL_TOKEN_RE.findall(text)) - _ALLOWED_PROTOCOL_TOKENS)
    if unknown:
        raise ValueError(f"trajectory contains unreserved protocol tokens: {unknown}")


def _agent_case(seed: int, sequence: int) -> tuple[str, str, str, dict]:
    lane = LANES[0]
    scenario = _u64(seed, lane, sequence, "scenario") % 12
    if scenario == 0:
        a = 11 + _u64(seed, lane, sequence, "a") % 9_973
        b = 7 + _u64(seed, lane, sequence, "b") % 997
        c = _u64(seed, lane, sequence, "c") % 50_000
        expression = f"({a} * {b}) + {c}"
        result = a * b + c
        prompt = f"Compute {expression} exactly and verify the returned value."
        action = f'tool=exact_calculator expression="{expression}"'
        observation = str(result)
        evidence = {
            "scenario": "integer_arithmetic",
            "a": a,
            "b": b,
            "c": c,
            "result": result,
        }
    elif scenario == 1:
        kib = 1 + _u64(seed, lane, sequence, "kib") % 16_777_215
        result = kib * 1024
        prompt = f"Convert {kib} KiB to bytes using the binary unit definition."
        action = f"tool=unit_convert value={kib} from=KiB to=byte"
        observation = f"{result} bytes"
        evidence = {"scenario": "kib_to_bytes", "kib": kib, "bytes": result}
    elif scenario == 2:
        key = f"sensor_{_u64(seed, lane, sequence, 'key') % 97:02d}"
        value = 1000 + _u64(seed, lane, sequence, "value") % 900_000
        payload = {
            "device": f"node-{sequence % 4096:04d}",
            "measurements": {key: value},
            "ok": True,
        }
        compact = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        prompt = f"Read measurements.{key} from this JSON object without guessing: {compact}"
        action = f"tool=json_get path=measurements.{key}"
        observation = str(value)
        evidence = {
            "scenario": "json_get",
            "payload": payload,
            "path": f"measurements.{key}",
            "result": value,
        }
    elif scenario == 3:
        payload = f"ilaria-packet-{sequence}-{_u64(seed, lane, sequence, 'payload'):016x}"
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        prompt = f"Calculate the SHA-256 digest of the exact UTF-8 text {payload!r}."
        action = f"tool=sha256 text={json.dumps(payload)}"
        observation = digest
        evidence = {"scenario": "sha256", "payload": payload, "sha256": digest}
    elif scenario == 4:
        values = [int(_u64(seed, lane, sequence, f"n{i}") % 10_000) for i in range(8)]
        result = sorted(values)
        prompt = f"Sort these integers in ascending order: {values}."
        action = f"tool=sort_ints values={json.dumps(values, separators=(',', ':'))}"
        observation = json.dumps(result, separators=(",", ":"))
        evidence = {"scenario": "sort_integers", "values": values, "result": result}
    elif scenario == 5:
        a = 2 + _u64(seed, lane, sequence, "gcd-a") % 100_000
        b = 2 + _u64(seed, lane, sequence, "gcd-b") % 100_000
        result = math.gcd(a, b)
        prompt = f"Find gcd({a}, {b}) and verify it divides both inputs exactly."
        action = f"tool=gcd a={a} b={b}"
        observation = str(result)
        evidence = {"scenario": "gcd", "a": a, "b": b, "result": result}
    elif scenario == 6:
        value = 16 + _u64(seed, lane, sequence, "base-value") % 16_000_000
        observation = hex(value)
        prompt = f"Convert decimal integer {value} to canonical lowercase hexadecimal."
        action = f"tool=base_convert value={value} from=10 to=16"
        evidence = {
            "scenario": "decimal_to_hex",
            "value": value,
            "result": observation,
        }
    elif scenario == 7:
        value = _u64(seed, lane, sequence, "mask-value") & 0xFFFFFFFF
        bit = int(_u64(seed, lane, sequence, "mask-bit") % 32)
        mask = 1 << bit
        result = bool(value & mask)
        observation = "true" if result else "false"
        prompt = (
            f"Check whether bit {bit} is set in unsigned 32-bit value {value}. "
            "Return only the verified boolean."
        )
        action = f"tool=bitmask_test value={value} mask={mask}"
        evidence = {
            "scenario": "bitmask_test",
            "value": value,
            "bit": bit,
            "mask": mask,
            "result": result,
        }
    elif scenario == 8:
        start_ms = _u64(seed, lane, sequence, "time-start") % 10_000_000
        delta_ms = 1 + _u64(seed, lane, sequence, "time-delta") % 500_000
        end_ms = start_ms + delta_ms
        observation = f"{delta_ms} ms"
        prompt = (
            f"Compute the exact elapsed time from timestamp {start_ms} ms to "
            f"{end_ms} ms."
        )
        action = f"tool=time_delta start_ms={start_ms} end_ms={end_ms}"
        evidence = {
            "scenario": "timestamp_delta",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "result_ms": delta_ms,
        }
    elif scenario == 9:
        token = hashlib.sha256(
            f"{seed}:{sequence}:reverse".encode("utf-8")
        ).hexdigest()[:18]
        payload = f"node-{sequence % 997}-{token}"
        observation = payload[::-1]
        prompt = f"Reverse the exact ASCII string {payload!r} without changing any byte."
        action = f"tool=string_reverse text={json.dumps(payload)}"
        evidence = {
            "scenario": "string_reverse",
            "input": payload,
            "result": observation,
        }
    elif scenario == 10:
        values = [
            int(_u64(seed, lane, sequence, f"byte-{index}") % 256)
            for index in range(12)
        ]
        checksum = sum(values) % 256
        observation = str(checksum)
        prompt = (
            "Compute the unsigned 8-bit additive checksum (sum modulo 256) "
            f"for these bytes: {values}."
        )
        action = (
            "tool=checksum8 bytes="
            + json.dumps(values, separators=(",", ":"))
        )
        evidence = {
            "scenario": "checksum8",
            "bytes": values,
            "result": checksum,
        }
    else:
        left = [
            int(_u64(seed, lane, sequence, f"left-{index}") % 40)
            for index in range(8)
        ]
        right = [
            int(_u64(seed, lane, sequence, f"right-{index}") % 40)
            for index in range(8)
        ]
        result = sorted(set(left) & set(right))
        observation = json.dumps(result, separators=(",", ":"))
        prompt = (
            f"Return the sorted unique intersection of {left} and {right}."
        )
        action = (
            "tool=set_intersection left="
            + json.dumps(left, separators=(",", ":"))
            + " right="
            + json.dumps(right, separators=(",", ":"))
        )
        evidence = {
            "scenario": "set_intersection",
            "left": left,
            "right": right,
            "result": result,
        }
    return prompt, action, observation, evidence


def _agent_row(seed: int, sequence: int) -> dict:
    prompt, action, observation, evidence = _agent_case(seed, sequence)
    verifier_hash = _evidence_hash(evidence)
    style = _u64(seed, LANES[0], sequence, "style") % 3
    verification = (
        "The observation matches the deterministic reference computation."
        if style == 0
        else "Recomputation from the original inputs yields the same observation."
        if style == 1
        else "Independent exact verification agrees with the tool result."
    )
    text = (
        "<|role:system|>\n"
        "Use deterministic tools when exact results are available. Never invent a tool observation.\n"
        "<|role:user|>\n"
        f"{prompt}\n"
        "<|role:assistant|>\n"
        "<|action:execute|>\n"
        f"{action}\n"
        "<|obs:result|>\n"
        f"{observation}\n"
        "<|role:assistant|>\n"
        "<|action:verify|>\n"
        f"{verification}\n"
        "<|verify:pass|>\n"
        f"Verified result: {observation}"
    )
    _assert_protocol_text(text)
    task_hash = canonical_json_sha256(
        {"lane": LANES[0], "sequence": sequence, "evidence": verifier_hash}
    )
    task_id = f"agent-{sequence:012d}-{task_hash[:12]}"
    return {
        "path": f"{LANES[0]}/{sequence // 10_000:05d}/{task_id}",
        "text": text,
        "task_id": task_id,
        "generator_sequence": sequence,
        "privacy_class": "CURATED",
        "task_family": evidence["scenario"],
        "verifier_type": "deterministic_reference_v1",
        "verifier_evidence_hash": verifier_hash,
    }


def _world_case(seed: int, sequence: int) -> tuple[str, str, str, str, dict]:
    lane = LANES[1]
    scenario = _u64(seed, lane, sequence, "scenario") % 10
    if scenario == 0:
        rpm = 500 + _u64(seed, lane, sequence, "rpm") % 6_500
        speed = _u64(seed, lane, sequence, "speed") % 181
        threshold = 550 + _u64(seed, lane, sequence, "engine-threshold") % 351
        coolant = 20 + _u64(seed, lane, sequence, "coolant") % 101
        state = (
            f"<|device:vehicle|> <|bus:obd2|> <|sensor:rpm|>={rpm}rpm "
            f"<|sensor:speed|>={speed}km/h coolant={coolant}C "
            f"engine_running_threshold={threshold}rpm"
        )
        action = "hypothesis=engine_running"
        result = "true" if rpm >= threshold else "false"
        explanation = (
            f"engine_running is {result} because rpm={rpm} "
            f"{'is at least' if rpm >= threshold else 'is below'} {threshold}"
        )
        evidence = {
            "scenario": "vehicle_engine_state",
            "rpm": rpm,
            "speed": speed,
            "coolant_c": coolant,
            "threshold_rpm": threshold,
            "result": result,
        }
    elif scenario == 1:
        battery = 5 + _u64(seed, lane, sequence, "battery") % 96
        millivolts = 3300 + _u64(seed, lane, sequence, "mv") % 1_001
        threshold = 8 + _u64(seed, lane, sequence, "battery-threshold") % 18
        load_ma = 50 + _u64(seed, lane, sequence, "battery-load") % 4_951
        state = (
            f"<|device:phone|> <|bus:usb|> <|sensor:battery|>={battery}% "
            f"<|sensor:voltage|>={millivolts}mV load={load_ma}mA "
            f"critical_threshold={threshold}%"
        )
        action = "hypothesis=battery_critical"
        result = "true" if battery <= threshold else "false"
        explanation = (
            f"battery_critical is {result} because battery={battery}% and "
            f"the synthetic threshold is {threshold}%"
        )
        evidence = {
            "scenario": "phone_battery",
            "battery_percent": battery,
            "millivolts": millivolts,
            "load_ma": load_ma,
            "threshold_percent": threshold,
            "result": result,
        }
    elif scenario == 2:
        temp = 25 + _u64(seed, lane, sequence, "temp") % 91
        voltage = 3000 + _u64(seed, lane, sequence, "voltage") % 2_001
        threshold = 65 + _u64(seed, lane, sequence, "thermal-threshold") % 31
        load_ma = 10 + _u64(seed, lane, sequence, "thermal-load") % 7_991
        state = (
            f"<|device:embedded|> <|bus:devicetree|> <|sensor:temperature|>={temp}C "
            f"<|sensor:voltage|>={voltage}mV load={load_ma}mA "
            f"fan_high_threshold={threshold}C"
        )
        action = "action=set_fan_high"
        result = "required" if temp >= threshold else "not_required"
        explanation = (
            f"set_fan_high is {result} because temperature={temp}C and "
            f"threshold={threshold}C"
        )
        evidence = {
            "scenario": "embedded_thermal",
            "temperature_c": temp,
            "millivolts": voltage,
            "load_ma": load_ma,
            "threshold_c": threshold,
            "result": result,
        }
    elif scenario == 3:
        ax = int(_u64(seed, lane, sequence, "ax") % 401) - 200
        ay = int(_u64(seed, lane, sequence, "ay") % 401) - 200
        az = 850 + int(_u64(seed, lane, sequence, "az") % 301)
        gyro = int(_u64(seed, lane, sequence, "gyro") % 161) - 80
        accel_threshold = 60 + _u64(seed, lane, sequence, "accel-threshold") % 61
        gyro_threshold = 20 + _u64(seed, lane, sequence, "gyro-threshold") % 31
        state = (
            f"<|device:robot|> <|sensor:accelerometer|>=({ax},{ay},{az})mg "
            f"<|sensor:gyroscope|>={gyro}mdps accel_limit={accel_threshold}mg "
            f"gyro_limit={gyro_threshold}mdps"
        )
        action = "hypothesis=platform_stable"
        stable = (
            abs(ax) <= accel_threshold
            and abs(ay) <= accel_threshold
            and abs(gyro) <= gyro_threshold
        )
        result = "true" if stable else "false"
        explanation = (
            f"platform_stable is {result} using |ax|,|ay|<={accel_threshold}mg "
            f"and |gyro|<={gyro_threshold}mdps"
        )
        evidence = {
            "scenario": "robot_stability",
            "ax_mg": ax,
            "ay_mg": ay,
            "az_mg": az,
            "gyro_mdps": gyro,
            "accel_threshold_mg": accel_threshold,
            "gyro_threshold_mdps": gyro_threshold,
            "result": result,
        }
    elif scenario == 4:
        temp = 30 + _u64(seed, lane, sequence, "pc-temp") % 76
        voltage = 11_500 + _u64(seed, lane, sequence, "pc-mv") % 1_501
        threshold = 85 + _u64(seed, lane, sequence, "pc-threshold") % 21
        package_power_w = 5 + _u64(seed, lane, sequence, "pc-power") % 246
        state = (
            f"<|device:pc|> <|bus:acpi|> <|sensor:temperature|>={temp}C "
            f"<|sensor:voltage|>={voltage}mV package_power={package_power_w}W "
            f"throttle_threshold={threshold}C"
        )
        action = "hypothesis=thermal_throttle_expected"
        result = "true" if temp >= threshold else "false"
        explanation = (
            f"thermal_throttle_expected is {result} because temperature={temp}C "
            f"and threshold={threshold}C"
        )
        evidence = {
            "scenario": "pc_thermal",
            "temperature_c": temp,
            "millivolts": voltage,
            "package_power_w": package_power_w,
            "threshold_c": threshold,
            "result": result,
        }
    elif scenario == 5:
        data0 = _u64(seed, lane, sequence, "can-data0") & 0xFF
        data1 = _u64(seed, lane, sequence, "can-data1") & 0xFF
        scale = 1 + _u64(seed, lane, sequence, "can-scale") % 3
        offset = _u64(seed, lane, sequence, "can-offset") % 17
        frame_id = 0x120 + _u64(seed, lane, sequence, "can-frame") % 32
        window_ms = 10 + _u64(seed, lane, sequence, "can-window") % 4_991
        raw = data0 | (data1 << 8)
        speed = (raw * scale + offset) % 301
        state = (
            f"<|device:vehicle|> <|bus:can|> frame_id=0x{frame_id:x} "
            f"data0={data0} data1={data1} scale={scale} offset={offset} "
            f"window={window_ms}ms <|sensor:speed|>={speed}km/h"
        )
        action = "hypothesis=can_speed_decode_consistent"
        result = "true"
        explanation = (
            "can_speed_decode_consistent is true because uint16le(data0,data1)="
            f"{raw} and ({raw}*{scale}+{offset}) mod 301={speed}km/h"
        )
        evidence = {
            "scenario": "can_speed_decode",
            "frame_id": frame_id,
            "data0": data0,
            "data1": data1,
            "scale": scale,
            "offset": offset,
            "window_ms": window_ms,
            "speed_kmh": speed,
            "result": result,
        }
    elif scenario == 6:
        battery = 5 + _u64(seed, lane, sequence, "charge-battery") % 91
        voltage = 3300 + _u64(seed, lane, sequence, "charge-voltage") % 1_201
        current_ma = 50 + _u64(seed, lane, sequence, "charge-current") % 4_951
        min_voltage = 3500 + _u64(seed, lane, sequence, "charge-min") % 301
        max_voltage = 4200 + _u64(seed, lane, sequence, "charge-max") % 401
        state = (
            f"<|device:phone|> <|bus:usb|> <|sensor:battery|>={battery}% "
            f"<|sensor:voltage|>={voltage}mV current={current_ma}mA "
            f"charger_present=true accepted_voltage={min_voltage}..{max_voltage}mV"
        )
        action = "hypothesis=charging_voltage_plausible"
        plausible = min_voltage <= voltage <= max_voltage
        result = "true" if plausible else "false"
        explanation = (
            f"charging_voltage_plausible is {result} because voltage={voltage}mV "
            f"and the synthetic accepted interval is {min_voltage}..{max_voltage}mV"
        )
        evidence = {
            "scenario": "usb_charge_voltage",
            "battery_percent": battery,
            "voltage_mv": voltage,
            "current_ma": current_ma,
            "min_voltage_mv": min_voltage,
            "max_voltage_mv": max_voltage,
            "result": result,
        }
    elif scenario == 7:
        ax = int(_u64(seed, lane, sequence, "impact-x") % 4001) - 2000
        ay = int(_u64(seed, lane, sequence, "impact-y") % 4001) - 2000
        az = int(_u64(seed, lane, sequence, "impact-z") % 4001) - 2000
        peak = max(abs(ax), abs(ay), abs(az))
        state = (
            f"<|device:embedded|> <|sensor:accelerometer|>=({ax},{ay},{az})mg "
            f"peak_axis={peak}mg"
        )
        action = "hypothesis=impact_detected"
        result = "true" if peak >= 1500 else "false"
        explanation = (
            f"impact_detected is {result} because peak_axis={peak}mg and threshold=1500mg"
        )
        evidence = {
            "scenario": "accelerometer_impact",
            "ax_mg": ax,
            "ay_mg": ay,
            "az_mg": az,
            "peak_mg": peak,
            "result": result,
        }
    elif scenario == 8:
        rpm = 600 + _u64(seed, lane, sequence, "ratio-rpm") % 6_000
        speed = 5 + _u64(seed, lane, sequence, "ratio-speed") % 176
        gear = 1 + _u64(seed, lane, sequence, "ratio-gear") % 8
        low = 5 + _u64(seed, lane, sequence, "ratio-low") % 16
        high = low + 60 + _u64(seed, lane, sequence, "ratio-high") % 61
        ratio = rpm / speed
        state = (
            f"<|device:vehicle|> <|bus:obd2|> <|sensor:rpm|>={rpm}rpm "
            f"<|sensor:speed|>={speed}km/h gear={gear} ratio_band={low}..{high}"
        )
        action = "hypothesis=drivetrain_ratio_in_expected_band"
        in_band = low <= ratio <= high
        result = "true" if in_band else "false"
        explanation = (
            f"drivetrain_ratio_in_expected_band is {result}; rpm/speed={ratio:.3f} "
            f"and the synthetic interval is {low}..{high}"
        )
        evidence = {
            "scenario": "vehicle_ratio_band",
            "rpm": rpm,
            "speed_kmh": speed,
            "gear": gear,
            "ratio_low": low,
            "ratio_high": high,
            "ratio_milli": int(round(ratio * 1000)),
            "result": result,
        }
    else:
        temp = 20 + _u64(seed, lane, sequence, "fan-temp") % 86
        low = 40 + _u64(seed, lane, sequence, "fan-low") % 16
        high = low + 20 + _u64(seed, lane, sequence, "fan-high") % 16
        sample_window_ms = 100 + _u64(seed, lane, sequence, "fan-window") % 9_901
        if temp >= high:
            expected = "high"
        elif temp >= low:
            expected = "medium"
        else:
            expected = "low"
        state = (
            f"<|device:pc|> <|bus:acpi|> <|sensor:temperature|>={temp}C "
            f"fan_policy={low}C:medium,{high}C:high window={sample_window_ms}ms"
        )
        action = "action=select_fan_level"
        result = expected
        explanation = (
            f"select_fan_level result is {expected} for temperature={temp}C "
            f"under thresholds medium={low}C high={high}C"
        )
        evidence = {
            "scenario": "fan_curve",
            "temperature_c": temp,
            "medium_threshold_c": low,
            "high_threshold_c": high,
            "sample_window_ms": sample_window_ms,
            "result": result,
        }
    return state, action, result, explanation, evidence


def _world_row(seed: int, sequence: int) -> dict:
    state, action, result, explanation, evidence = _world_case(seed, sequence)
    verifier_hash = _evidence_hash(evidence)
    text = (
        "<|world:start|>\n"
        f"{state}\n"
        "<|privacy:device_nonpersonal|>\n"
        "source=deterministic_simulator_v1\n"
        "<|world:end|>\n"
        "<|pce:start|>\n"
        f"state: {state}\n"
        "<|role:assistant|>\n"
        "<|action:probe|>\n"
        f"{action}\n"
        "<|obs:result|>\n"
        f"{result}\n"
        "<|action:verify|>\n"
        f"{explanation}\n"
        "<|result:verified|>\n"
        "<|verify:pass|>\n"
        "<|pce:end|>"
    )
    _assert_protocol_text(text)
    task_hash = canonical_json_sha256(
        {"lane": LANES[1], "sequence": sequence, "evidence": verifier_hash}
    )
    task_id = f"world-{sequence:012d}-{task_hash[:12]}"
    return {
        "path": f"{LANES[1]}/{sequence // 10_000:05d}/{task_id}",
        "text": text,
        "task_id": task_id,
        "generator_sequence": sequence,
        "privacy_class": "DEVICE_NONPERSONAL",
        "task_family": evidence["scenario"],
        "verifier_type": "deterministic_simulator_v1",
        "verifier_evidence_hash": verifier_hash,
    }


def load_generation_config(path: str | Path) -> dict:
    source = Path(path)
    with source.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict) or data.get("format") != GENERATION_FORMAT:
        raise ValueError("unsupported verified-trajectory generation config")
    if data.get("source_name") != SOURCE_NAME or data.get("language") != "en":
        raise ValueError("verified-trajectory source identity is invalid")
    if type(data.get("seed")) is not int or data["seed"] < 0:
        raise ValueError("verified-trajectory seed is invalid")
    shard_docs = data.get("shard_docs")
    if type(shard_docs) is not int or shard_docs < 1:
        raise ValueError("verified-trajectory shard_docs is invalid")
    targets = data.get("target_text_bytes")
    if not isinstance(targets, dict) or set(targets) != set(LANES):
        raise ValueError("verified-trajectory target lane set mismatch")
    if any(type(targets[lane]) is not int or targets[lane] < 1 for lane in LANES):
        raise ValueError("verified-trajectory target_text_bytes must be positive integers")
    quality = data.get("quality_gate")
    if not isinstance(quality, dict):
        raise ValueError("verified-trajectory quality_gate is missing")
    sample_documents = quality.get("sample_documents_per_lane")
    if type(sample_documents) is not int or sample_documents < 100:
        raise ValueError("quality_gate sample_documents_per_lane must be >= 100")
    minimum_families = quality.get("minimum_families")
    if not isinstance(minimum_families, dict) or set(minimum_families) != set(LANES):
        raise ValueError("quality_gate minimum_families lane set mismatch")
    if any(
        type(minimum_families[lane]) is not int or minimum_families[lane] < 1
        for lane in LANES
    ):
        raise ValueError("quality_gate minimum_families values must be positive integers")
    for field in (
        "minimum_unique_text_ratio_ppm",
        "minimum_unique_evidence_ratio_ppm",
        "maximum_family_share_ppm",
    ):
        value = quality.get(field)
        if type(value) is not int or not 1 <= value <= 1_000_000:
            raise ValueError(f"quality_gate {field} must be in 1..1000000")
    return data


def evaluate_quality(config: dict) -> dict:
    """Deterministically reject low-diversity or collapsed trajectory generation."""
    quality = config["quality_gate"]
    sample_documents = int(quality["sample_documents_per_lane"])
    seed = int(config["seed"])
    generators = {LANES[0]: _agent_row, LANES[1]: _world_row}
    lane_reports: dict[str, dict] = {}
    for lane in LANES:
        families: Counter[str] = Counter()
        texts: set[str] = set()
        evidence_hashes: set[str] = set()
        task_ids: set[str] = set()
        total_text_bytes = 0
        for sequence in range(sample_documents):
            row = generators[lane](seed, sequence)
            families[row["task_family"]] += 1
            texts.add(row["text"])
            evidence_hashes.add(row["verifier_evidence_hash"])
            task_ids.add(row["task_id"])
            total_text_bytes += len(row["text"].encode("utf-8"))
        unique_text_ratio_ppm = len(texts) * 1_000_000 // sample_documents
        unique_evidence_ratio_ppm = (
            len(evidence_hashes) * 1_000_000 // sample_documents
        )
        max_family_documents = max(families.values())
        max_family_share_ppm = (
            max_family_documents * 1_000_000 // sample_documents
        )
        if len(task_ids) != sample_documents:
            raise ValueError(f"quality gate failed for {lane}: duplicate task ids")
        if len(families) < int(quality["minimum_families"][lane]):
            raise ValueError(
                f"quality gate failed for {lane}: only {len(families)} task families"
            )
        if unique_text_ratio_ppm < int(quality["minimum_unique_text_ratio_ppm"]):
            raise ValueError(
                f"quality gate failed for {lane}: unique text ratio {unique_text_ratio_ppm} ppm"
            )
        if unique_evidence_ratio_ppm < int(
            quality["minimum_unique_evidence_ratio_ppm"]
        ):
            raise ValueError(
                f"quality gate failed for {lane}: unique evidence ratio "
                f"{unique_evidence_ratio_ppm} ppm"
            )
        if max_family_share_ppm > int(quality["maximum_family_share_ppm"]):
            raise ValueError(
                f"quality gate failed for {lane}: family concentration "
                f"{max_family_share_ppm} ppm"
            )
        lane_reports[lane] = {
            "sample_documents": sample_documents,
            "task_families": dict(sorted(families.items())),
            "unique_text_ratio_ppm": unique_text_ratio_ppm,
            "unique_evidence_ratio_ppm": unique_evidence_ratio_ppm,
            "maximum_family_share_ppm": max_family_share_ppm,
            "mean_text_bytes": total_text_bytes // sample_documents,
        }
    report = {
        "format": QUALITY_FORMAT,
        "seed": seed,
        "policy": dict(quality),
        "lanes": lane_reports,
    }
    report["quality_gate_sha256"] = canonical_json_sha256(report)
    return report


def _pipeline_identity(
    config_path: Path, attestation: dict, quality_report: dict
) -> tuple[dict, dict]:
    generator_path = Path(__file__).resolve()
    tokenizer_path = generator_path.with_name("hf_tokenizer.py")
    scope_sha = attestation_scope_sha256(attestation)
    required_attested_files = [
        {
            "path": "forge/hf_tokenizer.py",
            "sha256": sha256_file(tokenizer_path),
        },
        {
            "path": "forge/verified_trajectory_corpus.py",
            "sha256": sha256_file(generator_path),
        },
    ]
    pipeline = {
        "name": PIPELINE_NAME,
        "rights_basis": "first_party_attestation",
        "attestation_scope_sha256": scope_sha,
        "attestation_required_files": required_attested_files,
        "generation_config_sha256": sha256_file(config_path),
        "generator_sha256": sha256_file(generator_path),
        "protocol_tokens_sha256": canonical_json_sha256(
            {"protocol_tokens": protocol_tokens()}
        ),
        "quality_gate_sha256": quality_report["quality_gate_sha256"],
        "verifier_policy": "deterministic-exact-or-simulator-v1",
    }
    source = {
        "name": SOURCE_NAME,
        "provider": "ilaria/forge/verified_trajectory_corpus",
        "config": GENERATION_FORMAT,
        "revision": canonical_json_sha256(pipeline),
        "language": "en",
    }
    return source, pipeline


def _verify_existing(
    manifest_path: Path,
    *,
    source: dict,
    pipeline: dict,
    targets: dict,
    quality_report: dict,
) -> dict:
    if not manifest_path.exists():
        return {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": source,
            "pipeline": pipeline,
            "target_text_bytes": dict(targets),
            "quality_gate": quality_report,
            "docs": 0,
            "shards": 0,
            "complete": [],
            "shard_records": [],
            "lane_stats": {
                lane: {"documents": 0, "text_bytes": 0, "next_sequence": 0}
                for lane in LANES
            },
        }
    with manifest_path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if manifest.get("schema_version") != CORPUS_MANIFEST_SCHEMA:
        raise ValueError("verified-trajectory manifest schema mismatch")
    if manifest.get("source") != source or manifest.get("pipeline") != pipeline:
        raise ValueError("verified-trajectory manifest identity changed")
    if manifest.get("target_text_bytes") != targets:
        raise ValueError("verified-trajectory target bytes changed")
    if manifest.get("quality_gate") != quality_report:
        raise ValueError("verified-trajectory quality gate changed")
    records = manifest.get("shard_records")
    if not isinstance(records, list):
        raise ValueError("verified-trajectory manifest has invalid shard records")
    for index, record in enumerate(records):
        if record.get("index") != index:
            raise ValueError("verified-trajectory shard indexes are not contiguous")
        shard = manifest_path.parent / str(record.get("filename", ""))
        if not shard.is_file():
            raise ValueError(f"verified-trajectory shard is missing: {shard}")
        if (
            shard.stat().st_size != record.get("bytes")
            or sha256_file(shard) != record.get("sha256")
        ):
            raise ValueError(
                f"verified-trajectory shard hash/size changed: {shard.name}"
            )
    lane_stats = manifest.get("lane_stats")
    if not isinstance(lane_stats, dict) or set(lane_stats) != set(LANES):
        raise ValueError("verified-trajectory manifest lane stats are invalid")
    return manifest


def write_candidate_corpus(
    *,
    config_path: str | Path,
    attestation_path: str | Path,
    workspace_root: str | Path,
    out_dir: str | Path,
) -> dict:
    config_path = Path(config_path).resolve()
    config = load_generation_config(config_path)
    attestation = inspect_attestation(attestation_path, workspace_root=workspace_root)
    quality_report = evaluate_quality(config)
    source, pipeline = _pipeline_identity(config_path, attestation, quality_report)
    targets = dict(config["target_text_bytes"])
    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / f"{SOURCE_NAME}.manifest.json"
    manifest = _verify_existing(
        manifest_path,
        source=source,
        pipeline=pipeline,
        targets=targets,
        quality_report=quality_report,
    )
    records = list(manifest["shard_records"])
    lane_stats = {lane: dict(manifest["lane_stats"][lane]) for lane in LANES}
    total_docs = int(manifest.get("docs", 0))
    buffer: list[tuple[str, dict]] = []
    shard_index = len(records)

    def persist() -> None:
        value = {
            "schema_version": CORPUS_MANIFEST_SCHEMA,
            "source": source,
            "pipeline": pipeline,
            "target_text_bytes": targets,
            "quality_gate": quality_report,
            "docs": total_docs,
            "shards": len(records),
            "shard_docs": config["shard_docs"],
            "complete": [record["index"] for record in records],
            "lane_stats": lane_stats,
            "shard_records": records,
        }
        atomic_write_json(manifest_path, value)

    def flush() -> None:
        nonlocal shard_index, total_docs
        if not buffer:
            return
        filename = f"{SOURCE_NAME}-{shard_index:05d}.jsonl"
        destination = output / filename
        if destination.exists():
            raise ValueError(
                f"verified-trajectory corpus refuses to overwrite {destination}"
            )
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        lane_docs = {lane: 0 for lane in LANES}
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            for lane, row in buffer:
                stream.write(
                    json.dumps(
                        row,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
                lane_docs[lane] += 1
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        records.append(
            {
                "index": shard_index,
                "filename": filename,
                "sha256": sha256_file(destination),
                "bytes": destination.stat().st_size,
                "documents": len(buffer),
                "lane_documents": {
                    lane: count for lane, count in lane_docs.items() if count
                },
            }
        )
        total_docs += len(buffer)
        shard_index += 1
        buffer.clear()
        persist()

    generators = {LANES[0]: _agent_row, LANES[1]: _world_row}
    for lane in LANES:
        stats = lane_stats[lane]
        while int(stats["text_bytes"]) < targets[lane]:
            sequence = int(stats["next_sequence"])
            row = generators[lane](int(config["seed"]), sequence)
            text_bytes = len(row["text"].encode("utf-8"))
            buffer.append((lane, row))
            stats["documents"] = int(stats["documents"]) + 1
            stats["text_bytes"] = int(stats["text_bytes"]) + text_bytes
            stats["next_sequence"] = sequence + 1
            if len(buffer) >= int(config["shard_docs"]):
                flush()
        flush()
    persist()
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", default=str(config / "imc_125m_trajectory_generation.json")
    )
    parser.add_argument(
        "--attestation",
        default=str(config / "first_party_trajectories.attestation.json"),
    )
    parser.add_argument("--workspace-root", default=str(root))
    parser.add_argument("--out-dir")
    parser.add_argument("--quality-only", action="store_true")
    parser.add_argument("--quality-out")
    args = parser.parse_args()
    if args.quality_only:
        quality = evaluate_quality(load_generation_config(args.config))
        if args.quality_out:
            atomic_write_json(args.quality_out, quality)
        print(
            f"[verified-trajectories] quality={quality['quality_gate_sha256']}"
        )
        for lane in LANES:
            record = quality["lanes"][lane]
            print(
                f"[verified-trajectories] quality {lane}: "
                f"families={len(record['task_families'])} "
                f"unique_text_ppm={record['unique_text_ratio_ppm']} "
                f"max_family_ppm={record['maximum_family_share_ppm']}"
            )
        return
    if not args.out_dir:
        parser.error("--out-dir is required unless --quality-only is used")
    manifest = write_candidate_corpus(
        config_path=args.config,
        attestation_path=args.attestation,
        workspace_root=args.workspace_root,
        out_dir=args.out_dir,
    )
    print(
        f"[verified-trajectories] docs={manifest['docs']:,} "
        f"shards={manifest['shards']}"
    )
    for lane in LANES:
        stats = manifest["lane_stats"][lane]
        print(
            f"[verified-trajectories] {lane}: docs={stats['documents']:,} "
            f"text_bytes={stats['text_bytes']:,}"
        )


if __name__ == "__main__":
    main()
