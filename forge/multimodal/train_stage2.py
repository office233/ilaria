"""forge/multimodal/train_stage2.py -- stage 2 of Ilaria's "eyes" (P3):
INSTRUCTION-TUNE the vision-language model so it can answer questions about
images (VQA, OCR/documents, charts, multi-turn) instead of only captioning
them (stage 1's job, train_stage1.py). Trains two things together:

  (a) LoRA adapters (lora_bitlinear.LoRABitLinear) injected into the frozen
      BitNet LLM's 7 per-layer projections (q/k/v/o/gate/up/down_proj).
  (b) The SAME vision_adapter.VisionAdapter projector MLP stage 1 trained,
      now INITIALIZED from stage 1's export (--adapter-init) and kept
      TRAINABLE (stage 1 trained it from scratch and froze nothing that
      wasn't already frozen; stage 2 just keeps training it further,
      jointly with the new LoRA adapters).

The SigLIP2 tower stays frozen throughout, unchanged from stage 1
(VisionAdapterConfig.freeze_tower). Docs: docs/research/
2026-09-24-ilaria-1.58-multimodal-studiu.md sections 4 and 6 (plan step P3,
"stage 2: LoRA on FineVision (1-2M samples), ~130-220 Colab units").

This file imports (never modifies) mm_model.BitNetVLM, vision_adapter.
VisionAdapter/VisionAdapterConfig, data.py's image-preprocessing helpers,
train_stage1.py's cosine_lr/cycle, lora_bitlinear.py's LoRA machinery, and
data_instruct.py's stage-2 datasets.

BitNetVLMStage2 (below) subclasses BitNetVLM rather than editing it, for two
reasons specific to stage 2:

  1. BitNetVLM.__init__ freezes EVERY parameter under `self.llm` (correct
     for stage 1, where the LLM had no trainable parameters at all) -- but
     stage 2 injects LoRA into `llm` BEFORE constructing the VLM wrapper
     precisely so that freeze loop also (harmlessly) touches the freshly
     created lora_A/lora_B parameters; the subclass's __init__ then
     re-enables `requires_grad` on exactly those two tensors per
     LoRABitLinear, leaving every genuine base weight frozen.
  2. BitNetVLM.train() unconditionally forces `self.llm.eval()` ("no
     dropout drift in a model we never update") -- true for stage 1, false
     for stage 2 (LoRA's own dropout needs real train()/eval() toggling).
     The subclass's train() bypasses that override.

Multi-turn, multi-image (cap 2) samples: BitNetVLM's own `build_sample` only
ever handles one (prompt, answer) pair with one image, spliced via
`_prefix_embeds`/`_split_prompt` (which only look for a SINGLE `<image>`
marker). This subclass adds `build_multiturn_sample` (reusing the parent's
`_encode_text`/`_embed_ids`/`encode_images`/`embed_tokens`/`eot_id` --
regular, non-mangled methods, safe to call from a subclass) rather than
patching those private helpers to handle N markers -- see that method's
docstring for the exact chat-template splicing (all `<image>` markers go on
the FIRST turn only, one per image, in order; every turn after that is
plain "User: ...<|eot_id|>Assistant: ...<|eot_id|>" text with loss on the
answer span, same as stage 1's template).

PC smoke test (no download, no network, tiny random LLM + tiny tower +
tiny_synthetic_vqa, a couple of minutes on a 6 GB GPU or CPU):

    python forge/multimodal/train_stage2.py --smoke

Colab command (96 GB GPU; batch 16, accum 4 -> effective batch 64, ~6000
steps per the plan table's ~130-220-unit stage-2 budget; LoRA r=16 alpha=32
on all 7 projections x 30 layers = 210 adapters, ~1.3M trainable LoRA params
+ ~26M trainable projector params -- both tiny next to the 2.4B frozen base,
so optimizer state and activations dominate memory, not parameters; with
--grad-checkpoint, a 96 GB GPU has ample headroom for batch 16 at ~1-2K text
tokens + 2x121 image tokens per sample):

    python forge/multimodal/train_stage2.py \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T --base offline \\
        --adapter-init /content/drive/MyDrive/ilaria/stage1_projector/adapter_export \\
        --source finevision --datasets vqav2,textvqa,docvqa,chartqa,"sharegpt4v(llava)",ai2d_merged \\
        --text-ratio 0.1 --max-images 2 --max-turns 4 \\
        --lora-targets q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj --lora-r 16 --lora-alpha 32 --lora-dropout 0.05 \\
        --batch 16 --accum 4 --steps 6000 --warmup 200 \\
        --lr-projector 5e-5 --min-lr-projector 5e-6 --lr-lora 1e-4 --min-lr-lora 1e-5 \\
        --grad-checkpoint --ckpt-every 500 --eval-every 250 --eval-samples 4 --log-every 20 \\
        --out /content/drive/MyDrive/ilaria/stage2_instruct

    # resume (same flags, plus --resume):
    python forge/multimodal/train_stage2.py --resume /content/drive/MyDrive/ilaria/stage2_instruct/checkpoint.pt \\
        --llm-dir /content/drive/MyDrive/ilaria/bitnet-b1.58-2B-4T --base offline \\
        --adapter-init /content/drive/MyDrive/ilaria/stage1_projector/adapter_export \\
        --out /content/drive/MyDrive/ilaria/stage2_instruct \\
        --batch 16 --accum 4 --steps 6000 --lora-r 16 --lora-alpha 32
"""

