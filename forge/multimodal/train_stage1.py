"""forge/multimodal/train_stage1.py -- stage 1 of Ilaria's "eyes" (P3): train
ONLY vision_adapter.VisionAdapter's projector MLP. The SigLIP2 tower and the
BitNet LLM are both frozen (see mm_model.BitNetVLM). Docs: docs/research/
2026-09-24-ilaria-1.58-multimodal-studiu.md sections 4 and 6, plan step P3.

Colab commands (a 96 GB RTX PRO 6000; batch 32, shuffle 3 -> 121 img
tokens/sample; ~45-90 Colab units per the study's plan table P3 for the
projector-only stage):

    python forge/multimodal/train_stage1.py \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T \\
        --tower siglip2-base --shuffle-factor 3 --grid-policy pad \\
        --datasets localized_narratives,screen2words,textcaps --streaming \\
        --batch 32 --accum 4 --steps 20000 --warmup 500 --lr 3e-4 --min-lr 3e-5 \\
        --ckpt-every 500 --eval-every 500 --eval-samples 4 --log-every 20 \\
        --out /content/drive/MyDrive/ilaria/stage1_projector

    # resume (same flags, plus --resume):
    python forge/multimodal/train_stage1.py --resume /content/drive/MyDrive/ilaria/stage1_projector/checkpoint.pt \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T --out /content/drive/MyDrive/ilaria/stage1_projector \\
        --tower siglip2-base --shuffle-factor 3 --batch 32 --accum 4 --steps 20000 --lr 3e-4 --min-lr 3e-5

    # larger tower (SigLIP2-Large, closer to Qwen2-VL-2B's encoder size --
    # this is still stage 1, the projector-only alignment pass; the
    # heavier ~130-220 unit LoRA pass from the plan table is stage 2, not
    # implemented by this script):
    python forge/multimodal/train_stage1.py --tower siglip2-large ... (same flags as above)

PC smoke test (no download, no network, under a minute on a 6 GB GPU or CPU):

    python forge/multimodal/train_stage1.py --smoke
"""

from __future__ import annotations

import os

# transformers' BitNet quantization ops (WeightQuant/ActQuant/etc., used by
# EVERY AutoBitLinear forward -- offline or online, real checkpoint or the
# --smoke stand-in) are @torch.compile-decorated; the inductor backend tries
# to invoke a C compiler / Triton that is not set up on this machine and
# fails. Must be set before torch is imported anywhere in the process, same
# fix and same reasoning as forge/bitnet_reference.py's module docstring.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import argparse  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import (  # noqa: E402
    CAULDRON_CAPTION_SUBSETS, build_image_processor, iter_caption_samples,
    iter_tiny_synthetic, preprocess_images, tiny_pixel_values,
)
from mm_model import BitNetVLM, build_tiny_bitnet_llm, load_real_bitnet_llm  # noqa: E402
from vision_adapter import VisionAdapter, VisionAdapterConfig  # noqa: E402


def cosine_lr(step: int, warmup: int, total: int, peak: float, floor: float) -> float:
    if step < warmup:
        return peak * (step + 1) / max(1, warmup)
    p = min(1.0, (step - warmup) / max(1, total - warmup))
    return floor + 0.5 * (peak - floor) * (1 + math.cos(math.pi * p))


def cycle(factory):
    """factory: zero-arg callable returning a fresh iterator each call.
    Re-invokes it whenever the current pass runs out, so a finite (or
    streaming-but-eventually-exhausted) sample source can feed a
    step-count-based training loop indefinitely."""
    while True:
        produced = False
        for item in factory():
            produced = True
            yield item
        if not produced:
            raise RuntimeError("sample source produced zero samples")


def make_sample_source(args):
    if args.smoke:
        def factory():
            return iter_tiny_synthetic(image_size=64, max_samples=args.smoke_samples, seed=args.seed)
    else:
        subsets = args.datasets.split(",") if args.datasets else CAULDRON_CAPTION_SUBSETS

        def factory():
            return iter_caption_samples(subsets, split="train", streaming=args.streaming,
                                         max_samples=args.max_samples, seed=args.seed)
    return cycle(factory)


