"""PCE Transfer v2: train/validation/test + Collective Sleep + anti-forgetting.

This experiment upgrades v1 in four ways:
1. PCE skill prompts have separate train/validation/test phrasings.
2. Cells first learn a frozen set of pre-existing anchor skills.
3. Sleep mixes new PCE replay with anchor replay.
4. Collective Sleep selects/restores the best validation checkpoint and rejects
   candidates that exceed the allowed anchor-forgetting budget.

Transfer and control begin from identical post-anchor weights. The control gets
the same optimizer budget and the same anchor replay, but the PCE action mapping
is rotated across skills.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
from pathlib import Path

import torch
import torch.nn.functional as F

from collective_sleep import SleepPolicy, consolidate
from imc_model import ImcConfig, ImcTransformer
from pce_replay import load_replay_artifact_dir

BOS = 1
EOS = 2
SEP = 3
BYTE_OFFSET = 4
BYTE_VOCAB_SIZE = 260


def encode(text: str) -> list[int]:
    return [b + BYTE_OFFSET for b in text.encode("utf-8")]


def load_jsonl(path: str | Path, required: set[str]) -> list[dict]:
    items = []
    seen = set()
    with open(path, encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            item = json.loads(line)
            missing = required - set(item)
            if missing:
                raise ValueError(
                    f"{path}:{line_no}: missing {sorted(missing)}"
                )
            if item["id"] in seen:
                raise ValueError(f"{path}:{line_no}: duplicate id {item['id']!r}")
            seen.add(item["id"])
            items.append(item)
    if not items:
        raise ValueError(f"{path}: no items")
    return items


def load_skills(path: str | Path) -> list[dict]:
    return load_jsonl(
        path,
        {
            "id",
            "domain",
            "train_state",
            "val_prompt",
            "test_prompt",
            "action",
            "result",
            "skill_key",
        },
    )


def load_anchors(path: str | Path) -> list[dict]:
    return load_jsonl(
        path,
        {
            "id",
            "domain",
            "train_state",
            "val_prompt",
            "test_prompt",
            "action",
            "skill_key",
        },
    )


def make_model(
    seed: int,
    ternary: bool,
    max_seq_len: int,
    action_count: int,
) -> ImcTransformer:
    torch.manual_seed(seed)
    cfg = ImcConfig(
        vocab_size=BYTE_VOCAB_SIZE + action_count,
        d_model=64,
        n_layers=2,
        n_heads=4,
        n_kv_heads=2,
        ffn_dim=128,
        max_seq_len=max_seq_len,
        eos_token_id=EOS,
        ternary=ternary,
    )
    return ImcTransformer(cfg)


def skill_token(index: int) -> int:
    return BYTE_VOCAB_SIZE + index


def anchor_token(index: int, skill_count: int) -> int:
    return BYTE_VOCAB_SIZE + skill_count + index


def action_loss(
    model: ImcTransformer,
    prefix: str,
    target_token: int,
    *,
    device: torch.device,
) -> tuple[torch.Tensor, int]:
    prefix_ids = encode(prefix)
    max_prefix = model.cfg.max_seq_len - 2
    prefix_ids = prefix_ids[-max_prefix:]
    x_ids = [BOS] + prefix_ids + [SEP]
    x = torch.tensor(x_ids, dtype=torch.long, device=device)[None, :]
    logits = model(x)[0, -1].float()
    target = torch.tensor([target_token], dtype=torch.long, device=device)
    loss = F.cross_entropy(logits[None, :], target)
    return loss, int(torch.argmax(logits))


def action_logits(
    model: ImcTransformer,
    prefix: str,
    *,
    device: torch.device,
) -> torch.Tensor:
    """Return next-action logits for a replay prefix."""
    prefix_ids = encode(prefix)
    max_prefix = model.cfg.max_seq_len - 2
    prefix_ids = prefix_ids[-max_prefix:]
    x_ids = [BOS] + prefix_ids + [SEP]
    x = torch.tensor(x_ids, dtype=torch.long, device=device)[None, :]
    return model(x)[0, -1].float()


def replay_action_loss(
    model: ImcTransformer,
    prefix: str,
    target_token: int,
    *,
    action_rank_weight: float,
    label_smoothing: float,
    device: torch.device,
) -> torch.Tensor:
    """Replay CE plus an auxiliary ranking loss over action tokens only.

    Evaluation remains the unchanged full-vocabulary NLL. The auxiliary term is
    training-only and gives the tiny transfer model a direct signal for the
    decision that matters: distinguish the verified action from alternative
    actions rather than spending all gradient budget separating it from bytes.
    """
    if action_rank_weight < 0:
        raise ValueError("action_rank_weight must be non-negative")
    logits = action_logits(model, prefix, device=device)
    return replay_loss_from_logits(
        logits,
        target_token,
        action_rank_weight=action_rank_weight,
        label_smoothing=label_smoothing,
        device=device,
    )


def replay_loss_from_logits(
    logits: torch.Tensor,
    target_token: int,
    *,
    action_rank_weight: float,
    label_smoothing: float,
    device: torch.device,
) -> torch.Tensor:
    """Compute the training-only full-vocab + action-ranking objective."""
    if not 0 <= label_smoothing < 1:
        raise ValueError("label_smoothing must be inside [0, 1)")
    target = torch.tensor([target_token], dtype=torch.long, device=device)
    full_loss = F.cross_entropy(
        logits[None, :], target, label_smoothing=label_smoothing
    )
    if action_rank_weight == 0:
        return full_loss
    if target_token < BYTE_VOCAB_SIZE:
        raise ValueError("replay target is not an action token")
    action_logits_only = logits[BYTE_VOCAB_SIZE:]
    action_target = torch.tensor(
        [target_token - BYTE_VOCAB_SIZE], dtype=torch.long, device=device
    )
    rank_loss = F.cross_entropy(
        action_logits_only[None, :],
        action_target,
        label_smoothing=label_smoothing,
    )
    return full_loss + action_rank_weight * rank_loss


def bind_verified_replays(skills: list[dict], replay_dir: str | Path) -> tuple[list[dict], list[str]]:
    """Bind validated signed-PCE replay artifacts to the frozen skill rows.

    Matching is intentionally strict on both domain and action. The artifact
    becomes only the training-side pre-action state; validation/test prompts and
    targets stay frozen. Any missing, duplicate or unmatched artifact fails the
    run before model allocation.
    """
    decisions = load_replay_artifact_dir(replay_dir)
    by_key: dict[tuple[str, str], object] = {}
    for decision in decisions:
        key = (decision.domain, decision.action_target)
        if key in by_key:
            raise ValueError(f"duplicate replay binding for domain/action {key!r}")
        by_key[key] = decision

    bound: list[dict] = []
    used: set[str] = set()
    for skill in skills:
        key = (skill["domain"], skill["action"])
        decision = by_key.get(key)
        if decision is None:
            raise ValueError(
                "missing signed replay artifact for "
                f"skill {skill['id']!r} domain/action {key!r}"
            )
        item = dict(skill)
        item["verified_replay_prompt"] = decision.decision_prompt
        item["replay_artifact_sha256"] = decision.artifact_sha256
        item["replay_capsule_hash"] = decision.capsule_hash
        bound.append(item)
        used.add(decision.artifact_sha256)

    if len(used) != len(decisions):
        extras = sorted(
            decision.artifact_sha256
            for decision in decisions
            if decision.artifact_sha256 not in used
        )
        raise ValueError(f"unmatched signed replay artifacts: {extras}")
    return bound, sorted(used)


def skill_train_prompt(item: dict, variant: int = 0) -> str:
    """Replay one verified skill through multiple deterministic views.

    Every replay view contains the pre-action state. The stable skill_key is
    metadata for PCE identity, never a substitute for state and never a carrier
    for the post-action result. One view intentionally mirrors the held-out
    evaluation grammar while using only train_state, reducing format shift
    without exposing validation/test text.
    """
    domain = item["domain"]
    state = item.get("verified_replay_prompt", item["train_state"])
    key = item["skill_key"]
    views = (
        (
            f"domain: {domain}\n"
            f"new observation: {state}\n"
            f"skill key: {key}\n"
            "select learned action: "
        ),
        (
            "<|pce:start|>\n"
            f"domain: {domain}\n"
            f"verified state: {state}\n"
            f"skill key: {key}\n"
            "select learned action: "
        ),
        (
            f"domain: {domain}\n"
            f"observation: {state}\n"
            f"skill key: {key}\n"
            "choose verified action: "
        ),
    )
    return views[variant % len(views)]


def skill_eval_prompt(item: dict, split: str) -> str:
    field = f"{split}_prompt"
    return (
        f"domain: {item['domain']}\n"
        f"new observation: {item[field]}\n"
        f"skill key: {item['skill_key']}\n"
        "select learned action: "
    )


def skill_key_probe(item: dict) -> str:
    return (
        f"domain: {item['domain']}\n"
        f"skill key: {item['skill_key']}\n"
        "select learned action: "
    )


def anchor_train_prompt(item: dict) -> str:
    return (
        f"stable domain: {item['domain']}\n"
        f"known state: {item['train_state']}\n"
        f"skill key: {item['skill_key']}\n"
        "select stable action: "
    )


def anchor_eval_prompt(item: dict, split: str) -> str:
    field = f"{split}_prompt"
    return (
        f"stable domain: {item['domain']}\n"
        f"new case: {item[field]}\n"
        f"skill key: {item['skill_key']}\n"
        "select stable action: "
    )


@torch.no_grad()
def evaluate_items(
    model: ImcTransformer,
    items: list[dict],
    *,
    prefix_fn,
    token_fn,
    device: torch.device,
) -> dict:
    model.eval()
    losses = []
    correct = 0
    per_item = {}
    for index, item in enumerate(items):
        target = token_fn(index)
        loss, prediction = action_loss(
            model,
            prefix_fn(item),
            target,
            device=device,
        )
        value = float(loss)
        hit = prediction == target
        losses.append(value)
        correct += int(hit)
        per_item[item["id"]] = {
            "nll": value,
            "correct": hit,
            "prediction": prediction,
            "target": target,
        }
    return {
        "mean_nll": sum(losses) / len(losses),
        "top1_accuracy": correct / len(items),
        "correct": correct,
        "count": len(items),
        "per_item": per_item,
    }


def pretrain_anchors(
    model: ImcTransformer,
    anchors: list[dict],
    *,
    skill_count: int,
    steps: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> list[float]:
    if steps < 1:
        raise ValueError("anchor pretrain steps must be positive")
    model.train()
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01
    )
    rng = random.Random(seed)
    losses = []
    for _ in range(steps):
        index = rng.randrange(len(anchors))
        loss, _ = action_loss(
            model,
            anchor_train_prompt(anchors[index]),
            anchor_token(index, skill_count),
            device=device,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(
            model.parameters(), 1.0, error_if_nonfinite=True
        )
        optimizer.step()
        losses.append(float(loss.detach()))
    return losses


def sleep_one_cell(
    model: ImcTransformer,
    *,
    skills: list[dict],
    anchors: list[dict],
    skill_mapping: list[int],
    policy: SleepPolicy,
    lr: float,
    anchor_replay_ratio: float,
    teacher_kl_weight: float,
    action_rank_weight: float,
    replay_consistency_weight: float,
    replay_label_smoothing: float,
    skill_batch_size: int,
    anchor_batch_size: int,
    seed: int,
    device: torch.device,
) -> dict:
    if not 0 <= anchor_replay_ratio <= 1:
        raise ValueError("anchor_replay_ratio must be inside [0, 1]")
    if len(skill_mapping) != len(skills):
        raise ValueError("skill mapping length differs from skills")
    if teacher_kl_weight < 0:
        raise ValueError("teacher_kl_weight must be non-negative")
    if action_rank_weight < 0:
        raise ValueError("action_rank_weight must be non-negative")
    if replay_consistency_weight < 0:
        raise ValueError("replay_consistency_weight must be non-negative")
    if not 0 <= replay_label_smoothing < 1:
        raise ValueError("replay_label_smoothing must be inside [0, 1)")
    if not 1 <= skill_batch_size <= len(skills):
        raise ValueError("skill_batch_size must be inside [1, len(skills)]")
    if not 1 <= anchor_batch_size <= len(anchors):
        raise ValueError("anchor_batch_size must be inside [1, len(anchors)]")

    optimizer = torch.optim.AdamW(
        model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01
    )
    teacher = copy.deepcopy(model).eval()
    for parameter in teacher.parameters():
        parameter.requires_grad_(False)

    def train_step(step: int):
        model.train()
        skill_start = ((step - 1) * skill_batch_size) % len(skills)
        skill_indices = [
            (skill_start + offset) % len(skills)
            for offset in range(skill_batch_size)
        ]
        skill_losses = []
        for source_index in skill_indices:
            target_index = skill_mapping[source_index]
            target_token = skill_token(target_index)
            view_logits = [
                action_logits(
                    model,
                    skill_train_prompt(skills[source_index], variant),
                    device=device,
                )
                for variant in range(3)
            ]
            supervised = torch.stack(
                [
                    replay_loss_from_logits(
                        logits,
                        target_token,
                        action_rank_weight=action_rank_weight,
                        label_smoothing=replay_label_smoothing,
                        device=device,
                    )
                    for logits in view_logits
                ]
            ).mean()
            action_probs = torch.stack(
                [
                    F.softmax(logits[BYTE_VOCAB_SIZE:], dim=-1)
                    for logits in view_logits
                ]
            )
            consensus = action_probs.mean(dim=0).detach()
            consistency = torch.stack(
                [
                    F.kl_div(
                        F.log_softmax(logits[BYTE_VOCAB_SIZE:], dim=-1),
                        consensus,
                        reduction="sum",
                    )
                    for logits in view_logits
                ]
            ).mean()
            skill_losses.append(
                supervised + replay_consistency_weight * consistency
            )
        skill_loss = torch.stack(skill_losses).mean()

        anchor_start = ((step - 1) * anchor_batch_size) % len(anchors)
        anchor_losses = []
        anchor_kls = []
        for offset in range(anchor_batch_size):
            anchor_index = (anchor_start + offset) % len(anchors)
            anchor_prefix = anchor_train_prompt(anchors[anchor_index])
            item_loss, _ = action_loss(
                model,
                anchor_prefix,
                anchor_token(anchor_index, len(skills)),
                device=device,
            )
            anchor_losses.append(item_loss)
            student_logits = action_logits(model, anchor_prefix, device=device)
            with torch.no_grad():
                teacher_logits = action_logits(teacher, anchor_prefix, device=device)
            anchor_kls.append(
                F.kl_div(
                    F.log_softmax(student_logits, dim=-1),
                    F.softmax(teacher_logits, dim=-1),
                    reduction="sum",
                )
            )
        anchor_loss = torch.stack(anchor_losses).mean()
        anchor_kl = torch.stack(anchor_kls).mean()
        loss = (
            (1.0 - anchor_replay_ratio) * skill_loss
            + anchor_replay_ratio * anchor_loss
            + teacher_kl_weight * anchor_kl
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(
            model.parameters(), 1.0, error_if_nonfinite=True
        )
        optimizer.step()
        return loss

    def validation():
        skill_val = evaluate_items(
            model,
            skills,
            prefix_fn=lambda item: skill_eval_prompt(item, "val"),
            token_fn=skill_token,
            device=device,
        )
        skill_key_val = evaluate_items(
            model,
            skills,
            prefix_fn=skill_key_probe,
            token_fn=skill_token,
            device=device,
        )
        anchor_known = evaluate_items(
            model,
            anchors,
            prefix_fn=anchor_train_prompt,
            token_fn=lambda index: anchor_token(index, len(skills)),
            device=device,
        )
        anchor_val = evaluate_items(
            model,
            anchors,
            prefix_fn=lambda item: anchor_eval_prompt(item, "val"),
            token_fn=lambda index: anchor_token(index, len(skills)),
            device=device,
        )
        return {
            # Natural held-out validation NLL is the sole checkpoint objective.
            # Top-1 and key-only metrics are diagnostics/secondary evidence only.
            "objective": skill_val["mean_nll"],
            "skill_accuracy": skill_val["top1_accuracy"],
            "skill_nll": skill_val["mean_nll"],
            "skill_key_accuracy": skill_key_val["top1_accuracy"],
            "skill_key_nll": skill_key_val["mean_nll"],
            # The forgetting gate protects competence the cell demonstrably
            # mastered before sleep, rather than an unseen paraphrase it may
            # never have known in the first place.
            "anchor_accuracy": anchor_known["top1_accuracy"],
            "anchor_nll": anchor_known["mean_nll"],
            "anchor_generalization_accuracy": anchor_val["top1_accuracy"],
            "anchor_generalization_nll": anchor_val["mean_nll"],
        }

    result = consolidate(
        model,
        train_step=train_step,
        validate=validation,
        policy=policy,
    )
    return {
        "best_step": result.best_step,
        "stopped_early": result.stopped_early,
        "best_metrics": result.best_metrics,
        "initial_metrics": result.initial_metrics,
        "accepted_updates": result.accepted_updates,
        "rejected_for_forgetting": result.rejected_for_forgetting,
        "history": result.history,
    }


def run(
    skill_path: str | Path,
    anchor_path: str | Path,
    *,
    seed: int = 7,
    ternary: bool = True,
    max_seq_len: int = 256,
    anchor_pretrain_steps: int = 250,
    anchor_lr: float = 3e-3,
    sleep_steps: int = 320,
    sleep_lr: float = 2e-3,
    eval_every: int = 20,
    patience_evals: int = 3,
    sleep_min_improvement: float = 0.01,
    anchor_replay_ratio: float = 0.35,
    teacher_kl_weight: float = 0.05,
    action_rank_weight: float = 1.0,
    replay_consistency_weight: float = 0.1,
    replay_label_smoothing: float = 0.1,
    skill_batch_size: int = 2,
    anchor_batch_size: int = 2,
    max_anchor_accuracy_drop: float = 0.125,
    device_name: str = "cpu",
    replay_artifact_dir: str | Path | None = None,
) -> dict:
    skills = load_skills(skill_path)
    replay_artifact_hashes: list[str] = []
    if replay_artifact_dir is not None:
        skills, replay_artifact_hashes = bind_verified_replays(
            skills, replay_artifact_dir
        )
    anchors = load_anchors(anchor_path)
    device = torch.device(device_name)
    total_actions = len(skills) + len(anchors)

    base = make_model(seed, ternary, max_seq_len, total_actions).to(device)
    anchor_curve = pretrain_anchors(
        base,
        anchors,
        skill_count=len(skills),
        steps=anchor_pretrain_steps,
        lr=anchor_lr,
        seed=seed,
        device=device,
    )

    anchor_train_before = evaluate_items(
        base,
        anchors,
        prefix_fn=anchor_train_prompt,
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    anchor_val_before = evaluate_items(
        base,
        anchors,
        prefix_fn=lambda item: anchor_eval_prompt(item, "val"),
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    anchor_test_before = evaluate_items(
        base,
        anchors,
        prefix_fn=lambda item: anchor_eval_prompt(item, "test"),
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    skill_val_before = evaluate_items(
        base,
        skills,
        prefix_fn=lambda item: skill_eval_prompt(item, "val"),
        token_fn=skill_token,
        device=device,
    )
    skill_test_before = evaluate_items(
        base,
        skills,
        prefix_fn=lambda item: skill_eval_prompt(item, "test"),
        token_fn=skill_token,
        device=device,
    )

    initial_state = copy.deepcopy(base.state_dict())
    transfer = make_model(seed + 1, ternary, max_seq_len, total_actions).to(device)
    transfer.load_state_dict(initial_state)
    control = make_model(seed + 2, ternary, max_seq_len, total_actions).to(device)
    control.load_state_dict(initial_state)

    policy = SleepPolicy(
        max_steps=sleep_steps,
        eval_every=eval_every,
        patience_evals=patience_evals,
        min_improvement=sleep_min_improvement,
        max_anchor_accuracy_drop=max_anchor_accuracy_drop,
    )
    correct_mapping = list(range(len(skills)))
    rotated_mapping = list(range(1, len(skills))) + [0]

    transfer_sleep = sleep_one_cell(
        transfer,
        skills=skills,
        anchors=anchors,
        skill_mapping=correct_mapping,
        policy=policy,
        lr=sleep_lr,
        anchor_replay_ratio=anchor_replay_ratio,
        teacher_kl_weight=teacher_kl_weight,
        action_rank_weight=action_rank_weight,
        replay_consistency_weight=replay_consistency_weight,
        replay_label_smoothing=replay_label_smoothing,
        skill_batch_size=skill_batch_size,
        anchor_batch_size=anchor_batch_size,
        seed=seed,
        device=device,
    )
    control_sleep = sleep_one_cell(
        control,
        skills=skills,
        anchors=anchors,
        skill_mapping=rotated_mapping,
        policy=policy,
        lr=sleep_lr,
        anchor_replay_ratio=anchor_replay_ratio,
        teacher_kl_weight=teacher_kl_weight,
        action_rank_weight=action_rank_weight,
        replay_consistency_weight=replay_consistency_weight,
        replay_label_smoothing=replay_label_smoothing,
        skill_batch_size=skill_batch_size,
        anchor_batch_size=anchor_batch_size,
        seed=seed,
        device=device,
    )

    transfer_skill_test = evaluate_items(
        transfer,
        skills,
        prefix_fn=lambda item: skill_eval_prompt(item, "test"),
        token_fn=skill_token,
        device=device,
    )
    control_skill_test = evaluate_items(
        control,
        skills,
        prefix_fn=lambda item: skill_eval_prompt(item, "test"),
        token_fn=skill_token,
        device=device,
    )
    transfer_anchor_train = evaluate_items(
        transfer,
        anchors,
        prefix_fn=anchor_train_prompt,
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    control_anchor_train = evaluate_items(
        control,
        anchors,
        prefix_fn=anchor_train_prompt,
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    transfer_anchor_test = evaluate_items(
        transfer,
        anchors,
        prefix_fn=lambda item: anchor_eval_prompt(item, "test"),
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )
    control_anchor_test = evaluate_items(
        control,
        anchors,
        prefix_fn=lambda item: anchor_eval_prompt(item, "test"),
        token_fn=lambda index: anchor_token(index, len(skills)),
        device=device,
    )

    return {
        "experiment": "pce-transfer-v2-collective-sleep",
        "seed": seed,
        "ternary": ternary,
        "skill_count": len(skills),
        "anchor_count": len(anchors),
        **({"signed_replay_artifacts": replay_artifact_hashes} if replay_artifact_hashes else {}),
        "anchor_pretrain": {
            "steps": anchor_pretrain_steps,
            "loss_start": anchor_curve[0],
            "loss_end": anchor_curve[-1],
            "train_before_sleep": anchor_train_before,
            "val_before_sleep": anchor_val_before,
            "test_before_sleep": anchor_test_before,
        },
        "skill_before_sleep": {
            "val": skill_val_before,
            "test": skill_test_before,
        },
        "sleep_policy": {
            "max_steps": sleep_steps,
            "eval_every": eval_every,
            "patience_evals": patience_evals,
            "min_improvement": sleep_min_improvement,
            "anchor_replay_ratio": anchor_replay_ratio,
            "teacher_kl_weight": teacher_kl_weight,
            "action_rank_weight": action_rank_weight,
            "replay_consistency_weight": replay_consistency_weight,
            "replay_label_smoothing": replay_label_smoothing,
            "skill_batch_size": skill_batch_size,
            "anchor_batch_size": anchor_batch_size,
            "max_anchor_accuracy_drop": max_anchor_accuracy_drop,
            "lr": sleep_lr,
        },
        "transfer_sleep": transfer_sleep,
        "control_sleep": control_sleep,
        "transfer_test": {
            "skill": transfer_skill_test,
            "anchor_known": transfer_anchor_train,
            "anchor_generalization": transfer_anchor_test,
        },
        "control_test": {
            "skill": control_skill_test,
            "anchor_known": control_anchor_train,
            "anchor_generalization": control_anchor_test,
        },
        "causal_advantage_accuracy": (
            transfer_skill_test["top1_accuracy"]
            - control_skill_test["top1_accuracy"]
        ),
        "causal_advantage_nll": (
            control_skill_test["mean_nll"]
            - transfer_skill_test["mean_nll"]
        ),
        "transfer_gain_accuracy": (
            transfer_skill_test["top1_accuracy"]
            - skill_test_before["top1_accuracy"]
        ),
        "transfer_gain_nll": (
            skill_test_before["mean_nll"]
            - transfer_skill_test["mean_nll"]
        ),
        "transfer_anchor_accuracy_delta": (
            transfer_anchor_train["top1_accuracy"]
            - anchor_train_before["top1_accuracy"]
        ),
        "control_anchor_accuracy_delta": (
            control_anchor_train["top1_accuracy"]
            - anchor_train_before["top1_accuracy"]
        ),
        "transfer_anchor_generalization_delta": (
            transfer_anchor_test["top1_accuracy"]
            - anchor_test_before["top1_accuracy"]
        ),
        "control_anchor_generalization_delta": (
            control_anchor_test["top1_accuracy"]
            - anchor_test_before["top1_accuracy"]
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    bench = (
        Path(__file__).resolve().parents[1]
        / "bench"
        / "myriad"
        / "pce_transfer_v2"
    )
    parser.add_argument("--skills", default=str(bench / "tasks.jsonl"))
    parser.add_argument("--anchors", default=str(bench / "anchors.jsonl"))
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--anchor-pretrain-steps", type=int, default=250)
    parser.add_argument("--sleep-steps", type=int, default=320)
    parser.add_argument("--sleep-lr", type=float, default=2e-3)
    parser.add_argument("--eval-every", type=int, default=20)
    parser.add_argument("--patience-evals", type=int, default=3)
    parser.add_argument("--sleep-min-improvement", type=float, default=0.01)
    parser.add_argument("--anchor-replay-ratio", type=float, default=0.35)
    parser.add_argument("--teacher-kl-weight", type=float, default=0.05)
    parser.add_argument("--action-rank-weight", type=float, default=1.0)
    parser.add_argument("--replay-consistency-weight", type=float, default=0.1)
    parser.add_argument("--replay-label-smoothing", type=float, default=0.1)
    parser.add_argument("--skill-batch-size", type=int, default=2)
    parser.add_argument("--anchor-batch-size", type=int, default=2)
    parser.add_argument("--max-anchor-drop", type=float, default=0.125)
    parser.add_argument("--max-seq-len", type=int, default=256)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--full-precision", action="store_true")
    parser.add_argument("--replay-artifact-dir", default="")
    parser.add_argument("--assert-gain", action="store_true")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    result = run(
        args.skills,
        args.anchors,
        seed=args.seed,
        ternary=not args.full_precision,
        max_seq_len=args.max_seq_len,
        anchor_pretrain_steps=args.anchor_pretrain_steps,
        sleep_steps=args.sleep_steps,
        sleep_lr=args.sleep_lr,
        eval_every=args.eval_every,
        patience_evals=args.patience_evals,
        sleep_min_improvement=args.sleep_min_improvement,
        anchor_replay_ratio=args.anchor_replay_ratio,
        teacher_kl_weight=args.teacher_kl_weight,
        action_rank_weight=args.action_rank_weight,
        replay_consistency_weight=args.replay_consistency_weight,
        replay_label_smoothing=args.replay_label_smoothing,
        skill_batch_size=args.skill_batch_size,
        anchor_batch_size=args.anchor_batch_size,
        max_anchor_accuracy_drop=args.max_anchor_drop,
        device_name=args.device,
        replay_artifact_dir=args.replay_artifact_dir or None,
    )
    payload = json.dumps(result, indent=2, sort_keys=True)
    print(payload)
    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")

    if args.assert_gain:
        if result["causal_advantage_nll"] <= 0:
            raise SystemExit(
                "PCE v2 failed: transfer test NLL did not beat mismatched control"
            )
        if result["transfer_anchor_accuracy_delta"] < -args.max_anchor_drop:
            raise SystemExit(
                "PCE v2 failed: transfer cell exceeded anchor forgetting budget"
            )


if __name__ == "__main__":
    main()
