from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import pytest

import guard


def _seal(value, field):
    value = dict(value)
    value[field] = guard._canonical_sha256(value, field)
    return value


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _export(root: Path, contract, *, tamper=False):
    root.mkdir(parents=True, exist_ok=True)
    values = {
        "checkpoint.pt": b"checkpoint",
        "imc.pt": b"model",
        "tokenizer.json": b"tokenizer",
    }
    for name, raw in values.items():
        (root / name).write_bytes(raw)
    guard.build_export_manifest(
        root,
        contract_sha256=contract.contract_sha256,
        instance_id=contract.instance_id,
        workspace_name=contract.workspace_name,
        required=contract.required_export_files,
    )
    if tamper:
        (root / "imc.pt").write_bytes(values["imc.pt"] + b"x")


def _contract(tmp_path: Path, now: datetime, *, lead=50, poll=40, confirmations=2):
    cli = tmp_path / "brev"
    cli.write_bytes(b"pinned-brev-cli")
    value = {
        "format": guard.CONTRACT_FORMAT,
        "instance_id": "ws-123",
        "workspace_name": "ilaria-h200",
        "org": "synthetic-org",
        "cli_path": str(cli),
        "cli_sha256": _sha(cli),
        "remote_output_path": "/home/ubuntu/workspace/outputs",
        "export_dir": str(tmp_path / "export"),
        "required_export_files": ["checkpoint.pt", "imc.pt", "tokenizer.json"],
        "hard_delete_deadline_utc": (now + timedelta(seconds=120)).isoformat().replace("+00:00", "Z"),
        "emergency_delete_lead_seconds": lead,
        "command_timeout_seconds": 10,
        "copy_timeout_seconds": 60,
        "max_poll_seconds": poll,
        "poll_interval_seconds": 1,
        "absent_confirmations": confirmations,
        "max_export_bytes": 1024 * 1024,
    }
    value = _seal(value, "contract_sha256")
    path = tmp_path / "contract.json"
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    return path, value


class FakeClient:
    def __init__(self, contract, export_root, *, disappear_after=1, export_error=None):
        self.contract = contract
        self.export_root = export_root
        self.disappear_after = disappear_after
        self.export_error = export_error
        self.deleted = 0
        self.exported = 0
        self.inventory_calls = 0
        self.copy_timeouts = []

    def inventory(self) -> dict[str, object]:
        self.inventory_calls += 1
        absent = self.deleted and self.inventory_calls > self.disappear_after + 1
        return {"workspaces": None if absent else [{
            "id": self.contract.instance_id,
            "name": self.contract.workspace_name,
            "status": "RUNNING",
        }]}

    def export(self, *, timeout_seconds):
        self.exported += 1
        self.copy_timeouts.append(timeout_seconds)
        if self.export_error:
            raise RuntimeError(self.export_error)
        _export(self.export_root, self.contract)

    def delete(self):
        self.deleted += 1


def _clock(values):
    items = iter(values)
    last = values[-1]

    def current():
        nonlocal last
        try:
            last = next(items)
        except StopIteration:
            pass
        return last
    return current


def _monotonic():
    value = [0.0]

    def tick():
        value[0] += 0.1
        return value[0]
    return tick


def test_normal_export_delete_confirmed_is_idempotent(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)
    client = FakeClient(contract, tmp_path / "export", disappear_after=1)
    ticks = [start + timedelta(seconds=i) for i in range(20)]
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    state = guard.run_guard(path, client, now=_clock(ticks), sleep=lambda _: None)
    assert state["status"] == "ABSENT_CONFIRMED"
    assert state["export"]["file_count"] == 3
    assert state["emergency_delete"] is False
    assert state["billing_stop_verified"] is False
    assert client.exported == client.deleted == 1
    assert client.copy_timeouts == [60]
    again = guard.run_guard(path, client, now=lambda: ticks[-1], sleep=lambda _: None)
    assert again == state
    assert client.exported == client.deleted == 1


def test_valid_preexisting_export_is_recovered_without_second_copy(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)
    _export(tmp_path / "export", contract)
    client = FakeClient(contract, tmp_path / "export", disappear_after=0)
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    state = guard.run_guard(path, client, now=lambda: start, sleep=lambda _: None)
    assert state["status"] == "ABSENT_CONFIRMED"
    assert state["export"]["file_count"] == 3
    assert client.exported == 0 and client.deleted == 1
    assert any(event["kind"] == "preexisting_export_recovered" for event in state["events"])


