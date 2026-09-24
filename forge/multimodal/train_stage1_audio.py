"""forge/multimodal/train_stage1_audio.py -- stage 1 of Ilaria's "ears" (P4):
train ONLY audio_adapter.AudioAdapter's projector MLP. The Whisper encoder
and the BitNet LLM are both frozen (see mm_model.BitNetVLM, generalized for
this file's AudioAdapter the same way it already served
vision_adapter.VisionAdapter -- see mm_model.py's module docstring). Docs:
docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md section 4 "Audio",
plan step P4. Mirrors train_stage1.py's shape as closely as the audio
modality allows (same CLI groups, --smoke design, cosine LR/cycle reused
directly from train_stage1.py, checkpoint/resume, non-fatal eval).

Colab commands (budget: the study's own plan table gives P4 "Whisper-small +
proiector stack-and-project pe LibriSpeech + Common Voice" as ~90 Colab
units -- this is the SAME order-of-magnitude budget train_stage1.py's own
docstring quotes for the vision projector stage (~45-90 units), and for a
comparable reason: only the projector trains, the frozen encoder forward
runs under torch.no_grad(), and a stacked audio clip contributes at most
ceil(1500/8)=188 tokens (whisper-small's full 30 s window) to the frozen
LLM's forward/backward -- fewer than vision's 121 img tokens/sample only in
the best case (most LibriSpeech/AudioCaps clips are well under 30 s, so
usually far fewer); ~90 units is this doc's own honest ESTIMATE, not a
measured number -- nothing here has run on a real GPU yet):

    python forge/multimodal/train_stage1_audio.py \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T \\
        --encoder whisper-small --stack 8 \\
        --batch 16 --accum 4 --steps 2000 --warmup 100 --lr 3e-4 --min-lr 3e-5 \\
        --ckpt-every 250 --eval-every 250 --eval-samples 4 --log-every 20 \\
        --out /content/drive/MyDrive/ilaria/stage1_audio

    # resume (same flags, plus --resume):
    python forge/multimodal/train_stage1_audio.py --resume /content/drive/MyDrive/ilaria/stage1_audio/checkpoint.pt \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T --out /content/drive/MyDrive/ilaria/stage1_audio \\
        --encoder whisper-small --batch 16 --accum 4 --steps 2000 --lr 3e-4 --min-lr 3e-5

    # larger/smaller encoder:
    python forge/multimodal/train_stage1_audio.py --encoder whisper-base ... (same flags as above)

PC smoke test (no download, no network, under a minute on a 6 GB GPU or CPU):

    python forge/multimodal/train_stage1_audio.py --smoke
"""

from __future__ import annotations

import os

# transformers' BitNet quantization ops (WeightQuant/ActQuant/etc., used by
# EVERY AutoBitLinear forward -- offline or online, real checkpoint or the
# --smoke stand-in) are @torch.compile-decorated; the inductor backend tries
# to invoke a C compiler / Triton that is not set up on this machine and
# fails. Must be set before torch is imported anywhere in the process, same
# fix and same reasoning as forge/bitnet_reference.py's / train_stage1.py's
# module docstrings.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import argparse  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data_audio  # noqa: E402
from audio_adapter import AudioAdapter, AudioAdapterConfig  # noqa: E402
from mm_model import AUDIO_PLACEHOLDER, BitNetVLM, build_tiny_bitnet_llm, load_real_bitnet_llm  # noqa: E402
from train_stage1 import cosine_lr, cycle  # noqa: E402


def make_sample_source(args):
    if args.smoke:
        def factory():
            return data_audio.iter_tiny_synthetic_audio(sample_rate=16000, duration_s=1.0,
                                                          max_samples=args.smoke_samples, seed=args.seed)
    else:
        def factory():
            return data_audio.iter_audio_samples(
                config=args.librispeech_config, split=args.librispeech_split, caption_split=args.caption_split,
                streaming=args.streaming, max_samples=args.max_samples, seed=args.seed,
                include_captions=args.include_captions,
            )
    return cycle(factory)


