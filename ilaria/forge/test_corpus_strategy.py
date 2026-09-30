from __future__ import annotations

import json
from pathlib import Path

import pytest

from corpus_strategy import REQUIRED_LANES, assess_strategy, load_strategy


STRATEGY = Path(__file__).resolve().parent / "config" / "corpus_strategy.json"


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


def test_strategy_readiness_blocks_unreviewed_preferred_sources():
    strategy = load_strategy(STRATEGY)
    report = assess_strategy(
        strategy,
        {
            "golang_go",
            "python_cpython",
            "rust_lang",
            "zephyr",
            "freertos_kernel",
            "freebsd_licensed_tree",
        },
    )
    assert report["ready"] is False
    assert any("code:zephyr:status=MANUAL_SOURCE_REQUIRED" in x for x in report["blockers"])


def test_valid_first_party_attestation_satisfies_tools_protocol_status_only():
    strategy = load_strategy(STRATEGY)
    report = assess_strategy(
        strategy,
        {"zephyr", "golang_go", "python_cpython", "rust_lang", "freertos_kernel", "freebsd_licensed_tree"},
        first_party_attested=True,
    )
    assert not any("tools_protocol:first_party_contracts" in x for x in report["blockers"])
    assert report["ready"] is False
