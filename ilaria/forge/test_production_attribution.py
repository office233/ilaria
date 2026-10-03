from __future__ import annotations

import json
from pathlib import Path

import pytest

from production_attribution import build_attribution
from test_production_review_packet import canonical_packet

def _packet(tmp_path: Path) -> Path:
    packet = canonical_packet(tmp_path)
    path = tmp_path / "packet.json"
    path.write_text(json.dumps(packet, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path

def _manifests(tmp_path: Path, packet_path: Path) -> dict[str, Path]:
    packet = json.loads(packet_path.read_text(encoding="utf-8"))
    paths = {}
    for name, record in packet["external_sources"].items():
        revision = record["revision"].get("revision") or record["revision"]["commit"]
        path = tmp_path / f"{name}.manifest.json"
        path.write_text(json.dumps({"source": {"name": name, "revision": revision},
                                   "docs": 3, "pipeline": {"purpose": "synthetic test fixture"}}), encoding="utf-8")
        paths[name] = path
    return paths

def test_attribution_binds_exact_revisions(tmp_path: Path):
    packet = _packet(tmp_path)
    manifests = _manifests(tmp_path, packet)
    value = build_attribution(packet, source_manifests=manifests)
    assert len(value["attribution_sha256"]) == 64
    assert set(value["external_sources"]) == set(manifests)
    assert value["external_sources"]["apache_nuttx"]["revision"]["commit"] == "4295024832a0f70820156d2a7e6e09d68897e91f"
    assert value["first_party_sources"]["first_party_contracts"]["files"]

def test_attribution_rejects_revision_drift(tmp_path: Path):
    packet = _packet(tmp_path)
    manifests = _manifests(tmp_path, packet)
    original = json.loads(manifests["freertos_kernel"].read_text(encoding="utf-8"))
    original["source"]["revision"] = "drift"
    bad = tmp_path / "freertos.manifest.json"
    bad.write_text(json.dumps(original), encoding="utf-8")
    manifests["freertos_kernel"] = bad
    with pytest.raises(ValueError, match="revision mismatch"):
        build_attribution(packet, source_manifests=manifests)