def build_models(args, device: str):
    llm_hidden = args.smoke_hidden if args.smoke else args.llm_hidden

    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.llm_dir)

    va_cfg = VisionAdapterConfig(
        tower="random-tiny" if args.smoke else args.tower,
        shuffle_factor=args.shuffle_factor, grid_policy=args.grid_policy,
        llm_hidden=llm_hidden, mlp_hidden=args.mlp_hidden,
    )
    vision_adapter = VisionAdapter(va_cfg)

    if args.smoke:
        llm, _ = build_tiny_bitnet_llm(hidden=llm_hidden, vocab=len(tokenizer),
                                        bos_id=tokenizer.bos_token_id, eos_id=tokenizer.eos_token_id)
    else:
        llm = load_real_bitnet_llm(args.llm_dir)

    vlm = BitNetVLM(llm, tokenizer, vision_adapter, max_text_len=args.max_text_len).to(device)

    # Frozen components go to bf16 to match the stage's target memory
    # profile (LLM ~5 GB instead of ~10 GB in fp32); the trainable projector
    # stays fp32 for optimizer stability, upcast/downcast on the fly by
    # autocast during the forward pass. Skipped for --smoke: the PC's GPU
    # (Turing, no native bf16 tensor cores) and CPU runs should stay boring
    # and fast rather than exercise Colab-only numerics.
    if device == "cuda" and not args.smoke:
        vlm.llm.to(torch.bfloat16)
        vlm.vision_adapter.tower.to(torch.bfloat16)

    return vlm, va_cfg


def save_checkpoint(path: str, vlm: BitNetVLM, opt, step: int, args) -> None:
    va = vlm.vision_adapter
    cfg = va.config.to_json()
    cfg.update({
        "image_size": va.image_size,
        "patch_size": va.patch_size,
        "vision_hidden": va.vision_hidden,
        "patch_grid_side": va.grid_side,
        "tokens_per_image": va.tokens_per_image,
    })
    torch.save({
        "projector": va.projector.state_dict(),
        "vision_adapter_config": cfg,
        "opt": opt.state_dict(),
        "step": step,
        "args": vars(args),
    }, path)


def load_checkpoint(path: str, vlm: BitNetVLM, opt, device: str) -> int:
    # weights_only=False: carries optimizer state + an argparse.Namespace,
    # not just tensors -- trusted input (this script's own checkpoint.pt).
    ck = torch.load(path, map_location=device, weights_only=False)
    vlm.vision_adapter.projector.load_state_dict(ck["projector"])
    if opt is not None and "opt" in ck:
        opt.load_state_dict(ck["opt"])
    return ck.get("step", 0)


def prepare_batch(vlm: BitNetVLM, samples: list, image_processor, device: str):
    images = [s["image"] for s in samples]
    prompts = [s["prompt"] for s in samples]
    answers = [s["answer"] for s in samples]
    if image_processor is not None:
        pixel_values = preprocess_images(image_processor, images)
    else:
        pixel_values = tiny_pixel_values(images, vlm.vision_adapter.image_size)
    return prompts, answers, pixel_values.to(device)


def run_eval_captions(vlm: BitNetVLM, samples: list, image_processor, device: str) -> list:
    vlm.eval()
    lines = []
    for s in samples:
        if image_processor is not None:
            pv = preprocess_images(image_processor, [s["image"]])[0]
        else:
            pv = tiny_pixel_values([s["image"]], vlm.vision_adapter.image_size)[0]
        pv = pv.to(device)
        cap = vlm.generate_caption(pv, prompt=s["prompt"])
        lines.append(f"  gt={s['answer']!r} pred={cap!r}")
    vlm.train()
    return lines


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    # model
    ap.add_argument("--llm-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--llm-hidden", type=int, default=2560)
    ap.add_argument("--tower", default="siglip2-base", choices=["siglip2-base", "siglip2-large", "random-tiny"])
    ap.add_argument("--shuffle-factor", type=int, default=3, choices=[2, 3])
    ap.add_argument("--grid-policy", default="pad", choices=["pad", "crop"])
    ap.add_argument("--mlp-hidden", type=int, default=0, help="0 -> defaults to --llm-hidden")
    ap.add_argument("--max-text-len", type=int, default=256)
    # data
    ap.add_argument("--datasets", default=",".join(CAULDRON_CAPTION_SUBSETS))
    ap.add_argument("--streaming", dest="streaming", action="store_true", default=True)
    ap.add_argument("--no-streaming", dest="streaming", action="store_false")
    ap.add_argument("--max-samples", type=int, default=None)
    # optim
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--steps", type=int, default=20000)
    ap.add_argument("--warmup", type=int, default=500)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--min-lr", type=float, default=3e-5)
    ap.add_argument("--wd", type=float, default=0.01)
    ap.add_argument("--grad-clip", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=42)
    # logging / checkpoints. NOTE: this PC's AGENTS.md forbids writes under
    # data/ -- the default below is a plain repo-relative dir for ad-hoc
    # local runs; --smoke ignores --out entirely and always writes to a
    # fresh OS temp dir (see main()). Colab runs always pass an explicit
    # --out (a Drive path, see the module docstring's command block).
    ap.add_argument("--out", default="stage1_out")
    ap.add_argument("--resume", default="")
    ap.add_argument("--log-every", type=int, default=20)
    ap.add_argument("--ckpt-every", type=int, default=500)
    ap.add_argument("--eval-every", type=int, default=500)
    ap.add_argument("--eval-samples", type=int, default=4)
    # smoke
    ap.add_argument("--smoke", action="store_true", help="5 steps on tiny_synthetic + a tiny stand-in LLM, no download")
    ap.add_argument("--smoke-steps", type=int, default=5)
    ap.add_argument("--smoke-hidden", type=int, default=64)
    ap.add_argument("--smoke-batch", type=int, default=2)
    ap.add_argument("--smoke-samples", type=int, default=32)
    return ap


