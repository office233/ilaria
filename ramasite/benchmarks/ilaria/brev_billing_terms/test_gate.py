from __future__ import annotations

from datetime import datetime, timedelta, timezone
import copy

import pytest

import gate


NOW = datetime(2026, 10, 2, 9, 30, tzinfo=timezone.utc)


def policy(**updates):
    value = {
        "format": gate.POLICY_FORMAT,
        "selection_sha256": "a" * 64,
        "offer_type": "oci.h100x8.sxm",
        "provider": "oci",
        "cloud": "oci",
        "expected_total_per_vm_hourly_usd": "28.44",
        "authorized_budget_usd": "100.00",
        "reserve_usd": "23.20",
        "planned_billable_seconds": 7200,
        "evidence_max_age_seconds": 900,
    }
    value.update(updates)
    return value


def refs(at=NOW):
    return [
        {
            "claim": "offer_quote",
            "kind": "local_receipt",
            "reference": "E:/evidence/selection.json",
            "checked_at_utc": at.isoformat(),
        },
        {
            "claim": "running_compute_billing",
            "kind": "official_web",
            "reference": "https://docs.nvidia.com/brev/concepts/gpu-instances",
            "checked_at_utc": at.isoformat(),
        },
        {
            "claim": "delete_no_charges",
            "kind": "official_web",
            "reference": "https://docs.nvidia.com/brev/concepts/gpu-instances",
            "checked_at_utc": at.isoformat(),
        },
        {
            "claim": "billing_dashboard",
            "kind": "official_web",
            "reference": "https://docs.nvidia.com/brev/guides/console-reference",
            "checked_at_utc": at.isoformat(),
        },
        {
            "claim": "auto_recharge_controls",
            "kind": "official_web",
            "reference": "https://docs.nvidia.com/brev/guides/console-reference",
            "checked_at_utc": at.isoformat(),
        },
    ]


def evidence(**updates):
    value = {
        "format": gate.EVIDENCE_FORMAT,
        "selection_sha256": "a" * 64,
        "offer_type": "oci.h100x8.sxm",
        "provider": "oci",
        "cloud": "oci",
        "observed_at_utc": NOW.isoformat(),
        "currency": "USD",
        "rate_scope": "TOTAL_PER_VM",
        "total_per_vm_hourly_usd": "28.44",
        "billing_start_verified": True,
        "billing_start_phase": "PROVISIONING",
        "billing_granularity_seconds": 3600,
        "delete_stops_all_charges_verified": True,
        "storage_cost_verified": True,
        "storage_max_cost_usd": "5.00",
        "egress_cost_verified": True,
        "egress_max_cost_usd": "2.00",
        "taxes_other_verified": True,
        "taxes_other_max_cost_usd": "3.00",
        "auto_recharge_status_verified": True,
        "auto_recharge_disabled": True,
        "source_refs": refs(),
    }
    value.update(updates)
    value["evidence_sha256"] = gate._canonical_sha256(value, "evidence_sha256")
    return value


def reseal(value):
    value = dict(value)
    value.pop("evidence_sha256", None)
    value["evidence_sha256"] = gate._canonical_sha256(value, "evidence_sha256")
    return value


def test_fully_verified_terms_fit_reserved_budget():
    result = gate.assess(evidence(), policy(), now=NOW)
    assert result["ready"] is True
    assert result["allocation_authorized"] is False
    assert result["budget"]["projected_compute_usd"] == "56.88"
    assert result["budget"]["ancillary_max_usd"] == "10.00"
    assert result["budget"]["projected_all_in_usd"] == "66.88"