from __future__ import annotations

import os

# Must be set before torch is imported anywhere in the process -- see
# forge/bitnet_reference.py's module docstring (transformers' BitNet
# quantization ops are @torch.compile-decorated; the inductor backend
# fails on this machine for lack of a working C compiler / Triton).
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

import torch  # noqa: E402
import torch.nn as nn  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import data_instruct  # noqa: E402
import lora_bitlinear  # noqa: E402
from data import build_image_processor, preprocess_images, tiny_pixel_values  # noqa: E402
from mm_model import IMAGE_PLACEHOLDER, BitNetVLM, build_tiny_bitnet_llm, pad_and_stack  # noqa: E402
from train_stage1 import cosine_lr, cycle  # noqa: E402
from vision_adapter import VisionAdapter, VisionAdapterConfig  # noqa: E402


# ---------------------------------------------------------------------------
# BitNetVLMStage2 -- subclass, not a stage-1 edit (see module docstring)
# ---------------------------------------------------------------------------

class BitNetVLMStage2(BitNetVLM):
    def __init__(self, llm, tokenizer, vision_adapter, max_text_len: int = 256):
        super().__init__(llm, tokenizer, vision_adapter, max_text_len=max_text_len)
        # super().__init__() just froze EVERY llm parameter, including any
        # LoRABitLinear.lora_A/lora_B the caller already injected into
        # `llm` before constructing this class -- undo that for LoRA
        # params only (the wrapped base AutoBitLinear weights stay frozen).
        n = 0
        for mod in self.llm.modules():
            if isinstance(mod, lora_bitlinear.LoRABitLinear):
                mod.lora_A.requires_grad_(True)
                mod.lora_B.requires_grad_(True)
                n += 1
        self.n_lora_modules = n

    def train(self, mode: bool = True):
        # Bypass BitNetVLM.train()'s "always eval()" override (correct for
        # stage 1's fully-frozen LLM, wrong here: LoRA's own dropout needs
        # real train()/eval() toggling). VisionAdapter.train() still forces
        # its own frozen tower to eval() regardless -- untouched, unrelated.
        nn.Module.train(self, mode)
        return self

    def _embed_with_images(self, text: str, img_embeds: torch.Tensor) -> torch.Tensor:
        """`text` must contain exactly `img_embeds.shape[0]` occurrences of
        IMAGE_PLACEHOLDER; splits around them and splices each image's
        token block in place -- the N-image generalization of BitNetVLM.
        _prefix_embeds's single-marker splice (stage 1 only ever spliced
        one image)."""
        n_img = img_embeds.shape[0]
        parts = text.split(IMAGE_PLACEHOLDER)
        if len(parts) != n_img + 1:
            raise ValueError(f"expected {n_img} {IMAGE_PLACEHOLDER!r} marker(s) in {text!r}, found {len(parts) - 1}")
        pieces = []
        for i, part in enumerate(parts):
            pieces.append(self._embed_ids(self._encode_text(part), img_embeds))
            if i < n_img:
                pieces.append(img_embeds[i])
        return torch.cat(pieces, dim=0)

    def build_multiturn_sample(self, pixel_values_i: torch.Tensor, turns: list):
        """pixel_values_i: [n_img,3,H,W] (n_img in {0,1,2}, data_instruct.py
        caps at 2) for ONE sample. turns: list of (user, answer) str pairs,
        already `<image>`-marker-free (data_instruct.py strips any literal
        marker text a source dataset happens to carry) -- this method is the
        one that inserts the markers, ALL up front on the FIRST turn only
        (n_img markers, one per image, in order), matching data.py's stage-1
        convention of prepending the marker when a sample's own prompt
        doesn't already carry one. Returns (inputs_embeds [T,H], labels [T])
        with -100 everywhere except every turn's answer span -- the
        multi-turn generalization of BitNetVLM.build_sample's single-turn
        labelling."""
        if not turns:
            raise ValueError("build_multiturn_sample: turns must be non-empty")
        n_img = pixel_values_i.shape[0]
        img_embeds = self.encode_images(pixel_values_i) if n_img else None
        like = self.embed_tokens.weight

        emb_chunks, lab_chunks = [], []
        for i, (user, answer) in enumerate(turns):
            marker_prefix = IMAGE_PLACEHOLDER * n_img if i == 0 else ""
            header_text = f"User: {marker_prefix}{user}"
            if i == 0 and n_img:
                header_emb = self._embed_with_images(header_text, img_embeds)
            else:
                header_emb = self._embed_ids(self._encode_text(header_text), like)
            tail_emb = self._embed_ids(self._encode_text("<|eot_id|>Assistant: "), like)
            answer_ids = self._encode_text(answer.strip() + "<|eot_id|>")
            answer_emb = self._embed_ids(answer_ids, like)

            emb_chunks += [header_emb, tail_emb, answer_emb]
            prefix_len = header_emb.shape[0] + tail_emb.shape[0]
            lab_chunks.append(torch.full((prefix_len,), -100, dtype=torch.long, device=like.device))
            lab_chunks.append(torch.tensor(answer_ids, dtype=torch.long, device=like.device))

        inputs_embeds = torch.cat(emb_chunks, dim=0)
        labels = torch.cat(lab_chunks, dim=0)
        return inputs_embeds, labels

    def forward_multiturn(self, batch: list):
        """batch: list of (pixel_values_i [n_img,3,H,W], turns) tuples, one
        per sample (see prepare_stage2_batch) -- n_img may differ per sample
        (0, 1 or 2; text-only samples pass a [0,3,H,W] tensor). Returns
        (loss, logits) from the underlying HF CausalLM forward, same
        contract as BitNetVLM.forward."""
        samples = [self.build_multiturn_sample(pv, turns) for pv, turns in batch]
        embeds, labels, attn = pad_and_stack(samples)
        out = self.llm(inputs_embeds=embeds, attention_mask=attn, labels=labels)
        return out.loss, out.logits