def main() -> None:
    # Generated/decoded caption text can contain arbitrary Unicode (the
    # tokenizer's vocab is not ASCII-only); Windows consoles default to a
    # narrow codepage (e.g. cp1250) that raises on anything outside it.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    args = build_argparser().parse_args()

    if args.smoke:
        args.steps = args.smoke_steps
        args.batch = args.smoke_batch
        args.accum = 1
        args.warmup = 1
        args.ckpt_every = args.smoke_steps
        args.eval_every = args.smoke_steps
        args.eval_samples = min(args.eval_samples, 2)
        args.log_every = 1
        # Always a fresh OS temp dir -- never the repo (and never data/,
        # which this PC's AGENTS.md forbids writing under), regardless of
        # whatever --out the caller passed.
        args.out = tempfile.mkdtemp(prefix="ilaria_vlm_smoke_")
        args.streaming = False

    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(args.seed)
    os.makedirs(args.out, exist_ok=True)

    vlm, va_cfg = build_models(args, device)

    image_processor = None
    if not args.smoke:
        image_processor = build_image_processor(va_cfg.tower_repo())

    opt = torch.optim.AdamW(vlm.vision_adapter.trainable_parameters(), lr=args.lr,
                             betas=(0.9, 0.95), weight_decay=args.wd)
    n_trainable = sum(p.numel() for p in vlm.vision_adapter.trainable_parameters())
    print(f"[stage1] trainable params (projector only): {n_trainable / 1e6:.2f}M | "
          f"tower={va_cfg.tower} shuffle={va_cfg.shuffle_factor} policy={va_cfg.grid_policy} "
          f"tokens/img={vlm.vision_adapter.tokens_per_image} device={device} smoke={args.smoke}")

    start_step = 0
    if args.resume and os.path.exists(args.resume):
        start_step = load_checkpoint(args.resume, vlm, opt, device)
        print(f"[stage1] resumed from {args.resume} @ step {start_step}")

    use_amp = device == "cuda" and not args.smoke
    autocast_device = "cuda" if torch.cuda.is_available() else "cpu"

    sample_source = make_sample_source(args)
    held_out = None
    if args.smoke:
        held_out = list(iter_tiny_synthetic(image_size=64, max_samples=args.eval_samples, seed=args.seed + 999))

    t0 = time.time()
    imgs_seen = 0
    vlm.train()
    for step in range(start_step, args.steps):
        lr = cosine_lr(step, args.warmup, args.steps, args.lr, args.min_lr)
        for g in opt.param_groups:
            g["lr"] = lr
        opt.zero_grad(set_to_none=True)
        loss_acc = 0.0
        for _ in range(args.accum):
            samples = [next(sample_source) for _ in range(args.batch)]
            prompts, answers, pixel_values = prepare_batch(vlm, samples, image_processor, device)
            with torch.autocast(autocast_device, dtype=torch.bfloat16, enabled=use_amp):
                loss, _ = vlm(prompts, answers, pixel_values)
                loss = loss / args.accum
            loss.backward()
            loss_acc += loss.item()
            imgs_seen += len(samples)

        gn = torch.nn.utils.clip_grad_norm_(vlm.vision_adapter.trainable_parameters(), args.grad_clip)
        opt.step()

        if step % args.log_every == 0:
            el = time.time() - t0
            print(f"step {step:6d} | loss {loss_acc:.4f} | lr {lr:.2e} | gn {gn:.2f} | "
                  f"{imgs_seen / max(el, 1e-9):,.1f} img/s | {el / 60:.1f} min")

        if (step + 1) % args.ckpt_every == 0 or step + 1 == args.steps:
            ckpt_path = os.path.join(args.out, "checkpoint.pt")
            save_checkpoint(ckpt_path, vlm, opt, step + 1, args)
            print(f"[stage1] checkpoint saved @ step {step + 1} -> {ckpt_path}")

        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            eval_pool = held_out if args.smoke else [next(sample_source) for _ in range(args.eval_samples)]
            print(f"[eval] step {step + 1}:")
            try:
                for line in run_eval_captions(vlm, eval_pool, image_processor, device):
                    print(line)
            except Exception as e:  # monitoring must never kill a multi-hour run
                print(f"[eval] skipped: {type(e).__name__}: {e}")

    print(f"[stage1] DONE @ step {args.steps} -> {args.out}/checkpoint.pt")


if __name__ == "__main__":
    main()
