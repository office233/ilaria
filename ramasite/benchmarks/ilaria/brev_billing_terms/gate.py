"""Read-only billing-terms admission for one selected Brev offer.

No account access, service calls, payment changes or allocation occur here. The
gate validates a content-addressed evidence packet and computes a conservative
all-in upper bound for one planned validation window.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, localcontext
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping
from urllib.parse import urlparse


EVIDENCE_FORMAT = "ilaria-brev-billing-terms-evidence-v1"
ASSESSMENT_FORMAT = "ilaria-brev-billing-terms-assessment-v1"
POLICY_FORMAT = "ilaria-brev-billing-terms-policy-v1"
MAX_JSON_BYTES = 2 * 1024 * 1024
CENT = Decimal("0.01")
SECONDS_PER_HOUR = Decimal(3600)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ALLOWED_START_PHASES = frozenset({"CREATE_ACCEPTED", "PROVISIONING", "RUNNING"})
_REQUIRED_SOURCE_CLAIMS = frozenset({
    "offer_quote",
    "running_compute_billing",
    "delete_no_charges",
    "billing_dashboard",
    "auto_recharge_controls",
})


class BillingTermsError(ValueError):
    """Invalid or insufficient billing evidence."""


def _pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise BillingTermsError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _load_json(path: str | Path) -> Any:
    target = Path(path)
    if target.is_symlink() or not target.is_file():
        raise BillingTermsError(f"input missing or symlinked: {target}")
    with target.open("rb") as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise BillingTermsError("input exceeds byte cap")

    def nonfinite(value):
        raise BillingTermsError(f"non-finite JSON value: {value}")

    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)


def _canonical_sha256(value: Mapping[str, Any], identity_field: str) -> str:
    payload = dict(value)
    payload.pop(identity_field, None)
    raw = json.dumps(
        payload,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _sha(name: str, value: Any) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise BillingTermsError(f"{name} must be lowercase SHA-256")
    return value


def _money(value: Any, name: str, *, positive: bool = False) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise BillingTermsError(f"{name} must be an exact decimal string/integer")
    try:
        result = Decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise BillingTermsError(f"invalid {name}") from exc
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise BillingTermsError(f"{name} must be finite and {'positive' if positive else 'nonnegative'}")
    exponent = result.as_tuple().exponent
    if not isinstance(exponent, int) or result.adjusted() > 12 or exponent < -12:
        raise BillingTermsError(f"{name} exceeds supported precision/range")
    return result


def _integer(value: Any, name: str, *, positive: bool = False) -> int:
    minimum = 1 if positive else 0
    if type(value) is not int or not minimum <= value <= 10**9:
        raise BillingTermsError(f"{name} must be a bounded {'positive' if positive else 'nonnegative'} integer")
    return value


def _text(value: Any, name: str, *, max_bytes: int = 2048) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or "\0" in value
        or "\n" in value
        or "\r" in value
        or len(value.encode("utf-8")) > max_bytes
    ):
        raise BillingTermsError(f"invalid {name}")
    return value


def _utc(value: Any, name: str) -> datetime:
    if not isinstance(value, str):
        raise BillingTermsError(f"{name} must be a timezone-aware ISO string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BillingTermsError(f"invalid {name}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise BillingTermsError(f"{name} requires timezone")
    return parsed.astimezone(timezone.utc)


def _ceil_cent(value: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 64
        context.rounding = ROUND_CEILING
        return value.quantize(CENT, rounding=ROUND_CEILING)


@dataclass(frozen=True)
class TermsPolicy:
    selection_sha256: str
    offer_type: str
    provider: str
    cloud: str
    expected_total_per_vm_hourly_usd: Decimal
    authorized_budget_usd: Decimal
    reserve_usd: Decimal
    planned_billable_seconds: int
    evidence_max_age_seconds: int

    @classmethod
    def from_value(cls, value: Any) -> "TermsPolicy":
        if not isinstance(value, Mapping) or value.get("format") != POLICY_FORMAT:
            raise BillingTermsError(f"unsupported {POLICY_FORMAT} input")
        expected = {
            "format",
            "selection_sha256",
            "offer_type",
            "provider",
            "cloud",
            "expected_total_per_vm_hourly_usd",
            "authorized_budget_usd",
            "reserve_usd",
            "planned_billable_seconds",
            "evidence_max_age_seconds",
        }
        if set(value) != expected:
            raise BillingTermsError("billing policy fields differ")
        policy = cls(
            selection_sha256=_sha("selection_sha256", value["selection_sha256"]),
            offer_type=_text(value["offer_type"], "offer_type"),
            provider=_text(value["provider"], "provider"),
            cloud=_text(value["cloud"], "cloud"),
            expected_total_per_vm_hourly_usd=_money(
                value["expected_total_per_vm_hourly_usd"],
                "expected_total_per_vm_hourly_usd",
                positive=True,
            ),
            authorized_budget_usd=_money(
                value["authorized_budget_usd"],
                "authorized_budget_usd",
                positive=True,
            ),
            reserve_usd=_money(value["reserve_usd"], "reserve_usd"),
            planned_billable_seconds=_integer(
                value["planned_billable_seconds"],
                "planned_billable_seconds",
                positive=True,
            ),
            evidence_max_age_seconds=_integer(
                value["evidence_max_age_seconds"],
                "evidence_max_age_seconds",
                positive=True,
            ),
        )
        if policy.reserve_usd >= policy.authorized_budget_usd:
            raise BillingTermsError("reserve leaves no compute budget")
        if policy.planned_billable_seconds > 24 * 3600:
            raise BillingTermsError("planned billable window exceeds 24-hour hard cap")
        return policy

    @property
    def compute_budget_usd(self) -> Decimal:
        return self.authorized_budget_usd - self.reserve_usd


def _source_refs(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise BillingTermsError("source_refs must be a non-empty list")
    refs = {}
    for item in value:
        expected = {"claim", "kind", "reference", "checked_at_utc"}
        if not isinstance(item, Mapping) or set(item) != expected:
            raise BillingTermsError("source reference fields differ")
        claim = _text(item["claim"], "source claim", max_bytes=128)
        kind = _text(item["kind"], "source kind", max_bytes=64)
        reference = _text(item["reference"], "source reference", max_bytes=4096)
        checked = _utc(item["checked_at_utc"], "source checked_at_utc")
        if claim in refs:
            raise BillingTermsError("duplicate source claim")
        if kind == "official_web":
            parsed = urlparse(reference)
            if parsed.scheme != "https" or parsed.netloc != "docs.nvidia.com":
                raise BillingTermsError("official_web reference must be docs.nvidia.com HTTPS")
        elif kind != "local_receipt":
            raise BillingTermsError("unsupported source reference kind")
        refs[claim] = {
            "claim": claim,
            "kind": kind,
            "reference": reference,
            "checked_at_utc": checked,
        }
    return refs


def _optional_money(
    value: Any,
    verified: bool,
    name: str,
) -> Decimal | None:
    if type(verified) is not bool:
        raise BillingTermsError(f"{name}_verified must be boolean")
    if not verified:
        if value is not None:
            raise BillingTermsError(f"{name} must be null while unverified")
        return None
    if value is None:
        raise BillingTermsError(f"{name} is required when verified")
    return _money(value, name)


def assess(
    evidence_value: Any,
    policy_value: Any,
    *,
    now: datetime,
) -> dict[str, Any]:
    policy = TermsPolicy.from_value(policy_value)
    if not isinstance(evidence_value, Mapping) or evidence_value.get("format") != EVIDENCE_FORMAT:
        raise BillingTermsError(f"unsupported {EVIDENCE_FORMAT} input")
    expected = {
        "format",
        "evidence_sha256",
        "selection_sha256",
        "offer_type",
        "provider",
        "cloud",
        "observed_at_utc",
        "currency",
        "rate_scope",
        "total_per_vm_hourly_usd",
        "billing_start_verified",
        "billing_start_phase",
        "billing_granularity_seconds",
        "delete_stops_all_charges_verified",
        "storage_cost_verified",
        "storage_max_cost_usd",
        "egress_cost_verified",
        "egress_max_cost_usd",
        "taxes_other_verified",
        "taxes_other_max_cost_usd",
        "auto_recharge_status_verified",
        "auto_recharge_disabled",
        "source_refs",
    }
    if set(evidence_value) != expected:
        raise BillingTermsError("billing evidence fields differ")
    declared = _sha("evidence_sha256", evidence_value["evidence_sha256"])
    if _canonical_sha256(evidence_value, "evidence_sha256") != declared:
        raise BillingTermsError("billing evidence identity mismatch")
    if evidence_value["selection_sha256"] != policy.selection_sha256:
        raise BillingTermsError("billing evidence selection binding differs")
    for field in ("offer_type", "provider", "cloud"):
        if evidence_value[field] != getattr(policy, field):
            raise BillingTermsError(f"billing evidence {field} binding differs")
    observed = _utc(evidence_value["observed_at_utc"], "observed_at_utc")
    if now.tzinfo is None or now.utcoffset() is None:
        raise BillingTermsError("now requires timezone")
    now = now.astimezone(timezone.utc)
    age = Decimal(str((now - observed).total_seconds()))
    if age < 0 or age > policy.evidence_max_age_seconds:
        raise BillingTermsError("billing evidence is future-dated or stale")

    if evidence_value["currency"] != "USD" or evidence_value["rate_scope"] != "TOTAL_PER_VM":
        raise BillingTermsError("billing quote must be USD TOTAL_PER_VM")
    hourly = _money(
        evidence_value["total_per_vm_hourly_usd"],
        "total_per_vm_hourly_usd",
        positive=True,
    )
    if hourly != policy.expected_total_per_vm_hourly_usd:
        raise BillingTermsError("billing hourly quote differs from selected offer")

    refs = _source_refs(evidence_value["source_refs"])
    missing_base_refs = sorted(_REQUIRED_SOURCE_CLAIMS - set(refs))
    if missing_base_refs:
        raise BillingTermsError("billing source references missing: " + ",".join(missing_base_refs))

    blockers = []
    billing_start_verified = evidence_value["billing_start_verified"]
    if type(billing_start_verified) is not bool:
        raise BillingTermsError("billing_start_verified must be boolean")
    phase = evidence_value["billing_start_phase"]
    if billing_start_verified:
        if phase not in _ALLOWED_START_PHASES:
            raise BillingTermsError("verified billing_start_phase is invalid")
    else:
        if phase is not None:
            raise BillingTermsError("billing_start_phase must be null while unverified")
        blockers.append("billing_start_unverified")

    quantum = evidence_value["billing_granularity_seconds"]
    if quantum is None:
        blockers.append("billing_granularity_unverified")
    else:
        quantum = _integer(quantum, "billing_granularity_seconds", positive=True)
        if quantum > 24 * 3600:
            raise BillingTermsError("billing granularity exceeds 24-hour hard cap")

    delete_verified = evidence_value["delete_stops_all_charges_verified"]
    if type(delete_verified) is not bool:
        raise BillingTermsError("delete_stops_all_charges_verified must be boolean")
    if not delete_verified:
        blockers.append("delete_billing_stop_unverified")

    storage = _optional_money(
        evidence_value["storage_max_cost_usd"],
        evidence_value["storage_cost_verified"],
        "storage_max_cost_usd",
    )
    egress = _optional_money(
        evidence_value["egress_max_cost_usd"],
        evidence_value["egress_cost_verified"],
        "egress_max_cost_usd",
    )
    other = _optional_money(
        evidence_value["taxes_other_max_cost_usd"],
        evidence_value["taxes_other_verified"],
        "taxes_other_max_cost_usd",
    )
    if storage is None:
        blockers.append("storage_cost_unverified")
    if egress is None:
        blockers.append("egress_cost_unverified")
    if other is None:
        blockers.append("taxes_other_cost_unverified")

    auto_verified = evidence_value["auto_recharge_status_verified"]
    auto_disabled = evidence_value["auto_recharge_disabled"]
    if type(auto_verified) is not bool:
        raise BillingTermsError("auto_recharge_status_verified must be boolean")
    if auto_verified:
        if type(auto_disabled) is not bool:
            raise BillingTermsError("auto_recharge_disabled must be boolean when verified")
        if auto_disabled is not True:
            blockers.append("auto_recharge_enabled")
    else:
        if auto_disabled is not None:
            raise BillingTermsError("auto_recharge_disabled must be null while unverified")
        blockers.append("auto_recharge_status_unverified")

    if quantum is None:
        projected_compute = None
    else:
        with localcontext() as context:
            context.prec = 64
            quanta = (
                Decimal(policy.planned_billable_seconds) / Decimal(quantum)
            ).to_integral_value(rounding=ROUND_CEILING)
            billed_seconds = quanta * Decimal(quantum)
            projected_compute = _ceil_cent(
                billed_seconds * hourly / SECONDS_PER_HOUR
            )

    ancillary = None
    all_in = None
    if storage is not None and egress is not None and other is not None:
        ancillary = _ceil_cent(storage + egress + other)
        if ancillary > policy.reserve_usd:
            blockers.append("ancillary_max_exceeds_reserved_budget")
        if projected_compute is not None:
            all_in = _ceil_cent(projected_compute + ancillary)
            if projected_compute > policy.compute_budget_usd:
                blockers.append("projected_compute_exceeds_compute_budget")
            if all_in > policy.authorized_budget_usd:
                blockers.append("projected_all_in_exceeds_authorized_budget")
    elif projected_compute is not None and projected_compute > policy.compute_budget_usd:
        blockers.append("projected_compute_exceeds_compute_budget")

    source_age_blockers = []
    for claim, ref in refs.items():
        source_age = Decimal(str((now - ref["checked_at_utc"]).total_seconds()))
        if source_age < 0 or source_age > policy.evidence_max_age_seconds:
            source_age_blockers.append(claim)
    if source_age_blockers:
        blockers.append(
            "source_reference_stale_or_future:" + ",".join(sorted(source_age_blockers))
        )

    result = {
        "format": ASSESSMENT_FORMAT,
        "evidence_sha256": declared,
        "selection_sha256": policy.selection_sha256,
        "offer_type": policy.offer_type,
        "ready": not blockers,
        "allocation_authorized": False,
        "blockers": blockers,
        "quote": {
            "currency": "USD",
            "rate_scope": "TOTAL_PER_VM",
            "hourly_usd": str(hourly),
            "billing_granularity_seconds": quantum,
            "billing_start_phase": phase,
        },
        "budget": {
            "authorized_budget_usd": str(policy.authorized_budget_usd),
            "reserve_usd": str(policy.reserve_usd),
            "compute_budget_usd": str(policy.compute_budget_usd),
            "planned_billable_seconds": policy.planned_billable_seconds,
            "projected_compute_usd": (
                str(projected_compute) if projected_compute is not None else None
            ),
            "ancillary_max_usd": str(ancillary) if ancillary is not None else None,
            "projected_all_in_usd": str(all_in) if all_in is not None else None,
        },
        "controls": {
            "delete_stops_all_charges_verified": delete_verified,
            "auto_recharge_status_verified": auto_verified,
            "auto_recharge_disabled": auto_disabled,
        },
        "source_claims": sorted(refs),
    }
    result["assessment_sha256"] = _canonical_sha256(
        result,
        "assessment_sha256",
    )
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--now-utc", required=True)
    args = parser.parse_args(argv)
    evidence = _load_json(args.evidence)
    policy = _load_json(args.policy)
    now = _utc(args.now_utc, "now_utc")
    result = assess(evidence, policy, now=now)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