# ---------------------------------------------------------------------------
# Model construction
# ---------------------------------------------------------------------------

def load_stage1_projector(vision_adapter: VisionAdapter, prefix: str) -> None:
    """Loads export_adapter.py's PREFIX.safetensors (projector.0.weight/
    bias, projector.2.weight/bias -- see that module's docstring) into
    `vision_adapter.projector`, IN PLACE. Trainability is untouched here
    (VisionAdapterConfig never freezes the projector), so it stays
    trainable, per the task: "initialize the projector from it and keep it
    TRAINABLE"."""
    from safetensors.torch import load_file

    tensors = load_file(prefix + ".safetensors")
    state = {k[len("projector."):]: v for k, v in tensors.items() if k.startswith("projector.")}
    if not state:
        raise ValueError(f"{prefix}.safetensors has no 'projector.*' tensors")
    vision_adapter.projector.load_state_dict(state, strict=True)


def _load_adapter_config(prefix: str) -> VisionAdapterConfig:
    with open(prefix + ".json", encoding="utf-8") as f:
        meta = json.load(f)
    c = meta["vision_adapter_config"]
    return VisionAdapterConfig(tower=c["tower"], shuffle_factor=c["shuffle_factor"], grid_policy=c["grid_policy"],
                                llm_hidden=c["llm_hidden"], mlp_hidden=c["mlp_hidden"])