def test_emergency_deadline_deletes_without_export(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start, lead=50)
    contract = guard.load_contract(path)
    client = FakeClient(contract, tmp_path / "export", disappear_after=0)
    near = start + timedelta(seconds=75)
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    state = guard.run_guard(path, client, now=lambda: near, sleep=lambda _: None)
    assert state["status"] == "ABSENT_CONFIRMED"
    assert state["emergency_delete"] is True
    assert state["export"] is None
    assert client.exported == 0 and client.deleted == 1


def test_export_failure_before_emergency_window_never_deletes(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)
    client = FakeClient(contract, tmp_path / "export", export_error="copy failed")
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    with pytest.raises(RuntimeError, match="copy failed"):
        guard.run_guard(path, client, now=lambda: start, sleep=lambda _: None)
    assert client.exported == 1 and client.deleted == 0


def test_tampered_export_is_not_accepted(tmp_path):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)
    root = tmp_path / "export"
    _export(root, contract, tamper=True)
    with pytest.raises(ValueError, match="identity differs"):
        guard.verify_export(root, contract)


def test_wrong_instance_name_binding_refuses_before_action(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)

    class Wrong(FakeClient):
        def inventory(self) -> dict[str, object]:
            return {"workspaces": [{"id": contract.instance_id, "name": "other-name"}]}

    client = Wrong(contract, tmp_path / "export")
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    with pytest.raises(ValueError, match="ID/name binding differs"):
        guard.run_guard(path, client, now=lambda: start, sleep=lambda _: None)
    assert client.deleted == client.exported == 0


def test_inventory_null_is_terminal_without_delete(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)

    class Empty(FakeClient):
        def inventory(self) -> dict[str, object]:
            return {"workspaces": None}

    client = Empty(contract, tmp_path / "export")
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    with pytest.raises(RuntimeError, match="initial absence is not deletion proof"):
        guard.run_guard(path, client, now=lambda: start, sleep=lambda _: None)
    assert client.deleted == client.exported == 0


def test_export_failure_crossing_emergency_window_deletes(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start, lead=50)
    contract = guard.load_contract(path)
    client = FakeClient(
        contract, tmp_path / "export", disappear_after=0, export_error="copy timed out")
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    clock = _clock([start, start + timedelta(seconds=75), start + timedelta(seconds=75)])
    state = guard.run_guard(path, client, now=clock, sleep=lambda _: None)
    assert state["status"] == "ABSENT_CONFIRMED"
    assert state["emergency_delete"] is True
    assert state["export"] is None
    assert client.exported == client.deleted == 1


def test_state_for_other_contract_is_rejected(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    state_path = path.with_name("contract.state.json")
    state_path.write_text(json.dumps({
        "format": guard.STATE_FORMAT,
        "contract_sha256": "0" * 64,
        "events": [],
    }))
    contract = guard.load_contract(path)
    client = FakeClient(contract, tmp_path / "export")
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    with pytest.raises(ValueError, match="another contract"):
        guard.run_guard(path, client, now=lambda: start, sleep=lambda _: None)


def test_export_manifest_rejects_traversal(tmp_path):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    contract_path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(contract_path)
    root = tmp_path / "export"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"x")
    manifest = _seal({
        "format": guard.EXPORT_FORMAT,
        "contract_sha256": contract.contract_sha256,
        "instance_id": contract.instance_id,
        "workspace_name": contract.workspace_name,
        "files": [{"path": "../outside", "bytes": 1, "sha256": _sha(outside)}],
    }, "manifest_sha256")
    (root / "export.manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="unsafe"):
        guard.verify_export(root, contract)


def test_export_manifest_from_another_contract_is_rejected(tmp_path):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    contract = guard.load_contract(path)
    root = tmp_path / "export"
    _export(root, contract)
    manifest_path = root / "export.manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["instance_id"] = "ws-other"
    manifest = _seal(manifest, "manifest_sha256")
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="another workspace/contract"):
        guard.verify_export(root, contract)


def test_contract_cli_pin_drift_is_rejected(tmp_path):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start)
    value = json.loads(path.read_text())
    Path(value["cli_path"]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="byte identity differs"):
        guard.load_contract(path)


def test_deadline_present_after_delete_is_hard_failure(tmp_path, monkeypatch):
    start = datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)
    path, _ = _contract(tmp_path, start, lead=50, poll=40)
    contract = guard.load_contract(path)
    client = FakeClient(contract, tmp_path / "export", disappear_after=999)
    monkeypatch.setattr(guard.time, "monotonic", _monotonic())
    times = [
        start,
        start,
        start + timedelta(seconds=75),
        start + timedelta(seconds=121),
    ]
    with pytest.raises(RuntimeError, match="hard delete deadline"):
        guard.run_guard(path, client, now=_clock(times), sleep=lambda _: None)
    assert client.deleted == 1
