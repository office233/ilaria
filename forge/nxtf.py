"""nxtf.py — write/read the Nexus NXTF2BIN checkpoint format from Python.

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
import struct

import numpy as np
import torch

from ilaria_model import IlariaConfig, IlariaTransformer

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
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        for t in _ordered_tensors(model):
            arr = t.detach().to("cpu", torch.float32).contiguous().numpy()
            f.write(struct.pack("<I", arr.ndim))
            for d in arr.shape:
                f.write(struct.pack("<I", d))
            f.write(arr.astype("<f4", copy=False).tobytes())


def load_nxtf(path: str, device: str = "cpu") -> IlariaTransformer:
    with open(path, "rb") as f:
        assert f.read(8) == MAGIC, "not an NXTF2BIN file"
        (hdr_len,) = struct.unpack("<I", f.read(4))
        header = json.loads(f.read(hdr_len))
        c = header["config"]
        cfg = IlariaConfig(
            vocab_size=c["vocab_size"], embed_dim=c["embed_dim"],
            num_heads=c["num_heads"], num_layers=c["num_layers"],
            ffn_dim=c["ffn_dim"], max_seq_len=c["max_seq_len"],
            eos_token_id=c.get("eos_token_id", 3),
            dropout_rate=c.get("dropout_rate", 0.0),
            use_rope=c.get("use_rope", False), use_swiglu=c.get("use_swiglu", False),
        )
        model = IlariaTransformer(cfg)
        for t in _ordered_tensors(model):
            (ndim,) = struct.unpack("<I", f.read(4))
            dims = struct.unpack("<" + "I" * ndim, f.read(4 * ndim))
            assert tuple(dims) == tuple(t.shape), f"shape mismatch {dims} vs {tuple(t.shape)}"
            n = int(np.prod(dims))
            arr = np.frombuffer(f.read(4 * n), dtype="<f4").reshape(dims)
            with torch.no_grad():
                t.copy_(torch.from_numpy(arr.copy()))
    return model.to(device)