def build_models(args, device: str):
    llm_hidden = args.smoke_hidden if args.smoke else args.llm_hidden

    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.llm_dir)

    aa_cfg = AudioAdapterConfig(
        encoder="random-tiny" if args.smoke else args.encoder,
        stack_factor=args.stack_factor, llm_hidden=llm_hidden, mlp_hidden=args.mlp_hidden,
    )
    audio_adapter = AudioAdapter(aa_cfg)

    if args.smoke:
        llm, _ = build_tiny_bitnet_llm(hidden=llm_hidden, vocab=len(tokenizer),
                                        bos_id=tokenizer.bos_token_id, eos_id=tokenizer.eos_token_id)
    else:
        llm = load_real_bitnet_llm(args.llm_dir)

    vlm = BitNetVLM(llm, tokenizer, audio_adapter, max_text_len=args.max_text_len,
                     placeholder=AUDIO_PLACEHOLDER).to(device)

    # Frozen components go to bf16 to match the stage's target memory
    # profile, same reasoning/skip-on-smoke policy as train_stage1.py's
    # build_models (Turing GPUs / CPU stay boring fp32).
    if device == "cuda" and not args.smoke:
        vlm.llm.to(torch.bfloat16)
        vlm.adapter.encoder.to(torch.bfloat16)

    return vlm, aa_cfg


def save_checkpoint(path: str, vlm: BitNetVLM, opt, step: int, args) -> None:
    aa = vlm.adapter
    cfg = aa.config.to_json()
    cfg.update({
        "audio_hidden": aa.audio_hidden,
        "max_encoder_frames": aa.max_encoder_frames,
        "sampling_rate": aa.sampling_rate,
    })
    torch.save({
        "projector": aa.projector.state_dict(),
        "audio_adapter_config": cfg,
        "opt": opt.state_dict(),
        "step": step,
        "args": vars(args),
    }, path)


def load_checkpoint(path: str, vlm: BitNetVLM, opt, device: str) -> int:
    # weights_only=False: carries optimizer state + an argparse.Namespace,
    # not just tensors -- trusted input (this script's own checkpoint.pt).
    ck = torch.load(path, map_location=device, weights_only=False)
    vlm.adapter.projector.load_state_dict(ck["projector"])
    if opt is not None and "opt" in ck:
        opt.load_state_dict(ck["opt"])
    return ck.get("step", 0)


def prepare_batch(vlm: BitNetVLM, samples: list, device: str):
    waveforms = [s["audio"] for s in samples]
    prompts = [s["prompt"] for s in samples]
    answers = [s["answer"] for s in samples]
    input_features, num_frames = vlm.adapter.prepare_features(waveforms, sampling_rate=data_audio.TARGET_SAMPLE_RATE)
    return prompts, answers, (input_features.to(device), num_frames.to(device))


def run_eval_transcripts(vlm: BitNetVLM, samples: list, device: str) -> list:
    vlm.eval()
    lines = []
    for s in samples:
        input_features, num_frames = vlm.adapter.prepare_features([s["audio"]], sampling_rate=data_audio.TARGET_SAMPLE_RATE)
        features_1 = (input_features.to(device), num_frames.to(device))
        pred = vlm.generate_from_features(features_1, prompt=s["prompt"])
        lines.append(f"  gt={s['answer']!r} pred={pred!r}")
    vlm.train()
    return lines


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    # model
    ap.add_argument("--llm-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--llm-hidden", type=int, default=2560)
    ap.add_argument("--encoder", default="whisper-small",
                     help="'whisper-small' | 'whisper-base' | 'random-tiny' | any HF WhisperModel repo id or "
                          "local snapshot_download dir (e.g. a pre-downloaded /content/whisper-small on Colab)")
    ap.add_argument("--stack", type=int, default=8, dest="stack_factor")
    ap.add_argument("--mlp-hidden", type=int, default=0, help="0 -> defaults to --llm-hidden")
    ap.add_argument("--max-text-len", type=int, default=256)
    # data
    ap.add_argument("--librispeech-config", default="clean")
    ap.add_argument("--librispeech-split", default="train.100")
    ap.add_argument("--caption-split", default="train")
    ap.add_argument("--no-captions", dest="include_captions", action="store_false", default=True,
                     help="drop AudioCaps (CC-BY-NC-4.0) from the mixture, train on LibriSpeech alone")
    ap.add_argument("--streaming", dest="streaming", action="store_true", default=True)
    ap.add_argument("--no-streaming", dest="streaming", action="store_false")
    ap.add_argument("--max-samples", type=int, default=None)
    # optim
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--warmup", type=int, default=100)
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
    ap.add_argument("--out", default="stage1_audio_out")
    ap.add_argument("--resume", default="")
    ap.add_argument("--log-every", type=int, default=20)
    ap.add_argument("--ckpt-every", type=int, default=250)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--eval-samples", type=int, default=4)
    # smoke
    ap.add_argument("--smoke", action="store_true", help="5 steps on tiny_synthetic_audio + a tiny stand-in LLM, no download")
    ap.add_argument("--smoke-steps", type=int, default=5)
    ap.add_argument("--smoke-hidden", type=int, default=64)
    ap.add_argument("--smoke-batch", type=int, default=2)
    ap.add_argument("--smoke-samples", type=int, default=32)
    return ap


