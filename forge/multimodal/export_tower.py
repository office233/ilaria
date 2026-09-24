"""forge/multimodal/export_tower.py -- exports the SigLIP2-base VISION
tower's weights (frozen, never fine-tuned by train_stage1.py -- see
vision_adapter.py's VisionAdapterConfig.freeze_tower) from the downloaded
google/siglip2-base-patch16-512 HF checkpoint into NXTF v3
(`siglip2_base.nxtf`, magic "NXTF3BIN", arch "siglip2_vision"), the format
cortex.LoadSiglipVisionTower (cortex/vision_siglip_persist.go) reads.

Checkpoint facts (verified by loading config.json + inspecting the
downloaded model.safetensors' vision_model.* keys directly -- see also
vision_adapter.py's _load_real_tower doc comment):

  - config.json declares model_type "siglip" (the fixed-512px SiglipModel
    architecture, NOT the NaFlex variable-resolution Siglip2Model family)
    with vision_config overriding only image_size=512; every other
    SiglipVisionConfig field is that class's own default: patch_size=16,
    hidden_size=768, num_hidden_layers=12, num_attention_heads=12,
    intermediate_size=3072, hidden_act="gelu_pytorch_tanh",
    layer_norm_eps=1e-6, num_channels=3.
  - num_positions = (image_size/patch_size)^2 = 1024 -- no class token, no
    position-embedding interpolation needed (see SiglipVisionEmbeddings).
  - vision_model.head.* (a SiglipMultiheadAttentionPoolingHead -- 7
    tensors: attention.{in_proj_weight,in_proj_bias,out_proj.{weight,bias}},
    layernorm.{weight,bias}, mlp.{fc1,fc2}.{weight,bias}, probe) exists in
    the checkpoint but is NOT exported: VisionAdapter.forward only ever
    reads `.last_hidden_state` (the encoder output after post_layernorm),
    never `.pooler_output` -- so the Go engine has no use for the pooling
    head, and the NXTF header's "has_pooling_head" field is written false
    so cortex.LoadSiglipVisionTower can assert that expectation rather
    than silently ignoring a checkpoint that might need it.

Tensor layout: every tensor is float32, kind "f32" (no ternary weights --
the tower runs in plain float32, unlike bitnet's ternary BitLinear).
nn.Linear stores weight [out,in]; cortex's own dense-layer convention is
the opposite -- row-vector y = x @ W with W laid out [in,out] (same
convention forge/import_bitnet.py's BitLinear tensors and
forge/multimodal/export_adapter.py's projector use) -- so every q/k/v/
out_proj/fc1/fc2 weight is transposed before writing. The patch-embedding
Conv2d weight [out=768, in_ch=3, kh=16, kw=16] is additionally flattened:
each output channel's (in_ch,kh,kw) cube is flattened row-major (in_ch
outermost, kw innermost) into a length-768 (3*16*16) vector -- exactly the
order cortex/vision_siglip.go's patchEmbed unfolds an input patch into --
then the resulting [out=768, in=768] matrix is transposed to cortex's
[in,out], same as every other linear weight here.

Tensor names (per-layer i, 0-based) match cortex/vision_siglip_persist.go's
LoadSiglipVisionTower exactly:

    embeddings.patch_embedding.weight   [in=3*patch*patch, out=hidden]
    embeddings.patch_embedding.bias     [hidden]
    embeddings.position_embedding.weight [num_positions, hidden]
    layers.<i>.ln1.weight / .bias                  [hidden]
    layers.<i>.ln2.weight / .bias                  [hidden]
    layers.<i>.attn.q.weight [hidden,hidden] / .q.bias [hidden]
    layers.<i>.attn.k.weight / .k.bias  (same shapes)
    layers.<i>.attn.v.weight / .v.bias
    layers.<i>.attn.out.weight / .out.bias           (SiglipAttention.out_proj)
    layers.<i>.mlp.fc1.weight [hidden,intermediate] / .fc1.bias [intermediate]
    layers.<i>.mlp.fc2.weight [intermediate,hidden] / .fc2.bias [hidden]
    post_layernorm.weight / .bias                  [hidden]

Usage:
    python forge/multimodal/export_tower.py \\
        --hf-dir data/pretrained/siglip2-base-patch16-512 \\
        --out data/forge/eyes/siglip2_base.nxtf
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from nxtf3 import NXTFWriter, f32_bytes  # noqa: E402


def _transpose(w: np.ndarray) -> np.ndarray:
    """nn.Linear weight [out,in] -> cortex [in,out]."""
    return np.ascontiguousarray(w.T)


def _flatten_patch_embed(conv_weight: np.ndarray) -> np.ndarray:
    """Conv2d weight [out,in_ch,kh,kw] -> cortex linear [in=in_ch*kh*kw,out]
    -- flatten each output channel's (in_ch,kh,kw) cube row-major (matches
    cortex/vision_siglip.go's patchEmbed unfold order exactly), then
    transpose [out,in] -> [in,out]."""
    out_c = conv_weight.shape[0]
    flat = conv_weight.reshape(out_c, -1)  # [out, in_ch*kh*kw], row-major over (in_ch,kh,kw)
    return _transpose(flat)


def export_siglip_tower(hf_dir: str, out_path: str) -> None:
    from safetensors import safe_open

    with open(os.path.join(hf_dir, "config.json")) as f:
        hf_cfg = json.load(f)
    vision_cfg = hf_cfg.get("vision_config", {})
    if hf_cfg.get("model_type") != "siglip":
        raise ValueError(
            f"{hf_dir}/config.json: model_type={hf_cfg.get('model_type')!r}, want 'siglip' "
            "(the fixed-512px SiglipModel architecture this exporter targets, not NaFlex/Siglip2Model)"
        )

    # Defaults match transformers.models.siglip.configuration_siglip.SiglipVisionConfig
    # (verified against the installed transformers 5.3.0 — see module docstring).
    image_size = vision_cfg.get("image_size", 224)
    patch_size = vision_cfg.get("patch_size", 16)
    hidden = vision_cfg.get("hidden_size", 768)
    num_layers = vision_cfg.get("num_hidden_layers", 12)
    num_heads = vision_cfg.get("num_attention_heads", 12)
    intermediate = vision_cfg.get("intermediate_size", 3072)
    num_channels = vision_cfg.get("num_channels", 3)
    layer_norm_eps = vision_cfg.get("layer_norm_eps", 1e-6)
    hidden_act = vision_cfg.get("hidden_act", "gelu_pytorch_tanh")
    if hidden_act != "gelu_pytorch_tanh":
        raise ValueError(f"unsupported hidden_act {hidden_act!r} — cortex/vision_siglip.go only implements gelu_pytorch_tanh")

    grid_side = image_size // patch_size
    num_positions = grid_side * grid_side

    cfg = {
        "image_size": image_size,
        "patch_size": patch_size,
        "hidden_size": hidden,
        "num_layers": num_layers,
        "num_heads": num_heads,
        "intermediate_size": intermediate,
        "num_channels": num_channels,
        "num_positions": num_positions,
        "layer_norm_eps": float(layer_norm_eps),
        "hidden_act": hidden_act,
        "has_pooling_head": False,  # VisionAdapter only reads last_hidden_state — see module docstring
    }

    st_path = os.path.join(hf_dir, "model.safetensors")
    writer = NXTFWriter(out_path, "siglip2_vision", cfg)

    with safe_open(st_path, framework="pt", device="cpu") as f:
        def f32(name: str) -> np.ndarray:
            return f.get_tensor(name).to(torch.float32).contiguous().numpy()

        conv_w = f32("vision_model.embeddings.patch_embedding.weight")  # [hidden,3,patch,patch]
        patch_w = _flatten_patch_embed(conv_w)  # [3*patch*patch, hidden]
        writer.add("embeddings.patch_embedding.weight", "f32", list(patch_w.shape), f32_bytes(patch_w))
        conv_b = f32("vision_model.embeddings.patch_embedding.bias")
        writer.add("embeddings.patch_embedding.bias", "f32", list(conv_b.shape), f32_bytes(conv_b))

        pos_w = f32("vision_model.embeddings.position_embedding.weight")  # [num_positions,hidden] already
        writer.add("embeddings.position_embedding.weight", "f32", list(pos_w.shape), f32_bytes(pos_w))

        for li in range(num_layers):
            p = f"vision_model.encoder.layers.{li}."
            gp = f"layers.{li}."

            for norm in ("layer_norm1", "layer_norm2"):
                out_name = "ln1" if norm == "layer_norm1" else "ln2"
                w = f32(p + norm + ".weight")
                b = f32(p + norm + ".bias")
                writer.add(gp + out_name + ".weight", "f32", list(w.shape), f32_bytes(w))
                writer.add(gp + out_name + ".bias", "f32", list(b.shape), f32_bytes(b))

            for tag, mod in (("q", "self_attn.q_proj"), ("k", "self_attn.k_proj"),
                              ("v", "self_attn.v_proj"), ("out", "self_attn.out_proj")):
                w = _transpose(f32(p + mod + ".weight"))
                b = f32(p + mod + ".bias")
                writer.add(f"{gp}attn.{tag}.weight", "f32", list(w.shape), f32_bytes(w))
                writer.add(f"{gp}attn.{tag}.bias", "f32", list(b.shape), f32_bytes(b))

            fc1_w = _transpose(f32(p + "mlp.fc1.weight"))
            fc1_b = f32(p + "mlp.fc1.bias")
            writer.add(gp + "mlp.fc1.weight", "f32", list(fc1_w.shape), f32_bytes(fc1_w))
            writer.add(gp + "mlp.fc1.bias", "f32", list(fc1_b.shape), f32_bytes(fc1_b))

            fc2_w = _transpose(f32(p + "mlp.fc2.weight"))
            fc2_b = f32(p + "mlp.fc2.bias")
            writer.add(gp + "mlp.fc2.weight", "f32", list(fc2_w.shape), f32_bytes(fc2_w))
            writer.add(gp + "mlp.fc2.bias", "f32", list(fc2_b.shape), f32_bytes(fc2_b))

        post_w = f32("vision_model.post_layernorm.weight")
        post_b = f32("vision_model.post_layernorm.bias")
        writer.add("post_layernorm.weight", "f32", list(post_w.shape), f32_bytes(post_w))
        writer.add("post_layernorm.bias", "f32", list(post_b.shape), f32_bytes(post_b))

    writer.finalize()
    print(f"[export_tower] wrote {out_path} (image_size={image_size} patch={patch_size} "
          f"hidden={hidden} layers={num_layers} heads={num_heads} intermediate={intermediate} "
          f"num_positions={num_positions}, pooling head NOT exported)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hf-dir", default="data/pretrained/siglip2-base-patch16-512")
    ap.add_argument("--out", default="data/forge/eyes/siglip2_base.nxtf")
    args = ap.parse_args()
    export_siglip_tower(args.hf_dir, args.out)


if __name__ == "__main__":
    main()
