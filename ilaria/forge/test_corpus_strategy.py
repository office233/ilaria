from __future__ import annotations

import json
from pathlib import Path

import pytest

from corpus_strategy import REQUIRED_LANES, assess_strategy, load_strategy


STRATEGY = Path(__file__).resolve().parent / "config" / "corpus_strategy.json"
SOURCE_PLAN = Path(__file__).resolve().parent / "config" / "imc_125m_production_sources.json"
RIGHTS = Path(__file__).resolve().parent / "config" / "data_rights.json"


def test_canonical_strategy_has_every_required_lane():
    strategy = load_strategy(STRATEGY)
    assert set(strategy["lanes"]) == REQUIRED_LANES
    assert "general_romanian" not in strategy["lanes"]
    assert any(item["source"] == "openstax_default_library" for item in strategy["excluded_by_default"])


def test_strategy_rejects_auto_approved_candidate(tmp_path):
    strategy = json.loads(STRATEGY.read_text(encoding="utf-8"))
    strategy["lanes"]["code"][0]["status"] = "APPROVED"
    path = tmp_path / "strategy.json"
    path.write_text(json.dumps(strategy), encoding="utf-8")
    with pytest.raises(ValueError, match="unsafe status"):
        load_strategy(path)


def test_strategy_requires_one_preferred_candidate_per_lane(tmp_path):
    strategy = json.loads(STRATEGY.read_text(encoding="utf-8"))
    strategy["lanes"]["hardware"][0]["role"] = "supplement"
    path = tmp_path / "strategy.json"
    path.write_text(json.dumps(strategy), encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one preferred"):
        load_strategy(path)


def test_strategy_readiness_passes_for_approved_external_and_attested_first_party_sources():
    strategy = load_strategy(STRATEGY)
    report = assess_strategy(
        strategy,
        {
            "apache_nuttx",
            "golang_go",
            "python_cpython",
            "rust_lang",
            "zephyr",
            "freertos_kernel",
            "freebsd_licensed_tree",
        },
        first_party_attested_sources={
            "first_party_contracts",
            "first_party_trajectories",
        },
    )
    assert report["ready"] is True
    assert report["blockers"] == []
    assert report["preferred_sources"]["code"] == "opencode_reasoning_split0"
    assert report["preferred_sources"]["math_science"] == "openmath_reasoning_cot"


def test_valid_first_party_attestation_satisfies_tools_protocol_status_only():
    strategy = load_strategy(STRATEGY)
    report = assess_strategy(
        strategy,
        {"apache_nuttx", "zephyr", "golang_go", "python_cpython", "rust_lang", "freertos_kernel", "freebsd_licensed_tree"},
        first_party_attested=True,
    )
    assert not any("tools_protocol:first_party_contracts" in x for x in report["blockers"])
    assert any("agent_tool_trajectories:first_party_trajectories" in x for x in report["blockers"])
    assert report["ready"] is False


def test_trajectory_attestation_satisfies_both_trajectory_lanes_only():
    strategy = load_strategy(STRATEGY)
    report = assess_strategy(
        strategy,
        {"apache_nuttx", "zephyr", "golang_go", "python_cpython", "rust_lang", "freertos_kernel", "freebsd_licensed_tree"},
        first_party_attested_sources={"first_party_trajectories"},
    )
    assert not any("agent_tool_trajectories:first_party_trajectories" in x for x in report["blockers"])
    assert not any("world_device_trajectories:first_party_trajectories" in x for x in report["blockers"])
    assert any("tools_protocol:first_party_contracts" in x for x in report["blockers"])


def test_canonical_strategy_preferred_sources_match_production_source_plan():
    strategy = load_strategy(STRATEGY)
    plan = json.loads(SOURCE_PLAN.read_text(encoding="utf-8"))
    report = assess_strategy(
        strategy,
        {
            "apache_nuttx",
            "golang_go",
            "python_cpython",
            "rust_lang",
            "zephyr",
            "freertos_kernel",
            "freebsd_licensed_tree",
        },
        first_party_attested_sources={
            "first_party_contracts",
            "first_party_trajectories",
        },
    )
    preferred = report["preferred_sources"]
    assert preferred["general_english"] in plan["lanes"]["general_knowledge"]
    assert preferred["code"] in plan["lanes"]["code"]
    assert preferred["math_science"] in plan["lanes"]["mathematics"]
    assert preferred["os_drivers"] in plan["lanes"]["os_hardware_drivers_standards"]
    assert preferred["hardware"] in plan["lanes"]["os_hardware_drivers_standards"]
    assert preferred["tools_protocol"] in plan["first_party_sources"]
    assert preferred["agent_tool_trajectories"] in plan["lanes"]["agent_tool_trajectories"]
    assert preferred["world_device_trajectories"] in plan["lanes"]["world_device_trajectories"]


def test_every_eligible_strategy_source_is_rights_approved_with_no_open_obligations():
    strategy = load_strategy(STRATEGY)
    rights = json.loads(RIGHTS.read_text(encoding="utf-8"))
    sources = rights["sources"]
    for candidates in strategy["lanes"].values():
        for candidate in candidates:
            if candidate["status"] != "ELIGIBLE":
                continue
            source = candidate["source"]
            assert source in sources
            assert sources[source]["status"] == "APPROVED"
            assert sources[source]["commercial_use_approved"] is True


def test_preferred_apache_nuttx_requires_git_lock():
    strategy = json.loads(STRATEGY.read_text(encoding="utf-8"))
    strategy["lanes"]["os_drivers"][0]["role"] = "supplement"
    for candidate in strategy["lanes"]["os_drivers"]:
        if candidate["source"] == "apache_nuttx":
            candidate["role"] = "preferred"
            break
    report = assess_strategy(
        strategy,
        {"zephyr", "golang_go", "python_cpython", "rust_lang", "freertos_kernel", "freebsd_licensed_tree"},
    )
    assert any("os_drivers:apache_nuttx:missing_git_lock" in x for x in report["blockers"])
