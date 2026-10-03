"""Deterministic, read-only selector for multi-GPU Brev catalog offers.

The module consumes a captured catalog plus an explicit policy. It never calls
Brev, creates instances, accepts Terms, or grants allocation authority.
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


SELECTION_FORMAT = "ilaria-brev-offer-selection-v1"
POLICY_FORMAT = "ilaria-brev-offer-policy-v1"
CATALOG_FORMAT = "nexus-brev-live-accelerator-catalog-v1"
MAX_JSON_BYTES = 32 * 1024 * 1024
CENT = Decimal("0.01")
_GPU = re.compile(r"^[A-Z][A-Z0-9._+-]{0,31}$")


class SelectionError(ValueError):
    """Invalid catalog/policy input."""


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise SelectionError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _load_json(path: str | Path) -> Any:
    target = Path(path)
    if not target.is_file() or target.is_symlink():
        raise SelectionError(f"input is missing or symlinked: {target}")
    with target.open("rb") as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise SelectionError("input exceeds byte limit")

    def nonfinite(value):
        raise SelectionError(f"non-finite JSON value: {value}")

    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=nonfinite)


def _money(value: Any, name: str, *, positive: bool = False) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise SelectionError(f"{name} must be numeric")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise SelectionError(f"invalid {name}") from exc
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise SelectionError(f"{name} must be finite and {'positive' if positive else 'nonnegative'}")
    exponent = result.as_tuple().exponent
    if not isinstance(exponent, int):
        raise SelectionError(f"{name} has unsupported decimal exponent")
    if result.adjusted() > 12 or exponent < -12:
        raise SelectionError(f"{name} exceeds supported precision/range")
    return result


def _bounded_int(value: Any, name: str, *, positive: bool = False) -> int:
    minimum = 1 if positive else 0
    if type(value) is not int or not minimum <= value <= 10**9:
        raise SelectionError(f"{name} must be a bounded {'positive' if positive else 'nonnegative'} integer")
    return value


def _utc(value: Any, name: str) -> datetime:
    if not isinstance(value, str):
        raise SelectionError(f"{name} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SelectionError(f"invalid {name}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SelectionError(f"{name} requires timezone")
    return parsed.astimezone(timezone.utc)


def _ceil_money(value: Decimal) -> Decimal:
    with localcontext() as context:
        context.prec = 64
        context.rounding = ROUND_CEILING
        return value.quantize(CENT, rounding=ROUND_CEILING)


def _canonical_hash(value: Mapping[str, Any]) -> str:
    raw = json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class Policy:
    authorized_budget_usd: Decimal
    reserve_usd: Decimal
    prior_spend_usd: Decimal
    planned_billable_hours: Decimal
    required_gpu_count: int
    min_vram_per_gpu_gb: int
    min_compute_capability: Decimal
    preferred_gpu_families: tuple[str, ...]
    catalog_max_age_seconds: int
    billing_terms_verified: bool
    topology_verified: bool
    terms_acceptance_verified: bool

    @classmethod
    def from_json(cls, value: Any) -> "Policy":
        if not isinstance(value, Mapping) or value.get("format") != POLICY_FORMAT:
            raise SelectionError(f"unsupported {POLICY_FORMAT} input")
        expected = {
            "format",
            "authorized_budget_usd",
            "reserve_usd",
            "prior_spend_usd",
            "planned_billable_hours",
            "required_gpu_count",
            "min_vram_per_gpu_gb",
            "min_compute_capability",
            "preferred_gpu_families",
            "catalog_max_age_seconds",
            "billing_terms_verified",
            "topology_verified",
            "terms_acceptance_verified",
        }
        if set(value) != expected:
            raise SelectionError("offer policy fields differ")
        families = value["preferred_gpu_families"]
        if not isinstance(families, list) or not families or len(families) != len(set(families)):
            raise SelectionError("preferred_gpu_families must be a unique non-empty list")
        normalized = []
        for family in families:
            if not isinstance(family, str):
                raise SelectionError("GPU family must be text")
            family = family.upper()
            if _GPU.fullmatch(family) is None:
                raise SelectionError("GPU family name is invalid")
            normalized.append(family)
        for field in (
            "billing_terms_verified",
            "topology_verified",
            "terms_acceptance_verified",
        ):
            if type(value[field]) is not bool:
                raise SelectionError(f"{field} must be boolean")
        policy = cls(
            authorized_budget_usd=_money(value["authorized_budget_usd"], "authorized_budget_usd", positive=True),
            reserve_usd=_money(value["reserve_usd"], "reserve_usd"),
            prior_spend_usd=_money(value["prior_spend_usd"], "prior_spend_usd"),
            planned_billable_hours=_money(value["planned_billable_hours"], "planned_billable_hours", positive=True),
            required_gpu_count=_bounded_int(value["required_gpu_count"], "required_gpu_count", positive=True),
            min_vram_per_gpu_gb=_bounded_int(value["min_vram_per_gpu_gb"], "min_vram_per_gpu_gb", positive=True),
            min_compute_capability=_money(value["min_compute_capability"], "min_compute_capability", positive=True),
            preferred_gpu_families=tuple(normalized),
            catalog_max_age_seconds=_bounded_int(value["catalog_max_age_seconds"], "catalog_max_age_seconds", positive=True),
            billing_terms_verified=value["billing_terms_verified"],
            topology_verified=value["topology_verified"],
            terms_acceptance_verified=value["terms_acceptance_verified"],
        )
        if policy.reserve_usd + policy.prior_spend_usd >= policy.authorized_budget_usd:
            raise SelectionError("reserve/prior spend leaves no compute budget")
        if policy.planned_billable_hours > Decimal("24"):
            raise SelectionError("planned_billable_hours exceeds selector hard cap")
        return policy

    @property
    def compute_budget_usd(self) -> Decimal:
        return self.authorized_budget_usd - self.reserve_usd - self.prior_spend_usd


def _catalog(value: Any) -> tuple[datetime, list[dict[str, Any]], str | None]:
    source_hash = None
    if not isinstance(value, Mapping):
        raise SelectionError("catalog must be an object")
    if value.get("format") != CATALOG_FORMAT:
        raise SelectionError(f"unsupported {CATALOG_FORMAT} input")
    checked_at = _utc(value.get("checked_at_utc"), "checked_at_utc")
    entries = value.get("entries")
    source_hash = value.get("source_catalog_sha256")
    if source_hash is not None and (
        not isinstance(source_hash, str) or re.fullmatch(r"[0-9a-f]{64}", source_hash) is None
    ):
        raise SelectionError("source_catalog_sha256 is invalid")
    if not isinstance(entries, list):
        raise SelectionError("catalog entries must be a list")
    return checked_at, entries, source_hash


def _normalize_offer(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, Mapping):
        raise SelectionError("catalog offer must be an object")
    required_text = ("type", "cloud", "provider", "gpu_name")
    text = {}
    for field in required_text:
        value = entry.get(field)
        if not isinstance(value, str) or not value.strip():
            raise SelectionError(f"catalog offer missing {field}")
        text[field] = value.strip()
    gpu_name = text["gpu_name"].upper()
    if _GPU.fullmatch(gpu_name) is None:
        raise SelectionError("catalog GPU family is invalid")
    return {
        **text,
        "gpu_name": gpu_name,
        "gpu_count": _bounded_int(entry.get("gpu_count"), "gpu_count", positive=True),
        "vram_per_gpu_gb": _bounded_int(entry.get("vram_per_gpu_gb"), "vram_per_gpu_gb", positive=True),
        "total_vram_gb": _bounded_int(entry.get("total_vram_gb"), "total_vram_gb", positive=True),
        "capability": _money(entry.get("capability"), "capability"),
        "price_per_hour": _money(entry.get("price_per_hour"), "price_per_hour", positive=True),
        "boot_time_seconds": _bounded_int(entry.get("boot_time_seconds", 0), "boot_time_seconds"),
        "stoppable": entry.get("stoppable") if type(entry.get("stoppable")) is bool else None,
        "rebootable": entry.get("rebootable") if type(entry.get("rebootable")) is bool else None,
        "arch": entry.get("arch") if isinstance(entry.get("arch"), str) else None,
        "ram_gb": entry.get("ram_gb") if isinstance(entry.get("ram_gb"), (int, float)) and not isinstance(entry.get("ram_gb"), bool) else None,
        "target_disk_gb": entry.get("target_disk_gb") if type(entry.get("target_disk_gb")) is int else None,
        "disk_price_per_gb_mo": (
            _money(entry["disk_price_per_gb_mo"], "disk_price_per_gb_mo")
            if "disk_price_per_gb_mo" in entry
            else None
        ),
    }


def select_offer(catalog_value: Any, policy_value: Any, *, now: datetime) -> dict[str, Any]:
    policy = Policy.from_json(policy_value)
    checked_at, entries, source_catalog_sha256 = _catalog(catalog_value)
    if now.tzinfo is None or now.utcoffset() is None:
        raise SelectionError("now requires timezone")
    now = now.astimezone(timezone.utc)
    age_seconds = Decimal(str((now - checked_at).total_seconds()))
    if age_seconds < 0 or age_seconds > policy.catalog_max_age_seconds:
        raise SelectionError("catalog is future-dated or stale")

    family_rank = {family: index for index, family in enumerate(policy.preferred_gpu_families)}
    accepted = []
    rejected = []
    for raw in entries:
        offer = _normalize_offer(raw)
        reasons = []
        if offer["gpu_name"] not in family_rank:
            reasons.append("gpu_family_not_allowed")
        if offer["gpu_count"] != policy.required_gpu_count:
            reasons.append("not_single_catalog_entry_with_required_gpu_count")
        if offer["vram_per_gpu_gb"] < policy.min_vram_per_gpu_gb:
            reasons.append("vram_per_gpu_below_minimum")
        if offer["capability"] < policy.min_compute_capability:
            reasons.append("compute_capability_below_minimum")
        projected = _ceil_money(offer["price_per_hour"] * policy.planned_billable_hours)
        if projected > policy.compute_budget_usd:
            reasons.append("projected_compute_exceeds_compute_budget")
        record = {
            "type": offer["type"],
            "cloud": offer["cloud"],
            "provider": offer["provider"],
            "gpu_name": offer["gpu_name"],
            "gpu_count": offer["gpu_count"],
            "vram_per_gpu_gb": offer["vram_per_gpu_gb"],
            "total_vram_gb": offer["total_vram_gb"],
            "capability": str(offer["capability"]),
            "price_per_hour_usd": str(offer["price_per_hour"]),
            "projected_compute_usd": str(projected),
            "boot_time_seconds": offer["boot_time_seconds"],
            "stoppable": offer["stoppable"],
            "rebootable": offer["rebootable"],
            "arch": offer["arch"],
            "ram_gb": offer["ram_gb"],
            "target_disk_gb": offer["target_disk_gb"],
            "disk_price_per_gb_mo": (
                str(offer["disk_price_per_gb_mo"])
                if offer["disk_price_per_gb_mo"] is not None
                else None
            ),
            "catalog_single_vm_entry": offer["gpu_count"] == policy.required_gpu_count,
        }
        if reasons:
            rejected.append({**record, "reasons": reasons})
        else:
            accepted.append((family_rank[offer["gpu_name"]], projected, offer["type"], record))

    accepted.sort(key=lambda item: (item[0], item[1], item[2]))
    shortlist = [record for _, _, _, record in accepted]
    preferred = shortlist[0] if shortlist else None
    blockers = []
    if preferred is None:
        blockers.append("no_budget_eligible_single_entry_offer")
    if not policy.billing_terms_verified:
        blockers.append("billing_terms_unverified")
    if not policy.topology_verified:
        blockers.append("physical_topology_unverified")
    if not policy.terms_acceptance_verified:
        blockers.append("deployment_terms_not_accepted")

    family_counts = {
        family: sum(
            1 for raw in entries
            if isinstance(raw, Mapping) and str(raw.get("gpu_name", "")).upper() == family
        )
        for family in policy.preferred_gpu_families
    }
    exact_preferred_available = any(
        isinstance(raw, Mapping)
        and str(raw.get("gpu_name", "")).upper() == policy.preferred_gpu_families[0]
        and raw.get("gpu_count") == policy.required_gpu_count
        for raw in entries
    )
    result = {
        "format": SELECTION_FORMAT,
        "catalog_checked_at_utc": checked_at.isoformat().replace("+00:00", "Z"),
        "catalog_age_seconds": str(age_seconds),
        "source_catalog_sha256": source_catalog_sha256,
        "policy": {
            "authorized_budget_usd": str(policy.authorized_budget_usd),
            "reserve_usd": str(policy.reserve_usd),
            "prior_spend_usd": str(policy.prior_spend_usd),
            "compute_budget_usd": str(policy.compute_budget_usd),
            "planned_billable_hours": str(policy.planned_billable_hours),
            "required_gpu_count": policy.required_gpu_count,
            "min_vram_per_gpu_gb": policy.min_vram_per_gpu_gb,
            "min_compute_capability": str(policy.min_compute_capability),
            "preferred_gpu_families": list(policy.preferred_gpu_families),
            "billing_terms_verified": policy.billing_terms_verified,
            "topology_verified": policy.topology_verified,
            "terms_acceptance_verified": policy.terms_acceptance_verified,
        },
        "catalog_family_counts": family_counts,
        "exact_preferred_multi_gpu_available": exact_preferred_available,
        "preferred_candidate": preferred,
        "shortlist": shortlist,
        "rejected": rejected,
        "allocation_ready": preferred is not None and not blockers,
        "allocation_authorized": False,
        "blockers": blockers,
        "selection_semantics": (
            "single catalog entry only; family priority first, then projected compute cost; "
            "no aggregation of separate one-GPU instances"
        ),
    }
    result["selection_sha256"] = _canonical_hash(result)
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--now-utc", required=True)
    args = parser.parse_args(argv)
    catalog = _load_json(args.catalog)
    policy = _load_json(args.policy)
    now = _utc(args.now_utc, "now_utc")
    result = select_offer(catalog, policy, now=now)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result["allocation_ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
