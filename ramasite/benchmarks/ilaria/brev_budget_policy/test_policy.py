from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext

import pytest

from policy import (
    Action, Binding, IMPLEMENTATION_STATUS, InstanceState, Observation, Policy,
    PolicyError, QuoteSnapshot, TerminationEvidence, evaluate, plan,
)


def manifest():
    return {
        "schema_version": 1,
        "binding": {"instance_id": "existing-fixture-vm", "provider": "fixture-provider",
                    "instance_type": "fixture-8xH200", "gpu_quantity": 8,
                    "quote_id": "fixed-existing-quote", "currency": "USD", "rate_scope": "TOTAL_PER_VM",
                    "total_per_vm_hourly_usd": "38.40"},
        "authorized_budget_usd": "100.00", "budget_cap_usd": "100.00", "prior_spend_usd": "0",
        "billing_started_at": "2026-10-01T20:00:00Z", "absolute_deadline": "2026-10-01T22:30:00Z",
        "host_stops_at": "2026-10-01T23:00:00Z", "provisioning_seconds": 60, "startup_seconds": 750,
        "export_seconds": 120, "deletion_slack_seconds": 300, "quote_max_age_seconds": 900,
        "observation_max_age_seconds": 60, "max_new_instances": 0, "restart_allowed": False,
    }


@pytest.fixture
def p():
    return Policy.from_manifest(manifest())


def snapshot(p, now, state=InstanceState.RUNNING, **kwargs):
    return QuoteSnapshot(p.binding, now), Observation(p.binding, state, now, True, **kwargs)


def test_full_plan_charges_startup_and_all_slack_once_at_whole_vm_rate(p):
    now = p.billing_started_at
    result = plan(p, QuoteSnapshot(p.binding, now), now, 3600)
    assert result.accepted
    assert result.billable_seconds == 4830
    assert result.projected_total_usd == Decimal("51.52")
    assert result.decision.target_instance_id == p.binding.instance_id
    assert result.decision.implementation_status == IMPLEMENTATION_STATUS


def test_elapsed_provisioning_is_also_charged(p):
    now = p.billing_started_at + timedelta(seconds=100)
    result = plan(p, QuoteSnapshot(p.binding, now), now, 0)
    assert result.billable_seconds == 1330
    assert result.projected_total_usd == Decimal("14.19")


def test_insufficient_startup_time_and_budget_reject(p):
    now = p.deadline - timedelta(seconds=1000)
    assert not plan(p, QuoteSnapshot(p.binding, now), now, 0).accepted
    low = replace(p, budget_cap_usd=Decimal("5"))
    assert plan(low, QuoteSnapshot(low.binding, low.billing_started_at), low.billing_started_at, 0).decision.action == Action.STOP_AND_DELETE


def test_charge_rounds_up_including_fractional_seconds(p):
    assert p.charge(Decimal("0.01")) == Decimal("0.01")
    assert p.charge(Decimal("3600")) == Decimal("38.40")


def test_caller_decimal_context_cannot_reduce_cost_estimate(p):
    with localcontext() as context:
        context.prec = 3
        assert p.charge(Decimal("4830")) == Decimal("51.52")


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", "-1", 38.4, True, "1e99", "0.0000000000001"])
def test_nonfinite_or_inexact_money_rejected(bad):
    data = manifest()
    data["binding"]["total_per_vm_hourly_usd"] = bad
    with pytest.raises(PolicyError):
        Policy.from_manifest(data)


@pytest.mark.parametrize("field,value", [("schema_version", True), ("startup_seconds", float("nan")),
    ("max_new_instances", 1), ("max_new_instances", False), ("restart_allowed", True),
    ("budget_cap_usd", "101"), ("prior_spend_usd", "101"), ("export_seconds", 0)])
def test_manifest_rejects_scope_broadening_or_malformed_caps(field, value):
    data = manifest()
    data[field] = value
    with pytest.raises(PolicyError):
        Policy.from_manifest(data)


def test_missing_unknown_fields_and_immutable_bindings(p):
    for mutate in (lambda d: d.pop("binding"), lambda d: d.update(extra="ignored")):
        data = manifest()
        mutate(data)
        with pytest.raises(PolicyError):
            Policy.from_manifest(data)
    with pytest.raises(FrozenInstanceError):
        p.binding.instance_id = "new-instance"


def test_timezone_required_and_offsets_normalized():
    data = manifest()
    data["billing_started_at"] = "2026-10-01T23:00:00+03:00"
    assert Policy.from_manifest(data).billing_started_at.hour == 20
    data["billing_started_at"] = "2026-10-01T20:00:00"
    with pytest.raises(PolicyError):
        Policy.from_manifest(data)


@pytest.mark.parametrize("field,value", [("provider", "other"), ("instance_id", "other"),
    ("instance_type", "other"), ("gpu_quantity", 1), ("quote_id", "other"),
    ("total_per_vm_hourly_usd", Decimal("307.20"))])
def test_quote_or_instance_drift_never_broadens_target(p, field, value):
    now = p.billing_started_at
    q, obs = snapshot(p, now)
    drift = replace(p.binding, **{field: value})
    for quote, observation in ((replace(q, binding=drift), obs), (q, replace(obs, binding=drift))):
        decision = evaluate(p, quote, observation, now)
        assert decision.action == Action.STOP_AND_DELETE
        assert decision.target_instance_id == p.binding.instance_id
        assert not decision.billing_stop_evidence_confirmed


