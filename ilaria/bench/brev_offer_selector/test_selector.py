from __future__ import annotations

from datetime import datetime, timedelta, timezone
import copy

import pytest

import selector


NOW = datetime(2026, 10, 2, 9, 30, tzinfo=timezone.utc)


def policy(**updates):
    value = {
        "format": selector.POLICY_FORMAT,
        "authorized_budget_usd": "100.00",
        "reserve_usd": "23.20",
        "prior_spend_usd": "0",
        "planned_billable_hours": "2",
        "required_gpu_count": 8,
        "min_vram_per_gpu_gb": 80,
        "min_compute_capability": "9",
        "preferred_gpu_families": ["H200", "B200", "H100"],
        "catalog_max_age_seconds": 900,
        "billing_terms_verified": False,
        "topology_verified": False,
        "terms_acceptance_verified": False,
    }
    value.update(updates)
    return value


def offer(gpu, count, price, *, kind=None, vram=80, capability=9, cloud="fixture"):
    return {
        "type": kind or f"{gpu.lower()}x{count}",
        "cloud": cloud,
        "provider": cloud,
        "gpu_name": gpu,
        "gpu_count": count,
        "vram_per_gpu_gb": vram,
        "total_vram_gb": vram * count,
        "capability": capability,
        "vcpus": 112,
        "memory": "2TiB",
        "ram_gb": 2048,
        "arch": "x86_64",
        "disk_min_gb": 100,
        "disk_max_gb": 100,
        "boot_time_seconds": 600,
        "stoppable": False,
        "rebootable": False,
        "flex_ports": False,
        "target_disk_gb": 100,
        "price_per_hour": price,
    }


def catalog(entries, *, at=NOW):
    return {
        "format": selector.CATALOG_FORMAT,
        "checked_at_utc": at.isoformat(),
        "source_catalog_sha256": "a" * 64,
        "entries": entries,
    }


def test_exact_eight_h200_beats_cheaper_fallback_but_no_allocation_without_external_gates():
    result = selector.select_offer(
        catalog([offer("H100", 8, 20), offer("H200", 8, 30)]),
        policy(),
        now=NOW,
    )
    assert result["preferred_candidate"]["gpu_name"] == "H200"
    assert result["exact_preferred_multi_gpu_available"] is True
    assert result["allocation_ready"] is False
    assert result["allocation_authorized"] is False
    assert set(result["blockers"]) == {
        "billing_terms_unverified",
        "physical_topology_unverified",
        "deployment_terms_not_accepted",
    }


def test_single_h200_is_not_aggregated_and_fallback_single_host_h100_wins():
    result = selector.select_offer(
        catalog([
            offer("H200", 1, 6.48, vram=141),
            offer("H100", 8, 28.44, kind="oci.h100x8.sxm"),
        ]),
        policy(),
        now=NOW,
    )
    assert result["exact_preferred_multi_gpu_available"] is False
    assert result["preferred_candidate"]["type"] == "oci.h100x8.sxm"
    rejected = {entry["type"]: entry["reasons"] for entry in result["rejected"]}
    assert "not_single_catalog_entry_with_required_gpu_count" in rejected["h200x1"]


def test_b200_priority_is_explicitly_policy_driven():
    offers = [
        offer("H100", 8, 20),
        offer("B200", 8, 30, capability=10, vram=180),
    ]
    result = selector.select_offer(
        catalog(offers),
        policy(preferred_gpu_families=["H200", "B200", "H100"]),
        now=NOW,
    )
    assert result["preferred_candidate"]["gpu_name"] == "B200"
    reverse = selector.select_offer(
        catalog(offers),
        policy(preferred_gpu_families=["H200", "H100", "B200"]),
        now=NOW,
    )
    assert reverse["preferred_candidate"]["gpu_name"] == "H100"


def test_budget_is_total_vm_compute_not_gpu_multiplier():
    result = selector.select_offer(
        catalog([offer("H100", 8, 28.44)]),
        policy(
            billing_terms_verified=True,
            topology_verified=True,
            terms_acceptance_verified=True,
        ),
        now=NOW,
    )
    assert result["preferred_candidate"]["projected_compute_usd"] == "56.88"
    assert result["policy"]["compute_budget_usd"] == "76.80"
    assert result["allocation_ready"] is True
    assert result["allocation_authorized"] is False


def test_offer_over_compute_budget_is_rejected():
    result = selector.select_offer(
        catalog([offer("H100", 8, 99.30)]),
        policy(),
        now=NOW,
    )
    assert result["preferred_candidate"] is None
    assert "no_budget_eligible_single_entry_offer" in result["blockers"]
    assert result["rejected"][0]["projected_compute_usd"] == "198.60"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(required_gpu_count=0),
        lambda p: p.update(preferred_gpu_families=["H200", "H200"]),
        lambda p: p.update(planned_billable_hours="25"),
        lambda p: p.update(authorized_budget_usd="NaN"),
        lambda p: p.update(billing_terms_verified=1),
    ],
)
def test_malformed_policy_refused(mutate):
    value = policy()
    mutate(value)
    with pytest.raises(selector.SelectionError):
        selector.select_offer(catalog([offer("H100", 8, 20)]), value, now=NOW)


def test_stale_and_future_catalog_refused():
    for at in (NOW - timedelta(seconds=901), NOW + timedelta(seconds=1)):
        with pytest.raises(selector.SelectionError, match="stale|future"):
            selector.select_offer(catalog([offer("H100", 8, 20)], at=at), policy(), now=NOW)


def test_unknown_family_and_insufficient_vram_or_capability_are_visible_rejections():
    result = selector.select_offer(
        catalog([
            offer("A100", 8, 10),
            offer("H100", 8, 10, vram=40),
            offer("H100", 8, 10, capability=8),
        ]),
        policy(),
        now=NOW,
    )
    reasons = [set(item["reasons"]) for item in result["rejected"]]
    assert {"gpu_family_not_allowed"} in reasons
    assert {"vram_per_gpu_below_minimum"} in reasons
    assert {"compute_capability_below_minimum"} in reasons


def test_selection_hash_is_stable_and_input_is_not_mutated():
    c = catalog([offer("H100", 8, 28.44)])
    p = policy()
    before_c, before_p = copy.deepcopy(c), copy.deepcopy(p)
    one = selector.select_offer(c, p, now=NOW)
    two = selector.select_offer(c, p, now=NOW)
    assert one == two
    assert one["selection_sha256"] == two["selection_sha256"]
    assert c == before_c and p == before_p
