"""import_bitnet.py — convert the packed HF BitNet b1.58 checkpoint (or any
in-memory BitNet-shaped state dict) into NXTF v3 (`bitnet.nxtf`), the format
`cortex.LoadBitNetModel` reads.

Two entry points share the same tensor-writing code (the "importer code
path" the task asks both the real model and the `--tiny` synthetic fixture
to go through):

    write_top(writer, embed, final_norm)      — embedding + final RMSNorm
    write_layer(writer, layer_idx, layer)      — one decoder layer

`import_from_hf_dir` builds each layer's arrays straight from the packed
safetensors (via `safe_open`, so only one tensor is materialized at a time —
the whole 2.4B-param checkpoint never needs to live in RAM at once) and
feeds them through those two functions. `forge/bitnet_reference.py --tiny`
builds a random synthetic BitNet's ternary weights the same shape and feeds
them through the identical `write_top`/`write_layer` pair.

Weight-scale convention (verified against the installed transformers
5.3.0, transformers/integrations/bitnet.py, AutoBitLinear.forward,
`quantization_mode="offline"` path — the mode this checkpoint's
config.json declares):

    if self.online_quant:
        weight = WeightQuant.apply(self.weight)
    else:
        weight = self.weight          # already unpacked to {-1,0,1} by load_hook
    input = ActQuant.apply(input)
    output = F.linear(input, weight, self.bias)
    if not self.online_quant:
        output = output * self.weight_scale

`self.weight` after `AutoBitLinear.load_hook` has already been unpacked
(via `unpack_weights`) to plain ternary values in {-1, 0, 1} — never
scaled. The *only* place weight_scale is applied is as a scalar multiply
on the matmul output, which is mathematically identical to first
dequantizing the weight matrix as `W_real = weight_scale * W_ternary` and
then doing a normal matmul. So the convention is MULTIPLY:

    W ≈ scale · T

which is exactly what the NXTF v3 header's per-tensor "scale" field means,
and exactly what `BitLinear.Scale` is used for on the Go side.

Packing layout (ternary tensors): mirrors cortex/ternary.go's
PackTernaryTile bit-for-bit — see pack_ternary_tile() below. Row-major
over Out, ceil(In/16) tiles per row, each tile a little-endian uint32.

HF's on-disk packing (unrelated 2-bit format, decoded here via
hf_unpack_packed) is different: transformers packs 4 output-rows per
uint8 byte (see transformers/integrations/bitnet.py: pack_weights /
unpack_weights, VALUES_PER_ITEM=4). We unpack THAT format fully to a
plain {-1,0,1} int8 matrix first, then re-pack it into our own
PackTernaryTile layout for the Go engine.

    python forge/import_bitnet.py --hf-dir data/pretrained/bitnet-b1.58-2B-4T \
        --out data/forge/bitnet-2b4t/bitnet.nxtf
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
from typing import Any

import numpy as np

MAGIC = b"NXTF3BIN"

# ---------------------------------------------------------------------------
# Ternary packing — mirrors cortex/ternary.go: PackTernaryTile exactly.
# ---------------------------------------------------------------------------
#
# Go (cortex/ternary.go):
#   R byte = signLo (bit i set => weight i, i in [0,8) is negative)
#   G byte = maskLo (bit i set => weight i, i in [0,8) is non-zero)
#   B byte = signHi (bit i set => weight 8+i is negative)
#   A byte = maskHi (bit i set => weight 8+i is non-zero)
#   tile uint32 = signLo | maskLo<<8 | signHi<<16 | maskHi<<24
#   stored little-endian on disk (binary.LittleEndian.PutUint32).

_BIT = (1 << np.arange(8, dtype=np.uint32))  # [1,2,4,...,128]


def pack_ternary_tile(weights16: list[int]) -> int:
    """Scalar reference implementation — pack exactly 16 ternary weights
    ({-1,0,1}) into one uint32 tile, bit-for-bit identical to Go's
    PackTernaryTile. Used to sanity-check the vectorized path and to build
    forge/fixtures/ternary_pack_fixture.json."""
    assert len(weights16) == 16
    sign_lo = mask_lo = sign_hi = mask_hi = 0
    for i in range(8):
        w = weights16[i]
        if w != 0:
            mask_lo |= 1 << i
            if w < 0:
                sign_lo |= 1 << i
    for i in range(8):
        w = weights16[8 + i]
        if w != 0:
            mask_hi |= 1 << i
            if w < 0:
                sign_hi |= 1 << i
    return (sign_lo | (mask_lo << 8) | (sign_hi << 16) | (mask_hi << 24)) & 0xFFFFFFFF


def pack_ternary_matrix(mat: np.ndarray) -> bytes:
    """Vectorized version of pack_ternary_tile applied row-major over a
    (out_features, in_features) int8 matrix with values in {-1,0,1}.
    Returns raw bytes: out_features * ceil(in_features/16) little-endian
    uint32 tiles, row-major over `out`, tiles left-to-right along `in`
    within a row (rows beyond padding are zero-filled, matching Go's
    zero-initialized Tiles for positions >= InputSize).
    """
    if mat.dtype != np.int8:
        mat = mat.astype(np.int8)
    out_f, in_f = mat.shape
    tiles_per_row = (in_f + 15) // 16
    padded_len = tiles_per_row * 16
    if padded_len != in_f:
        padded = np.zeros((out_f, padded_len), dtype=np.int8)
        padded[:, :in_f] = mat
    else:
        padded = mat
    tiled = padded.reshape(out_f, tiles_per_row, 16)
    lo = tiled[:, :, :8]
    hi = tiled[:, :, 8:16]

    mask_lo = (lo != 0)
    sign_lo = (lo < 0)
    mask_hi = (hi != 0)
    sign_hi = (hi < 0)

    sign_lo_byte = (sign_lo.astype(np.uint32) * _BIT).sum(axis=-1).astype(np.uint32)
    mask_lo_byte = (mask_lo.astype(np.uint32) * _BIT).sum(axis=-1).astype(np.uint32)
    sign_hi_byte = (sign_hi.astype(np.uint32) * _BIT).sum(axis=-1).astype(np.uint32)
    mask_hi_byte = (mask_hi.astype(np.uint32) * _BIT).sum(axis=-1).astype(np.uint32)

    tile_u32 = (
        sign_lo_byte
        | (mask_lo_byte << 8)
        | (sign_hi_byte << 16)
        | (mask_hi_byte << 24)
    )  # (out_f, tiles_per_row) uint32, row-major over out already via C order

    return np.ascontiguousarray(tile_u32, dtype="<u4").tobytes()


# ---------------------------------------------------------------------------
# HF packed-uint8 -> plain ternary int8, mirrors
# transformers/integrations/bitnet.py: unpack_weights exactly.
# ---------------------------------------------------------------------------

VALUES_PER_ITEM = 4  # HF packs 4 ternary values (2 bits each) per uint8


def hf_unpack_packed(packed: np.ndarray, out_features: int) -> np.ndarray:
    """packed: (row_dim, in_features) uint8, row_dim = ceil(out_features/4).
    Returns (out_features, in_features) int8 with values in {-1,0,1}."""
    row_dim = packed.shape[0]
    full = np.zeros((row_dim * VALUES_PER_ITEM,) + packed.shape[1:], dtype=np.int8)
    for i in range(VALUES_PER_ITEM):
        codes = ((packed >> (2 * i)) & 3).astype(np.int8) - 1
        full[i * row_dim:(i + 1) * row_dim, ...] = codes
    return full[:out_features, ...]


# ---------------------------------------------------------------------------
# NXTF v3 writer
# ---------------------------------------------------------------------------

class NXTFWriter:
    """Streams tensor blobs to a temp file (so we never hold more than one
    tensor's raw bytes in memory at a time), then concatenates
    magic+header+blobs into the final file on finalize()."""

    def __init__(self, out_path: str, config: dict[str, Any]):
        self.out_path = out_path
        self.config = config
        self.tensors: list[dict[str, Any]] = []
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        self._tmp_path = out_path + ".blob.tmp"
        self._tmp = open(self._tmp_path, "wb")
        self._offset = 0

    def add(self, name: str, kind: str, shape: list[int], data: bytes, scale: float | None = None) -> None:
        entry: dict[str, Any] = {
            "name": name,
            "kind": kind,
            "shape": list(shape),
            "offset": self._offset,
            "bytes": len(data),
        }
        if scale is not None:
            entry["scale"] = float(scale)
        self.tensors.append(entry)
        self._tmp.write(data)
        self._offset += len(data)

    def finalize(self) -> None:
        self._tmp.close()
        header = {
            "version": 3,
            "arch": "bitnet",
            "config": self.config,
            "tensors": self.tensors,
        }
        hdr_bytes = json.dumps(header).encode("utf-8")
        with open(self.out_path, "wb") as out:
            out.write(MAGIC)
            out.write(struct.pack("<I", len(hdr_bytes)))
            out.write(hdr_bytes)
            with open(self._tmp_path, "rb") as tmp:
                shutil.copyfileobj(tmp, out, length=4 * 1024 * 1024)
        os.remove(self._tmp_path)


def _f32_bytes(arr: np.ndarray) -> bytes:
    return np.ascontiguousarray(arr, dtype="<f4").tobytes()


def write_top(writer: NXTFWriter, embed: np.ndarray, final_norm: np.ndarray) -> None:
    """Shared importer step: embedding table + final RMSNorm weight.
    Called identically by the real-checkpoint importer and the --tiny
    synthetic-fixture exporter."""
    writer.add("embed", "f32", list(embed.shape), _f32_bytes(embed))
    writer.add("final_norm", "f32", list(final_norm.shape), _f32_bytes(final_norm))


_LAYER_NORM_KEYS = ("attn_norm", "ffn_norm", "attn_sub_norm", "ffn_sub_norm")
_LAYER_LINEAR_TAGS = ("q", "k", "v", "o", "gate", "up", "down")


def write_layer(writer: NXTFWriter, layer_idx: int, layer: dict[str, Any]) -> None:
    """Shared importer step: one decoder layer's norms + 7 BitLinear
    tensors. `layer[norm_key]` is a 1-D float array; `layer[tag]` is a
    (ternary_int8_matrix, scale) pair. Called identically by the
    real-checkpoint importer and the --tiny synthetic-fixture exporter."""
    prefix = f"layers.{layer_idx}."
    for key in _LAYER_NORM_KEYS:
        arr = layer[key]
        writer.add(prefix + key, "f32", list(arr.shape), _f32_bytes(arr))
    for tag in _LAYER_LINEAR_TAGS:
        ternary, scale = layer[tag]
        writer.add(prefix + tag, "ternary", list(ternary.shape), pack_ternary_matrix(ternary), scale=scale)


def export_bitnet_nxtf(out_path: str, config: dict[str, Any], embed: np.ndarray,
                        final_norm: np.ndarray, layers: list[dict[str, Any]]) -> None:
    """Convenience wrapper: write a complete model in one call (used by the
    --tiny fixture generator, which holds everything in memory already)."""
    w = NXTFWriter(out_path, config)
    write_top(w, embed, final_norm)
    for i, layer in enumerate(layers):
        write_layer(w, i, layer)
    w.finalize()


# ---------------------------------------------------------------------------
# Real-checkpoint import
# ---------------------------------------------------------------------------

def bitnet_config_from_hf(hf_cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "vocab_size": hf_cfg["vocab_size"],
        "embed_dim": hf_cfg["hidden_size"],
        "num_layers": hf_cfg["num_hidden_layers"],
        "num_heads": hf_cfg["num_attention_heads"],
        "num_kv_heads": hf_cfg["num_key_value_heads"],
        "ffn_dim": hf_cfg["intermediate_size"],
        "max_seq_len": hf_cfg["max_position_embeddings"],
        "rope_theta": float(hf_cfg["rope_theta"]),
        "rms_norm_eps": float(hf_cfg["rms_norm_eps"]),
        "bos_token_id": hf_cfg["bos_token_id"],
        "eos_token_id": hf_cfg["eos_token_id"],
    }


def import_from_hf_dir(hf_dir: str, out_path: str) -> None:
    import torch
    from safetensors import safe_open

    with open(os.path.join(hf_dir, "config.json")) as f:
        hf_cfg = json.load(f)
    cfg = bitnet_config_from_hf(hf_cfg)
    head_dim = cfg["embed_dim"] // cfg["num_heads"]

    specs = [
        ("q", "self_attn.q_proj", cfg["num_heads"] * head_dim, cfg["embed_dim"]),
        ("k", "self_attn.k_proj", cfg["num_kv_heads"] * head_dim, cfg["embed_dim"]),
        ("v", "self_attn.v_proj", cfg["num_kv_heads"] * head_dim, cfg["embed_dim"]),
        ("o", "self_attn.o_proj", cfg["embed_dim"], cfg["num_heads"] * head_dim),
        ("gate", "mlp.gate_proj", cfg["ffn_dim"], cfg["embed_dim"]),
        ("up", "mlp.up_proj", cfg["ffn_dim"], cfg["embed_dim"]),
        ("down", "mlp.down_proj", cfg["embed_dim"], cfg["ffn_dim"]),
    ]

    st_path = os.path.join(hf_dir, "model.safetensors")
    writer = NXTFWriter(out_path, cfg)

    with safe_open(st_path, framework="pt", device="cpu") as f:
        def f32(name: str) -> np.ndarray:
            t = f.get_tensor(name).to(torch.float32).contiguous()
            return t.numpy()

        write_top(writer, f32("model.embed_tokens.weight"), f32("model.norm.weight"))

        for li in range(cfg["num_layers"]):
            p = f"model.layers.{li}."
            layer = {
                "attn_norm": f32(p + "input_layernorm.weight"),
                "ffn_norm": f32(p + "post_attention_layernorm.weight"),
                "attn_sub_norm": f32(p + "self_attn.attn_sub_norm.weight"),
                "ffn_sub_norm": f32(p + "mlp.ffn_sub_norm.weight"),
            }
            for tag, mod, out_f, in_f in specs:
                packed = f.get_tensor(p + mod + ".weight").numpy()  # uint8
                ternary = hf_unpack_packed(packed, out_f)
                if ternary.shape != (out_f, in_f):
                    raise ValueError(f"{p}{mod}: unpacked shape {ternary.shape}, want {(out_f, in_f)}")
                scale = float(f.get_tensor(p + mod + ".weight_scale").to(torch.float32).item())
                layer[tag] = (ternary, scale)
            write_layer(writer, li, layer)
            del layer

    writer.finalize()
    print(f"[import_bitnet] wrote {out_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hf-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--out", default="data/forge/bitnet-2b4t/bitnet.nxtf")
    args = ap.parse_args()
    import_from_hf_dir(args.hf_dir, args.out)


if __name__ == "__main__":
    main()
