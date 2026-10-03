"""Promotion gate for the frozen PCE Transfer v2 experiment."""
from __future__ import annotations

import argparse
import glob
import json
import math
from pathlib import Path


def load_results(pattern: str) -> list[dict]:
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise ValueError(f"no result files matched {pattern!r}")
    results = []
    seeds = set()
    for path in paths:
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
        if data.get("experiment") != "pce-transfer-v2-collective-sleep":
            raise ValueError(f"{path}: wrong experiment type")
        seed = data.get("seed")
        if seed in seeds:
            raise ValueError(f"duplicate seed {seed}")
        seeds.add(seed)
        results.append(data)
    return results


def evaluate_gate(
    results: list[dict],
    *,
    min_seeds: int = 4,
    min_positive_nll_fraction: float = 1.0,
    min_positive_accuracy_fraction: float = 0.75,
    max_known_anchor_drop: float = 0.125,
    min_mean_nll_advantage: float = 0.5,
) -> dict:
    if len(results) < min_seeds:
        raise ValueError(
            f"need at least {min_seeds} seeds, got {len(results)}"
        )
    for name, value in {
        "min_positive_nll_fraction": min_positive_nll_fraction,
        "min_positive_accuracy_fraction": min_positive_accuracy_fraction,
        "max_known_anchor_drop": max_known_anchor_drop,
    }.items():
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError(f"{name} must be finite inside [0,1]")
    if (
        not math.isfinite(min_mean_nll_advantage)
        or min_mean_nll_advantage < 0
    ):
        raise ValueError(
            "min_mean_nll_advantage must be finite and non-negative"
        )

    n = len(results)
    nll_advantages = [float(x["causal_advantage_nll"]) for x in results]
    acc_advantages = [
        float(x["causal_advantage_accuracy"]) for x in results
    ]
    known_deltas = [
        float(x["transfer_anchor_accuracy_delta"]) for x in results
    ]
    early_stops = [
        bool(x["transfer_sleep"]["stopped_early"]) for x in results
    ]

    positive_nll = sum(x > 0 for x in nll_advantages)
    positive_acc = sum(x > 0 for x in acc_advantages)
    nonnegative_acc = sum(x >= 0 for x in acc_advantages)
    mean_nll = sum(nll_advantages) / n
    mean_acc = sum(acc_advantages) / n

    checks = {
        "seed_count": n >= min_seeds,
        "positive_nll_fraction": (
            positive_nll / n >= min_positive_nll_fraction
        ),
        "positive_accuracy_fraction": (
            positive_acc / n >= min_positive_accuracy_fraction
        ),
        "no_negative_accuracy_advantage": nonnegative_acc == n,
        "known_anchor_retention": all(
            delta >= -max_known_anchor_drop - 1e-12
            for delta in known_deltas
        ),
        "mean_nll_advantage": mean_nll >= min_mean_nll_advantage,
        "all_early_stopped": all(early_stops),
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "seeds": [x["seed"] for x in results],
        "mean_nll_advantage": mean_nll,
        "mean_accuracy_advantage": mean_acc,
        "positive_nll": positive_nll,
        "positive_accuracy": positive_acc,
        "known_anchor_deltas": known_deltas,
        "best_steps": [
            x["transfer_sleep"]["best_step"] for x in results
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    from workspace_paths import benchmark_root
    default_pattern = str(
        benchmark_root(Path(__file__).resolve().parents[1])
        / "myriad"
        / "pce_transfer_v2"
        / "result-seed*.json"
    )
    parser.add_argument("--pattern", default=default_pattern)
    parser.add_argument("--min-seeds", type=int, default=4)
    parser.add_argument("--min-positive-nll-fraction", type=float, default=1.0)
    parser.add_argument(
        "--min-positive-accuracy-fraction", type=float, default=0.75
    )
    parser.add_argument("--max-known-anchor-drop", type=float, default=0.125)
    parser.add_argument("--min-mean-nll-advantage", type=float, default=0.5)
    args = parser.parse_args()

    report = evaluate_gate(
        load_results(args.pattern),
        min_seeds=args.min_seeds,
        min_positive_nll_fraction=args.min_positive_nll_fraction,
        min_positive_accuracy_fraction=args.min_positive_accuracy_fraction,
        max_known_anchor_drop=args.max_known_anchor_drop,
        min_mean_nll_advantage=args.min_mean_nll_advantage,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["passed"]:
        raise SystemExit("PCE Transfer v2 promotion gate failed")


if __name__ == "__main__":
    main()
