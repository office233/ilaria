"""forge/multimodal/export_adapter.py -- exports a trained stage-1 projector
checkpoint (forge/multimodal/train_stage1.py's checkpoint.pt) as safetensors
+ a JSON sidecar, ready to be ported into the Go engine later (P6 in
docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md's plan table).

Output, given --out-prefix PREFIX:

    PREFIX.safetensors -- the projector's nn.Sequential(Linear, GELU, Linear)
        state dict. Tensor names/shapes (mlp_hidden defaults to llm_hidden,
        e.g. 2560; vision_hidden * shuffle_factor^2 is the pixel-shuffled
        input width, e.g. 768*9=6912 for siglip2-base at shuffle 3):

            projector.0.weight   [mlp_hidden, vision_hidden * shuffle_factor^2]
            projector.0.bias     [mlp_hidden]
            projector.2.weight   [llm_hidden, mlp_hidden]
            projector.2.bias     [llm_hidden]

        (Sequential index 1 is the parameter-free GELU -- no tensor for it.)
        nn.Linear stores weight as [out_features, in_features]. cortex's own
        dense-layer convention is the opposite -- row-vector y = x @ W with
        W laid out [in, out] (see forge/ilaria_model.py's module docstring)
        -- so a future Go importer must transpose both weight matrices
        before loading them, the same way it would for any other PyTorch
        nn.Linear this project exports.

    PREFIX.json -- everything needed to reconstruct the adapter without the
        training code: tower id/repo, shuffle_factor, grid_policy,
        image_size, patch_size, patch_grid_side, tokens_per_image,
        vision_hidden, mlp_hidden, llm_hidden, tensor shapes, and the
        source checkpoint path/step it was exported from.

Usage:
    python forge/multimodal/export_adapter.py \\
        --checkpoint data/forge/ilaria-vlm/stage1/checkpoint.pt \\
        --out-prefix data/forge/ilaria-vlm/stage1/adapter_export
"""

from __future__ import annotations

import argparse
import json
import os

import torch
from safetensors.torch import save_file


def export(checkpoint_path: str, out_prefix: str) -> None:
    # weights_only=False: this checkpoint carries the optimizer state dict
    # and an argparse.Namespace, not just tensors -- trusted input (our own
    # train_stage1.py wrote it).
    ck = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    projector_state = ck["projector"]
    va_cfg = ck["vision_adapter_config"]

    tensors = {f"projector.{k}": v.contiguous().float() for k, v in projector_state.items()}
    out_dir = os.path.dirname(os.path.abspath(out_prefix))
    os.makedirs(out_dir, exist_ok=True)
    save_file(tensors, out_prefix + ".safetensors", metadata={"format": "pt"})

    meta = {
        "vision_adapter_config": va_cfg,
        "tensor_shapes": {k: list(v.shape) for k, v in tensors.items()},
        "source_checkpoint": os.path.abspath(checkpoint_path),
        "source_step": ck.get("step"),
    }
    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    n_params = sum(t.numel() for t in tensors.values())
    print(f"[export_adapter] wrote {out_prefix}.safetensors ({n_params / 1e6:.2f}M params) and {out_prefix}.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out-prefix", required=True)
    args = ap.parse_args()
    export(args.checkpoint, args.out_prefix)


if __name__ == "__main__":
    main()
