"""English-first BitNet LoRA SFT; single GPU or torchrun DDP.

Requires curated --train/--validation JSONL, a local --llm-dir, and an empty
output directory (or explicit --resume). No corpus or model downloads.
Validation measures assistant-token loss per language, NOT task success.
"""
import os
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).parent / "multimodal"))
if __package__:
    from .tool_data import load_trajectories, validate_splits, encode_trajectory, ENCODING_VERSION
else:
    from tool_data import load_trajectories, validate_splits, encode_trajectory, ENCODING_VERSION


def initialize_adapter(base, prefix, lb, expected_kind, rank, alpha):
    """Warm start weights only, with strict export validation and provenance."""
    import torch
    from safetensors.torch import load_file
    meta_path, weights_path = Path(prefix + ".json"), Path(prefix + ".safetensors")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("base", {}).get("kind") != expected_kind:
        raise ValueError("initial adapter base kind differs")
    cfg = meta.get("lora", {})
    modules = lb.lora_modules(base)
    if (cfg.get("r"), cfg.get("alpha"), cfg.get("scaling"), cfg.get("n_modules")) != (rank, alpha, alpha / rank, len(modules)):
        raise ValueError("initial adapter LoRA configuration differs")
    tensors = load_file(str(weights_path), device="cpu")
    expected = {lb.export_key(name) + "." + key for name in modules for key in ("A", "B")}
    if set(tensors) != expected:
        raise ValueError("initial adapter tensor keys differ")
    state = {}
    for name, module in modules.items():
        state[name] = {}
        for key, parameter in (("A", module.lora_A), ("B", module.lora_B)):
            value = tensors[lb.export_key(name) + "." + key]
            if value.shape != parameter.shape or not torch.isfinite(value).all():
                raise ValueError("invalid initial adapter tensor: " + name + "." + key)
            state[name][key] = value
    lb.load_lora_state_dict(base, state)
    return {"weights_sha256": hashlib.sha256(weights_path.read_bytes()).hexdigest(),
            "metadata_sha256": hashlib.sha256(meta_path.read_bytes()).hexdigest()}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--train", required=True)
    p.add_argument("--validation", required=True)
    p.add_argument("--languages", default="en")
    p.add_argument("--llm-dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--init-adapter", help="Export prefix for a new training stage; fresh optimizer, not exact resume")
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--accum", type=int, default=8)
    p.add_argument("--max-length", type=int, default=2048)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--alpha", type=int, default=32)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--checkpoint-every", type=int, default=100)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--gradient-checkpointing", action="store_true")
    p.add_argument("--max-runtime-minutes", type=float, default=0, help="Soft training-loop limit; checkpoint and validation take additional time")
    p.add_argument("--log-every", type=int, default=10)
    p.add_argument("--validate-only", action="store_true")
    p.add_argument("--smoke", action="store_true", help="Tiny random CPU model; checks plumbing only, never production weights")
    args = p.parse_args()
    for field in ("steps", "batch", "accum", "max_length", "rank", "alpha", "checkpoint_every"):
        if getattr(args, field) < 1:
            p.error(f"{field} must be positive")
    if not math.isfinite(args.lr) or args.lr <= 0:
        p.error("lr must be finite and positive")
    if not math.isfinite(args.max_runtime_minutes) or args.max_runtime_minutes < 0 or args.log_every < 1:
        p.error("runtime limit must be nonnegative and log-every positive")
    languages = tuple(args.languages.split(","))
    train = load_trajectories(args.train, languages)
    validation = load_trajectories(args.validation, languages)
    counts = validate_splits(train, validation)
    print(json.dumps(counts, sort_keys=True))
    if args.validate_only:
        return
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    import torch.distributed as dist
    from torch.nn.parallel import DistributedDataParallel
    from torch.utils.data import DataLoader, DistributedSampler
    from transformers import AutoTokenizer
    from safetensors.torch import save_file
    import lora_bitlinear as lb

    world = int(os.environ.get("WORLD_SIZE", "1"))
    rank = int(os.environ.get("RANK", "0"))
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    cuda = torch.cuda.is_available() and not args.smoke
    device = torch.device("cuda", local_rank) if cuda else torch.device("cpu")
    if cuda:
        torch.cuda.set_device(local_rank)
    if world > 1:
        dist.init_process_group("nccl" if cuda and os.name != "nt" else "gloo")
    try:
        torch.manual_seed(args.seed)
        if args.smoke:
            class TinyTokenizer:
                eos_token_id = 1
                def encode(self, text, add_special_tokens=False):
                    return [2 + (ord(c) % 60) for c in text]
            tokenizer = TinyTokenizer()
        else:
            tokenizer = AutoTokenizer.from_pretrained(args.llm_dir, local_files_only=True)
        encoded = [encode_trajectory(r, tokenizer, args.max_length) for r in train]
        evaluated = [encode_trajectory(r, tokenizer, args.max_length) for r in validation]
        if args.smoke:
            from mm_model import build_tiny_bitnet_llm
            base, _ = build_tiny_bitnet_llm(16, 64, 0, 1, layers=1, heads=2, kv_heads=1, ffn=32, max_pos=args.max_length)
            base.requires_grad_(False)
        else:
            base = lb.load_frozen_base("offline", args.llm_dir)
        base = base.to(device)
        params = lb.inject_lora(base, r=args.rank, alpha=args.alpha, dropout=0.05)
        base.to(device)
        initialization = None
        if args.init_adapter:
            initialization = initialize_adapter(base, args.init_adapter, lb,
                "smoke" if args.smoke else "offline", args.rank, args.alpha)
        base.config.use_cache = False
        if args.gradient_checkpointing:
            base.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model = DistributedDataParallel(base, device_ids=[local_rank] if cuda else None) if world > 1 else base
        opt = torch.optim.AdamW(params, lr=args.lr)
        dtype = torch.bfloat16 if cuda and torch.cuda.is_bf16_supported() else torch.float16
        scaler = torch.amp.GradScaler("cuda", enabled=cuda and dtype == torch.float16)
        pad = tokenizer.eos_token_id
        if pad is None:
            raise ValueError("tokenizer requires an EOS token")

        def collate(rows):
            n = max(len(r["input_ids"]) for r in rows)
            return {
                "input_ids": torch.tensor([r["input_ids"] + [pad] * (n - len(r["input_ids"])) for r in rows], device=device),
                "labels": torch.tensor([r["labels"] + [-100] * (n - len(r["labels"])) for r in rows], device=device),
                "attention_mask": torch.tensor([[1] * len(r["input_ids"]) + [0] * (n - len(r["input_ids"])) for r in rows], device=device),
            }

        signature = hashlib.sha256(json.dumps({"train": train, "validation": validation}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        contract = {k: getattr(args, k) for k in ("llm_dir", "languages", "batch", "accum", "max_length", "rank", "alpha", "lr", "seed", "steps")}
        contract.update(dataset_sha256=signature, world_size=world, smoke=args.smoke)
        contract["gradient_checkpointing"] = args.gradient_checkpointing
        contract["encoding_version"] = ENCODING_VERSION
        if initialization is not None:
            contract["initial_adapter"] = initialization
        out = Path(args.out)
        checkpoint = out / "checkpoint.pt"
        start = 0
        if args.resume:
            ck = torch.load(checkpoint, map_location="cpu", weights_only=False)
            if ck["contract"] != contract:
                raise ValueError("resume contract differs: dataset/model/training settings must match")
            lb.load_lora_state_dict(base, ck["lora"])
            opt.load_state_dict(ck["optimizer"])
            scaler.load_state_dict(ck["scaler"])
            torch.set_rng_state(ck["rng"][rank]["cpu"])
            if cuda:
                torch.cuda.set_rng_state(ck["rng"][rank]["cuda"], device)
            start = ck["step"]
        elif out.exists() and any(out.iterdir()):
            raise ValueError("output directory is not empty; use --resume or a new directory")
        out.mkdir(parents=True, exist_ok=True)
        def evaluate():
            base.eval()
            sums = {lang: [0.0, 0] for lang in languages}
            with torch.no_grad():
                for row in evaluated:
                    batch = collate([row])
                    with torch.autocast(device.type, dtype=dtype, enabled=cuda):
                        value = base(**batch).loss.item()
                    if not math.isfinite(value):
                        raise ValueError("nonfinite validation loss")
                    count = int((batch["labels"][:, 1:] != -100).sum())
                    sums[row["language"]][0] += value * count
                    sums[row["language"]][1] += count
            base.train()
            return {lang: total / n for lang, (total, n) in sums.items() if n}

        if not args.resume and rank == 0:
            baseline = evaluate()
            (out / "baseline.json").write_text(json.dumps(baseline, indent=2), encoding="utf-8")
            print(json.dumps({"step": 0, "validation_assistant_loss": baseline}), flush=True)
        if world > 1:
            dist.barrier()
        sampler = DistributedSampler(encoded, num_replicas=world, rank=rank, seed=args.seed)
        loader = DataLoader(encoded, batch_size=args.batch, sampler=sampler, collate_fn=collate,
                            generator=torch.Generator().manual_seed(args.seed))
        micro = start * args.accum
        epoch, offset = divmod(micro, len(loader))
        sampler.set_epoch(epoch)
        iterator = iter(loader)
        for _ in range(offset):
            next(iterator)
        model.train()
        started_at = time.monotonic()
        for step in range(start, args.steps):
            opt.zero_grad(set_to_none=True)
            for _ in range(args.accum):
                try:
                    batch = next(iterator)
                except StopIteration:
                    epoch += 1
                    sampler.set_epoch(epoch)
                    iterator = iter(loader)
                    batch = next(iterator)
                with torch.autocast(device.type, dtype=dtype, enabled=cuda):
                    loss = model(**batch).loss / args.accum
                if not torch.isfinite(loss):
                    raise ValueError("nonfinite training loss")
                scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(params, 1.0, error_if_nonfinite=True)
            scaler.step(opt)
            scaler.update()
            elapsed = time.monotonic() - started_at
            stop = torch.tensor(int(rank == 0 and args.max_runtime_minutes > 0 and elapsed >= args.max_runtime_minutes * 60), device=device)
            if world > 1:
                dist.broadcast(stop, src=0)
            stopping = bool(stop.item())
            if rank == 0 and (step + 1) % args.log_every == 0:
                print(json.dumps({"step": step + 1, "elapsed_seconds": elapsed,
                    "seconds_per_step": elapsed / (step + 1 - start),
                    "peak_gpu_gb": torch.cuda.max_memory_allocated(device) / 1e9 if cuda else 0}), flush=True)
            if (step + 1) % args.checkpoint_every and step + 1 != args.steps and not stopping:
                continue
            rng = {"cpu": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state(device) if cuda else None}
            states = [None] * world
            if world > 1:
                dist.all_gather_object(states, rng)
            else:
                states[0] = rng
            if rank == 0:
                metrics = evaluate()
                print(json.dumps({"step": step + 1, "validation_assistant_loss": metrics}))
                payload = {"step": step + 1, "lora": lb.lora_state_dict(base), "optimizer": opt.state_dict(),
                           "scaler": scaler.state_dict(), "rng": states, "contract": contract, "metrics": metrics}
                torch.save(payload, out / "checkpoint.tmp")
                os.replace(out / "checkpoint.tmp", checkpoint)
                tensors = {}
                for name, entry in payload["lora"].items():
                    for key in ("A", "B"):
                        tensors[lb.export_key(name) + "." + key] = entry[key].detach().cpu().float().contiguous()
                # Immutable step exports avoid mismatched sidecar/weights after interruption.
                prefix = out / f"adapter-step{step + 1}"
                save_file(tensors, str(prefix) + ".safetensors")
                meta = {"base": {"kind": "smoke" if args.smoke else "offline"}, "lora": {"r": args.rank, "alpha": args.alpha,
                        "scaling": args.alpha / args.rank, "n_modules": len(payload["lora"])}, "languages": languages,
                        "contract": contract, "validation_assistant_loss": metrics}
                Path(str(prefix) + ".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.train()
            if world > 1:
                dist.barrier()
            if stopping:
                break
    finally:
        if world > 1 and dist.is_initialized():
            dist.destroy_process_group()


if __name__ == "__main__":
    main()