def _cast_frozen_to_bf16(module: nn.Module) -> None:
    """Casts every requires_grad=False parameter AND every floating-point
    buffer of `module` to bf16 IN PLACE (the frozen AutoBitLinear base
    weights + weight_scale buffers), leaving requires_grad=True parameters
    (LoRA A/B) at their own dtype (fp32 master weights -- see build_models).
    Generalizes train_stage1.py's `vlm.llm.to(torch.bfloat16)` (which cast
    everything, correct only because stage 1's LLM had nothing trainable
    living inside it) to a tree that now has trainable LoRA submodules
    mixed in."""
    for p in module.parameters(recurse=True):
        if not p.requires_grad:
            p.data = p.data.to(torch.bfloat16)
    for _, buf in module.named_buffers(recurse=True):
        if buf.is_floating_point():
            buf.data = buf.data.to(torch.bfloat16)


def build_models(args, device: str):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.llm_dir)

    if args.smoke:
        llm_hidden = args.smoke_hidden
        llm, _ = build_tiny_bitnet_llm(hidden=llm_hidden, vocab=len(tokenizer),
                                        bos_id=tokenizer.bos_token_id, eos_id=tokenizer.eos_token_id)
        va_cfg = VisionAdapterConfig(tower="random-tiny", shuffle_factor=args.shuffle_factor,
                                      grid_policy=args.grid_policy, llm_hidden=llm_hidden,
                                      mlp_hidden=args.mlp_hidden)
        vision_adapter = VisionAdapter(va_cfg)
    else:
        llm = lora_bitlinear.load_frozen_base(args.base, args.llm_dir)
        va_cfg = _load_adapter_config(args.adapter_init)
        vision_adapter = VisionAdapter(va_cfg)
        load_stage1_projector(vision_adapter, args.adapter_init)

    lora_params = lora_bitlinear.inject_lora(llm, targets=args.lora_targets.split(","), r=args.lora_r,
                                              alpha=args.lora_alpha, dropout=args.lora_dropout)

    vlm = BitNetVLMStage2(llm, tokenizer, vision_adapter, max_text_len=args.max_text_len).to(device)

    if device == "cuda" and not args.smoke:
        _cast_frozen_to_bf16(vlm.llm)
        vlm.vision_adapter.tower.to(torch.bfloat16)

    if args.grad_checkpoint:
        vlm.llm.gradient_checkpointing_enable()
        vlm.llm.config.use_cache = False

    return vlm, va_cfg, lora_params


# ---------------------------------------------------------------------------
# Checkpointing -- {projector, LoRA A/B} only (small; the frozen 2.4B base
# and frozen SigLIP2 tower are never re-saved, same policy train_stage1.py
# uses for the frozen LLM there)
# ---------------------------------------------------------------------------

