"""Validation-only promotion gate for sealed PCE Transfer v3."""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_policy(bench: Path) -> tuple[dict, dict]:
    manifest = json.loads((bench / "manifest.json").read_text(encoding="utf-8"))
    policy = json.loads((bench / "policy.json").read_text(encoding="utf-8"))
    if manifest["test_status"] != "sealed":
        raise ValueError("v3 tuning gate requires sealed test split")
    if manifest["policy_sha256"] != sha256(bench / "policy.json"):
        raise ValueError("v3 policy hash mismatch")
    return policy, manifest


def load_results(
    pattern: str,
    policy_sha256: str,
    *,
    manifest_sha256: str,
    tuner_sha256: str,
) -> list[dict]:
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise ValueError(f"no results matched {pattern!r}")
    rows, seeds = [], set()
    for path in paths:
        with open(path, encoding="utf-8") as stream:
            row = json.load(stream)
        if row.get("experiment") != "pce-transfer-v3-tuning":
            raise ValueError(f"{path}: wrong experiment")
        if row.get("policy_sha256") != policy_sha256:
            raise ValueError(f"{path}: policy hash mismatch")
        if row.get("manifest_sha256") != manifest_sha256:
            raise ValueError(f"{path}: manifest hash mismatch")
        if row.get("tuner_sha256") != tuner_sha256:
            raise ValueError(f"{path}: tuner hash mismatch")
        if row.get("ternary") is not True:
            raise ValueError(f"{path}: canonical v3 tuning result must be ternary")
        seed = row.get("seed")
        if seed in seeds:
            raise ValueError(f"duplicate seed {seed}")
        seeds.add(seed)
        rows.append(row)
    return rows


def evaluate_gate(results: list[dict], policy: dict) -> dict:
    gate = policy["validation_gate"]
    expected_seeds = list(policy["tuning_seeds"])
    got_seeds = sorted(int(x["seed"]) for x in results)
    if got_seeds != sorted(expected_seeds):
        raise ValueError(
            f"result seeds {got_seeds} differ from frozen tuning seeds "
            f"{sorted(expected_seeds)}"
        )

    n = len(results)
    nll = [float(x["validation_causal_advantage_nll"]) for x in results]
    acc = [float(x["validation_causal_advantage_accuracy"]) for x in results]
    anchor = [float(x["transfer_anchor_accuracy_delta"]) for x in results]
    early = [bool(x["transfer_sleep"]["stopped_early"]) for x in results]

    for values in (nll, acc, anchor):
        if not all(math.isfinite(x) for x in values):
            raise ValueError("non-finite v3 gate metric")

    positive_nll = sum(x > 0 for x in nll)
    positive_acc = sum(x > 0 for x in acc)
    mean_nll = sum(nll) / n
    mean_acc = sum(acc) / n

    checks = {
        "seed_count": n >= int(gate["min_seeds"]),
        "positive_nll_fraction": (
            positive_nll / n >= float(gate["min_positive_nll_fraction"])
        ),
        "positive_accuracy_fraction": (
            positive_acc / n >= float(gate["min_positive_accuracy_fraction"])
        ),
        "known_anchor_retention": all(
            x >= -float(gate["max_known_anchor_drop"]) - 1e-12
            for x in anchor
        ),
        "mean_nll_advantage": (
            mean_nll >= float(gate["min_mean_nll_advantage"])
        ),
        "all_early_stopped": (
            all(early)
            if bool(gate["require_all_early_stopped"])
            else True
        ),
        "no_negative_accuracy": (
            all(x >= 0 for x in acc)
            if bool(gate["require_no_negative_accuracy"])
            else True
        ),
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "seeds": got_seeds,
        "mean_nll_advantage": mean_nll,
        "mean_accuracy_advantage": mean_acc,
        "positive_nll": positive_nll,
        "positive_accuracy": positive_acc,
        "anchor_deltas": anchor,
        "best_steps": [x["transfer_sleep"]["best_step"] for x in results],
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    bench = root / "bench" / "myriad" / "pce_transfer_v3"
    parser = argparse.ArgumentParser()
    parser.add_argument("--bench", default=str(bench))
    parser.add_argument(
        "--pattern",
        default=str(bench / "tune-seed*.json"),
    )
    args = parser.parse_args()

    bench = Path(args.bench)
    policy, manifest = load_policy(bench)
    report = evaluate_gate(
        load_results(
            args.pattern,
            manifest["policy_sha256"],
            manifest_sha256=sha256(bench / "manifest.json"),
            tuner_sha256=sha256(root / "forge" / "pce_transfer_v3.py"),
        ),
        policy,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["passed"]:
        raise SystemExit("PCE Transfer v3 validation gate failed")


if __name__ == "__main__":
    main()
