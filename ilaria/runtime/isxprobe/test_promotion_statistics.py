"""I-3: paired statistical promotion gate and a report-only sealed split."""
import copy
import importlib.util
import math
from itertools import pairwise
from pathlib import Path

import pytest
import torch

spec = importlib.util.spec_from_file_location("local_imc_peer_stats", Path(__file__).with_name("peer.py"))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


def test_t95_table_is_conservative_and_monotone():
    values = [peer.t95(df) for df in range(1, 200)]
    assert all(a >= b for a, b in pairwise(values))
    assert peer.t95(3) == 2.353 and peer.t95(12) == 1.812 and peer.t95(500) == 1.658
    with pytest.raises(ValueError):
        peer.t95(0)


def test_no_change_and_noisy_gain_are_not_significant():
    base = torch.full((4, 8), 2.0)
    same = peer.paired_lower_bound(base, base.clone())
    assert same["mean_improvement"] == 0 and same["lower95"] <= 0
    noisy = peer.paired_lower_bound(base, base - torch.tensor([[0.9], [-0.8], [0.7], [-0.6]]))
    assert noisy["mean_improvement"] > peer.RECIPE["min_improvement"] and noisy["lower95"] < 0


def test_consistent_gain_is_significant():
    base = torch.full((4, 8), 2.0)
    stats = peer.paired_lower_bound(base, base - torch.tensor([[0.30], [0.31], [0.29], [0.30]]))
    assert stats["clusters"] == 4 and stats["lower95"] > 0.25


def test_sealed_split_is_disjoint_and_never_used_for_selection(monkeypatch):
    rows = {s: {tuple(r) for r in peer.fixture(s)[0].tolist()} for s in ("train", "eval", "anchors", "sealed")}
    assert rows["sealed"] and all(not (rows["sealed"] & rows[s]) for s in ("train", "eval", "anchors"))
    base = peer.model(peer.RECIPE)
    candidate = copy.deepcopy(base)
    with torch.no_grad():
        for parameter in candidate.parameters():
            parameter.add_(0.01)
    first = peer.promotion_statistics(base, candidate)
    original = peer.fixture

    def altered(split):
        ids, targets = original(split)
        return (ids.flip(1), targets.flip(1)) if split == "sealed" else (ids, targets)

    monkeypatch.setattr(peer, "fixture", altered)
    second = peer.promotion_statistics(base, candidate)
    assert first["selection"] == second["selection"]
    assert first["sealed_after"] != second["sealed_after"]


def test_strict_rule_rejects_underpowered_and_accepts_powered_significant_gain():
    small = {"clusters": 4, "mean_improvement": 0.3, "se": 0.004, "lower95": 0.29}
    assert peer.strict_promotion(small)[0] is False and "underpowered" in peer.strict_promotion(small)[1]
    big = {"clusters": 25, "mean_improvement": 0.3, "se": 0.05, "lower95": 0.3 - peer.t95(24) * 0.05}
    assert peer.strict_promotion(big)[0] is True
    noisy = {"clusters": 25, "mean_improvement": 0.05, "se": 0.2, "lower95": 0.05 - peer.t95(24) * 0.2}
    assert peer.strict_promotion(noisy)[0] is False


def test_real_candidate_receipt_carries_honest_statistics_and_sealed_report():
    result = peer.evaluate(peer.propose(peer.RECIPE))
    c = result["candidate"]
    assert result["accepted"] is True and c["decision_rule"] == "legacy-mean-min-improvement"
    assert c["selection_clusters"] == 4 and c["decision_statistically_justified"] is False
    assert c["selection_clusters_required"] is None or c["selection_clusters_required"] > 4
    assert c["sealed_used_for_selection"] is False and math.isfinite(c["sealed_objective"]) and "sealed_objective" in result["before"]
