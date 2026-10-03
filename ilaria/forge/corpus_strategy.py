"""Validate the canonical source-selection policy without granting rights."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

STRATEGY_FORMAT = "ilaria-corpus-strategy-v1"
REQUIRED_LANES = frozenset(
    {
        "general_english",
        "code",
        "math_science",
        "os_drivers",
        "hardware",
        "tools_protocol",
        "agent_tool_trajectories",
        "world_device_trajectories",
    }
)
ALLOWED_STATUSES = frozenset(
    {
        "REVIEW_REQUIRED",
        "MANUAL_SOURCE_REQUIRED",
        "OWNERSHIP_ATTESTATION_REQUIRED",
        "ELIGIBLE",
    }
)


def assess_strategy(
    strategy: dict,
    git_locked_sources: set[str],
    *,
    first_party_attested: bool = False,
    first_party_attested_sources: set[str] | None = None,
) -> dict:
    """Report whether every preferred lane source has completed manual review."""
    blockers: list[str] = []
    preferred_sources: dict[str, str] = {}
    attested_sources = set(first_party_attested_sources or set())
    if first_party_attested:
        # Backward-compatible meaning of the original boolean gate.
        attested_sources.add("first_party_contracts")
    for lane in sorted(REQUIRED_LANES):
        candidates = strategy["lanes"][lane]
        preferred = next(
            candidate
            for candidate in candidates
            if candidate.get("role") in {"preferred", "preferred_external"}
        )
        source = preferred["source"]
        preferred_sources[lane] = source
        status = preferred.get("status")
        attestation_satisfies = (
            source in attested_sources
            and status == "OWNERSHIP_ATTESTATION_REQUIRED"
        )
        if status != "ELIGIBLE" and not attestation_satisfies:
            blockers.append(
                f"corpus_strategy:{lane}:{source}:status={status}"
            )
        if source in {
            "apache_nuttx",
            "golang_go",
            "python_cpython",
            "rust_lang",
            "zephyr",
            "freertos_kernel",
            "freebsd_licensed_tree",
        } and source not in git_locked_sources:
            blockers.append(f"corpus_strategy:{lane}:{source}:missing_git_lock")
    return {
        "ready": not blockers,
        "preferred_sources": preferred_sources,
        "blockers": blockers,
    }


def load_strategy(path: str | Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        strategy = json.load(stream)
    if not isinstance(strategy, dict) or strategy.get("format") != STRATEGY_FORMAT:
        raise ValueError("unsupported corpus strategy format")
    lanes = strategy.get("lanes")
    if not isinstance(lanes, dict) or set(lanes) != REQUIRED_LANES:
        raise ValueError("corpus strategy lane set mismatch")
    for lane in sorted(REQUIRED_LANES):
        candidates = lanes[lane]
        if not isinstance(candidates, list) or not candidates:
            raise ValueError(f"corpus strategy lane {lane!r} has no candidates")
        preferred = 0
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise ValueError(f"corpus strategy candidate in {lane!r} is invalid")
            if not str(candidate.get("source", "")).strip():
                raise ValueError(f"corpus strategy candidate in {lane!r} has no source")
            if candidate.get("status") not in ALLOWED_STATUSES:
                raise ValueError(
                    f"corpus strategy candidate {candidate.get('source')!r} has unsafe status"
                )
            if not str(candidate.get("reason", "")).strip():
                raise ValueError(f"corpus strategy candidate in {lane!r} has no rationale")
            if candidate.get("role") in {"preferred", "preferred_external"}:
                preferred += 1
        if preferred != 1:
            raise ValueError(
                f"corpus strategy lane {lane!r} must have exactly one preferred source"
            )
    excluded = strategy.get("excluded_by_default")
    if not isinstance(excluded, list):
        raise ValueError("corpus strategy excluded_by_default is invalid")
    return strategy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--strategy",
        default=str(Path(__file__).resolve().parent / "config" / "corpus_strategy.json"),
    )
    args = parser.parse_args()
    strategy = load_strategy(args.strategy)
    print(
        json.dumps(
            {
                "format": strategy["format"],
                "policy": strategy["policy"],
                "lanes": sorted(strategy["lanes"]),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
