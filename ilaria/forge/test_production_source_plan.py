from __future__ import annotations

from pathlib import Path

from production_source_plan import assess_plan, load_inventory, load_plan


ROOT = Path(__file__).resolve().parents[1]
PLAN = Path(__file__).resolve().parent / "config" / "imc_125m_production_sources.json"
INVENTORY = ROOT / "bench" / "imc_125m_data_inventory" / "candidate-inventory.json"


def test_canonical_production_source_plan_has_conservative_headroom():
    plan = load_plan(PLAN)
    inventory = load_inventory(INVENTORY)
    report = assess_plan(plan, inventory)
    assert report["ready"] is True
    assert report["blockers"] == []
    assert report["lanes"]["code"]["sources"] == ["opencode_reasoning_split0"]
    assert report["lanes"]["general_knowledge"]["sources"] == ["wiki_en"]
    assert report["lanes"]["mathematics"]["sources"] == ["openmath_reasoning_cot"]
    assert report["lanes"]["science_technical_reasoning"]["sources"] == [
        "openscience_reasoning_2"
    ]
    assert set(report["required_first_party_sources"]) == {
        "first_party_contracts",
        "first_party_trajectories",
    }
    for lane, lane_report in report["lanes"].items():
        if lane_report["quota_tokens"]:
            assert lane_report["headroom_tokens"] >= lane_report["required_headroom_tokens"]


def test_plan_rejects_os_selection_without_required_headroom():
    plan = load_plan(PLAN)
    inventory = load_inventory(INVENTORY)
    plan = dict(plan)
    plan["lanes"] = {name: list(sources) for name, sources in plan["lanes"].items()}
    plan["lanes"]["os_hardware_drivers_standards"] = [
        "apache_nuttx",
        "freebsd_licensed_tree",
        "freertos_kernel",
    ]
    report = assess_plan(plan, inventory)
    assert report["ready"] is False
    assert any(
        blocker.startswith(
            "source_plan:os_hardware_drivers_standards:insufficient_headroom="
        )
        for blocker in report["blockers"]
    )


def test_plan_detects_inventory_identity_drift():
    plan = load_plan(PLAN)
    inventory = load_inventory(INVENTORY)
    inventory = dict(inventory)
    inventory["inventory_sha256"] = "0" * 64
    report = assess_plan(plan, inventory)
    assert report["ready"] is False
    assert "source_plan:inventory_identity_mismatch" in report["blockers"]
