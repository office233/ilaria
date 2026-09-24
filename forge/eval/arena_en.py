"""arena_en.py — the English "arena": run the same lm-evaluation-harness
tasks, with the same few-shot settings the BitNet b1.58 2B4T Technical
Report (https://arxiv.org/abs/2504.12285) used, against either

  --system bitnet2b   microsoft/bitnet-b1.58-2B-4T (transformers `hf` wrapper)
  --system ilaria130m our own Ilaria-130M (forge/eval/arena_ilaria_adapter.py)

so Ilaria's numbers land in the same table as a model whose numbers are
already published, instead of floating on their own.

Task / few-shot settings (replicated from the report — see
docs/research/2026-09-24-arena-en-design.md for the exact quotes):
  MMLU            5-shot,  acc          (Table 1)
  GSM8K           4-shot,  exact_match, chat-formatted generation (Table 1, Appendix B)
  ARC-Challenge   0-shot,  acc_norm     (Table 1)
  ARC-Easy        0-shot,  acc_norm     (Table 1)
  HellaSwag       0-shot,  acc_norm     (Table 1)
  WinoGrande      0-shot,  acc          (Table 1)
  PIQA            0-shot,  acc_norm     (Table 1)
  IFEval          0-shot,  inst_level_strict_acc, chat-formatted generation (Table 1, Appendix B)

Appendix B: "For all other benchmarks ... we used the standard
lm-evaluation-harness framework. Models were prompted using a chat format
for generative tasks (e.g., GSM8K, IFEval, and MT-Bench), while default
settings from the respective toolkits were used for other tasks." Chat
format is only applied for --system bitnet2b (the checkpoint's
tokenizer_config.json carries the report's own SFT chat template);
Ilaria-130M is an untuned base LM with no chat template, so it always runs
in plain-completion mode — see the design doc for why this is the right
call rather than a shortcut.

    python forge/eval/arena_en.py --system ilaria130m --tasks arc_easy,hellaswag --limit 20
    python forge/eval/arena_en.py --system bitnet2b --tasks arc_easy --limit 5 --batch-size 1
"""

from __future__ import annotations

import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")  # see forge/bitnet_reference.py's own note

import argparse  # noqa: E402
import datetime  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402

import torch  # noqa: E402

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import bitnet_reference  # noqa: E402  (for _fix_unmaterialized_offline_weights)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

DEFAULT_TASKS = ["mmlu", "gsm8k", "arc_challenge", "arc_easy", "hellaswag", "winogrande", "piqa", "ifeval"]

# Few-shot count per task, replicated from Table 1 of arXiv:2504.12285.
FEWSHOT_BY_TASK = {
    "mmlu": 5,
    "gsm8k": 4,
    "arc_challenge": 0,
    "arc_easy": 0,
    "hellaswag": 0,
    "winogrande": 0,
    "piqa": 0,
    "ifeval": 0,
}

# Appendix B: "chat format for generative tasks (e.g., GSM8K, IFEval, ...)".
CHAT_TASKS = {"gsm8k", "ifeval"}

REPORT_URL = "https://arxiv.org/abs/2504.12285"
REPORT_CITE = "BitNet b1.58 2B4T Technical Report, Table 1 / Appendix B — " + REPORT_URL

# Published BitNet b1.58 2B4T numbers from Table 1, as fractions (0-1) so they
# sit next to lm_eval's own fraction-scale metrics without a unit mismatch.
# {task: {metric_root: reference_fraction}}
REFERENCE = {
    "mmlu": {"acc": 0.5317},
    "gsm8k": {"exact_match": 0.5838},
    "arc_challenge": {"acc_norm": 0.4991},
    "arc_easy": {"acc_norm": 0.7479},
    "hellaswag": {"acc_norm": 0.6844},
    "winogrande": {"acc": 0.7190},
    "piqa": {"acc_norm": 0.7709},
    "ifeval": {"inst_level_strict_acc": 0.5348},
}

DTYPE_MAP = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}


