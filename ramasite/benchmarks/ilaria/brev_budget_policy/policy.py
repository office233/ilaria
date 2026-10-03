"""Offline decisions for one explicitly authorized existing VM; no service calls."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, localcontext
from enum import Enum
from typing import Any, Mapping, Protocol

IMPLEMENTATION_STATUS = "OFFLINE_ONLY_REMOTE_DELETE_UNVERIFIED"
CENT = Decimal("0.01")
SECONDS_PER_HOUR = Decimal(3600)


class PolicyError(ValueError):
    """Invalid or insufficient authorization/observation."""


def _money(value: Any, name: str, *, positive: bool = False) -> Decimal:
    if not isinstance(value, (str, Decimal, int)) or isinstance(value, bool):
        raise PolicyError(f"{name} must be an exact decimal string, Decimal or integer")
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise PolicyError(f"invalid {name}") from exc
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise PolicyError(f"{name} must be finite and {'positive' if positive else 'nonnegative'}")
    # Bound decimal complexity so quantization cannot overflow its context.
    if result.adjusted() > 12 or result.as_tuple().exponent < -12:
        raise PolicyError(f"{name} exceeds supported decimal precision/range")
    return result


def _integer(value: Any, name: str, *, positive: bool = False) -> int:
    if type(value) is not int or value < (1 if positive else 0) or value > 10**9:
        raise PolicyError(f"{name} must be a bounded {'positive' if positive else 'nonnegative'} integer")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise PolicyError(f"{name} must be a nonempty, unpadded string")
    return value


def _utc(value: Any, name: str) -> datetime:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise PolicyError(f"invalid {name}") from exc
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise PolicyError(f"{name} requires an explicit timezone")
    return value.astimezone(timezone.utc)


def _seconds(delta: timedelta) -> Decimal:
    with localcontext() as context:
        context.prec = 64
        return Decimal(delta.days * 86400 + delta.seconds) + Decimal(delta.microseconds) / Decimal(1000000)


def _keys(data: Any, expected: set[str], name: str) -> Mapping[str, Any]:
    if not isinstance(data, Mapping) or set(data) != expected:
        raise PolicyError(f"{name} fields must be exactly {sorted(expected)}")
    return data


@dataclass(frozen=True)
class Binding:
    instance_id: str
    provider: str
    instance_type: str
    gpu_quantity: int
    quote_id: str
    currency: str
    rate_scope: str
    total_per_vm_hourly_usd: Decimal

    def __post_init__(self) -> None:
        for name in ("instance_id", "provider", "instance_type", "quote_id"):
            _text(getattr(self, name), name)
        _integer(self.gpu_quantity, "gpu_quantity", positive=True)
        if self.currency != "USD" or self.rate_scope != "TOTAL_PER_VM":
            raise PolicyError("only an explicit USD TOTAL_PER_VM quote is authorized")
        object.__setattr__(self, "total_per_vm_hourly_usd", _money(
            self.total_per_vm_hourly_usd, "total_per_vm_hourly_usd", positive=True))


@dataclass(frozen=True)
class Policy:
    binding: Binding
    authorized_budget_usd: Decimal
    budget_cap_usd: Decimal
    prior_spend_usd: Decimal
    billing_started_at: datetime
    absolute_deadline: datetime
    host_stops_at: datetime
    provisioning_seconds: int
    startup_seconds: int
    export_seconds: int
    deletion_slack_seconds: int
    quote_max_age_seconds: int
    observation_max_age_seconds: int
    max_new_instances: int = 0
    restart_allowed: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.binding, Binding):
            raise PolicyError("an immutable existing-instance binding is required")
        if type(self.max_new_instances) is not int or self.max_new_instances != 0 or self.restart_allowed is not False:
            raise PolicyError("new instances and stop/start or restart are forbidden")
        for name in ("authorized_budget_usd", "budget_cap_usd", "prior_spend_usd"):
            object.__setattr__(self, name, _money(getattr(self, name), name, positive=name != "prior_spend_usd"))
        if self.budget_cap_usd > self.authorized_budget_usd or self.prior_spend_usd > self.budget_cap_usd:
            raise PolicyError("spend cap/prior spend exceeds authorization")
        for name in ("billing_started_at", "absolute_deadline", "host_stops_at"):
            object.__setattr__(self, name, _utc(getattr(self, name), name))
        for name in ("provisioning_seconds", "startup_seconds", "export_seconds", "deletion_slack_seconds",
                     "quote_max_age_seconds", "observation_max_age_seconds"):
            _integer(getattr(self, name), name, positive=name in (
                "export_seconds", "deletion_slack_seconds", "quote_max_age_seconds", "observation_max_age_seconds"))
        if self.billing_started_at >= self.deadline:
            raise PolicyError("billing start must precede the effective deadline")

    @property
    def deadline(self) -> datetime:
        """Conservatively require confirmed termination by either hard boundary."""
        return min(self.absolute_deadline, self.host_stops_at)

    @property
    def latest_delete_request_at(self) -> datetime:
        return self.deadline - timedelta(seconds=self.deletion_slack_seconds)

    @classmethod
    def from_manifest(cls, data: Mapping[str, Any]) -> Policy:
        fields = set(cls.__dataclass_fields__) | {"schema_version"}
        data = _keys(data, fields, "manifest")
        if type(data["schema_version"]) is not int or data["schema_version"] != 1:
            raise PolicyError("unsupported manifest schema")
        binding = _keys(data["binding"], set(Binding.__dataclass_fields__), "binding")
        args = {key: value for key, value in data.items() if key not in ("schema_version", "binding")}
        return cls(binding=Binding(**binding), **args)

    def charge(self, billable_seconds: Decimal) -> Decimal:
        seconds = _money(billable_seconds, "billable_seconds")
        with localcontext() as context:
            context.prec = 64
            context.rounding = ROUND_CEILING
            return (self.prior_spend_usd + seconds * self.binding.total_per_vm_hourly_usd /
                    SECONDS_PER_HOUR).quantize(CENT, rounding=ROUND_CEILING)


@dataclass(frozen=True)
class QuoteSnapshot:
    binding: Binding
    observed_at: datetime


class InstanceState(str, Enum):
    PROVISIONING = "PROVISIONING"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    EXPORTING = "EXPORTING"
    DELETING = "DELETING"
    TERMINATED = "TERMINATED"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class TerminationEvidence:
    instance_id: str
    provider: str
    terminated_at: datetime
    observed_at: datetime
    provider_readback_reference: str
    terminal_state: InstanceState = InstanceState.TERMINATED


@dataclass(frozen=True)
class Observation:
    binding: Binding
    state: InstanceState
    observed_at: datetime
    readback_available: bool
    delete_requested_at: datetime | None = None
    export_failed: bool = False
    termination: TerminationEvidence | None = None


class ReadOnlyAdapter(Protocol):
    """A caller-owned reader. This module supplies no concrete service adapter."""

    def read_quote(self, quote_id: str) -> QuoteSnapshot: ...

    def read_instance(self, instance_id: str) -> Observation: ...


class Action(str, Enum):
    CONTINUE = "CONTINUE"
    EXPORT_AND_DELETE = "EXPORT_AND_DELETE"
    STOP_AND_DELETE = "STOP_AND_DELETE"
    TERMINATION_CONFIRMED = "TERMINATION_CONFIRMED"


@dataclass(frozen=True)
class Decision:
    action: Action
    target_instance_id: str
    reasons: tuple[str, ...]
    estimated_total_usd: Decimal | None = None
    latest_delete_request_at: datetime | None = None
    billing_stop_evidence_confirmed: bool = False
    implementation_status: str = IMPLEMENTATION_STATUS


@dataclass(frozen=True)
class CostPlan:
    accepted: bool
    decision: Decision
    billable_seconds: Decimal
    projected_total_usd: Decimal
    projected_termination_at: datetime


def _fresh(observed_at: datetime, now: datetime, age_limit: int, name: str) -> None:
    age = _seconds(now - _utc(observed_at, name))
    if age < 0 or age > age_limit:
        raise PolicyError(f"{name} is future-dated or stale")


def _quote(policy: Policy, quote: QuoteSnapshot, now: datetime) -> None:
    if not isinstance(quote, QuoteSnapshot) or quote.binding != policy.binding:
        raise PolicyError("quote drift or missing fixed TOTAL_PER_VM binding")
    _fresh(quote.observed_at, now, policy.quote_max_age_seconds, "quote")


def _decision(policy: Policy, action: Action, reason: str, estimate: Decimal | None = None) -> Decision:
    return Decision(action, policy.binding.instance_id, (reason,), estimate,
                    policy.latest_delete_request_at, action == Action.TERMINATION_CONFIRMED)


def plan(policy: Policy, quote: QuoteSnapshot, now: datetime, work_seconds: int) -> CostPlan:
    """Reserve all phases, charging elapsed provisioning time as well as future time.

    Planning reserves the full configured provisioning/startup duration even for an
    already existing VM. Runtime observations can establish that those phases ended.
    Invalid inputs raise PolicyError; a valid but unaffordable plan is rejected.
    """
    now = _utc(now, "now")
    _integer(work_seconds, "work_seconds")
    _quote(policy, quote, now)
    if now < policy.billing_started_at:
        raise PolicyError("now precedes the bound billing start")
    future = (policy.provisioning_seconds + policy.startup_seconds + work_seconds +
              policy.export_seconds + policy.deletion_slack_seconds)
    termination = now + timedelta(seconds=future)
    billable = _seconds(termination - policy.billing_started_at)
    cost = policy.charge(billable)
    reasons = []
    if termination > policy.deadline:
        reasons.append("insufficient time including startup/export/deletion reserves")
    if cost > policy.budget_cap_usd:
        reasons.append("insufficient budget including all reserved billable phases")
    accepted = not reasons
    decision = _decision(policy, Action.CONTINUE if accepted else Action.STOP_AND_DELETE,
                         "; ".join(reasons) if reasons else "all phase reserves fit", cost)
    return CostPlan(accepted, decision, billable, cost, termination)


def evaluate(policy: Policy, quote: QuoteSnapshot, observation: Observation,
             now: datetime, next_work_seconds: int = 0) -> Decision:
    """Fail closed. Returned actions are instructions, never executed operations.

    STOP_AND_DELETE means stop work and request deletion of the fixed instance;
    it never means power-off, pause, restart, create a replacement, or billing success.
    """
    try:
        now = _utc(now, "now")
        _integer(next_work_seconds, "next_work_seconds")
        if now < policy.billing_started_at:
            raise PolicyError("now precedes billing start")
        if not isinstance(observation, Observation) or observation.binding != policy.binding:
            raise PolicyError("instance identity/provider/type/quantity/rate drift")
        if observation.readback_available is not True:
            raise PolicyError("provider readback unavailable")
        if type(observation.export_failed) is not bool or observation.export_failed:
            raise PolicyError("export failed or its status is malformed")
        if not isinstance(observation.state, InstanceState) or observation.state == InstanceState.UNKNOWN:
            raise PolicyError("unknown or malformed instance state")
        _fresh(observation.observed_at, now, policy.observation_max_age_seconds, "instance observation")
        if observation.delete_requested_at is not None:
            requested = _utc(observation.delete_requested_at, "delete_requested_at")
            if requested < policy.billing_started_at or requested > _utc(observation.observed_at, "observation"):
                raise PolicyError("invalid deletion request timestamp")
            if observation.state != InstanceState.TERMINATED:
                return _decision(policy, Action.STOP_AND_DELETE,
                                 "deletion request is not verified termination")
        if observation.state == InstanceState.TERMINATED:
            evidence = observation.termination
            if not isinstance(evidence, TerminationEvidence):
                raise PolicyError("missing provider termination evidence")
            if (evidence.instance_id != policy.binding.instance_id or evidence.provider != policy.binding.provider
                    or not isinstance(evidence.terminal_state, InstanceState)
                    or evidence.terminal_state != InstanceState.TERMINATED):
                raise PolicyError("termination evidence does not bind the authorized instance")
            _text(evidence.provider_readback_reference, "provider_readback_reference")
            stopped = _utc(evidence.terminated_at, "terminated_at")
            confirmed = _utc(evidence.observed_at, "termination observed_at")
            _fresh(confirmed, now, policy.observation_max_age_seconds, "termination readback")
            if not policy.billing_started_at <= stopped <= confirmed <= _utc(observation.observed_at, "observation"):
                raise PolicyError("invalid termination evidence timeline")
            if observation.delete_requested_at is not None and requested > stopped:
                raise PolicyError("deletion request occurs after supplied termination")
            cost = policy.charge(_seconds(stopped - policy.billing_started_at))
            breaches = []
            if stopped > policy.deadline:
                breaches.append("termination exceeded deadline")
            if cost > policy.budget_cap_usd:
                breaches.append("estimated spend exceeded cap")
            reason = "provider termination readback confirmed; invoice reconciliation still required"
            if breaches:
                reason += "; " + "; ".join(breaches)
            return _decision(policy, Action.TERMINATION_CONFIRMED, reason, cost)
        _quote(policy, quote, now)
        if observation.termination is not None:
            raise PolicyError("termination evidence contradicts live state")
        if observation.state == InstanceState.DELETING:
            return _decision(policy, Action.STOP_AND_DELETE, "deletion in progress; termination unverified")
        setup = 0
        if observation.state == InstanceState.PROVISIONING:
            setup = policy.provisioning_seconds + policy.startup_seconds
        elif observation.state == InstanceState.STARTING:
            setup = policy.startup_seconds
        reserve = policy.export_seconds + policy.deletion_slack_seconds
        elapsed = _seconds(now - policy.billing_started_at)
        delete_cost = policy.charge(elapsed + Decimal(policy.deletion_slack_seconds))
        export_cost = policy.charge(elapsed + Decimal(reserve))
        full_cost = policy.charge(elapsed + Decimal(setup + next_work_seconds + reserve))
        if now >= policy.latest_delete_request_at or delete_cost > policy.budget_cap_usd:
            return _decision(policy, Action.STOP_AND_DELETE, "deletion deadline or budget reserve reached", delete_cost)
        if now + timedelta(seconds=reserve) > policy.deadline or export_cost > policy.budget_cap_usd:
            return _decision(policy, Action.STOP_AND_DELETE, "export cannot fit; preserve deletion reserve", delete_cost)
        if setup and (now + timedelta(seconds=setup + reserve) > policy.deadline or
                      policy.charge(elapsed + Decimal(setup + reserve)) > policy.budget_cap_usd):
            return _decision(policy, Action.STOP_AND_DELETE,
                             "remaining provisioning/startup cannot fit export/deletion reserves", delete_cost)
        if (observation.state == InstanceState.EXPORTING or
                now + timedelta(seconds=setup + next_work_seconds + reserve) >= policy.deadline or
                full_cost > policy.budget_cap_usd):
            return _decision(policy, Action.EXPORT_AND_DELETE, "stop work; use export/deletion reserve", export_cost)
        return _decision(policy, Action.CONTINUE, "next work interval and all reserves fit", full_cost)
    except (PolicyError, TypeError, ValueError, OverflowError, InvalidOperation) as exc:
        return _decision(policy, Action.STOP_AND_DELETE, str(exc))
