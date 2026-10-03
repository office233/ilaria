"""Validate the content-addressed IMC-125M production source selection.

The candidate inventory answers "what data exists"; this module answers "which
subset is intended for production". It never grants data rights. The plan is
bound to one inventory and curriculum identity and requires conservative token
headroom for every non-zero curriculum lane.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from data_contract import canonical_json_sha256, require_lower_sha256
from tokenizer_coverage import REQUIRED_COVERAGE

PLAN_FORMAT = "imc-125m-production-source-plan-v1"
INVENTORY_FORMAT = "ilaria-corpus-inventory-v1"


def _identity_hash(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def load_inventory(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        inventory = json.load(stream)
    if not isinstance(inventory, dict) or inventory.get("format") != INVENTORY_FORMAT:
        raise ValueError("unsupported corpus inventory format")
    declared = inventory.get("inventory_sha256", "")
    require_lower_sha256("inventory_sha256", declared)
    if _identity_hash(inventory, "inventory_sha256") != declared:
        raise ValueError("corpus inventory identity hash mismatch")
    return inventory


def load_plan(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        plan = json.load(stream)
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise ValueError("unsupported production source plan format")
    declared = plan.get("plan_sha256", "")
    require_lower_sha256("plan_sha256", declared)
    if _identity_hash(plan, "plan_sha256") != declared:
        raise ValueError("production source plan identity hash mismatch")
    require_lower_sha256("inventory_sha256", str(plan.get("inventory_sha256", "")))
    require_lower_sha256("curriculum_sha256", str(plan.get("curriculum_sha256", "")))
    minimum_headroom_ppm = plan.get("minimum_headroom_ppm")
    if (
        type(minimum_headroom_ppm) is not int
        or minimum_headroom_ppm < 0
        or minimum_headroom_ppm >= 1_000_000
    ):
        raise ValueError("production source plan minimum_headroom_ppm is invalid")
    lanes = plan.get("lanes")
    if not isinstance(lanes, dict) or not lanes:
        raise ValueError("production source plan has no lanes")
    for lane, sources in lanes.items():
        if not isinstance(lane, str) or not lane:
            raise ValueError("production source plan lane name is invalid")
        if not isinstance(sources, list) or not all(
            isinstance(source, str) and source for source in sources
        ):
            raise ValueError(f"production source plan lane {lane!r} source list is invalid")
        if len(sources) != len(set(sources)):
            raise ValueError(f"production source plan lane {lane!r} has duplicate sources")
    coverage = plan.get("tokenizer_coverage")
    if not isinstance(coverage, dict) or set(coverage) != REQUIRED_COVERAGE:
        raise ValueError("production source plan tokenizer coverage set mismatch")
    for category, sources in coverage.items():
        if not isinstance(sources, list) or not sources or not all(
            isinstance(source, str) and source for source in sources
        ):
            raise ValueError(
                f"production source plan tokenizer coverage {category!r} is invalid"
            )
        if len(sources) != len(set(sources)):
            raise ValueError(
                f"production source plan tokenizer coverage {category!r} has duplicates"
            )
    first_party = plan.get("first_party_sources")
    if not isinstance(first_party, list) or not all(
        isinstance(source, str) and source for source in first_party
    ):
        raise ValueError("production source plan first_party_sources is invalid")
    if len(first_party) != len(set(first_party)):
        raise ValueError("production source plan first_party_sources has duplicates")
    return plan


def assess_plan(plan: dict, inventory: dict) -> dict:
    blockers: list[str] = []
    if plan["inventory_sha256"] != inventory["inventory_sha256"]:
        blockers.append("source_plan:inventory_identity_mismatch")
    curriculum = inventory.get("curriculum", {})
    if plan["curriculum_sha256"] != curriculum.get("identity_sha256"):
        blockers.append("source_plan:curriculum_identity_mismatch")

    inventory_lanes = inventory.get("lanes")
    if not isinstance(inventory_lanes, dict) or set(plan["lanes"]) != set(inventory_lanes):
        blockers.append("source_plan:lane_set_mismatch")
        lane_names = sorted(set(plan["lanes"]) & set(inventory_lanes or {}))
    else:
        lane_names = sorted(plan["lanes"])

    source_stats = inventory.get("sources")
    if not isinstance(source_stats, dict):
        raise ValueError("corpus inventory source statistics are invalid")

    lane_reports: dict[str, dict] = {}
    minimum_headroom_ppm = int(plan["minimum_headroom_ppm"])
    for lane in lane_names:
        lane_inventory = inventory_lanes[lane]
        quota = int(lane_inventory.get("quota_tokens", 0))
        selected = list(plan["lanes"][lane])
        conservative_tokens = 0
        source_tokens: dict[str, int] = {}
        for source in selected:
            source_record = source_stats.get(source)
            if not isinstance(source_record, dict):
                blockers.append(f"source_plan:{lane}:{source}:missing_inventory_source")
                continue
            lane_record = source_record.get("lanes", {}).get(lane)
            if not isinstance(lane_record, dict):
                blockers.append(f"source_plan:{lane}:{source}:missing_lane_contribution")
                continue
            tokens = int(lane_record.get("estimated_tokens_min", 0))
            source_tokens[source] = tokens
            conservative_tokens += tokens

        required_headroom = (
            math.ceil(quota * minimum_headroom_ppm / 1_000_000) if quota else 0
        )
        headroom = conservative_tokens - quota
        if quota == 0 and selected:
            blockers.append(f"source_plan:{lane}:zero_quota_has_sources")
        elif quota > 0 and not selected:
            blockers.append(f"source_plan:{lane}:no_sources")
        if conservative_tokens < quota:
            blockers.append(
                f"source_plan:{lane}:insufficient_conservative_tokens="
                f"{conservative_tokens}<{quota}"
            )
        elif headroom < required_headroom:
            blockers.append(
                f"source_plan:{lane}:insufficient_headroom="
                f"{headroom}<{required_headroom}"
            )
        lane_reports[lane] = {
            "quota_tokens": quota,
            "sources": selected,
            "source_conservative_tokens": source_tokens,
            "conservative_tokens": conservative_tokens,
            "headroom_tokens": headroom,
            "required_headroom_tokens": required_headroom,
            "headroom_ppm": (
                (headroom * 1_000_000) // quota if quota else 0
            ),
        }

    first_party = set(plan["first_party_sources"])
    all_required = {
        source
        for sources in plan["lanes"].values()
        for source in sources
    }
    for sources in plan["tokenizer_coverage"].values():
        all_required.update(sources)
    unknown_coverage = sorted(
        source
        for source in all_required
        if source not in source_stats and source not in first_party
    )
    for source in unknown_coverage:
        blockers.append(f"source_plan:{source}:unknown_source")

    used_first_party = sorted(all_required & first_party)
    unused_first_party = sorted(first_party - all_required)
    if unused_first_party:
        blockers.append(
            "source_plan:unused_first_party_sources=" + ",".join(unused_first_party)
        )
    required_external = sorted(all_required - first_party)
    return {
        "ready": not blockers,
        "blockers": blockers,
        "plan_sha256": plan["plan_sha256"],
        "inventory_sha256": inventory["inventory_sha256"],
        "curriculum_sha256": curriculum.get("identity_sha256"),
        "minimum_headroom_ppm": minimum_headroom_ppm,
        "lanes": lane_reports,
        "tokenizer_coverage": {
            category: list(plan["tokenizer_coverage"][category])
            for category in sorted(REQUIRED_COVERAGE)
        },
        "required_external_sources": required_external,
        "required_first_party_sources": used_first_party,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    from workspace_paths import benchmark_root
    benchmarks = benchmark_root(root)
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--plan",
        default=str(
            Path(__file__).resolve().parent
            / "config"
            / "imc_125m_production_sources.json"
        ),
    )
    parser.add_argument(
        "--inventory",
        default=str(
            benchmarks / "imc_125m_data_inventory" / "candidate-inventory.json"
        ),
    )
    args = parser.parse_args()
    report = assess_plan(load_plan(args.plan), load_inventory(args.inventory))
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