def save_checkpoint(path: str, vlm: BitNetVLMStage2, opt, step: int, args) -> None:
    va = vlm.vision_adapter
    va_cfg = va.config.to_json()
    va_cfg.update({"image_size": va.image_size, "patch_size": va.patch_size, "vision_hidden": va.vision_hidden,
                   "patch_grid_side": va.grid_side, "tokens_per_image": va.tokens_per_image})
    torch.save({
        "projector": va.projector.state_dict(),
        "lora": lora_bitlinear.lora_state_dict(vlm.llm),
        "lora_config": {"targets": args.lora_targets.split(","), "r": args.lora_r, "alpha": args.lora_alpha,
                         "dropout": args.lora_dropout, "base": args.base, "llm_dir": args.llm_dir},
        "vision_adapter_config": va_cfg,
        "opt": opt.state_dict(),
        "step": step,
        "args": vars(args),
    }, path)


def load_checkpoint(path: str, vlm: BitNetVLMStage2, opt, device: str) -> int:
    # weights_only=False: carries optimizer state + an argparse.Namespace,
    # not just tensors -- trusted input (this script's own checkpoint.pt).
    ck = torch.load(path, map_location=device, weights_only=False)
    vlm.vision_adapter.projector.load_state_dict(ck["projector"])
    lora_bitlinear.load_lora_state_dict(vlm.llm, ck["lora"])
    if opt is not None and "opt" in ck:
        opt.load_state_dict(ck["opt"])
    return ck.get("step", 0)


# ---------------------------------------------------------------------------
# Batching / eval
# ---------------------------------------------------------------------------

def prepare_stage2_batch(vlm: BitNetVLMStage2, samples: list, image_processor, device: str):
    img_size = vlm.vision_adapter.image_size
    prepared = []
    for s in samples:
        imgs = s["images"]
        if imgs:
            pv = preprocess_images(image_processor, imgs) if image_processor is not None \
                else tiny_pixel_values(imgs, img_size)
        else:
            pv = torch.zeros((0, 3, img_size, img_size), dtype=torch.float32)
        prepared.append((pv.to(device), s["turns"]))
    return prepared


def run_eval_vqa(vlm: BitNetVLMStage2, samples: list, image_processor, device: str) -> list:
    """Generates an answer for each held-out sample's FIRST image + FIRST
    turn's question only (a deliberate simplification for eval logging --
    training itself uses every image/turn via forward_multiturn); reuses
    BitNetVLM.generate_caption unmodified, just with the question as the
    prompt instead of a fixed captioning instruction."""
    vlm.eval()
    lines = []
    for s in samples:
        img = s["images"][0]
        question, answer = s["turns"][0]
        pv = (preprocess_images(image_processor, [img])[0] if image_processor is not None
              else tiny_pixel_values([img], vlm.vision_adapter.image_size)[0]).to(device)
        pred = vlm.generate_caption(pv, prompt=f"{IMAGE_PLACEHOLDER}\n{question}", max_new_tokens=24)
        lines.append(f"  q={question!r} gt={answer!r} pred={pred!r}")
    vlm.train()
    return lines


# ---------------------------------------------------------------------------
# CLI / main
# ---------------------------------------------------------------------------

