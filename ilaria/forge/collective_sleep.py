"""Collective Sleep v1: verifier-gated replay consolidation.

This module deliberately knows nothing about PCE task semantics. Callers supply
one training step and one validation function. The sleep controller owns only
promotion discipline:

- evaluate before training;
- reject non-finite metrics/losses;
- enforce a frozen anchor-accuracy floor;
- promote only validation improvement;
- early-stop after configurable stale evaluations;
- restore the best accepted model state before returning.

The production version can later replace in-memory state copies with
content-addressed checkpoint files without changing the policy contract.
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass
from typing import Callable

import torch


@dataclass(frozen=True)
class SleepPolicy:
    max_steps: int = 300
    eval_every: int = 20
    patience_evals: int = 4
    min_improvement: float = 1e-4
    max_anchor_accuracy_drop: float = 0.05

    def validate(self) -> None:
        if self.max_steps < 1:
            raise ValueError("sleep max_steps must be positive")
        if self.eval_every < 1:
            raise ValueError("sleep eval_every must be positive")
        if self.patience_evals < 1:
            raise ValueError("sleep patience_evals must be positive")
        if not math.isfinite(self.min_improvement) or self.min_improvement < 0:
            raise ValueError("sleep min_improvement must be finite and non-negative")
        if (
            not math.isfinite(self.max_anchor_accuracy_drop)
            or not 0 <= self.max_anchor_accuracy_drop <= 1
        ):
            raise ValueError(
                "sleep max_anchor_accuracy_drop must be inside [0, 1]"
            )


@dataclass
class SleepResult:
    best_step: int
    stopped_early: bool
    best_metrics: dict
    initial_metrics: dict
    history: list[dict]
    accepted_updates: int
    rejected_for_forgetting: int


def _validate_metrics(metrics: dict) -> tuple[float, float]:
    if not isinstance(metrics, dict):
        raise ValueError("sleep validation must return a dict")
    if "objective" not in metrics or "anchor_accuracy" not in metrics:
        raise ValueError(
            "sleep validation requires objective and anchor_accuracy"
        )
    objective = float(metrics["objective"])
    anchor_accuracy = float(metrics["anchor_accuracy"])
    if not math.isfinite(objective):
        raise ValueError("sleep validation objective is non-finite")
    if not math.isfinite(anchor_accuracy) or not 0 <= anchor_accuracy <= 1:
        raise ValueError("sleep anchor_accuracy must be finite inside [0, 1]")
    return objective, anchor_accuracy


def consolidate(
    model: torch.nn.Module,
    *,
    train_step: Callable[[int], torch.Tensor | float],
    validate: Callable[[], dict],
    policy: SleepPolicy,
) -> SleepResult:
    """Run bounded replay and restore the best verifier-eligible candidate."""
    policy.validate()

    initial = dict(validate())
    initial_objective, initial_anchor = _validate_metrics(initial)
    anchor_floor = max(
        0.0, initial_anchor - policy.max_anchor_accuracy_drop
    )

    best_state = copy.deepcopy(model.state_dict())
    best_metrics = dict(initial)
    best_objective = initial_objective
    best_step = 0
    history = [
        {
            "step": 0,
            **initial,
            "eligible": True,
            "promoted": True,
        }
    ]
    stale_evals = 0
    accepted_updates = 0
    rejected_for_forgetting = 0
    stopped_early = False

    for step in range(1, policy.max_steps + 1):
        raw_loss = train_step(step)
        loss = (
            float(raw_loss.detach())
            if isinstance(raw_loss, torch.Tensor)
            else float(raw_loss)
        )
        if not math.isfinite(loss):
            raise RuntimeError(f"sleep training loss became non-finite at step {step}")

        should_eval = (
            step % policy.eval_every == 0 or step == policy.max_steps
        )
        if not should_eval:
            continue

        metrics = dict(validate())
        objective, anchor_accuracy = _validate_metrics(metrics)
        eligible = anchor_accuracy >= anchor_floor
        improved = (
            eligible
            and objective < best_objective - policy.min_improvement
        )

        record = {
            "step": step,
            "train_loss": loss,
            **metrics,
            "anchor_floor": anchor_floor,
            "eligible": eligible,
            "promoted": improved,
        }
        history.append(record)

        if not eligible:
            rejected_for_forgetting += 1

        if improved:
            best_state = copy.deepcopy(model.state_dict())
            best_metrics = dict(metrics)
            best_objective = objective
            best_step = step
            accepted_updates += 1
            stale_evals = 0
        else:
            stale_evals += 1

        if stale_evals >= policy.patience_evals:
            stopped_early = True
            break

    model.load_state_dict(best_state, strict=True)
    return SleepResult(
        best_step=best_step,
        stopped_early=stopped_early,
        best_metrics=best_metrics,
        initial_metrics=initial,
        history=history,
        accepted_updates=accepted_updates,
        rejected_for_forgetting=rejected_for_forgetting,
    )
