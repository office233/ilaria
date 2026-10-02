"""Content-addressed benchmark exclusion plan for IMC-125M Genesis."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from .data_contract import canonical_json_sha256, require_lower_sha256, sha256_file
except ImportError:
    from data_contract import canonical_json_sha256, require_lower_sha256, sha256_file


FORMAT = "imc-125m-benchmark-exclusion-plan-v1"
REQUIRED_EVALUATIONS = frozenset(
    {
        "general",
        "code",
        "math_science",
        "calibration",
        "pce_transfer",
        "continual_learning_regression",
    }
)


def _identity(value: dict) -> str:
    payload = dict(value)
    payload.pop("plan_sha256", None)
    return canonical_json_sha256(payload)


def load_plan(path: str | Path) -> dict:
    source = Path(path)
    with source.open(encoding="utf-8") as stream:
        plan = json.load(stream)
    if not isinstance(plan, dict) or plan.get("format") != FORMAT:
        raise ValueError("unsupported benchmark exclusion plan format")
    declared = str(plan.get("plan_sha256", ""))
    require_lower_sha256("benchmark exclusion plan_sha256", declared)
    if _identity(plan) != declared:
        raise ValueError("benchmark exclusion plan identity mismatch")
    evaluations = plan.get("evaluations")
    if not isinstance(evaluations, dict) or set(evaluations) != REQUIRED_EVALUATIONS:
        raise ValueError("benchmark exclusion evaluation set mismatch")
    for name, paths in evaluations.items():
        if not isinstance(paths, list) or any(
            not isinstance(item, str) or not item for item in paths
        ):
            raise ValueError(f"benchmark exclusion paths are invalid for {name!r}")
        if len(paths) != len(set(paths)):
            raise ValueError(f"benchmark exclusion paths are duplicated for {name!r}")
    return plan


def assess_plan(path: str | Path, *, workspace_root: str | Path) -> dict:
    plan = load_plan(path)
    root = Path(workspace_root).resolve()
    blockers: list[str] = []
    evaluations: dict[str, list[dict]] = {}
    all_paths: set[str] = set()
    for evaluation in sorted(REQUIRED_EVALUATIONS):
        records = []
        paths = plan["evaluations"][evaluation]
        if not paths:
            blockers.append(f"benchmark_exclusion:{evaluation}:no_frozen_inputs")
        for relative in paths:
            file_path = (root / relative).resolve()
            if root not in file_path.parents:
                blockers.append(f"benchmark_exclusion:{evaluation}:{relative}:escapes_workspace")
                continue
            if not file_path.is_file():
                blockers.append(f"benchmark_exclusion:{evaluation}:{relative}:missing")
                continue
            all_paths.add(str(file_path))
            records.append(
                {
                    "path": relative.replace("\\", "/"),
                    "sha256": sha256_file(file_path),
                    "bytes": file_path.stat().st_size,
                }
            )
        evaluations[evaluation] = records
    return {
        "format": "imc-125m-benchmark-exclusion-assessment-v1",
        "ready": not blockers,
        "blockers": blockers,
        "plan_sha256": plan["plan_sha256"],
        "evaluations": evaluations,
        "files": sorted(all_paths),
    }


def rehash_plan(path: str | Path, out: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        plan = json.load(stream)
    if plan.get("format") != FORMAT:
        raise ValueError("unsupported benchmark exclusion plan format")
    plan["plan_sha256"] = _identity(plan)
    Path(out).write_text(
        json.dumps(plan, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return plan


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    assess = sub.add_parser("assess")
    assess.add_argument(
        "--plan",
        default=str(
            Path(__file__).resolve().parent
            / "config"
            / "imc_125m_benchmark_exclusions.json"
        ),
    )
    assess.add_argument("--workspace-root", default=str(root))
    rehash = sub.add_parser("rehash")
    rehash.add_argument("--plan", required=True)
    rehash.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "rehash":
        plan = rehash_plan(args.plan, args.out)
        print(plan["plan_sha256"])
        return
    report = assess_plan(args.plan, workspace_root=args.workspace_root)
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["ready"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