def load_bitnet_lm(hf_dir: str, device: str, dtype_str: str, batch_size):
    """Build the harness's HF wrapper around the local BitNet checkpoint,
    then apply forge/bitnet_reference.py's known-quirk fix for this PC's
    transformers 5.3.0 (packed AutoBitLinear weights left as uint8 after
    from_pretrained). Conditional: a no-op (n_fixed == 0) wherever the bug
    doesn't reproduce, e.g. a newer transformers on Colab."""
    from lm_eval.models.huggingface import HFLM

    lm = HFLM(pretrained=hf_dir, dtype=dtype_str, batch_size=batch_size, device=device)
    n_fixed = bitnet_reference._fix_unmaterialized_offline_weights(lm.model, hf_dir)
    if n_fixed:
        from transformers.integrations.bitnet import AutoBitLinear

        # The fix reads straight from model.safetensors and produces new CPU
        # float32 Parameters (bitnet_reference.py's own CPU-only reference
        # script never needed to move them anywhere else). HFLM already
        # placed the rest of the model on `device` in `dtype_str` before we
        # got here, so relocate+cast just the modules the fix touched to
        # match — ternary values are exact integers in {-1,0,1}, so casting
        # float32 -> bf16/fp16 is lossless.
        target_dtype = DTYPE_MAP.get(dtype_str, lm.model.dtype if hasattr(lm.model, "dtype") else torch.float32)
        moved = 0
        for _, mod in lm.model.named_modules():
            if isinstance(mod, AutoBitLinear) and mod.weight.dtype == torch.float32 and mod.weight.device != lm.device:
                mod.weight = torch.nn.Parameter(mod.weight.data.to(device=lm.device, dtype=target_dtype), requires_grad=False)
                moved += 1
        print(f"[arena_en] bitnet2b: re-unpacked {n_fixed} AutoBitLinear modules from {hf_dir}/model.safetensors, "
              f"relocated {moved} to {lm.device}/{target_dtype}")
    return lm


def load_ilaria_lm(brain_dir: str, device: str, max_gen_toks: int, batch_size):
    from arena_ilaria_adapter import Ilaria130MLM  # noqa: local import: registers "ilaria" as a side effect too

    return Ilaria130MLM(brain_dir=brain_dir, device=device, max_gen_toks=max_gen_toks, batch_size=batch_size)


def group_tasks(tasks: list[str], chat_eligible: bool) -> dict[tuple[int, bool], list[str]]:
    """Group tasks by (num_fewshot, use_chat_format) so each distinct
    combination is a single simple_evaluate() call (num_fewshot and
    apply_chat_template are both call-wide, not per-task, in this harness
    version)."""
    groups: dict[tuple[int, bool], list[str]] = {}
    for t in tasks:
        fewshot = FEWSHOT_BY_TASK.get(t)
        if fewshot is None:
            print(f"[arena_en] warning: {t!r} has no known BitNet-report few-shot setting; defaulting to 0-shot", file=sys.stderr)
            fewshot = 0
        chat = chat_eligible and t in CHAT_TASKS
        groups.setdefault((fewshot, chat), []).append(t)
    return groups


def build_rows(combined: dict) -> list[dict]:
    rows = []
    for task_name, dic in combined["results"].items():
        n = combined.get("n-shot", {}).get(task_name, "")
        alias = dic.get("alias", task_name).strip() if isinstance(dic.get("alias"), str) else task_name
        for mf, v in sorted(dic.items()):
            if mf == "alias" or not isinstance(v, (int, float)):
                continue
            metric_root, _, _filt = mf.partition(",")
            if metric_root.endswith("_stderr"):
                continue
            ref = REFERENCE.get(task_name, {}).get(metric_root)
            rows.append({"task": alias, "task_key": task_name, "metric": mf, "n": n, "value": float(v), "reference": ref})
    return rows


