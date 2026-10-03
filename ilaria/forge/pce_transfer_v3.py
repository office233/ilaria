"""PCE Transfer v3 tuning harness.

This file NEVER opens the sealed test split. It only consumes:
- skills_trainval.jsonl
- anchors_trainval.jsonl
- policy.json
- manifest.json

The final test is opened by a separate finalization command after validation
policy is frozen and the multi-seed validation gate passes.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

import torch

from collective_sleep import SleepPolicy, consolidate
from pce_transfer_v2 import (
    action_loss,
    anchor_token,
    anchor_train_prompt,
    evaluate_items,
    make_model,
    pretrain_anchors,
    skill_key_probe,
    skill_token,
)


def sha256(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_rows(path: str | Path, required: set[str]) -> list[dict]:
    rows, seen = [], set()
    with open(path, encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            missing = required - set(row)
            if missing:
                raise ValueError(f"{path}:{line_no}: missing {sorted(missing)}")
            if row["id"] in seen:
                raise ValueError(f"{path}:{line_no}: duplicate id {row['id']!r}")
            seen.add(row["id"])
            rows.append(row)
    if not rows:
        raise ValueError(f"{path}: no rows")
    return rows


def load_benchmark(bench: Path) -> tuple[list[dict], list[dict], dict, dict]:
    manifest = json.loads((bench / "manifest.json").read_text(encoding="utf-8"))
    policy = json.loads((bench / "policy.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 2:
        raise ValueError("v3 manifest schema mismatch")
    if manifest.get("test_status") != "sealed":
        raise ValueError("v3 test split must remain sealed during tuning")
    checks = {
        "skills_trainval_sha256": "skills_trainval.jsonl",
        "anchors_trainval_sha256": "anchors_trainval.jsonl",
        "policy_sha256": "policy.json",
    }
    for key, name in checks.items():
        if manifest.get(key) != sha256(bench / name):
            raise ValueError(f"v3 frozen artifact hash mismatch: {name}")

    skills = load_rows(
        bench / "skills_trainval.jsonl",
        {
            "id", "domain", "skill_key", "train_state",
            "val_prompt_a", "val_prompt_b", "action", "result",
        },
    )
    anchors = load_rows(
        bench / "anchors_trainval.jsonl",
        {"id", "domain", "skill_key", "train_state", "val_prompt", "action"},
    )
    if len(skills) != manifest["skill_count"] or len(anchors) != manifest["anchor_count"]:
        raise ValueError("v3 benchmark count differs from manifest")
    return skills, anchors, policy, manifest


def skill_train_prompt(item: dict, variant: int) -> str:
    domain, state, key = item["domain"], item["train_state"], item["skill_key"]
    views = (
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
        (
            f"domain: {domain}\n"
            f"skill key: {key}\n"
            "select learned action: "
        ),
        (
            f"verified transferable skill: {key}\n"
            "choose learned action: "
        ),
    )
    return views[variant % len(views)]


def skill_val_prompt(item: dict, which: str) -> str:
    field = {"a": "val_prompt_a", "b": "val_prompt_b"}[which]
    return (
        f"domain: {item['domain']}\n"
        f"new observation: {item[field]}\n"
        f"skill key: {item['skill_key']}\n"
        "select learned action: "
    )


def validation_metrics(
    model, skills, anchors, device, worst_penalty_weight: float = 0.25
) -> dict:
    val_a = evaluate_items(
        model,
        skills,
        prefix_fn=lambda item: skill_val_prompt(item, "a"),
        token_fn=skill_token,
        device=device,
    )
    val_b = evaluate_items(
        model,
        skills,
        prefix_fn=lambda item: skill_val_prompt(item, "b"),
        token_fn=skill_token,
        device=device,
    )
    key_view = evaluate_items(
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
        token_fn=lambda i: anchor_token(i, len(skills)),
        device=device,
    )

    natural_nll = 0.5 * (val_a["mean_nll"] + val_b["mean_nll"])
    natural_accuracy = 0.5 * (
        val_a["top1_accuracy"] + val_b["top1_accuracy"]
    )
    if not 0 <= worst_penalty_weight <= 1:
        raise ValueError("worst_penalty_weight must be inside [0,1]")
    worst_view_nll = max(
        val_a["mean_nll"], val_b["mean_nll"], key_view["mean_nll"]
    )
    # Natural held-out behavior remains primary. A bounded penalty prevents
    # one weak view from being ignored without letting a noisy maximum fully
    # dominate checkpoint selection.
    objective = natural_nll + worst_penalty_weight * max(
        0.0, worst_view_nll - natural_nll
    )
    return {
        "objective": objective,
        "anchor_accuracy": anchor_known["top1_accuracy"],
        "anchor_nll": anchor_known["mean_nll"],
        "natural_nll": natural_nll,
        "natural_accuracy": natural_accuracy,
        "val_a_nll": val_a["mean_nll"],
        "val_b_nll": val_b["mean_nll"],
        "key_nll": key_view["mean_nll"],
        "worst_view_nll": worst_view_nll,
        "val_a_accuracy": val_a["top1_accuracy"],
        "val_b_accuracy": val_b["top1_accuracy"],
        "key_accuracy": key_view["top1_accuracy"],
    }


def sleep_cell(
    model,
    *,
    skills,
    anchors,
    mapping,
    policy_cfg,
    seed,
    device,
) -> dict:
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(policy_cfg["sleep_lr"]),
        betas=(0.9, 0.95),
        weight_decay=0.01,
    )
    anchor_ratio = float(policy_cfg["anchor_replay_ratio"])
    prompt_views = int(policy_cfg["train_prompt_views"])
    if prompt_views < 1:
        raise ValueError("train_prompt_views must be positive")

    def train_step(step: int):
        model.train()
        # The frozen policy's replay ratio is an exact loss mixture, not a
        # Bernoulli branch. Sampling anchor-vs-skill per optimizer step creates
        # long seed-dependent bursts without anchor protection and can make an
        # otherwise useful candidate ineligible solely through replay variance.
        # Transfer and control use the same RNG schedule and compute budget.
        # Cover every skill/anchor deterministically instead of allowing a
        # seed-specific random replay schedule to under-sample some mappings.
        # The model initialization remains seed-dependent; the replay curriculum
        # itself is balanced and identical between transfer and control.
        skill_start = (seed + (step - 1) * prompt_views) % len(skills)
        skill_indices = [
            (skill_start + offset) % len(skills)
            for offset in range(prompt_views)
        ]
        skill_loss = torch.stack(
            [
                action_loss(
                    model,
                    skill_train_prompt(skills[source], variant),
                    skill_token(mapping[source]),
                    device=device,
                )[0]
                for source in skill_indices
                for variant in range(prompt_views)
            ]
        ).mean()
        anchor_index = (seed + step - 1) % len(anchors)
        anchor_loss, _ = action_loss(
            model,
            anchor_train_prompt(anchors[anchor_index]),
            anchor_token(anchor_index, len(skills)),
            device=device,
        )
        loss = (1.0 - anchor_ratio) * skill_loss + anchor_ratio * anchor_loss
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(
            model.parameters(), 1.0, error_if_nonfinite=True
        )
        optimizer.step()
        return loss

    def validate():
        return validation_metrics(
            model,
            skills,
            anchors,
            device,
            float(policy_cfg["worst_view_penalty_weight"]),
        )

    result = consolidate(
        model,
        train_step=train_step,
        validate=validate,
        policy=SleepPolicy(
            max_steps=int(policy_cfg["sleep_steps"]),
            eval_every=int(policy_cfg["eval_every"]),
            patience_evals=int(policy_cfg["patience_evals"]),
            min_improvement=float(policy_cfg["min_improvement"]),
            max_anchor_accuracy_drop=float(
                policy_cfg["max_anchor_accuracy_drop"]
            ),
        ),
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


def run(bench: Path, *, seed: int, ternary: bool = True, device_name: str = "cpu") -> dict:
    skills, anchors, policy, manifest = load_benchmark(bench)
    if seed not in policy["tuning_seeds"]:
        raise ValueError(f"seed {seed} is not in frozen tuning_seeds")

    device = torch.device(device_name)
    total_actions = len(skills) + len(anchors)
    base = make_model(
        seed,
        ternary,
        320,
        total_actions,
    ).to(device)
    pretrain_anchors(
        base,
        anchors,
        skill_count=len(skills),
        steps=int(policy["anchor_pretrain_steps"]),
        lr=float(policy["anchor_lr"]),
        seed=seed,
        device=device,
    )

    initial = validation_metrics(
        base,
        skills,
        anchors,
        device,
        float(policy["worst_view_penalty_weight"]),
    )
    initial_state = copy.deepcopy(base.state_dict())

    transfer = make_model(seed + 1, ternary, 320, total_actions).to(device)
    transfer.load_state_dict(initial_state)
    control = make_model(seed + 2, ternary, 320, total_actions).to(device)
    control.load_state_dict(initial_state)

    correct = list(range(len(skills)))
    rotated = list(range(1, len(skills))) + [0]

    transfer_sleep = sleep_cell(
        transfer,
        skills=skills,
        anchors=anchors,
        mapping=correct,
        policy_cfg=policy,
        seed=seed,
        device=device,
    )
    control_sleep = sleep_cell(
        control,
        skills=skills,
        anchors=anchors,
        mapping=rotated,
        policy_cfg=policy,
        seed=seed,
        device=device,
    )

    t = transfer_sleep["best_metrics"]
    c = control_sleep["best_metrics"]
    return {
        "experiment": "pce-transfer-v3-tuning",
        "seed": seed,
        "ternary": ternary,
        "tuner_sha256": sha256(__file__),
        "manifest_sha256": sha256(bench / "manifest.json"),
        "policy_sha256": manifest["policy_sha256"],
        "initial": initial,
        "transfer_sleep": transfer_sleep,
        "control_sleep": control_sleep,
        "validation_causal_advantage_nll": (
            c["natural_nll"] - t["natural_nll"]
        ),
        "validation_causal_advantage_accuracy": (
            t["natural_accuracy"] - c["natural_accuracy"]
        ),
        "validation_objective_advantage": c["objective"] - t["objective"],
        "transfer_anchor_accuracy_delta": (
            t["anchor_accuracy"] - initial["anchor_accuracy"]
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    from workspace_paths import benchmark_root
    default_bench = (
        benchmark_root(Path(__file__).resolve().parents[1])
        / "myriad"
        / "pce_transfer_v3"
    )
    parser.add_argument("--bench", default=str(default_bench))
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--full-precision", action="store_true")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    result = run(
        Path(args.bench),
        seed=args.seed,
        ternary=not args.full_precision,
        device_name=args.device,
    )
    payload = json.dumps(result, indent=2, sort_keys=True)
    Path(args.out).write_text(payload + "\n", encoding="utf-8", newline="\n")
    print(
        json.dumps(
            {
                "seed": result["seed"],
                "nll_advantage": result["validation_causal_advantage_nll"],
                "accuracy_advantage": result[
                    "validation_causal_advantage_accuracy"
                ],
                "transfer_best_step": result["transfer_sleep"]["best_step"],
                "transfer_early_stop": result[
                    "transfer_sleep"
                ]["stopped_early"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
