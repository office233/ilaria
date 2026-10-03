"""imc_model.py — IMC (Ilaria MicroCortex), the from-scratch Ilaria architecture.

Native Ilaria decoder architecture:

    - grouped-query attention (n_kv_heads < n_heads), half-split RoPE
    - RMSNorm pre-norm, plus IMC sub-norms before the attention output
      and FFN down projections
    - gated FFN (SwiGLU, or the squared-ReLU gate), no biases anywhere
    - tied embedding / LM head
    - optional ternary block weights and 8-bit activations (native ternary IMC),
      trained with straight-through gradients on latent full-precision weights

Matrices are stored [in, out] (y = x @ W), like the rest of the forge.
Presets follow the Ilaria Myriad scale ladder 125M -> 250M -> 500M -> 1B
(sizes quoted for a 65,536-token vocabulary).
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.utils.checkpoint


def _ternarize(w: torch.Tensor) -> torch.Tensor:
    """Quantize latent weights to {-1, 0, +1} with an abs-mean scale."""
    scale = w.abs().mean().clamp(min=1e-5)
    return (w / scale).round().clamp(-1, 1) * scale


def _weight_quant(w: torch.Tensor) -> torch.Tensor:
    """Straight-through ternary weight quantization."""
    return w + (_ternarize(w) - w).detach()


def _act_quant(x: torch.Tensor) -> torch.Tensor:
    """Per-token symmetric int8 activation quantization with STE."""
    scale = 127.0 / x.abs().amax(dim=-1, keepdim=True).clamp(min=1e-5)
    q = (x * scale).round().clamp(-128, 127) / scale
    return x + (q - x).detach()


def linear(x: torch.Tensor, w: torch.Tensor, ternary: bool) -> torch.Tensor:
    """IMC matrix projection, optionally using the native ternary path."""
    return _act_quant(x) @ _weight_quant(w) if ternary else x @ w


PRESETS = {
    "imc-125m": dict(d_model=768, n_layers=12, n_heads=12, n_kv_heads=4, ffn_dim=2048),
    "imc-250m": dict(d_model=1024, n_layers=16, n_heads=16, n_kv_heads=4, ffn_dim=2816),
    "imc-500m": dict(d_model=1536, n_layers=16, n_heads=12, n_kv_heads=4, ffn_dim=4096),
    "imc-1b": dict(d_model=2048, n_layers=16, n_heads=16, n_kv_heads=4, ffn_dim=7104),
}


@dataclass(frozen=True)
class ImcConfig:
    vocab_size: int
    d_model: int
    n_layers: int
    n_heads: int
    n_kv_heads: int
    ffn_dim: int
    eos_token_id: int
    max_seq_len: int = 2048
    rope_theta: float = 10000.0
    norm_eps: float = 1e-5
    ffn_act: str = "silu"          # "silu" (SwiGLU) or "relu2" (squared ReLU)
    subln: bool = True
    ternary: bool = False

    def __post_init__(self):
        for name in ("vocab_size", "d_model", "n_layers", "n_heads", "n_kv_heads",
                     "ffn_dim", "max_seq_len"):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if type(self.eos_token_id) is not int or not 0 <= self.eos_token_id < self.vocab_size:
            raise ValueError("eos_token_id must belong to the vocabulary")
        for name in ("rope_theta", "norm_eps"):
            value = getattr(self, name)
            if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if self.d_model % self.n_heads or self.n_heads % self.n_kv_heads:
            raise ValueError("d_model must divide by n_heads and n_heads by n_kv_heads")
        if (self.d_model // self.n_heads) % 2:
            raise ValueError("RoPE needs an even head dimension")
        if self.ffn_act not in ("silu", "relu2"):
            raise ValueError("ffn_act must be 'silu' or 'relu2'")

    @classmethod
    def preset(cls, name: str, **overrides) -> "ImcConfig":
        return cls(**(PRESETS[name] | overrides))

    @property
    def head_dim(self) -> int:
        return self.d_model // self.n_heads

    def param_count(self) -> int:
        d, f, kv = self.d_model, self.ffn_dim, self.n_kv_heads * self.head_dim
        per_layer = 2 * d * d + 2 * d * kv + 3 * d * f + 2 * d + (d + f if self.subln else 0)
        return self.vocab_size * d + self.n_layers * per_layer + d

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict) -> "ImcConfig":
        return cls(**data)


class RMSNorm(nn.Module):
    def __init__(self, dim: int, eps: float):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Keep the master norm scale in FP32 for optimizer stability, but match
        # the activation dtype at compute time. PyTorch's CUDA RMSNorm fused
        # kernel requires matching input/weight dtypes; leaving the FP32
        # parameter uncast forces a much slower unfused path under BF16/FP16
        # autocast (notably on Colab G4 Blackwell).
        weight = self.weight
        if weight.dtype != x.dtype and x.dtype in (torch.float16, torch.bfloat16):
            weight = weight.to(dtype=x.dtype)
        return F.rms_norm(x, x.shape[-1:], weight, self.eps)


def rope(x: torch.Tensor, theta: float) -> torch.Tensor:
    """x: [B, H, T, hd]; Llama-style half-split rotation."""
    T, hd = x.shape[-2], x.shape[-1]
    half = hd // 2
    freqs = theta ** (-torch.arange(half, device=x.device, dtype=torch.float32) / half)
    angles = torch.arange(T, device=x.device, dtype=torch.float32)[:, None] * freqs
    cos, sin = angles.cos(), angles.sin()
    x1, x2 = x.float()[..., :half], x.float()[..., half:]
    return torch.cat((x1 * cos - x2 * sin, x1 * sin + x2 * cos), dim=-1).to(x.dtype)


def _mat(rows: int, cols: int) -> nn.Parameter:
    return nn.Parameter(torch.randn(rows, cols) / math.sqrt(rows))


class Attention(nn.Module):
    def __init__(self, cfg: ImcConfig):
        super().__init__()
        d, kv = cfg.d_model, cfg.n_kv_heads * cfg.head_dim
        self.WQ, self.WK, self.WV, self.WO = _mat(d, d), _mat(d, kv), _mat(d, kv), _mat(d, d)
        self.sub_norm = RMSNorm(d, cfg.norm_eps) if cfg.subln else None
        self.cfg = cfg

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, d = x.shape
        c, t = self.cfg, self.cfg.ternary
        q = linear(x, self.WQ, t).view(B, T, c.n_heads, c.head_dim).transpose(1, 2)
        k = linear(x, self.WK, t).view(B, T, c.n_kv_heads, c.head_dim).transpose(1, 2)
        v = linear(x, self.WV, t).view(B, T, c.n_kv_heads, c.head_dim).transpose(1, 2)
        q, k = rope(q, c.rope_theta), rope(k, c.rope_theta)
        group = c.n_heads // c.n_kv_heads
        k, v = k.repeat_interleave(group, dim=1), v.repeat_interleave(group, dim=1)
        out = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, d)
        if self.sub_norm is not None:
            out = self.sub_norm(out)
        return linear(out, self.WO, t)


class FeedForward(nn.Module):
    def __init__(self, cfg: ImcConfig):
        super().__init__()
        d, f = cfg.d_model, cfg.ffn_dim
        self.W1, self.W3, self.W2 = _mat(d, f), _mat(d, f), _mat(f, d)   # gate, up, down
        self.sub_norm = RMSNorm(f, cfg.norm_eps) if cfg.subln else None
        self.cfg = cfg

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        t = self.cfg.ternary
        gate = linear(x, self.W1, t)
        gate = F.silu(gate) if self.cfg.ffn_act == "silu" else F.relu(gate).square()
        h = gate * linear(x, self.W3, t)
        if self.sub_norm is not None:
            h = self.sub_norm(h)
        return linear(h, self.W2, t)


class Block(nn.Module):
    def __init__(self, cfg: ImcConfig):
        super().__init__()
        self.attn_norm, self.ffn_norm = RMSNorm(cfg.d_model, cfg.norm_eps), RMSNorm(cfg.d_model, cfg.norm_eps)
        self.attn, self.ffn = Attention(cfg), FeedForward(cfg)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.attn_norm(x))
        return x + self.ffn(self.ffn_norm(x))


def _ce_sum(h: torch.Tensor, emb: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    return F.cross_entropy((h @ emb.t()).float(), targets, reduction="sum")


class ImcTransformer(nn.Module):
    def __init__(self, cfg: ImcConfig):
        super().__init__()
        self.cfg = cfg
        self.TokenEmb = nn.Parameter(torch.randn(cfg.vocab_size, cfg.d_model) / math.sqrt(cfg.d_model))
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.n_layers))
        self.final_norm = RMSNorm(cfg.d_model, cfg.norm_eps)
        self.gradient_checkpointing = False

    def enable_gradient_checkpointing(self, enable: bool = True) -> None:
        self.gradient_checkpointing = enable

    def hidden(self, ids: torch.Tensor) -> torch.Tensor:
        x = self.TokenEmb[ids]
        for blk in self.blocks:
            if self.gradient_checkpointing and self.training:
                x = torch.utils.checkpoint.checkpoint(blk, x, use_reentrant=False)
            else:
                x = blk(x)
        return self.final_norm(x)

    def forward(self, ids: torch.Tensor, targets: torch.Tensor | None = None,
                loss_chunk_tokens: int = 8192) -> torch.Tensor:
        """Logits, or with targets the mean cross-entropy computed chunk by
        chunk: each chunk's logits are recomputed in backward instead of kept,
        so the full [tokens, vocab] matrix never exists. Going through
        forward keeps DDP gradient hooks and torch.compile in the path."""
        if targets is not None:
            if targets.shape != ids.shape or targets.numel() == 0:
                raise ValueError("targets must be nonempty and match the input shape")
            if type(loss_chunk_tokens) is not int or loss_chunk_tokens < 1:
                raise ValueError("loss_chunk_tokens must be a positive integer")
        h = self.hidden(ids)
        if targets is None:
            return h @ self.TokenEmb.t()
        h, t = h.reshape(-1, h.shape[-1]), targets.reshape(-1)
        total = h.new_zeros((), dtype=torch.float32)
        for s in range(0, t.numel(), loss_chunk_tokens):
            total = total + torch.utils.checkpoint.checkpoint(
                _ce_sum, h[s:s + loss_chunk_tokens], self.TokenEmb, t[s:s + loss_chunk_tokens],
                use_reentrant=False)
        return total / t.numel()

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    @torch.no_grad()
    def generate_greedy(self, ids: list[int], max_new: int) -> list[int]:
        self.eval()
        out = list(ids)
        for _ in range(max_new):
            ctx = torch.tensor(out[-self.cfg.max_seq_len:], device=self.TokenEmb.device)[None, :]
            nxt = int(torch.argmax(self(ctx)[0, -1]))
            out.append(nxt)
            if nxt == self.cfg.eos_token_id:
                break
        return out


def save_imc(model: ImcTransformer, path: str) -> None:
    """Latent weights plus config. Ternary runtimes quantize at load time
    (absmean re-quantization is not idempotent, so pre-quantized weights
    are never stored here); packed deployment formats come from this file."""
    from atomic_io import atomic_binary_writer
    state = {k: v.detach().cpu() for k, v in model.state_dict().items()}
    with atomic_binary_writer(path) as f:
        torch.save({"format": "imc-v1", "config": json.dumps(model.cfg.to_json()), "model": state}, f)


def load_imc(path: str, device: str = "cpu") -> ImcTransformer:
    data = torch.load(path, map_location=device, weights_only=True)
    if not isinstance(data, dict) or data.get("format") != "imc-v1":
        raise ValueError("not an imc-v1 file")
    model = ImcTransformer(ImcConfig.from_json(json.loads(data["config"])))
    model.load_state_dict(data["model"], strict=True)
    return model.to(device)