@pytest.mark.parametrize(
    "updates, blocker",
    [
        ({"billing_start_verified": False, "billing_start_phase": None}, "billing_start_unverified"),
        ({"billing_granularity_seconds": None}, "billing_granularity_unverified"),
        ({"delete_stops_all_charges_verified": False}, "delete_billing_stop_unverified"),
        ({"storage_cost_verified": False, "storage_max_cost_usd": None}, "storage_cost_unverified"),
        ({"egress_cost_verified": False, "egress_max_cost_usd": None}, "egress_cost_unverified"),
        ({"taxes_other_verified": False, "taxes_other_max_cost_usd": None}, "taxes_other_cost_unverified"),
        ({"auto_recharge_status_verified": False, "auto_recharge_disabled": None}, "auto_recharge_status_unverified"),
        ({"auto_recharge_status_verified": True, "auto_recharge_disabled": False}, "auto_recharge_enabled"),
    ],
)
def test_each_unverified_billing_control_blocks(updates, blocker):
    value = evidence(**updates)
    result = gate.assess(value, policy(), now=NOW)
    assert result["ready"] is False
    assert blocker in result["blockers"]


def test_hourly_quantum_rounds_up_conservatively():
    value = evidence(billing_granularity_seconds=3600)
    result = gate.assess(
        value,
        policy(planned_billable_seconds=3601),
        now=NOW,
    )
    assert result["budget"]["projected_compute_usd"] == "56.88"


def test_ancillary_reserve_breach_blocks_even_when_total_under_100():
    value = evidence(
        storage_max_cost_usd="20.00",
        egress_max_cost_usd="4.00",
        taxes_other_max_cost_usd="0.00",
    )
    result = gate.assess(value, policy(), now=NOW)
    assert "ancillary_max_exceeds_reserved_budget" in result["blockers"]


def test_compute_budget_breach_blocks():
    result = gate.assess(
        evidence(total_per_vm_hourly_usd="40.00"),
        policy(expected_total_per_vm_hourly_usd="40.00"),
        now=NOW,
    )
    assert "projected_compute_exceeds_compute_budget" in result["blockers"]


def test_binding_and_quote_drift_refused():
    for field, value in (
        ("selection_sha256", "b" * 64),
        ("offer_type", "other"),
        ("provider", "other"),
        ("cloud", "other"),
        ("total_per_vm_hourly_usd", "28.45"),
    ):
        item = evidence(**{field: value})
        with pytest.raises(gate.BillingTermsError):
            gate.assess(item, policy(), now=NOW)


def test_evidence_identity_tamper_refused():
    item = evidence()
    item["auto_recharge_disabled"] = False
    with pytest.raises(gate.BillingTermsError, match="identity mismatch"):
        gate.assess(item, policy(), now=NOW)


def test_stale_or_future_evidence_refused():
    for observed in (
        NOW - timedelta(seconds=901),
        NOW + timedelta(seconds=1),
    ):
        item = evidence(observed_at_utc=observed.isoformat())
        with pytest.raises(gate.BillingTermsError, match="stale|future"):
            gate.assess(item, policy(), now=NOW)


def test_stale_source_reference_blocks_not_silently_accepted():
    item = evidence(source_refs=refs(NOW - timedelta(seconds=901)))
    result = gate.assess(item, policy(), now=NOW)
    assert any(x.startswith("source_reference_stale_or_future") for x in result["blockers"])


def test_unverified_optional_money_must_be_null():
    item = evidence(storage_cost_verified=False, storage_max_cost_usd="1.00")
    with pytest.raises(gate.BillingTermsError):
        gate.assess(item, policy(), now=NOW)


def test_missing_required_source_claim_refused():
    item = evidence(source_refs=refs()[:-1])
    with pytest.raises(gate.BillingTermsError, match="source references missing"):
        gate.assess(item, policy(), now=NOW)


def test_official_source_must_be_docs_nvidia_https():
    bad = refs()
    bad[1] = dict(bad[1], reference="https://example.com/billing")
    item = evidence(source_refs=bad)
    with pytest.raises(gate.BillingTermsError, match="docs.nvidia.com"):
        gate.assess(item, policy(), now=NOW)


def test_assessment_is_deterministic_and_inputs_unchanged():
    e = evidence()
    p = policy()
    before_e, before_p = copy.deepcopy(e), copy.deepcopy(p)
    one = gate.assess(e, p, now=NOW)
    two = gate.assess(e, p, now=NOW)
    assert one == two
    assert e == before_e and p == before_p