def test_per_gpu_quote_is_not_accepted():
    data = manifest()
    data["binding"]["rate_scope"] = "PER_GPU"
    with pytest.raises(PolicyError):
        Policy.from_manifest(data)


@pytest.mark.parametrize("offset", [-901, 1])
def test_stale_or_future_quote_fails_closed(p, offset):
    now = p.billing_started_at
    q, obs = snapshot(p, now)
    q = replace(q, observed_at=now + timedelta(seconds=offset))
    assert evaluate(p, q, obs, now).action == Action.STOP_AND_DELETE
    with pytest.raises(PolicyError):
        plan(p, q, now, 0)


@pytest.mark.parametrize("state", [InstanceState.UNKNOWN, "RUNNING"])
def test_unknown_or_untyped_state_fails_closed(p, state):
    now = p.billing_started_at
    q, obs = snapshot(p, now, state)
    assert evaluate(p, q, obs, now).action == Action.STOP_AND_DELETE


def test_unavailable_and_stale_readback_fail_closed(p):
    now = p.billing_started_at + timedelta(seconds=100)
    q, obs = snapshot(p, now)
    for unsafe in (replace(obs, readback_available=False), replace(obs, observed_at=now-timedelta(seconds=61))):
        assert evaluate(p, q, unsafe, now).action == Action.STOP_AND_DELETE
    assert evaluate(p, q, obs, datetime(2026, 10, 1)).action == Action.STOP_AND_DELETE


def test_export_and_delete_timing_reserves(p):
    now = p.deadline - timedelta(seconds=600)
    q, obs = snapshot(p, now)
    assert evaluate(p, q, obs, now, next_work_seconds=181).action == Action.EXPORT_AND_DELETE
    assert evaluate(p, q, obs, now, next_work_seconds=100).action == Action.CONTINUE
    now = p.deadline - timedelta(seconds=350)
    q, obs = snapshot(p, now)
    assert evaluate(p, q, obs, now).action == Action.STOP_AND_DELETE


def test_at_and_after_delete_deadline_never_continues(p):
    for now in (p.latest_delete_request_at, p.deadline, p.host_stops_at):
        q, obs = snapshot(p, now)
        assert evaluate(p, q, obs, now).action == Action.STOP_AND_DELETE


def test_host_stop_can_be_the_earlier_hard_boundary(p):
    earlier = replace(p, host_stops_at=p.absolute_deadline-timedelta(minutes=10))
    assert earlier.deadline == earlier.host_stops_at
    assert earlier.latest_delete_request_at == earlier.host_stops_at-timedelta(seconds=300)


def test_budget_drift_preserves_delete_and_skips_export_when_needed(p):
    now = p.billing_started_at + timedelta(seconds=3600)
    q, obs = snapshot(p, now)
    enough_delete_only = replace(p, budget_cap_usd=Decimal("42.00"))
    assert evaluate(enough_delete_only, q, obs, now).action == Action.STOP_AND_DELETE
    enough_export = replace(p, budget_cap_usd=Decimal("45.00"))
    assert evaluate(enough_export, q, obs, now, 1000).action == Action.EXPORT_AND_DELETE


def test_startup_reserve_and_export_failure(p):
    now = p.deadline-timedelta(seconds=1100)
    q, obs = snapshot(p, now, InstanceState.STARTING)
    assert evaluate(p, q, obs, now).action == Action.STOP_AND_DELETE
    assert evaluate(p, q, replace(obs, export_failed=True), now).action == Action.STOP_AND_DELETE


@pytest.mark.parametrize("state", [InstanceState.RUNNING, InstanceState.DELETING, InstanceState.TERMINATED])
def test_delete_request_or_terminal_label_is_not_billing_success(p, state):
    now = p.billing_started_at+timedelta(hours=1)
    q, obs = snapshot(p, now, state, delete_requested_at=now)
    result = evaluate(p, q, obs, now)
    assert result.action == Action.STOP_AND_DELETE
    assert not result.billing_stop_evidence_confirmed


def test_scoped_provider_termination_readback_confirms_only_evidence(p):
    now = p.billing_started_at+timedelta(hours=1)
    evidence = TerminationEvidence(p.binding.instance_id, p.binding.provider, now, now, "fixture-readback")
    q, obs = snapshot(p, now, InstanceState.TERMINATED, termination=evidence)
    result = evaluate(p, q, obs, now)
    assert result.action == Action.TERMINATION_CONFIRMED
    assert result.billing_stop_evidence_confirmed
    assert result.estimated_total_usd == Decimal("38.40")
    assert "invoice reconciliation" in result.reasons[0]
    for invalid in (replace(evidence, instance_id="other"), replace(evidence, provider="other"),
                    replace(evidence, provider_readback_reference=""),
                    replace(evidence, terminated_at=now+timedelta(seconds=1)),
                    replace(evidence, terminal_state="TERMINATED"),
                    replace(evidence, terminal_state=InstanceState.DELETING)):
        assert evaluate(p, q, replace(obs, termination=invalid), now).action == Action.STOP_AND_DELETE


def test_late_termination_reports_cap_and_deadline_breach(p):
    now = p.billing_started_at+timedelta(hours=3)
    evidence = TerminationEvidence(p.binding.instance_id, p.binding.provider, now, now, "fixture-readback")
    q, obs = snapshot(p, now, InstanceState.TERMINATED, termination=evidence)
    result = evaluate(p, q, obs, now)
    assert result.action == Action.TERMINATION_CONFIRMED
    assert "exceeded deadline" in result.reasons[0]
    assert "exceeded cap" in result.reasons[0]