def main() -> None:
    # Generated/decoded transcript text can contain arbitrary Unicode;
    # Windows consoles default to a narrow codepage (e.g. cp1250) that
    # raises on anything outside it -- same fix as train_stage1.py's main().
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
        args.out = tempfile.mkdtemp(prefix="ilaria_vlm_audio_smoke_")
        args.streaming = False

    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(args.seed)
    os.makedirs(args.out, exist_ok=True)

    vlm, aa_cfg = build_models(args, device)

    opt = torch.optim.AdamW(vlm.adapter.trainable_parameters(), lr=args.lr,
                             betas=(0.9, 0.95), weight_decay=args.wd)
    n_trainable = sum(p.numel() for p in vlm.adapter.trainable_parameters())
    print(f"[stage1-audio] trainable params (projector only): {n_trainable / 1e6:.2f}M | "
          f"encoder={aa_cfg.encoder} stack={aa_cfg.stack_factor} audio_hidden={vlm.adapter.audio_hidden} "
          f"max_encoder_frames={vlm.adapter.max_encoder_frames} device={device} smoke={args.smoke}")

    start_step = 0
    if args.resume and os.path.exists(args.resume):
        start_step = load_checkpoint(args.resume, vlm, opt, device)
        print(f"[stage1-audio] resumed from {args.resume} @ step {start_step}")

    use_amp = device == "cuda" and not args.smoke
    autocast_device = "cuda" if torch.cuda.is_available() else "cpu"

    sample_source = make_sample_source(args)
    held_out = None
    if args.smoke:
        held_out = list(data_audio.iter_tiny_synthetic_audio(sample_rate=16000, duration_s=1.0,
                                                               max_samples=args.eval_samples, seed=args.seed + 999))

    t0 = time.time()
    audio_seconds_seen = 0.0
    vlm.train()
    for step in range(start_step, args.steps):
        lr = cosine_lr(step, args.warmup, args.steps, args.lr, args.min_lr)
        for g in opt.param_groups:
            g["lr"] = lr
        opt.zero_grad(set_to_none=True)
        loss_acc = 0.0
        for _ in range(args.accum):
            samples = [next(sample_source) for _ in range(args.batch)]
            prompts, answers, features = prepare_batch(vlm, samples, device)
            with torch.autocast(autocast_device, dtype=torch.bfloat16, enabled=use_amp):
                loss, _ = vlm(prompts, answers, features)
                loss = loss / args.accum
            loss.backward()
            loss_acc += loss.item()
            audio_seconds_seen += sum(len(s["audio"]) / s["sampling_rate"] for s in samples)

        gn = torch.nn.utils.clip_grad_norm_(vlm.adapter.trainable_parameters(), args.grad_clip)
        opt.step()

        if step % args.log_every == 0:
            el = time.time() - t0
            print(f"step {step:6d} | loss {loss_acc:.4f} | lr {lr:.2e} | gn {gn:.2f} | "
                  f"{audio_seconds_seen / max(el, 1e-9):,.2f} audio-s/s | {el / 60:.1f} min")

        if (step + 1) % args.ckpt_every == 0 or step + 1 == args.steps:
            ckpt_path = os.path.join(args.out, "checkpoint.pt")
            save_checkpoint(ckpt_path, vlm, opt, step + 1, args)
            print(f"[stage1-audio] checkpoint saved @ step {step + 1} -> {ckpt_path}")

        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            eval_pool = held_out if args.smoke else [next(sample_source) for _ in range(args.eval_samples)]
            print(f"[eval] step {step + 1}:")
            try:
                for line in run_eval_transcripts(vlm, eval_pool, device):
                    print(line)
            except Exception as e:  # monitoring must never kill a multi-hour run
                print(f"[eval] skipped: {type(e).__name__}: {e}")

    print(f"[stage1-audio] DONE @ step {args.steps} -> {args.out}/checkpoint.pt")


if __name__ == "__main__":
    main()
