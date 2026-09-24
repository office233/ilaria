"""forge/multimodal/dump_vision_reference.py -- runs the real HF SigLIP2-base
vision tower (float32, CPU) plus pixel-shuffle plus a projector (either a
trained forge/multimodal/export_adapter.py export, or a fixed-seed random
one built here) on one image, and dumps everything the Go equivalence test
(cortex/vision_siglip_test.go's TestSigLIPEquivalence) needs to check
cortex/vision_siglip.go against: preprocessing, tower last_hidden_state,
pixel-shuffled tokens, and projected image embeddings.

If --image is omitted, a deterministic 512x512 PNG (colored shapes on a
white background, no RNG) is synthesized instead -- there is no real photo
anywhere under D:\\nexus\\data or forge/fixtures (checked; this repo's
image assets are all diagrams/screenshots outside those trees), so this is
the "otherwise synthesize a second one" fallback the task allows, doubling
as the primary fixture too. `--variant N` picks between a couple of
distinct deterministic patterns so the equivalence check can be run
against more than one image without needing an external asset.

If --adapter is omitted, a fixed-seed (seed=42) randomly-initialized
projector (VisionAdapterConfig defaults: shuffle_factor=3, llm_hidden=2560,
mlp_hidden=llm_hidden) is built, then exported through the REAL
forge/multimodal/export_adapter.py:export() (via an in-memory checkpoint
dict shaped exactly like train_stage1.py's own checkpoint.pt: {"projector":
state_dict, "vision_adapter_config": ..., "step": None}) to
data/forge/eyes/projector_seed42.safetensors/.json -- so the exported file
is produced by the same code path a real trained checkpoint would go
through, not a hand-rolled duplicate writer.

Output (--out, default data/forge/eyes/vision_ref.json) — see
cortex/vision_siglip_test.go's visionRefFile struct for the exact schema
consumed on the Go side:

    {
      "image": {"path": <PNG written next to --out>, "width", "height"},
      "pixel_values": {"shape":[3,H,W], "first64":[...], "sha256": "..."},
      "tower": {"shape":[1024,768], "mean", "std", "bin_path": "..._hidden.bin"},
      "pixel_shuffle": {"shape":[121,6912], "mean", "std"},
      "projector": {"shape":[121,2560], "values": [[...]*121]},   # full, float32 precision preserved by json's float repr
      "adapter_prefix": "projector_seed42" (or the --adapter prefix's basename),
      "vision_adapter_config": {...}
    }

The tower's full last_hidden_state ([1024,768] = 786,432 floats) is written
to a SEPARATE raw little-endian float32 .bin file next to --out (named
<out-stem>_hidden.bin) rather than inline JSON, per the task's own
"float16 to keep JSON small, or a separate .bin" alternative -- float16
would floor relative precision around 1e-3, which conflicts with the
Go test's 1e-4 relative-L2 bound, so a full-precision float32 .bin is used
instead of the float16 option.

Usage:
    python forge/multimodal/dump_vision_reference.py \\
        --hf-dir data/pretrained/siglip2-base-patch16-512 \\
        --out data/forge/eyes/vision_ref.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vision_adapter import VisionAdapterConfig, _load_real_tower, grid_and_token_count, pixel_shuffle  # noqa: E402
import export_adapter  # noqa: E402


def _synth_image(size: int, variant: int):
    """Deterministic (no RNG) size x size PNG: colored shapes on a white
    background — see module docstring for why this stands in for a real
    photo. variant selects between two distinct patterns."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (size, size), color=(255, 255, 255))
    d = ImageDraw.Draw(img)
    if variant == 1:
        d.rectangle([size // 8, size // 8, size // 2 - size // 16, size // 2 - size // 16], fill=(220, 40, 40))
        d.ellipse([size // 2 + size // 16, size // 8, size - size // 8, size // 2 - size // 16], fill=(40, 90, 220))
        d.rectangle([0, size // 2 + size // 8, size, size // 2 + size // 4], fill=(40, 180, 70))
        d.ellipse([size // 4, size - size // 3, size - size // 4, size - size // 12], fill=(230, 200, 30))
    else:
        d.ellipse([size // 6, size // 6, size - size // 6, size - size // 6], fill=(150, 60, 190))
        d.rectangle([size // 3, size // 3, 2 * size // 3, 2 * size // 3], fill=(255, 255, 255))
        d.rectangle([0, 0, size, size // 16], fill=(20, 20, 20))
        d.rectangle([0, size - size // 16, size, size], fill=(20, 20, 20))
    return img


def _load_or_build_projector(adapter_prefix: str | None, eyes_dir: str, seed: int, vision_hidden: int):
    va_cfg = VisionAdapterConfig(tower="siglip2-base", shuffle_factor=3, grid_policy="pad",
                                  llm_hidden=2560, mlp_hidden=0, freeze_tower=True)
    in_dim = vision_hidden * va_cfg.shuffle_factor * va_cfg.shuffle_factor

    if adapter_prefix:
        from safetensors.torch import load_file
        tensors = load_file(adapter_prefix + ".safetensors")
        with open(adapter_prefix + ".json", encoding="utf-8") as f:
            meta = json.load(f)
        shapes = meta["tensor_shapes"]
        mlp_hidden, in_check = shapes["projector.0.weight"]
        llm_hidden, mlp_check = shapes["projector.2.weight"]
        assert mlp_hidden == mlp_check, "projector.0/.2 mlp_hidden mismatch in tensor_shapes"
        projector = torch.nn.Sequential(
            torch.nn.Linear(in_check, mlp_hidden), torch.nn.GELU(), torch.nn.Linear(mlp_hidden, llm_hidden))
        state = {k[len("projector."):]: v for k, v in tensors.items()}
        projector.load_state_dict(state)
        projector.eval()
        return projector, os.path.basename(adapter_prefix), meta.get("vision_adapter_config", va_cfg.to_json())

    torch.manual_seed(seed)
    projector = torch.nn.Sequential(
        torch.nn.Linear(in_dim, va_cfg.mlp_hidden), torch.nn.GELU(), torch.nn.Linear(va_cfg.mlp_hidden, va_cfg.llm_hidden))
    projector.eval()

    out_prefix = os.path.join(eyes_dir, f"projector_seed{seed}")
    ck = {"projector": projector.state_dict(), "vision_adapter_config": va_cfg.to_json(), "step": None}
    with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as tf:
        tmp_path = tf.name
    try:
        torch.save(ck, tmp_path)
        export_adapter.export(tmp_path, out_prefix)  # real export code path — see module docstring
    finally:
        os.unlink(tmp_path)

    return projector, os.path.basename(out_prefix), va_cfg.to_json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hf-dir", default="data/pretrained/siglip2-base-patch16-512")
    ap.add_argument("--image", default=None, help="Path to a PNG/JPEG; if omitted, a deterministic image is synthesized")
    ap.add_argument("--variant", type=int, default=1, choices=(1, 2), help="Synthetic image pattern when --image is omitted")
    ap.add_argument("--adapter", default=None, help="Prefix of an export_adapter.py output; if omitted, builds+exports a fixed-seed random projector")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="data/forge/eyes/vision_ref.json")
    args = ap.parse_args()

    torch.manual_seed(0)  # tower/processor loading is deterministic regardless, but keep this pinned for reproducibility

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    os.makedirs(out_dir, exist_ok=True)

    tower, tower_cfg = _load_real_tower(args.hf_dir)
    tower.eval()

    from transformers import AutoImageProcessor
    processor = AutoImageProcessor.from_pretrained(args.hf_dir)

    if args.image:
        from PIL import Image
        img = Image.open(args.image).convert("RGB")
        image_path_for_json = os.path.abspath(args.image)
    else:
        img = _synth_image(tower_cfg.image_size, args.variant)
        image_path_for_json = os.path.join(out_dir, f"synthetic_shapes{'' if args.variant == 1 else args.variant}.png")
        img.save(image_path_for_json)

    pixel_values = processor(images=[img], return_tensors="pt")["pixel_values"].to(torch.float32)  # [1,3,H,W]
    assert pixel_values.shape[-1] == tower_cfg.image_size and pixel_values.shape[-2] == tower_cfg.image_size, \
        f"processor produced {tuple(pixel_values.shape)}, expected image_size={tower_cfg.image_size}"

    with torch.no_grad():
        last_hidden = tower(pixel_values=pixel_values).last_hidden_state[0]  # [1024,768]

    grid_side = tower_cfg.image_size // tower_cfg.patch_size
    counts = grid_and_token_count(tower_cfg.image_size, tower_cfg.patch_size, 3, "pad")
    shuffled = pixel_shuffle(last_hidden.unsqueeze(0), grid_side, grid_side, 3, "pad")[0]  # [121,6912]
    assert shuffled.shape[0] == counts["tokens_per_image"]

    projector, adapter_prefix_name, va_cfg_json = _load_or_build_projector(
        args.adapter, out_dir, args.seed, tower_cfg.hidden_size)
    with torch.no_grad():
        projected = projector(shuffled)  # [121, llm_hidden]

    pv_flat = pixel_values[0].contiguous().numpy().astype("<f4")
    pv_bytes = pv_flat.tobytes()
    pv_hash = hashlib.sha256(pv_bytes).hexdigest()

    hidden_np = last_hidden.contiguous().numpy().astype("<f4")
    hidden_bin_name = os.path.splitext(os.path.basename(args.out))[0] + "_hidden.bin"
    with open(os.path.join(out_dir, hidden_bin_name), "wb") as f:
        f.write(hidden_np.tobytes())

    shuffled_np = shuffled.detach().numpy()

    ref = {
        "image": {
            "path": os.path.relpath(image_path_for_json, out_dir) if os.path.dirname(image_path_for_json) == out_dir else image_path_for_json,
            "width": tower_cfg.image_size,
            "height": tower_cfg.image_size,
        },
        "pixel_values": {
            "shape": list(pixel_values.shape[1:]),
            "first64": pv_flat.flatten()[:64].tolist(),
            "sha256": pv_hash,
        },
        "tower": {
            "shape": list(last_hidden.shape),
            "mean": float(hidden_np.mean()),
            "std": float(hidden_np.std()),
            "bin_path": hidden_bin_name,
            "bin_dtype": "float32",
        },
        "pixel_shuffle": {
            "shape": list(shuffled.shape),
            "mean": float(shuffled_np.mean()),
            "std": float(shuffled_np.std()),
        },
        "projector": {
            "shape": list(projected.shape),
            "values": projected.detach().numpy().astype("float64").tolist(),
        },
        "adapter_prefix": adapter_prefix_name,
        "vision_adapter_config": va_cfg_json,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(ref, f)

    print(f"[dump_vision_reference] image={image_path_for_json} tower_out={tuple(last_hidden.shape)} "
          f"shuffled={tuple(shuffled.shape)} projected={tuple(projected.shape)} adapter={adapter_prefix_name}")
    print(f"[dump_vision_reference] wrote {args.out} + {hidden_bin_name}")


if __name__ == "__main__":
    main()
