"""nxtf.py — write/read the Ilaria NXTF2BIN checkpoint format from Python.

Mirrors cortex/transformer_persist_binary.go exactly:

    magic   8 bytes  "NXTF2BIN"
    hdrLen  uint32   LE
    header  JSON     {"version": 2, "config": {...Go TransformerConfig tags...},
                      "use_tied_weights": true}
    tensors           in weightTensors() order, each:
                        ndim uint32, dims [ndim]uint32, data float32 LE

Order: TokenEmb, PosEmb, then per block
  WQ WK WV WO BQ BK BV BO W1 B1 W2 B2 LN1Gamma LN1Beta LN2Gamma LN2Beta [W3 B3]
then LNFGamma, LNFBeta.
"""

from __future__ import annotations

import json
import math
import os
import struct

import numpy as np
import torch

from ilaria_model import IlariaConfig, IlariaTransformer
from atomic_io import atomic_binary_writer

MAGIC = b"NXTF2BIN"


def _ordered_tensors(model: IlariaTransformer) -> list[torch.Tensor]:
    ts = [model.TokenEmb, model.PosEmb]
    for b in model.blocks:
        a, f = b.attn, b.ffn
        ts += [a.WQ, a.WK, a.WV, a.WO, a.BQ, a.BK, a.BV, a.BO,
               f.W1, f.B1, f.W2, f.B2,
               b.LN1Gamma, b.LN1Beta, b.LN2Gamma, b.LN2Beta]
        if f.use_swiglu:
            ts += [f.W3, f.B3]
    ts += [model.LNFGamma, model.LNFBeta]
    return ts


def save_nxtf(model: IlariaTransformer, path: str) -> None:
    header = json.dumps({
        "version": 2,
        "config": model.cfg.to_go_json(),
        "use_tied_weights": True,
    }).encode("utf-8")
    with atomic_binary_writer(path) as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        for t in _ordered_tensors(model):
            arr = model.export_tensor(t).to("cpu", torch.float32).contiguous().numpy()
            f.write(struct.pack("<I", arr.ndim))
            for d in arr.shape:
                f.write(struct.pack("<I", d))
            f.write(arr.astype("<f4", copy=False).tobytes())


def _read_exact(f, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise ValueError(f"truncated NXTF file: expected {n} bytes, got {len(data)}")
    return data


def _tensor_shapes(cfg: IlariaConfig) -> list[tuple[int, ...]]:
    d, f = cfg.embed_dim, cfg.ffn_dim
    shapes = [(cfg.vocab_size, d), (cfg.max_seq_len, d)]
    for _ in range(cfg.num_layers):
        shapes += [(d, d)] * 4 + [(d,)] * 4
        shapes += [(d, f), (f,), (f, d), (d,)] + [(d,)] * 4
        if cfg.use_swiglu:
            shapes += [(d, f), (f,)]
    return shapes + [(d,), (d,)]


def load_nxtf(path: str, device: str = "cpu", *, max_parameters: int = 256_000_000,
              max_header_bytes: int = 64 * 1024) -> IlariaTransformer:
    """Load a validated NXTF2BIN file, preflighting it BEFORE model allocation.

    The parameter limit is a resource budget, not an OS isolation boundary.
    Lower it when accepting smaller untrusted artifacts; raise it explicitly
    for trusted larger models. The binary layout is unchanged.
    """
    if type(max_parameters) is not int or max_parameters < 1:
        raise ValueError("max_parameters must be a positive integer")
    if type(max_header_bytes) is not int or max_header_bytes < 1:
        raise ValueError("max_header_bytes must be a positive integer")
    with open(path, "rb") as f:
        if _read_exact(f, 8) != MAGIC:
            raise ValueError("not an NXTF2BIN file")
        (hdr_len,) = struct.unpack("<I", _read_exact(f, 4))
        if not 0 < hdr_len <= max_header_bytes:
            raise ValueError("NXTF header exceeds limit or is empty")
        try:
            header = json.loads(_read_exact(f, hdr_len))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid NXTF JSON header") from exc
        if not isinstance(header, dict) or type(header.get("version")) is not int or header["version"] != 2:
            raise ValueError("unsupported NXTF version")
        if header.get("use_tied_weights") is not True:
            raise ValueError("this loader requires tied weights")
        c = header.get("config")
        if not isinstance(c, dict):
            raise ValueError("invalid NXTF config")
        integer_fields = ("vocab_size", "embed_dim", "num_heads", "num_layers", "ffn_dim", "max_seq_len")
        for key in integer_fields:
            if type(c.get(key)) is not int or c[key] < 1:
                raise ValueError(f"invalid NXTF config field: {key}")
        # Bound the layer count before generating the shape list.
        if c["num_layers"] > 4096:
            raise ValueError("NXTF layer count exceeds limit")
        # "ternary" files carry block matrices already quantized to {-s, 0, s};
        # they load as a plain model (no 8-bit activation rounding), since
        # re-quantizing absmean weights is not idempotent.
        for key in ("use_rope", "use_swiglu", "ternary"):
            if key in c and type(c[key]) is not bool:
                raise ValueError(f"invalid NXTF boolean field: {key}")
        eos, dropout = c.get("eos_token_id", 3), c.get("dropout_rate", 0.0)
        if type(eos) is not int or not 0 <= eos < c["vocab_size"]:
            raise ValueError("invalid NXTF EOS token")
        if type(dropout) not in (int, float) or not math.isfinite(dropout) or not 0 <= dropout < 1:
            raise ValueError("invalid NXTF dropout")
        if c["embed_dim"] % c["num_heads"]:
            raise ValueError("NXTF embed dimension must be divisible by heads")
        if c.get("use_rope", False) and (c["embed_dim"] // c["num_heads"]) % 2:
            raise ValueError("NXTF RoPE requires an even head dimension")
        cfg = IlariaConfig(**{k: c[k] for k in integer_fields}, eos_token_id=eos,
                           dropout_rate=dropout, use_rope=c.get("use_rope", False),
                           use_swiglu=c.get("use_swiglu", False))
        shapes = _tensor_shapes(cfg)
        if sum(math.prod(s) for s in shapes) > max_parameters:
            raise ValueError("NXTF parameter budget exceeded")
        size = os.fstat(f.fileno()).st_size
        offsets = []
        for shape in shapes:
            (ndim,) = struct.unpack("<I", _read_exact(f, 4))
            if ndim != len(shape):
                raise ValueError("NXTF tensor rank mismatch")
            dims = struct.unpack("<" + "I" * ndim, _read_exact(f, 4 * ndim))
            if dims != shape:
                raise ValueError(f"NXTF shape mismatch: {dims} vs {shape}")
            nbytes = 4 * math.prod(shape)
            offset = f.tell()
            if nbytes > size - offset:
                raise ValueError("truncated NXTF tensor payload")
            offsets.append((offset, nbytes))
            f.seek(nbytes, 1)
        if f.tell() != size:
            raise ValueError("unexpected trailing NXTF data")
        model = IlariaTransformer(cfg)
        with torch.no_grad():
            for t, shape, (offset, nbytes) in zip(_ordered_tensors(model), shapes, offsets):
                f.seek(offset)
                arr = np.frombuffer(_read_exact(f, nbytes), dtype="<f4").reshape(shape)
                t.copy_(torch.from_numpy(arr.copy()))
    return model.to(device)
