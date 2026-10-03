"""Synthetic adversarial cases against the canonical Ilaria probe evaluator."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

MANIFEST = Path(__file__).with_name("manifest.json")


def load_canonical_peer(root: Path):
    root = root.resolve(strict=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    expected = manifest["canonical_sources"]
    for relative, wanted in expected.items():
        path = root / "ilaria" / Path(relative).relative_to("ilaria")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != wanted.lower():
            raise RuntimeError(f"canonical source hash mismatch: {relative}")
    peer_path = root / "ilaria/runtime/isxprobe/peer.py"
    sys.path.insert(0, str(peer_path.parent))
    spec = importlib.util.spec_from_file_location("canonical_ilaria_isxprobe_peer", peer_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load canonical peer module")
    peer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(peer)
    import torch

    parameter_count = sum(
        parameter.numel() for parameter in peer.model(copy.deepcopy(peer.RECIPE)).parameters()
    )
    limits = manifest["limits"]
    if parameter_count > limits["max_model_parameters"]:
        raise RuntimeError("synthetic model exceeds the pinned parameter limit")
    if torch.get_num_threads() > limits["torch_threads"]:
        raise RuntimeError("synthetic model exceeds the pinned CPU thread limit")
    return peer, {key: hashlib.sha256((root / "ilaria" / Path(key).relative_to("ilaria")).read_bytes()).hexdigest()
                  for key in expected}


def _candidate_with_delta(peer, recipe, base_hash, delta):
    packed = peer.pack(delta)
    return {
        "recipe": recipe,
        "recipe_hash": peer.digest(recipe),
        "fixture_hash": peer.fixture_hash(),
        "base_hash": base_hash,
        "parameter_delta_hash": peer.digest(packed),
        "delta": packed,
    }


def sign_inverted_case(peer):
    """Invert a real canonical backprop update, then submit it to the real gate."""
    proposal = peer.propose(copy.deepcopy(peer.RECIPE))
    recipe = proposal["recipe"]
    base = peer.model(recipe).state_dict()
    delta, _ = peer.unpack(proposal["delta"], base, recipe["max_delta_norm"])
    inverted = {name: -value for name, value in delta.items()}
    candidate = _candidate_with_delta(peer, recipe, proposal["base_hash"], inverted)
    return peer.evaluate(candidate)


def eval_improves_anchor_regresses_case(peer):
    """Build a genuine gradient update that improves eval CE while harming anchors."""
    recipe = copy.deepcopy(peer.RECIPE)
    recipe["steps"] = 1
    model = peer.model(recipe)
    base = copy.deepcopy(model.state_dict())
    base_hash = peer.digest(peer.pack(base))
    eval_ids, eval_targets = peer.fixture("eval")
    anchor_ids, anchor_targets = peer.fixture("anchors")
    cross_entropy = peer.torch.nn.functional.cross_entropy
    model.zero_grad(set_to_none=True)
    eval_loss = cross_entropy(model(eval_ids).reshape(-1, 16), eval_targets.reshape(-1))
    anchor_loss = cross_entropy(model(anchor_ids).reshape(-1, 16), anchor_targets.reshape(-1))
    # Both terms use actual forward/backprop. The adversary maximizes anchor CE
    # while optimizing eval CE, solely to test the frozen-anchor acceptance rule.
    (eval_loss - 0.5 * anchor_loss).backward()
    delta = {name: (-parameter.grad).detach().clone()
             for name, parameter in model.named_parameters()}
    candidate = _candidate_with_delta(peer, recipe, base_hash, delta)
    return peer.evaluate(candidate)


def assert_rejected_and_restored(result, *, require_anchor_drop: bool = False):
    before = result["before"]
    candidate = result["candidate"]
    if candidate["objective"] >= before["objective"]:
        raise RuntimeError("adversarial candidate did not improve evaluation objective")
    if result["accepted"] or candidate["promoted"]:
        raise RuntimeError("quality gate promoted a candidate that should be rejected")
    if result["checkpoint"] is not None:
        raise RuntimeError("rejected candidate unexpectedly produced a checkpoint")
    if result["active"] != before:
        raise RuntimeError("rejected candidate changed active metrics")
    if require_anchor_drop:
        if candidate["anchor_accuracy"] >= before["anchor_accuracy"]:
            raise RuntimeError("adversarial candidate did not regress anchor accuracy")
        if candidate["eligible"]:
            raise RuntimeError("quality gate marked anchor-regressing candidate eligible")


def run_cases(root: Path):
    peer, source_hashes = load_canonical_peer(root)
    inverted = sign_inverted_case(peer)
    if inverted["accepted"]:
        raise RuntimeError("quality gate promoted a sign-inverted update")
    if inverted["candidate"]["objective"] <= inverted["before"]["objective"]:
        raise RuntimeError("sign-inverted update did not worsen evaluation objective")
    if inverted["checkpoint"] is not None or inverted["active"] != inverted["before"]:
        raise RuntimeError("sign-inverted update was not rejected and restored")

    conflict = eval_improves_anchor_regresses_case(peer)
    assert_rejected_and_restored(conflict, require_anchor_drop=True)
    return {
        "schema": "ilaria-p2p-quality-adversarial-receipt-v1",
        "status": "PASS",
        "quality_only": True,
        "network_authentication_or_distributed_security_tested": False,
        "canonical_source_sha256": source_hashes,
        "cases": {
            "sign_inverted_real_backprop_delta": {
                "status": "rejected-and-restored",
                "before": inverted["before"],
                "candidate": {k: inverted["candidate"][k] for k in ("objective", "anchor_accuracy", "eligible", "promoted")},
                "active": inverted["active"],
            },
            "eval_ce_improves_anchor_accuracy_degrades": {
                "status": "rejected-and-restored",
                "before": conflict["before"],
                "candidate": {k: conflict["candidate"][k] for k in ("objective", "anchor_accuracy", "anchor_floor", "eligible", "promoted")},
                "active": conflict["active"],
            },
        },
    }

