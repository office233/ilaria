"""ilaria_model.py — the PyTorch twin of cortex.MiniTransformer.

THE CONTRACT
------------
Every tensor here has the SAME name, shape and orientation as its Go
counterpart, so a checkpoint round-trips between the forge and the
organism without a single transpose:

    Go MatMul is row-vector:  y = x @ W  with W laid out [in, out].
    -> parameters are stored [in, out] here too (NOT nn.Linear's [out, in]).

    RoPE rotates INTERLEAVED pairs (2j, 2j+1) within each head, with
    theta = pos * base^(-2j/headDim), base 10000 — cortex/transformer_rope.go.
    (Llama-style half-split rotation would silently break equivalence.)

    GELU is the tanh approximation (Go tensor.GELU == gelu_new).
    SwiGLU: act = SiLU(x@W1+b1) * (x@W3+b3); out = act@W2+b2.
    Pre-LN blocks + final LN, eps 1e-5, tied LM head (logits = h @ TokenEmb^T).
    Heads are contiguous headDim slices of the embed dim.

cortex/forge_equivalence_test.go loads a model exported from here and
asserts identical logits. If you change anything above, that test is
the alarm.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict

import torch
import torch.nn as nn
import torch.nn.functional as F


@dataclass
class IlariaConfig:
    vocab_size: int
    embed_dim: int = 384
    num_heads: int = 6
    num_layers: int = 6
    ffn_dim: int = 1536
    max_seq_len: int = 1024
    eos_token_id: int = 3
    dropout_rate: float = 0.0
    use_rope: bool = False
    use_swiglu: bool = False

    def to_go_json(self) -> dict:
        """Keys == Go TransformerConfig json tags (omitempty ones included
        explicitly; Go ignores zero values identically)."""
        return {
            "vocab_size": self.vocab_size,
            "embed_dim": self.embed_dim,
            "num_heads": self.num_heads,
            "num_layers": self.num_layers,
            "ffn_dim": self.ffn_dim,
            "max_seq_len": self.max_seq_len,
            "eos_token_id": self.eos_token_id,
            "dropout_rate": self.dropout_rate,
            "use_rope": self.use_rope,
            "use_swiglu": self.use_swiglu,
        }


def _mat(rows: int, cols: int, std: float) -> nn.Parameter:
    return nn.Parameter(torch.randn(rows, cols) * std)


def _vec(n: int, fill: float = 0.0) -> nn.Parameter:
    return nn.Parameter(torch.full((n,), fill))


def apply_rope(x: torch.Tensor, pos_offset: int, head_dim: int, base: float = 10000.0) -> torch.Tensor:
    """x: [B, T, H, hd]. Interleaved-pair rotation, identical to Go applyRoPE."""
    B, T, H, hd = x.shape
    half = hd // 2
    pos = torch.arange(pos_offset, pos_offset + T, device=x.device, dtype=torch.float32)
    j = torch.arange(half, device=x.device, dtype=torch.float32)
    theta = pos[:, None] * base ** (-2.0 * j / hd)          # [T, half]
    sin, cos = torch.sin(theta), torch.cos(theta)          # [T, half]
    sin = sin[None, :, None, :]                             # [1, T, 1, half]
    cos = cos[None, :, None, :]
    xp = x.float().view(B, T, H, half, 2)
    x0, x1 = xp[..., 0], xp[..., 1]
    r0 = x0 * cos - x1 * sin
    r1 = x0 * sin + x1 * cos
    out = torch.stack((r0, r1), dim=-1).view(B, T, H, hd)
    return out.to(x.dtype)


class Attention(nn.Module):
    def __init__(self, cfg: IlariaConfig):
        super().__init__()
        d = cfg.embed_dim
        std = 1.0 / math.sqrt(d)
        self.WQ, self.WK, self.WV, self.WO = (_mat(d, d, std) for _ in range(4))
        self.BQ, self.BK, self.BV, self.BO = (_vec(d) for _ in range(4))
        self.num_heads = cfg.num_heads
        self.head_dim = d // cfg.num_heads
        self.use_rope = cfg.use_rope
        self.dropout = cfg.dropout_rate

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, d = x.shape
        H, hd = self.num_heads, self.head_dim
        q = (x @ self.WQ + self.BQ).view(B, T, H, hd)
        k = (x @ self.WK + self.BK).view(B, T, H, hd)
        v = (x @ self.WV + self.BV).view(B, T, H, hd)
        if self.use_rope:
            q = apply_rope(q, 0, hd)
            k = apply_rope(k, 0, hd)
        # SDPA wants [B, H, T, hd]
        q, k, v = (t.transpose(1, 2) for t in (q, k, v))
        out = F.scaled_dot_product_attention(
            q, k, v, is_causal=True,
            dropout_p=self.dropout if self.training else 0.0,
            scale=1.0 / math.sqrt(hd),
        )
        out = out.transpose(1, 2).reshape(B, T, d)
        return out @ self.WO + self.BO


class FeedForward(nn.Module):
    def __init__(self, cfg: IlariaConfig):
        super().__init__()
        d, f = cfg.embed_dim, cfg.ffn_dim
        self.W1 = _mat(d, f, 1.0 / math.sqrt(d))
        self.B1 = _vec(f)
        self.W2 = _mat(f, d, 1.0 / math.sqrt(f))
        self.B2 = _vec(d)
        self.use_swiglu = cfg.use_swiglu
        if cfg.use_swiglu:
            self.W3 = _mat(d, f, 1.0 / math.sqrt(d))
            self.B3 = _vec(f)
        self.dropout = cfg.dropout_rate

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = x @ self.W1 + self.B1
        if self.use_swiglu:
            act = F.silu(h) * (x @ self.W3 + self.B3)
        else:
            act = F.gelu(h, approximate="tanh")
        act = F.dropout(act, self.dropout, self.training)
        return act @ self.W2 + self.B2


class Block(nn.Module):
    def __init__(self, cfg: IlariaConfig):
        super().__init__()
        d = cfg.embed_dim
        self.attn = Attention(cfg)
        self.ffn = FeedForward(cfg)
        self.LN1Gamma, self.LN1Beta = _vec(d, 1.0), _vec(d)
        self.LN2Gamma, self.LN2Beta = _vec(d, 1.0), _vec(d)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(F.layer_norm(x, x.shape[-1:], self.LN1Gamma, self.LN1Beta, 1e-5))
        x = x + self.ffn(F.layer_norm(x, x.shape[-1:], self.LN2Gamma, self.LN2Beta, 1e-5))
        return x


class IlariaTransformer(nn.Module):
    def __init__(self, cfg: IlariaConfig):
        super().__init__()
        self.cfg = cfg
        d = cfg.embed_dim
        std = 1.0 / math.sqrt(d)
        self.TokenEmb = _mat(cfg.vocab_size, d, std)
        # Allocated even under RoPE: Go allocates it too and the binary
        # format always carries it (untrained/unused when use_rope).
        self.PosEmb = _mat(cfg.max_seq_len, d, std)
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.num_layers))
        self.LNFGamma, self.LNFBeta = _vec(d, 1.0), _vec(d)
        self.gradient_checkpointing = False

    def enable_gradient_checkpointing(self, enable: bool = True) -> None:
        self.gradient_checkpointing = enable

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        B, T = ids.shape
        x = self.TokenEmb[ids]
        if not self.cfg.use_rope:
            x = x + self.PosEmb[:T][None, :, :]
        for blk in self.blocks:
            if self.gradient_checkpointing and self.training:
                import torch.utils.checkpoint
                x = torch.utils.checkpoint.checkpoint(blk, x, use_reentrant=False)
            else:
                x = blk(x)
        x = F.layer_norm(x, x.shape[-1:], self.LNFGamma, self.LNFBeta, 1e-5)
        return x @ self.TokenEmb.t()

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    @torch.no_grad()
    def generate_greedy(self, ids: list[int], max_new: int) -> list[int]:
        self.eval()
        dev = self.TokenEmb.device
        out = list(ids)
        for _ in range(max_new):
            ctx = torch.tensor(out[-self.cfg.max_seq_len:], device=dev)[None, :]
            logits = self(ctx)[0, -1]
            nxt = int(torch.argmax(logits))
            out.append(nxt)
            if nxt == self.cfg.eos_token_id:
                break
        return out