def render_table(rows: list[dict], with_reference: bool) -> str:
    headers = ["Task", "Metric", "N-shot", "Value"]
    if with_reference:
        headers.append("BitNet 2B4T (paper)")
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        cols = [r["task"], r["metric"], str(r["n"]), f"{r['value']:.4f}"]
        if with_reference:
            cols.append(f"{r['reference']:.4f}" if r["reference"] is not None else "—")
        lines.append("| " + " | ".join(cols) + " |")
    return "\n".join(lines)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--system", required=True, choices=["bitnet2b", "ilaria130m"])
    ap.add_argument("--tasks", default=",".join(DEFAULT_TASKS), help="comma-separated task names")
    ap.add_argument("--limit", type=float, default=None, help="lm_eval --limit (examples per task; <1 = fraction)")
    ap.add_argument("--out", default=None, help="default: results/<system>.json")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--dtype", default="bfloat16", choices=list(DTYPE_MAP))
    ap.add_argument("--batch-size", default="auto", help="bitnet2b: int or 'auto'/'auto:N'. ilaria130m: accepted, unused (unbatched).")
    ap.add_argument("--hf-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--brain-dir", default="data/forge/brain-a")
    ap.add_argument("--max-gen-toks", type=int, default=256, help="ilaria130m fallback cap when a task doesn't set its own")
    ap.add_argument("--no-chat-template", action="store_true", help="disable chat formatting for bitnet2b's gsm8k/ifeval (paper's methodology uses it)")
    ap.add_argument("--log-samples", action="store_true")
    ap.add_argument("--bench-md", default="docs/benchmarks/arena_en.md")
    args = ap.parse_args(argv)

    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    limit = args.limit
    if limit is not None and limit >= 1:
        limit = int(limit)

    batch_size = args.batch_size
    try:
        batch_size = int(batch_size)
    except ValueError:
        pass  # "auto" / "auto:N"

    if args.system == "bitnet2b":
        hf_dir = args.hf_dir if os.path.isabs(args.hf_dir) else os.path.join(REPO_ROOT, args.hf_dir)
        try:
            lm = load_bitnet_lm(hf_dir, device=args.device, dtype_str=args.dtype, batch_size=batch_size)
        except RuntimeError as e:
            if "out of memory" not in str(e).lower() or args.device == "cpu":
                raise
            print(f"[arena_en] CUDA OOM loading bitnet2b in {args.dtype} on {args.device} "
                  f"({e}) — falling back to CPU float32, clamping --limit to <=3", file=sys.stderr)
            torch.cuda.empty_cache()
            args.device, args.dtype, batch_size = "cpu", "float32", 1
            limit = 3 if (limit is None or limit > 3) else limit
            lm = load_bitnet_lm(hf_dir, device="cpu", dtype_str="float32", batch_size=1)
        settings_desc = f"hf, pretrained={args.hf_dir}, dtype={args.dtype}, batch_size={batch_size}, device={args.device}"
    else:
        brain_dir = args.brain_dir if os.path.isabs(args.brain_dir) else os.path.join(REPO_ROOT, args.brain_dir)
        lm = load_ilaria_lm(brain_dir, device=args.device, max_gen_toks=args.max_gen_toks, batch_size=batch_size)
        settings_desc = f"ilaria, brain_dir={args.brain_dir}, device={args.device}, float32, unbatched"

    chat_eligible = (args.system == "bitnet2b") and not args.no_chat_template
    groups = group_tasks(tasks, chat_eligible)

    from lm_eval.evaluator import simple_evaluate
    from lm_eval.tasks import TaskManager

    task_manager = TaskManager()  # build the task-yaml index once, reuse across every group below

    combined: dict = {"results": {}, "versions": {}, "n-shot": {}, "higher_is_better": {}}
    for (fewshot, chat), group_task_names in groups.items():
        print(f"[arena_en] running {group_task_names} num_fewshot={fewshot} chat_template={chat} limit={limit}")
        out = simple_evaluate(
            model=lm,
            tasks=group_task_names,
            num_fewshot=fewshot,
            limit=limit,
            apply_chat_template=chat,
            fewshot_as_multiturn=chat,
            log_samples=args.log_samples,
            task_manager=task_manager,
            random_seed=1234,
            numpy_random_seed=1234,
            torch_random_seed=1234,
            fewshot_random_seed=1234,
        )
        for key in ("results", "versions", "n-shot", "higher_is_better"):
            combined[key].update(out.get(key, {}))
        if args.log_samples:
            combined.setdefault("samples", {}).update(out.get("samples", {}))

    rows = build_rows(combined)
    table = render_table(rows, with_reference=True)
    print()
    print(table)

    out_path = args.out or os.path.join(REPO_ROOT, "results", f"{args.system}.json")
    if not os.path.isabs(out_path):
        out_path = os.path.join(REPO_ROOT, out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(combined, f, indent=2, default=str)
    print(f"\n[arena_en] wrote {out_path}")

    bench_md = args.bench_md if os.path.isabs(args.bench_md) else os.path.join(REPO_ROOT, args.bench_md)
    os.makedirs(os.path.dirname(bench_md), exist_ok=True)
    is_new = not os.path.exists(bench_md)
    with open(bench_md, "a", encoding="utf-8") as f:
        if is_new:
            f.write("# Arena (EN) — Ilaria vs. published BitNet b1.58 2B4T numbers\n\n"
                    f"Reference column: {REPORT_CITE}\n\n"
                    "Few-shot settings and generative chat-formatting are replicated from that report "
                    "(see docs/research/2026-09-24-arena-en-design.md). Each run below is appended, not overwritten.\n\n")
        date = datetime.date.today().isoformat()
        f.write(f"## {date} — {args.system}\n\n")
        f.write(f"Settings: `{settings_desc}`, tasks=`{','.join(tasks)}`, limit=`{limit}`\n\n")
        f.write(table)
        f.write("\n\n")
    print(f"[arena_en] appended results to {bench_md}")


if __name__ == "__main__":
    main()
