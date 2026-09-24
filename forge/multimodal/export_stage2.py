"""forge/multimodal/export_stage2.py -- exports a trained stage-2
train_stage2.py checkpoint.pt (projector + per-layer LoRA A/B, see that
module's `save_checkpoint`) as safetensors + a JSON sidecar, ready for the
Go engine (cortex/bitnet.go et al.) to apply at inference time -- P6 in
docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md's plan table.

Operates purely on the saved checkpoint.pt dict (same pattern
export_adapter.py uses for stage 1): it never rebuilds the 2.4B LLM, so this
script is cheap to run anywhere, including this PC.

Output, given --out-prefix PREFIX:

    PREFIX.safetensors --
        projector.0.weight / .0.bias / .2.weight / .2.bias   (as
            export_adapter.py -- the projector's nn.Sequential(Linear,
            GELU, Linear) state dict; index 1 is the parameter-free GELU)
        lora.layers.<i>.<proj>.A   [r, in_features]
        lora.layers.<i>.<proj>.B   [out_features, r]
            one pair per LoRA-wrapped projection (<proj> in q_proj/k_proj/
            v_proj/o_proj/gate_proj/up_proj/down_proj, <i> the decoder
            layer index) -- see lora_bitlinear.export_key for the exact
            "model.layers.<i>.self_attn.q_proj" -> "lora.layers.<i>.q_proj"
            name mapping this reuses (train_stage2.py and this script agree
            on one naming scheme via that shared function, not two).
        nn.Linear/AutoBitLinear-style [out,in] layout throughout (cortex's
        own dense-layer convention is the transpose -- see export_adapter.
        py's docstring; a future Go importer must transpose the same way it
        would for any other PyTorch export from this project).

    PREFIX.json -- everything needed to APPLY the delta without the
        training code:
          - "lora": {"r", "alpha", "scaling" (= alpha/r), "targets"}
          - "base": {"kind" ("offline"|"bf16"), "llm_dir"}
          - "vision_adapter_config": as export_adapter.py's own field
          - "chat_template": the exact BitNet template string + the image/
            eot tokens (so a Go importer does not have to reverse-engineer
            mm_model.py's docstring)
          - "math": the exact formula to reproduce, spelled out below
          - "source_checkpoint" / "source_step"

Inference-time math (what the Go engine must reproduce EXACTLY, per
projection, per layer): given the base AutoBitLinear's own forward
`base(x)` (ternary-weight matmul + weight_scale rescale for the "offline"
--base; WeightQuant-STE-quantized bf16 matmul for "bf16" -- see
lora_bitlinear.py's module docstring for the full trade-off), and this
export's `A` [r, in], `B` [out, r], `alpha`, `r`:

    scaling = alpha / r
    y = base(x) + scaling * (B @ (A @ x))        # per-token x [in] -> y [out]
      = base(x) + scaling * (x @ A^T) @ B^T       # batched, row-vector convention

`x` is the SAME activation fed to `base` -- i.e. BEFORE `base`'s own
internal per-token activation quantization (ActQuant in transformers/
integrations/bitnet.py) -- see lora_bitlinear.py's module docstring
("LoRA math") for why. No merged weights are ever produced; see
lora_bitlinear.merge_lora's docstring for why that is not supported.

Usage:
    python forge/multimodal/export_stage2.py \\
        --checkpoint data/forge/ilaria-vlm/stage2/checkpoint.pt \\
        --out-prefix data/forge/ilaria-vlm/stage2/stage2_export
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import torch
from safetensors.torch import save_file

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lora_bitlinear import export_key  # noqa: E402

CHAT_TEMPLATE_INFO = {
    "template": "User: {content}<|eot_id|>Assistant: {answer}<|eot_id|>",
    "image_token": "<image>",
    "eot_token": "<|eot_id|>",
    "note": "matches mm_model.py's module docstring / cortex.Llama3ChatPrompt; multi-turn = "
            "concatenated turns, all <image> markers (one per image) prepended to the FIRST turn only.",
}


def export(checkpoint_path: str, out_prefix: str) -> None:
    # weights_only=False: this checkpoint carries the optimizer state dict
    # and an argparse.Namespace, not just tensors -- trusted input (our own
    # train_stage2.py wrote it).
    ck = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    projector_state = ck["projector"]
    lora_state = ck["lora"]  # {module_path: {"A":Tensor,"B":Tensor,"r":int,"alpha":int}}
    lora_cfg = ck.get("lora_config", {})
    va_cfg = ck["vision_adapter_config"]

    if not lora_state:
        raise ValueError(f"{checkpoint_path}: no LoRA tensors in checkpoint (empty 'lora' dict)")

    tensors = {f"projector.{k}": v.contiguous().float() for k, v in projector_state.items()}
    rs, alphas = set(), set()
    for module_path, entry in lora_state.items():
        key = export_key(module_path)
        tensors[f"{key}.A"] = entry["A"].contiguous().float()
        tensors[f"{key}.B"] = entry["B"].contiguous().float()
        rs.add(int(entry["r"]))
        alphas.add(int(entry["alpha"]))
    if len(rs) != 1 or len(alphas) != 1:
        raise ValueError(f"export_stage2: expected one shared (r, alpha) across all LoRA modules, got r={rs} alpha={alphas}")
    r, alpha = rs.pop(), alphas.pop()

    out_dir = os.path.dirname(os.path.abspath(out_prefix))
    os.makedirs(out_dir, exist_ok=True)
    save_file(tensors, out_prefix + ".safetensors", metadata={"format": "pt"})

    meta = {
        "lora": {"r": r, "alpha": alpha, "scaling": alpha / r,
                 "targets": lora_cfg.get("targets"), "n_modules": len(lora_state)},
        "base": {"kind": lora_cfg.get("base"), "llm_dir": lora_cfg.get("llm_dir")},
        "vision_adapter_config": va_cfg,
        "chat_template": CHAT_TEMPLATE_INFO,
        "math": ("y = base(x) + (alpha/r) * (x @ A^T) @ B^T, per LoRA-wrapped projection; x is the "
                  "SAME activation fed to base(x) (before base's own internal ActQuant) -- see this "
                  "module's docstring and lora_bitlinear.py's for the full derivation."),
        "tensor_shapes": {k: list(v.shape) for k, v in tensors.items()},
        "source_checkpoint": os.path.abspath(checkpoint_path),
        "source_step": ck.get("step"),
    }
    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    n_params = sum(t.numel() for t in tensors.values())
    print(f"[export_stage2] wrote {out_prefix}.safetensors ({n_params / 1e6:.2f}M params, "
          f"{len(lora_state)} LoRA modules, r={r} alpha={alpha}) and {out_prefix}.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out-prefix", required=True)
    args = ap.parse_args()
    export(args.checkpoint, args.out_prefix)


if __name__ == "__main__":
    main()
