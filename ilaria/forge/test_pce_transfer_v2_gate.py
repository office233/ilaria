import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pce_transfer_v2_gate import evaluate_gate  # noqa: E402


def result(seed, nll=1.0, acc=0.1, anchor=0.0, stopped=True):
    return {
        "seed": seed,
        "causal_advantage_nll": nll,
        "causal_advantage_accuracy": acc,
        "transfer_anchor_accuracy_delta": anchor,
        "transfer_sleep": {
            "stopped_early": stopped,
            "best_step": 40,
        },
    }


def test_gate_passes_healthy_multiseed_results():
    report = evaluate_gate([result(i) for i in range(4)])
    assert report["passed"]


def test_gate_rejects_negative_nll_seed():
    rows = [result(i) for i in range(4)]
    rows[0]["causal_advantage_nll"] = -0.1
    report = evaluate_gate(rows)
    assert not report["passed"]
    assert not report["checks"]["positive_nll_fraction"]


def test_gate_rejects_forgetting():
    rows = [result(i) for i in range(4)]
    rows[2]["transfer_anchor_accuracy_delta"] = -0.25
    report = evaluate_gate(rows)
    assert not report["passed"]
    assert not report["checks"]["known_anchor_retention"]


def test_gate_requires_early_stop():
    rows = [result(i) for i in range(4)]
    rows[1]["transfer_sleep"]["stopped_early"] = False
    report = evaluate_gate(rows)
    assert not report["passed"]
    assert not report["checks"]["all_early_stopped"]
