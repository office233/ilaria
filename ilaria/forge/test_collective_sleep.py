import copy
import math
import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collective_sleep import SleepPolicy, consolidate  # noqa: E402


class Tiny(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.x = torch.nn.Parameter(torch.tensor(0.0))


def test_sleep_restores_best_validation_checkpoint():
    model = Tiny()

    def train_step(_):
        with torch.no_grad():
            model.x.add_(1)
        return float(model.x.detach())

    def validate():
        # Best objective at x=2, then gets worse.
        x = float(model.x.detach())
        return {
            "objective": (x - 2.0) ** 2,
            "anchor_accuracy": 1.0,
        }

    result = consolidate(
        model,
        train_step=train_step,
        validate=validate,
        policy=SleepPolicy(
            max_steps=8,
            eval_every=1,
            patience_evals=2,
            min_improvement=0,
            max_anchor_accuracy_drop=0,
        ),
    )
    assert result.best_step == 2
    assert result.stopped_early
    assert float(model.x.detach()) == pytest.approx(2.0)


def test_sleep_rejects_candidate_that_forgets_anchors():
    model = Tiny()

    def train_step(_):
        with torch.no_grad():
            model.x.add_(1)
        return float(model.x.detach())

    def validate():
        x = float(model.x.detach())
        return {
            "objective": 10.0 - x,
            "anchor_accuracy": 1.0 if x < 2 else 0.5,
        }

    result = consolidate(
        model,
        train_step=train_step,
        validate=validate,
        policy=SleepPolicy(
            max_steps=4,
            eval_every=1,
            patience_evals=2,
            max_anchor_accuracy_drop=0.1,
        ),
    )
    # x=1 improves while preserving anchors; x>=2 is rejected.
    assert result.best_step == 1
    assert float(model.x.detach()) == pytest.approx(1.0)
    assert result.rejected_for_forgetting >= 1


def test_sleep_fails_closed_on_nonfinite_validation():
    model = Tiny()

    def train_step(_):
        return 0.0

    def validate():
        return {"objective": math.nan, "anchor_accuracy": 1.0}

    with pytest.raises(ValueError, match="non-finite"):
        consolidate(
            model,
            train_step=train_step,
            validate=validate,
            policy=SleepPolicy(max_steps=1),
        )


def test_policy_rejects_invalid_values():
    with pytest.raises(ValueError):
        SleepPolicy(max_steps=0).validate()
    with pytest.raises(ValueError):
        SleepPolicy(max_anchor_accuracy_drop=2).validate()


@pytest.mark.parametrize("failure", ["loss", "train", "validation"])
def test_sleep_restores_last_accepted_weights_after_failure(failure):
    model = Tiny()

    def train_step(step):
        with torch.no_grad():
            model.x.fill_(float(step))
        if step == 2:
            if failure == "loss":
                return math.nan
            if failure == "train":
                raise RuntimeError("training callback failed")
        return 1.0

    def validate():
        x = float(model.x.detach())
        if failure == "validation" and x == 2:
            return {"objective": math.nan, "anchor_accuracy": 1.0}
        return {"objective": 10 - x, "anchor_accuracy": 1.0}

    with pytest.raises((RuntimeError, ValueError)):
        consolidate(model, train_step=train_step, validate=validate,
                    policy=SleepPolicy(max_steps=3, eval_every=1))
    assert model.x.item() == 1.0
