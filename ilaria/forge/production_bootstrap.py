"""Fail-closed preflight for the post-review IMC-125M production build."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from .benchmark_exclusion_plan import assess_plan as assess_benchmarks
    from .data_contract import canonical_json_sha256, require_lower_sha256, sha256_file
    from .production_review_decision import BUNDLE_FORMAT
    from .production_source_plan import assess_plan, load_inventory, load_plan
except ImportError:
    from benchmark_exclusion_plan import assess_plan as assess_benchmarks
    from data_contract import canonical_json_sha256, require_lower_sha256, sha256_file
    from production_review_decision import BUNDLE_FORMAT
    from production_source_plan import assess_plan, load_inventory, load_plan


def _identity(value: dict, field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return canonical_json_sha256(payload)


def load_reviewed_bundle(path: str | Path) -> dict:
    manifest_path = Path(path)
    with manifest_path.open(encoding="utf-8") as stream:
        bundle = json.load(stream)
    if not isinstance(bundle, dict) or bundle.get("format") != BUNDLE_FORMAT:
        raise ValueError("unsupported reviewed rights bundle format")
    declared = str(bundle.get("bundle_sha256", ""))
    require_lower_sha256("reviewed bundle_sha256", declared)
    if _identity(bundle, "bundle_sha256") != declared:
        raise ValueError("reviewed rights bundle identity mismatch")
    for field in ("rights", "evidence"):
        record = bundle.get(field)
        if not isinstance(record, dict):
            raise ValueError(f"reviewed rights bundle has no {field}")
        filename = record.get("filename")
        digest = str(record.get("sha256", ""))
        require_lower_sha256(f"reviewed bundle {field} sha256", digest)
        file_path = manifest_path.parent / str(filename)
        if not file_path.is_file() or sha256_file(file_path) != digest:
            raise ValueError(f"reviewed rights bundle {field} file mismatch")
    first_party = bundle.get("first_party_attestations")
    if not isinstance(first_party, dict) or not first_party:
        raise ValueError("reviewed rights bundle has no first-party attestations")
    for source, record in first_party.items():
        if not isinstance(record, dict):
            raise ValueError(f"reviewed first-party record is invalid: {source}")
        digest = str(record.get("sha256", ""))
        require_lower_sha256(f"reviewed first-party {source} sha256", digest)
        file_path = manifest_path.parent / str(record.get("filename"))
        if not file_path.is_file() or sha256_file(file_path) != digest:
            raise ValueError(f"reviewed first-party file mismatch: {source}")
    return bundle


def assess_bootstrap(
    *,
    source_plan_path: str | Path,
    inventory_path: str | Path,
    reviewed_bundle_path: str | Path | None,
    benchmark_plan_path: str | Path,
    workspace_root: str | Path,
) -> dict:
    source_plan = load_plan(source_plan_path)
    inventory = load_inventory(inventory_path)
    source_report = assess_plan(source_plan, inventory)
    benchmark_report = assess_benchmarks(
        benchmark_plan_path,
        workspace_root=workspace_root,
    )
    blockers = list(source_report["blockers"]) + list(benchmark_report["blockers"])
    bundle_report = {
        "exists": False,
        "production_approved": False,
        "bundle_sha256": None,
    }
    if reviewed_bundle_path:
        path = Path(reviewed_bundle_path)
        if path.is_file():
            bundle = load_reviewed_bundle(path)
            bundle_report = {
                "exists": True,
                "production_approved": bundle.get("production_approved") is True,
                "bundle_sha256": bundle["bundle_sha256"],
            }
            if bundle.get("production_approved") is not True:
                blockers.append("reviewed_bundle:production_not_approved")
            rejections = bundle.get("rejections", {})
            if any(rejections.get(kind) for kind in ("external", "first_party")):
                blockers.append("reviewed_bundle:contains_rejections")
        else:
            blockers.append("reviewed_bundle:missing")
    else:
        blockers.append("reviewed_bundle:not_supplied")

    return {
        "format": "imc-125m-production-bootstrap-readiness-v1",
        "ready": not blockers,
        "blockers": sorted(set(blockers)),
        "source_plan": source_report,
        "benchmark_exclusions": benchmark_report,
        "reviewed_bundle": bundle_report,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    config = Path(__file__).resolve().parent / "config"
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-plan",
        default=str(config / "imc_125m_production_sources.json"),
    )
    parser.add_argument(
        "--inventory",
        default=str(root / "bench" / "imc_125m_data_inventory" / "candidate-inventory.json"),
    )
    parser.add_argument("--reviewed-bundle", default="")
    parser.add_argument(
        "--benchmark-plan",
        default=str(config / "imc_125m_benchmark_exclusions.json"),
    )
    parser.add_argument("--workspace-root", default=str(root))
    args = parser.parse_args()
    report = assess_bootstrap(
        source_plan_path=args.source_plan,
        inventory_path=args.inventory,
        reviewed_bundle_path=args.reviewed_bundle or None,
        benchmark_plan_path=args.benchmark_plan,
        workspace_root=args.workspace_root,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
