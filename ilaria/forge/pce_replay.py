"""Validated bridge from signed Go PCE artifacts into Forge replay inputs."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPLAY_ARTIFACT_FORMAT = "ilaria-pce-replay-v1"
PROTOCOL_VERSION = 1
_SHA256_HEX_LEN = 64
_FORBIDDEN_POST_ACTION_MARKERS = (
    "<|obs:result|>",
    "<|result:verified|>",
    "<|pce:end|>",
)


@dataclass(frozen=True)
class ReplayDecision:
    artifact_sha256: str
    capsule_hash: str
    ancestry_hash: str
    domain: str
    decision_prompt: str
    action_target: str
    verifier_evidence_hash: str
    signer_key_id: str

    def collective_sleep_item(self) -> dict[str, str]:
        """Return the pre-action state/action pair consumed by Forge sleep."""
        return {
            "train_state": self.decision_prompt,
            "action": self.action_target,
            "capsule_hash": self.capsule_hash,
            "verifier_evidence_hash": self.verifier_evidence_hash,
        }


def _require_sha256(name: str, value: Any) -> str:
    if not isinstance(value, str) or len(value) != _SHA256_HEX_LEN:
        raise ValueError(f"{name} must be a lowercase sha256 hex digest")
    if value != value.lower():
        raise ValueError(f"{name} must be a lowercase sha256 hex digest")
    try:
        bytes.fromhex(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a lowercase sha256 hex digest") from exc
    return value


def _require_text(name: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    if any(ord(ch) < 32 for ch in value if ch not in "\n\r\t"):
        raise ValueError(f"{name} contains a control character")
    return value


def _digest_payload(data: dict[str, Any]) -> bytes:
    fields = (
        data["format"],
        str(data["protocol_version"]),
        data["capsule_hash"],
        data["ancestry_hash"],
        data["domain"],
        data["decision_prompt"],
        data["action_target"],
        data["verifier_evidence_hash"],
        data["signer_key_id"],
    )
    payload = bytearray()
    for field in fields:
        raw = field.encode("utf-8")
        payload.extend(str(len(raw)).encode("ascii"))
        payload.extend(b":")
        payload.extend(raw)
    return bytes(payload)


def artifact_sha256(data: dict[str, Any]) -> str:
    return hashlib.sha256(_digest_payload(data)).hexdigest()


def validate_replay_artifact(data: Any) -> ReplayDecision:
    if not isinstance(data, dict):
        raise ValueError("PCE replay artifact must be a JSON object")
    required = {
        "format",
        "protocol_version",
        "artifact_sha256",
        "capsule_hash",
        "ancestry_hash",
        "domain",
        "decision_prompt",
        "action_target",
        "verifier_evidence_hash",
        "signer_key_id",
    }
    if set(data) != required:
        missing = sorted(required - set(data))
        extra = sorted(set(data) - required)
        raise ValueError(f"PCE replay artifact schema mismatch: missing={missing}, extra={extra}")
    if data["format"] != REPLAY_ARTIFACT_FORMAT:
        raise ValueError(f"unsupported PCE replay format {data['format']!r}")
    if type(data["protocol_version"]) is not int or data["protocol_version"] != PROTOCOL_VERSION:
        raise ValueError(f"unsupported PCE replay protocol version {data['protocol_version']!r}")

    artifact_hash = _require_sha256("artifact_sha256", data["artifact_sha256"])
    capsule_hash = _require_sha256("capsule_hash", data["capsule_hash"])
    ancestry_hash = _require_sha256("ancestry_hash", data["ancestry_hash"])
    verifier_hash = _require_sha256(
        "verifier_evidence_hash", data["verifier_evidence_hash"]
    )
    domain = _require_text("domain", data["domain"])
    signer_key_id = _require_text("signer_key_id", data["signer_key_id"])
    decision_prompt = _require_text("decision_prompt", data["decision_prompt"])
    action_target = _require_text("action_target", data["action_target"])

    for marker in _FORBIDDEN_POST_ACTION_MARKERS:
        if marker in decision_prompt or marker in action_target:
            raise ValueError("PCE replay artifact contains post-action material")

    expected = artifact_sha256(data)
    if artifact_hash != expected:
        raise ValueError("PCE replay artifact content hash mismatch")

    return ReplayDecision(
        artifact_sha256=artifact_hash,
        capsule_hash=capsule_hash,
        ancestry_hash=ancestry_hash,
        domain=domain,
        decision_prompt=decision_prompt,
        action_target=action_target,
        verifier_evidence_hash=verifier_hash,
        signer_key_id=signer_key_id,
    )


def load_replay_artifact(path: str | Path) -> ReplayDecision:
    raw = Path(path).read_bytes()
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid PCE replay artifact JSON: {exc}") from exc
    return validate_replay_artifact(data)


def load_replay_artifact_dir(path: str | Path) -> list[ReplayDecision]:
    """Load a content-addressed replay store, failing closed on any ambiguity.

    Every artifact must be named ``<artifact_sha256>.json``. Duplicate capsule
    hashes are rejected so the same signed experience cannot silently enter a
    sleep batch twice under different artifact files.
    """
    root = Path(path)
    if not root.is_dir():
        raise ValueError(f"PCE replay artifact directory does not exist: {root}")
    paths = sorted(root.glob("*.json"))
    if not paths:
        raise ValueError(f"PCE replay artifact directory is empty: {root}")

    decisions: list[ReplayDecision] = []
    seen_artifacts: set[str] = set()
    seen_capsules: set[str] = set()
    for artifact_path in paths:
        decision = load_replay_artifact(artifact_path)
        if artifact_path.stem != decision.artifact_sha256:
            raise ValueError(
                "PCE replay artifact filename must equal artifact_sha256: "
                f"{artifact_path.name} != {decision.artifact_sha256}.json"
            )
        if decision.artifact_sha256 in seen_artifacts:
            raise ValueError(
                f"duplicate PCE replay artifact hash {decision.artifact_sha256}"
            )
        if decision.capsule_hash in seen_capsules:
            raise ValueError(
                f"duplicate PCE replay capsule hash {decision.capsule_hash}"
            )
        seen_artifacts.add(decision.artifact_sha256)
        seen_capsules.add(decision.capsule_hash)
        decisions.append(decision)
    return decisions
