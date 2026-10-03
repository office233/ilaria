"""Fail-closed Brev export/delete lifecycle guard.

The guard is intentionally independent from model/trainer code. It can run on a
separate Linux control host and owns only the cloud-resource lifecycle after a
workspace already exists. It never creates instances, changes billing, or grants
training/promotion authority.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
from typing import Callable
from functools import wraps


CONTRACT_FORMAT = "ilaria-brev-lifecycle-contract-v1"
STATE_FORMAT = "ilaria-brev-lifecycle-state-v1"
EXPORT_FORMAT = "ilaria-export-manifest-v1"
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_EXPORT_BYTES = 16 * 1024**4
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _load_json(path: Path) -> dict:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"metadata is missing or symlinked: {path}")
    with path.open("rb") as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("metadata byte limit exceeded")

    def nonfinite(value):
        raise ValueError(f"non-finite JSON value: {value}")

    value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)
    if not isinstance(value, dict):
        raise ValueError("metadata must be a JSON object")
    return value


def _canonical_sha256(value: dict, identity_field: str) -> str:
    payload = dict(value)
    payload.pop(identity_field, None)
    raw = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _contained_regular_file(root: Path, relative: PurePosixPath) -> Path:
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError(f"export path traverses symlink: {relative}")
    if not cursor.is_file():
        raise ValueError(f"exported file is missing: {relative}")
    resolved_root = root.resolve()
    resolved = cursor.resolve()
    if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
        raise ValueError(f"exported file escapes export root: {relative}")
    return cursor


def _require_sha256(name: str, value) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{name} must be lowercase SHA-256")
    return value


def _utc(value: object) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("UTC timestamp must end in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"invalid UTC timestamp: {value}") from exc
    if parsed.utcoffset() != timedelta(0):
        raise ValueError("timestamp must be UTC")
    return parsed


def _iso(now: datetime) -> str:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_remote(path: object) -> str:
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise ValueError("remote export path must be an absolute POSIX path")
    pure = PurePosixPath(path)
    if any(part in ("", ".", "..") for part in pure.parts[1:]):
        raise ValueError("remote export path contains unsafe component")
    return path


def _safe_required_files(values) -> tuple[str, ...]:
    if not isinstance(values, list) or not values:
        raise ValueError("required_export_files must be a non-empty list")
    out = []
    for value in values:
        if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
            raise ValueError("required export file is invalid")
        pure = PurePosixPath(value)
        if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
            raise ValueError("required export file must be a safe relative path")
        out.append(value)
    if len(out) != len(set(out)):
        raise ValueError("required export file is duplicated")
    return tuple(out)


@dataclass(frozen=True)
class Contract:
    contract_sha256: str
    instance_id: str
    workspace_name: str
    org: str
    cli_path: Path
    cli_sha256: str
    remote_output_path: str
    export_dir: Path
    required_export_files: tuple[str, ...]
    hard_delete_deadline: datetime
    emergency_delete_lead_seconds: int
    command_timeout_seconds: int
    copy_timeout_seconds: int
    max_poll_seconds: int
    poll_interval_seconds: int
    absent_confirmations: int
    max_export_bytes: int


def load_contract(path: str | Path) -> Contract:
    raw_target = Path(path)
    if raw_target.is_symlink():
        raise ValueError("lifecycle contract path must not be a symlink")
    target = raw_target.resolve()
    value = _load_json(target)
    if value.get("format") != CONTRACT_FORMAT:
        raise ValueError(f"unsupported {CONTRACT_FORMAT} format")
    declared = _require_sha256("contract_sha256", value.get("contract_sha256"))
    if _canonical_sha256(value, "contract_sha256") != declared:
        raise ValueError("contract identity mismatch")
    instance_id = value.get("instance_id")
    workspace_name = value.get("workspace_name")
    org = value.get("org")
    if not isinstance(instance_id, str) or _IDENT.fullmatch(instance_id) is None:
        raise ValueError("invalid instance_id")
    if not isinstance(workspace_name, str) or _IDENT.fullmatch(workspace_name) is None:
        raise ValueError("invalid workspace_name")
    if not isinstance(org, str) or _IDENT.fullmatch(org) is None:
        raise ValueError("invalid Brev org")
    cli_value = value.get("cli_path")
    if not isinstance(cli_value, str) or not cli_value.strip():
        raise ValueError("cli_path must be a non-empty absolute path")
    cli_raw = Path(cli_value)
    if not cli_raw.is_absolute():
        raise ValueError("cli_path must be absolute")
    if cli_raw.is_symlink():
        raise ValueError("pinned Brev CLI path must not be a symlink")
    cli_path = cli_raw.resolve()
    cli_sha256 = _require_sha256("cli_sha256", value.get("cli_sha256"))
    if not cli_path.is_file():
        raise ValueError("pinned Brev CLI is missing")
    if _file_sha256(cli_path) != cli_sha256:
        raise ValueError("Brev CLI byte identity differs")
    export_value = value.get("export_dir")
    if not isinstance(export_value, str) or not export_value.strip():
        raise ValueError("export_dir must be a non-empty absolute path")
    export_raw = Path(export_value)
    if not export_raw.is_absolute():
        raise ValueError("export_dir must be absolute")
    if export_raw.is_symlink():
        raise ValueError("export_dir must not be a symlink")
    export_dir = export_raw.resolve()
    if not export_dir.is_absolute():
        raise ValueError("export_dir must be absolute")
    hard_delete_deadline = _utc(value.get("hard_delete_deadline_utc"))
    positive = {}
    for field in (
        "emergency_delete_lead_seconds",
        "command_timeout_seconds",
        "copy_timeout_seconds",
        "max_poll_seconds",
        "poll_interval_seconds",
        "absent_confirmations",
        "max_export_bytes",
    ):
        item = value.get(field)
        if type(item) is not int or item <= 0:
            raise ValueError(f"{field} must be a positive integer")
        positive[field] = item
    if positive["max_export_bytes"] > MAX_EXPORT_BYTES:
        raise ValueError("max_export_bytes exceeds guard hard cap")
    if positive["command_timeout_seconds"] > 120:
        raise ValueError("command_timeout_seconds exceeds guard hard cap")
    if positive["copy_timeout_seconds"] > 1800:
        raise ValueError("copy_timeout_seconds exceeds guard hard cap")
    if positive["poll_interval_seconds"] > positive["max_poll_seconds"]:
        raise ValueError("poll interval exceeds poll window")
    teardown_reserve = (
        positive["command_timeout_seconds"] * (1 + positive["absent_confirmations"])
        + positive["poll_interval_seconds"] * max(0, positive["absent_confirmations"] - 1)
    )
    if positive["emergency_delete_lead_seconds"] < teardown_reserve:
        raise ValueError("emergency delete lead does not reserve delete/readback time")
    return Contract(
        contract_sha256=declared,
        instance_id=instance_id,
        workspace_name=workspace_name,
        org=org,
        cli_path=cli_path,
        cli_sha256=cli_sha256,
        remote_output_path=_safe_remote(value.get("remote_output_path")),
        export_dir=export_dir,
        required_export_files=_safe_required_files(value.get("required_export_files")),
        hard_delete_deadline=hard_delete_deadline,
        emergency_delete_lead_seconds=positive["emergency_delete_lead_seconds"],
        command_timeout_seconds=positive["command_timeout_seconds"],
        copy_timeout_seconds=positive["copy_timeout_seconds"],
        max_poll_seconds=positive["max_poll_seconds"],
        poll_interval_seconds=positive["poll_interval_seconds"],
        absent_confirmations=positive["absent_confirmations"],
        max_export_bytes=positive["max_export_bytes"],
    )


def _workspace_identity(item: dict) -> tuple[str | None, str | None]:
    ids = [item.get(key) for key in ("id", "workspace_id", "workspaceId", "instance_id", "instanceId")]
    names = [item.get(key) for key in ("name", "workspace_name", "workspaceName")]
    ids = [value for value in ids if isinstance(value, str) and value]
    names = [value for value in names if isinstance(value, str) and value]
    if len(set(ids)) > 1 or len(set(names)) > 1:
        raise ValueError("Brev inventory has conflicting workspace identity fields")
    return (ids[0] if ids else None, names[0] if names else None)


def find_workspace(payload: dict, contract: Contract) -> dict | None:
    if not isinstance(payload, dict) or "workspaces" not in payload:
        raise ValueError("unsupported Brev inventory schema")
    raw = payload["workspaces"]
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("Brev workspaces inventory must be a list or null")
    matches = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Brev workspace record must be an object")
        instance_id, name = _workspace_identity(item)
        if instance_id == contract.instance_id or name == contract.workspace_name:
            if instance_id != contract.instance_id or name != contract.workspace_name:
                raise ValueError("Brev target ID/name binding differs")
            matches.append(item)
    if len(matches) > 1:
        raise ValueError("Brev target appears more than once")
    return matches[0] if matches else None


class BrevCLI:
    """Pinned CLI adapter. No command contains credentials."""

    def __init__(self, contract: Contract):
        self.contract = contract

    def _run(self, args: list[str], *, timeout_seconds: int | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(self.contract.cli_path), "--no-check-latest", *args],
            text=True,
            capture_output=True,
            timeout=timeout_seconds or self.contract.command_timeout_seconds,
            env=os.environ.copy(),
            check=False,
        )

    def inventory(self) -> dict:
        result = self._run(["ls", "--json", "--org", self.contract.org])
        if result.returncode != 0:
            raise RuntimeError("brev ls --json failed")
        try:
            value = json.loads(result.stdout, object_pairs_hook=_pairs)
        except json.JSONDecodeError as exc:
            raise RuntimeError("brev ls returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise RuntimeError("brev ls returned unsupported JSON")
        return value

    def export(self, *, timeout_seconds: int) -> None:
        self.contract.export_dir.parent.mkdir(parents=True, exist_ok=True)
        result = self._run([
            "copy",
            f"{self.contract.workspace_name}:{self.contract.remote_output_path}",
            str(self.contract.export_dir),
        ], timeout_seconds=timeout_seconds)
        if result.returncode != 0:
            raise RuntimeError("brev copy failed")

    def delete(self) -> None:
        result = self._run(["delete", self.contract.instance_id])
        if result.returncode != 0:
            raise RuntimeError("brev delete failed")


def build_export_manifest(
    export_dir: Path,
    *,
    contract_sha256: str,
    instance_id: str,
    workspace_name: str,
    required: tuple[str, ...],
) -> dict:
    """Create the remote-side manifest after trainer publication is complete."""
    _require_sha256("contract_sha256", contract_sha256)
    if _IDENT.fullmatch(instance_id) is None or _IDENT.fullmatch(workspace_name) is None:
        raise ValueError("invalid export manifest workspace identity")
    if not export_dir.is_dir() or export_dir.is_symlink():
        raise ValueError("export output directory is missing or symlinked")
    records = []
    for rel in _safe_required_files(list(required)):
        pure = PurePosixPath(rel)
        path = _contained_regular_file(export_dir, pure)
        records.append({
            "path": rel,
            "bytes": path.stat().st_size,
            "sha256": _file_sha256(path),
        })
    manifest = {
        "format": EXPORT_FORMAT,
        "contract_sha256": contract_sha256,
        "instance_id": instance_id,
        "workspace_name": workspace_name,
        "files": records,
    }
    manifest["manifest_sha256"] = _canonical_sha256(manifest, "manifest_sha256")
    target = export_dir / "export.manifest.json"
    with target.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return manifest


def verify_export(export_dir: Path, contract: Contract) -> dict:
    if not export_dir.is_dir() or export_dir.is_symlink():
        raise ValueError("export directory is missing or symlinked")
    manifest_path = export_dir / "export.manifest.json"
    manifest = _load_json(manifest_path)
    if manifest.get("format") != EXPORT_FORMAT:
        raise ValueError("unsupported export manifest format")
    declared = _require_sha256("manifest_sha256", manifest.get("manifest_sha256"))
    if _canonical_sha256(manifest, "manifest_sha256") != declared:
        raise ValueError("export manifest identity mismatch")
    if (manifest.get("contract_sha256") != contract.contract_sha256 or
            manifest.get("instance_id") != contract.instance_id or
            manifest.get("workspace_name") != contract.workspace_name):
        raise ValueError("export manifest belongs to another workspace/contract")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ValueError("export manifest has no files")
    observed = {}
    total = 0
    for record in records:
        if not isinstance(record, dict) or set(record) != {"path", "bytes", "sha256"}:
            raise ValueError("invalid export manifest file record")
        rel = record["path"]
        if not isinstance(rel, str) or "\\" in rel or "\0" in rel:
            raise ValueError("invalid exported relative path")
        pure = PurePosixPath(rel)
        if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
            raise ValueError("unsafe exported relative path")
        if rel in observed:
            raise ValueError("duplicate exported path")
        size = record["bytes"]
        if type(size) is not int or size < 0:
            raise ValueError("invalid exported byte count")
        digest = _require_sha256(f"{rel}:sha256", record["sha256"])
        path = _contained_regular_file(export_dir, pure)
        if path.stat().st_size != size or _file_sha256(path) != digest:
            raise ValueError(f"exported file identity differs: {rel}")
        total += size
        if total > contract.max_export_bytes:
            raise ValueError("export exceeds configured byte cap")
        observed[rel] = digest
    missing = sorted(set(contract.required_export_files) - set(observed))
    if missing:
        raise ValueError("required exports missing: " + ", ".join(missing))
    return {
        "manifest_sha256": declared,
        "file_count": len(observed),
        "total_bytes": total,
        "required_files": list(contract.required_export_files),
    }


def _state_path(contract_path: Path) -> Path:
    return contract_path.with_name(contract_path.stem + ".state.json")


@contextmanager
def _exclusive_lock(contract_path: Path):
    """Serialize one contract without relying on a crash-stale lock sentinel."""
    lock_path = contract_path.with_name(contract_path.stem + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if lock_path.is_symlink():
        raise ValueError("lifecycle lock path must not be a symlink")
    with lock_path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "posix":
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("another lifecycle guard owns this contract") from exc
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        else:
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("another lifecycle guard owns this contract") from exc
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def _serialized(function):
    @wraps(function)
    def wrapper(contract_path, *args, **kwargs):
        raw = Path(contract_path)
        if raw.is_symlink():
            raise ValueError("lifecycle contract path must not be a symlink")
        contract_file = raw.resolve()
        with _exclusive_lock(contract_file):
            return function(contract_file, *args, **kwargs)
    return wrapper


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(state, sort_keys=True, indent=2, allow_nan=False) + "\n"
    temp = path.with_name(path.name + ".tmp")
    if temp.exists() or temp.is_symlink():
        if temp.is_symlink() or not temp.is_file():
            raise ValueError("unsafe lifecycle temp path")
        temp.unlink()
    with temp.open("x", encoding="utf-8") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def _load_state(path: Path, contract: Contract) -> dict:
    if not path.exists():
        return {
            "format": STATE_FORMAT,
            "contract_sha256": contract.contract_sha256,
            "status": "PLANNED",
            "export": None,
            "delete_requested_at_utc": None,
            "emergency_delete": False,
            "absent_confirmations": 0,
            "terminal_at_utc": None,
            "billing_stop_verified": False,
            "events": [],
        }
    state = _load_json(path)
    if state.get("format") != STATE_FORMAT or state.get("contract_sha256") != contract.contract_sha256:
        raise ValueError("lifecycle state belongs to another contract")
    if not isinstance(state.get("events"), list):
        raise ValueError("invalid lifecycle event journal")
    return state


def _event(state: dict, now: datetime, kind: str, detail: dict | None = None) -> None:
    if len(state["events"]) >= 4096:
        raise RuntimeError("lifecycle event journal limit reached")
    state["events"].append({"at_utc": _iso(now), "kind": kind, "detail": detail or {}})


@_serialized
def run_guard(
    contract_path: str | Path,
    client,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """Drive one workspace to confirmed absence.

    Export is attempted first while time permits. Once the emergency lead window
    is reached, deletion takes precedence over export to cap billing exposure.
    Re-entry is idempotent: a recorded delete is never issued twice.
    """
    contract_file = Path(contract_path).resolve()
    contract = load_contract(contract_file)
    state_file = _state_path(contract_file)
    state = _load_state(state_file, contract)
    if state.get("status") == "ABSENT_CONFIRMED":
        return state

    current = now()
    target = find_workspace(client.inventory(), contract)
    if target is None:
        if state.get("delete_requested_at_utc") is None:
            raise RuntimeError(
                "target workspace was not observed; initial absence is not deletion proof")
        confirmations = int(state.get("absent_confirmations", 0)) + 1
        state["absent_confirmations"] = confirmations
        _event(state, current, "inventory_absent_confirmation", {"count": confirmations})
        if confirmations >= contract.absent_confirmations:
            state["status"] = "ABSENT_CONFIRMED"
            state["terminal_at_utc"] = _iso(current)
            _write_state(state_file, state)
            return state
        _write_state(state_file, state)
    else:
        _event(state, current, "target_observed")
        _write_state(state_file, state)

    delete_at = contract.hard_delete_deadline - timedelta(
        seconds=contract.emergency_delete_lead_seconds)
    export_verified = state.get("export") is not None
    delete_requested = state.get("delete_requested_at_utc") is not None

    if not export_verified and not delete_requested and current < delete_at:
        _event(state, current, "export_started")
        _write_state(state_file, state)
        try:
            if contract.export_dir.exists() or contract.export_dir.is_symlink():
                verified = verify_export(contract.export_dir, contract)
                _event(state, current, "preexisting_export_recovered")
            else:
                seconds_left = max(1, int((delete_at - current).total_seconds()))
                copy_timeout = min(contract.copy_timeout_seconds, seconds_left)
                client.export(timeout_seconds=copy_timeout)
                verified = verify_export(contract.export_dir, contract)
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
            current = now()
            _event(state, current, "export_failed", {"error_type": type(exc).__name__})
            _write_state(state_file, state)
            if current < delete_at:
                raise
        else:
            state["export"] = verified
            state["status"] = "EXPORT_VERIFIED"
            _event(state, now(), "export_verified", verified)
            _write_state(state_file, state)
            export_verified = True

    current = now()
    if not delete_requested:
        emergency = not export_verified
        if emergency and current < delete_at:
            raise RuntimeError("export is unverified before emergency deletion window")
        client.delete()
        state["delete_requested_at_utc"] = _iso(current)
        state["emergency_delete"] = emergency
        state["status"] = "DELETE_REQUESTED"
        _event(state, current, "delete_requested", {"emergency": emergency})
        _write_state(state_file, state)

    deadline = time.monotonic() + contract.max_poll_seconds
    confirmations = int(state.get("absent_confirmations", 0))
    while time.monotonic() < deadline:
        current = now()
        if current > contract.hard_delete_deadline:
            _event(state, current, "hard_deadline_exceeded")
            _write_state(state_file, state)
            raise RuntimeError("workspace still present after hard delete deadline")
        target = find_workspace(client.inventory(), contract)
        if target is None:
            confirmations += 1
            state["absent_confirmations"] = confirmations
            _event(state, current, "inventory_absent_confirmation", {"count": confirmations})
            if confirmations >= contract.absent_confirmations:
                state["status"] = "ABSENT_CONFIRMED"
                state["terminal_at_utc"] = _iso(current)
                state["billing_stop_verified"] = False
                _write_state(state_file, state)
                return state
        else:
            confirmations = 0
            state["absent_confirmations"] = 0
        _write_state(state_file, state)
        sleep(contract.poll_interval_seconds)
    raise RuntimeError("workspace absence was not confirmed within poll window")


def _main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True)
    parser.add_argument(
        "--execute", action="store_true",
        help="allow brev copy/delete; without this flag only validate contract and current inventory")
    args = parser.parse_args(argv)
    contract = load_contract(args.contract)
    client = BrevCLI(contract)
    target = find_workspace(client.inventory(), contract)
    if not args.execute:
        print(json.dumps({
            "format": "ilaria-brev-lifecycle-preflight-v1",
            "contract_sha256": contract.contract_sha256,
            "target_present": target is not None,
            "execute": False,
            "allocation_authorized": False,
        }, sort_keys=True))
        return 0
    state = run_guard(args.contract, client)
    print(json.dumps(state, sort_keys=True))
    return 0 if state["status"] == "ABSENT_CONFIRMED" else 2


if __name__ == "__main__":
    raise SystemExit(_main())