def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    # model
    ap.add_argument("--llm-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--base", default="offline", choices=["offline", "bf16"])
    ap.add_argument("--adapter-init", default="data/forge/eyes/adapter_export",
                     help="prefix of the stage-1 export_adapter.py output (PREFIX.safetensors + PREFIX.json)")
    ap.add_argument("--lora-targets", default=",".join(lora_bitlinear.DEFAULT_TARGETS))
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--shuffle-factor", type=int, default=3, choices=[2, 3], help="--smoke only (real runs read this from --adapter-init's JSON)")
    ap.add_argument("--grid-policy", default="pad", choices=["pad", "crop"], help="--smoke only")
    ap.add_argument("--mlp-hidden", type=int, default=0, help="--smoke only; 0 -> defaults to --smoke-hidden")
    ap.add_argument("--max-text-len", type=int, default=256)
    ap.add_argument("--grad-checkpoint", action="store_true")
    # data
    ap.add_argument("--source", default="finevision", choices=["finevision", "cauldron"])
    ap.add_argument("--datasets", default=",".join(data_instruct.FINEVISION_SUBSETS))
    ap.add_argument("--streaming", dest="streaming", action="store_true", default=True)
    ap.add_argument("--no-streaming", dest="streaming", action="store_false")
    ap.add_argument("--max-samples", type=int, default=None)
    ap.add_argument("--max-images", type=int, default=data_instruct.DEFAULT_MAX_IMAGES)
    ap.add_argument("--max-turns", type=int, default=data_instruct.DEFAULT_MAX_TURNS)
    ap.add_argument("--text-ratio", type=float, default=0.0)
    ap.add_argument("--text-dataset", default=data_instruct.TEXT_INSTRUCT_DATASET)
    ap.add_argument("--text-config", default=data_instruct.TEXT_INSTRUCT_CONFIG)
    # optim -- two param groups (projector, LoRA), see module docstring
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--steps", type=int, default=6000)
    ap.add_argument("--warmup", type=int, default=200)
    ap.add_argument("--lr-projector", type=float, default=5e-5)
    ap.add_argument("--min-lr-projector", type=float, default=5e-6)
    ap.add_argument("--lr-lora", type=float, default=1e-4)
    ap.add_argument("--min-lr-lora", type=float, default=1e-5)
    ap.add_argument("--wd", type=float, default=0.01)
    ap.add_argument("--grad-clip", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=42)
    # logging / checkpoints -- see train_stage1.py's identical note: this
    # PC's AGENTS.md forbids writes under data/, --smoke always uses a
    # fresh OS temp dir regardless of --out.
    ap.add_argument("--out", default="stage2_out")
    ap.add_argument("--resume", default="")
    ap.add_argument("--log-every", type=int, default=20)
    ap.add_argument("--ckpt-every", type=int, default=500)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--eval-samples", type=int, default=4)
    # smoke
    ap.add_argument("--smoke", action="store_true", help="tiny random LLM + tiny tower + tiny_synthetic_vqa, no download")
    ap.add_argument("--smoke-steps", type=int, default=5)
    ap.add_argument("--smoke-hidden", type=int, default=64)
    ap.add_argument("--smoke-batch", type=int, default=2)
    ap.add_argument("--smoke-samples", type=int, default=32)
    return ap


def make_sample_source(args):
    if args.smoke:
        def factory():
            return data_instruct.iter_tiny_synthetic_vqa(image_size=64, max_samples=args.smoke_samples, seed=args.seed)
        return cycle(factory)

    datasets_list = args.datasets.split(",") if args.datasets else None

    def vision_factory():
        return data_instruct.build_vision_stream(source=args.source, subsets=datasets_list, streaming=args.streaming,
                                                   max_samples=args.max_samples, max_images=args.max_images,
                                                   max_turns=args.max_turns, seed=args.seed)

    def factory():
        return data_instruct.instruct_mixture(vision_factory, text_ratio=args.text_ratio,
                                                text_dataset=args.text_dataset, text_config=args.text_config,
                                                streaming=args.streaming, max_turns=args.max_turns, seed=args.seed)
    return cycle(factory)


def make_eval_source(args):
    """A vision-ONLY stream (never the mixed text+vision one) -- eval always
    needs a real image, and run_eval_vqa always indexes samples[0]["images"]
    [0]."""
    datasets_list = args.datasets.split(",") if args.datasets else None

    def eval_factory():
        return data_instruct.build_vision_stream(source=args.source, subsets=datasets_list, streaming=args.streaming,
                                                   max_images=args.max_images, max_turns=args.max_turns,
                                                   seed=args.seed + 777)
    return cycle(eval_factory)


def main() -> None:
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
        args.out = tempfile.mkdtemp(prefix="ilaria_vlm_stage2_smoke_")
        args.streaming = False

    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(args.seed)
    os.makedirs(args.out, exist_ok=True)

    vlm, va_cfg, lora_params = build_models(args, device)
    projector_params = list(vlm.vision_adapter.trainable_parameters())

    image_processor = None
    if not args.smoke:
        image_processor = build_image_processor(va_cfg.tower_repo())

    opt = torch.optim.AdamW([
        {"params": projector_params, "lr": args.lr_projector},
        {"params": lora_params, "lr": args.lr_lora},
    ], betas=(0.9, 0.95), weight_decay=args.wd)

    n_proj = sum(p.numel() for p in projector_params)
    n_lora = sum(p.numel() for p in lora_params)
    print(f"[stage2] trainable params: projector={n_proj / 1e6:.2f}M lora={n_lora / 1e6:.2f}M "
          f"({vlm.n_lora_modules} LoRABitLinear modules, r={args.lora_r} alpha={args.lora_alpha}) | "
          f"base={args.base} tower={va_cfg.tower} tokens/img={vlm.vision_adapter.tokens_per_image} "
          f"device={device} smoke={args.smoke}")

    start_step = 0
    if args.resume and os.path.exists(args.resume):
        start_step = load_checkpoint(args.resume, vlm, opt, device)
        print(f"[stage2] resumed from {args.resume} @ step {start_step}")

    use_amp = device == "cuda" and not args.smoke
    autocast_device = "cuda" if torch.cuda.is_available() else "cpu"

    sample_source = make_sample_source(args)
    held_out = None
    eval_source = None
    if args.smoke:
        held_out = list(data_instruct.iter_tiny_synthetic_vqa(image_size=64, max_samples=args.eval_samples,
                                                                seed=args.seed + 999))
    else:
        eval_source = make_eval_source(args)

    trainable_all = projector_params + lora_params
    t0 = time.time()
    samples_seen = 0
    vlm.train()
    for step in range(start_step, args.steps):
        lr_proj = cosine_lr(step, args.warmup, args.steps, args.lr_projector, args.min_lr_projector)
        lr_lora = cosine_lr(step, args.warmup, args.steps, args.lr_lora, args.min_lr_lora)
        opt.param_groups[0]["lr"] = lr_proj
        opt.param_groups[1]["lr"] = lr_lora
        opt.zero_grad(set_to_none=True)
        loss_acc = 0.0
        for _ in range(args.accum):
            samples = [next(sample_source) for _ in range(args.batch)]
            batch = prepare_stage2_batch(vlm, samples, image_processor, device)
            with torch.autocast(autocast_device, dtype=torch.bfloat16, enabled=use_amp):
                loss, _ = vlm.forward_multiturn(batch)
                loss = loss / args.accum
            loss.backward()
            loss_acc += loss.item()
            samples_seen += len(samples)

        gn = torch.nn.utils.clip_grad_norm_(trainable_all, args.grad_clip)
        opt.step()

        if step % args.log_every == 0:
            el = time.time() - t0
            print(f"step {step:6d} | loss {loss_acc:.4f} | lr_proj {lr_proj:.2e} lr_lora {lr_lora:.2e} | "
                  f"gn {gn:.2f} | {samples_seen / max(el, 1e-9):,.1f} samples/s | {el / 60:.1f} min")

        if (step + 1) % args.ckpt_every == 0 or step + 1 == args.steps:
            ckpt_path = os.path.join(args.out, "checkpoint.pt")
            save_checkpoint(ckpt_path, vlm, opt, step + 1, args)
            print(f"[stage2] checkpoint saved @ step {step + 1} -> {ckpt_path}")

        if (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            eval_pool = held_out if args.smoke else [next(eval_source) for _ in range(args.eval_samples)]
            print(f"[eval] step {step + 1}:")
            try:
                for line in run_eval_vqa(vlm, eval_pool, image_processor, device):
                    print(line)
            except Exception as e:  # monitoring must never kill a multi-hour run (bit us in stage 1)
                print(f"[eval] skipped: {type(e).__name__}: {e}")

    print(f"[stage2] DONE @ step {args.steps} -> {args.out}/checkpoint.pt")


if __name__ == "__main__":
    main()
