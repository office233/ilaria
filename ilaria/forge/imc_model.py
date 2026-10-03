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
from dataclasses import asdict, dataclass, field
from typing import Callable
import sys
import time
import weakref

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


class InferenceCancelled(RuntimeError):
    """A caller cancelled or the explicitly supplied monotonic deadline elapsed."""


@dataclass(frozen=True)
class InferencePolicy:
    """Explicit inference-only limits; no changes to checkpoint/model config.

    max_cache_bytes covers owned cache tensor storage, Python metadata and a
    conservative reservation for old/new KV staging, token validation and
    GQA/rotary buffers. Cached inference requires homogeneous model dtypes.
    It is not a bound on the model, SDPA workspace or total process RAM.
    """
    max_cache_bytes: int
    max_tokens: int
    max_batch: int
    max_total_tokens: int
    deadline: float | None = None
    cancelled: Callable[[], bool] | None = field(default=None, repr=False)

    def __post_init__(self):
        for name in ("max_cache_bytes", "max_tokens", "max_batch", "max_total_tokens"):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.deadline is not None and (type(self.deadline) not in (int, float)
                or not math.isfinite(self.deadline) or self.deadline <= 0):
            raise ValueError("deadline must be a finite positive monotonic time")
        if self.cancelled is not None and not callable(self.cancelled):
            raise ValueError("cancelled must be callable")

    def check(self):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise InferenceCancelled("inference deadline elapsed")
        if self.cancelled is not None:
            value = self.cancelled()
            if type(value) is not bool:
                raise ValueError("cancelled must return bool")
            if value:
                raise InferenceCancelled("inference cancelled")

    def binding(self):
        return (self.max_cache_bytes, self.max_tokens, self.max_batch,
                self.max_total_tokens, self.deadline, id(self.cancelled))


def _tensor_stamp(t):
    storage = t.untyped_storage()
    return (t.data_ptr(), t._version, tuple(t.shape), t.dtype, t.device,
            tuple(t.stride()), t.storage_offset(), storage.data_ptr(), storage.nbytes())


def _storage_bytes(tensors):
    capacities = {}
    for t in tensors:
        storage = t.untyped_storage()
        # Views can have distinct tensor pointers into the same allocation.
        key = (t.device, storage.data_ptr())
        required = (t.storage_offset() + 1 + sum((size - 1) * stride
                    for size, stride in zip(t.shape, t.stride()))) * t.element_size()
        if required > storage.nbytes():
            raise ValueError("inference state has undersized tensor storage")
        capacities[key] = storage.nbytes()
    return sum(capacities.values())


def _python_bytes(value, seen=None):
    # Count metadata without following model references or tensor storage twice.
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    size = sys.getsizeof(value)
    if isinstance(value, (tuple, list)):
        size += sum(_python_bytes(x, seen) for x in value)
    elif isinstance(value, dict):
        size += sum(_python_bytes(k, seen) + _python_bytes(v, seen) for k, v in value.items())
    elif isinstance(value, InferenceState):
        size += _python_bytes(value.__dict__, seen)
    return size


@dataclass(frozen=True)
class InferenceState:
    """Per-stream snapshot. Returned only after all layers and checks succeed.

    Caller-owned snapshots must not be mutated or retained without accounting
    their bytes in an outer process budget. No state is stored on the module.
    """
    _model_ref: object = field(repr=False)
    _signature: tuple = field(repr=False)
    _stream: str = field(repr=False)
    _policy: tuple = field(repr=False)
    _layers: tuple = field(repr=False)
    _tokens: torch.Tensor = field(repr=False)
    _stamps: tuple = field(repr=False)
    total_tokens: int
    cache_bytes: int
    reserved_bytes: int
    rebuilt: bool

    @property
    def position(self):
        return self._tokens.shape[1]

    def _tensors(self):
        return (self._tokens,) + tuple(t for pair in self._layers for t in pair)

    def _metadata(self):
        return (self.total_tokens, self.position, self._stream, self._signature,
                self._policy, self.reserved_bytes, self.cache_bytes, self.rebuilt)

    def _seal(self):
        tensors = self._tensors()
        capacity = _storage_bytes(tensors)
        stamps = tuple(_tensor_stamp(t) for t in tensors)
        # The final stamps and byte counter themselves occupy metadata. Count
        # the complete snapshot, including them, before publishing it.
        for _ in range(4):
            object.__setattr__(self, "_stamps", (self._metadata(),) + stamps)
            actual = capacity + _python_bytes(self)
            if actual == self.cache_bytes:
                return actual
            object.__setattr__(self, "cache_bytes", actual)
        raise ValueError("inference storage accounting did not stabilize")

    def _validate_tensors(self):
        if not isinstance(self._model_ref, weakref.ReferenceType) or self._model_ref() is None:
            raise ValueError("inference state binding mismatch")
        model = self._model_ref()
        cfg = model.cfg
        if (not isinstance(self._tokens, torch.Tensor) or self._tokens.layout != torch.strided
                or self._tokens.ndim != 2 or self._tokens.dtype != torch.long
                or self._tokens.device != model.TokenEmb.device
                or min(self._tokens.shape) < 1):
            raise ValueError("malformed inference token storage")
        if (type(self._layers) is not tuple or len(self._layers) != cfg.n_layers
                or any(type(pair) is not tuple or len(pair) != 2 for pair in self._layers)):
            raise ValueError("malformed inference layer storage")
        expected = (self._tokens.shape[0], cfg.n_kv_heads, self.position, cfg.head_dim)
        if any(not isinstance(t, torch.Tensor) or t.layout != torch.strided
               or tuple(t.shape) != expected or t.dtype != model.TokenEmb.dtype
               or t.device != model.TokenEmb.device or t.requires_grad
               for pair in self._layers for t in pair):
            raise ValueError("malformed inference KV storage shape or dtype")
        if (type(self.total_tokens) is not int or self.total_tokens < self.position
                or type(self.rebuilt) is not bool):
            raise ValueError("inference state metadata changed")
        if (type(self._policy) is not tuple or len(self._policy) != 6
                or any(type(limit) is not int or limit < 1 for limit in self._policy[:4])
                or self.position > min(cfg.max_seq_len, self._policy[1])
                or self._tokens.shape[0] > self._policy[2]
                or self.total_tokens > self._policy[3]):
            raise ValueError("inference state exceeds token or batch bounds")
        if (type(self.cache_bytes) is not int or type(self.reserved_bytes) is not int
                or not 0 < self.cache_bytes <= self.reserved_bytes <= self._policy[0]):
            raise ValueError("invalid inference storage accounting")
        tensors = self._tensors()
        if (self._metadata(),) + tuple(_tensor_stamp(t) for t in tensors) != self._stamps:
            raise ValueError("inference state tensor changed or metadata changed")
        actual = _storage_bytes(tensors) + _python_bytes(self)
        if actual != self.cache_bytes:
            raise ValueError("inference storage accounting does not match retained capacity")
        return actual


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


def rope(x: torch.Tensor, theta: float, offset: int = 0) -> torch.Tensor:
    """x: [B, H, T, hd]; Llama-style half-split rotation."""
    T, hd = x.shape[-2], x.shape[-1]
    half = hd // 2
    freqs = theta ** (-torch.arange(half, device=x.device, dtype=torch.float32) / half)
    positions = torch.arange(T, device=x.device, dtype=torch.float32) if offset == 0 else torch.arange(offset, offset + T, device=x.device, dtype=torch.float32)
    angles = positions[:, None] * freqs
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

    def forward(self, x: torch.Tensor, *, cache=None, offset: int = 0, collect=None) -> torch.Tensor:
        B, T, d = x.shape
        c, t = self.cfg, self.cfg.ternary
        q = linear(x, self.WQ, t).view(B, T, c.n_heads, c.head_dim).transpose(1, 2)
        k = linear(x, self.WK, t).view(B, T, c.n_kv_heads, c.head_dim).transpose(1, 2)
        v = linear(x, self.WV, t).view(B, T, c.n_kv_heads, c.head_dim).transpose(1, 2)
        q, k = rope(q, c.rope_theta, offset), rope(k, c.rope_theta, offset)
        if cache is not None:
            k, v = torch.cat((cache[0], k), dim=2), torch.cat((cache[1], v), dim=2)
        if collect is not None:
            collect.append((k, v))
        group = c.n_heads // c.n_kv_heads
        k, v = k.repeat_interleave(group, dim=1), v.repeat_interleave(group, dim=1)
        if offset:
            # Align rectangular queries to their absolute positions, not to key 0.
            mask = torch.arange(k.shape[2], device=x.device)[None, :] <= (offset + torch.arange(T, device=x.device))[:, None]
            attended = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, is_causal=False)
        else:
            attended = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        out = attended.transpose(1, 2).reshape(B, T, d)
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

    def forward(self, x: torch.Tensor, *, cache=None, offset: int = 0, collect=None) -> torch.Tensor:
        if collect is None:
            x = x + self.attn(self.attn_norm(x))
        else:
            x = x + self.attn(self.attn_norm(x), cache=cache, offset=offset, collect=collect)
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

    def _inference_signature(self, weights_epoch):
        if type(weights_epoch) is not int or weights_epoch < 0:
            raise ValueError("weights_epoch must be a nonnegative integer")
        if any(m.training for m in self.modules()):
            raise ValueError("cached inference requires eval mode")
        if torch.is_inference_mode_enabled():
            raise ValueError("cache version bindings require no_grad, not inference_mode")
        if torch.is_autocast_enabled(self.TokenEmb.device.type):
            raise ValueError("cached inference requires explicit dtype, without autocast")
        dtype, device = self.TokenEmb.dtype, self.TokenEmb.device
        if dtype not in (torch.float16, torch.bfloat16, torch.float32, torch.float64) or any(
                p.layout != torch.strided or p.dtype != dtype or p.device != device
                for p in self.parameters()):
            raise ValueError("cached inference requires homogeneous supported floating weights")
        configs = (self.cfg,) + tuple(b.attn.cfg for b in self.blocks) + tuple(b.ffn.cfg for b in self.blocks)
        compute_fields = ("d_model", "n_heads", "n_kv_heads", "ffn_dim", "rope_theta",
                          "norm_eps", "ffn_act", "subln", "ternary")
        if len(self.blocks) != self.cfg.n_layers or any(
                any(getattr(c, name) != getattr(self.cfg, name) for name in compute_fields)
                for c in configs):
            raise ValueError("cached inference requires consistent layer configuration")
        return (weights_epoch, tuple(tuple(asdict(c).items()) for c in configs),
                tuple((name, id(p), *_tensor_stamp(p)) for name, p in self.named_parameters()))

    @torch.no_grad()
    def inference_step(self, ids: torch.Tensor, *, policy: InferencePolicy,
                       stream_id: str, weights_epoch: int, state: InferenceState | None = None,
                       evict: bool = False) -> tuple[torch.Tensor, InferenceState]:
        """Consume new tokens and return last-position logits plus a new snapshot.

        Chunks are homogeneous batches. On window rollover or explicit eviction,
        recompute the complete canonical cropped window; do not trim old KV.
        """
        if not isinstance(policy, InferencePolicy):
            raise ValueError("inference policy required")
        policy.check()
        if type(stream_id) is not str or not 1 <= len(stream_id) <= 128 or not stream_id.isascii() or any(not (c.isalnum() or c in "_.:-") for c in stream_id):
            raise ValueError("stream_id must be a bounded ASCII identifier")
        if type(evict) is not bool:
            raise ValueError("evict must be bool")
        signature = self._inference_signature(weights_epoch)
        if not isinstance(ids, torch.Tensor) or ids.layout != torch.strided or ids.ndim != 2 or ids.dtype != torch.long or ids.device != self.TokenEmb.device:
            raise ValueError("ids must be a 2D int64 tensor on the model device")
        input_stamp, policy_binding = _tensor_stamp(ids), policy.binding()
        batch, count = ids.shape
        if batch < 1 or batch > policy.max_batch or count < 1 or policy.max_tokens > self.cfg.max_seq_len:
            raise ValueError("inference batch/token bounds")
        previous, old_bytes, total = 0, 0, count
        if state is not None:
            if not isinstance(state, InferenceState) or not isinstance(state._model_ref, weakref.ReferenceType) or state._model_ref() is not self or state._signature != signature or state._stream != stream_id or state._policy != policy.binding():
                raise ValueError("inference state binding mismatch")
            old_bytes = state._validate_tensors()
            if state._tokens.shape[0] != batch:
                raise ValueError("inference state binding mismatch")
            previous = state.position
            total += state.total_tokens
        if total > policy.max_total_tokens:
            raise ValueError("inference total token budget")
        length = min(previous + count, self.cfg.max_seq_len)
        if length > policy.max_tokens:
            raise ValueError("inference cache token budget")
        rebuilt = state is None or evict or previous + count > self.cfg.max_seq_len
        offset = 0 if rebuilt else previous
        processed = length if rebuilt else count
        c, element = self.cfg, self.TokenEmb.element_size()
        kv = 2 * batch * c.n_kv_heads * length * c.head_dim * element
        # Old snapshots stay live until commit. Reserve the entire replacement,
        # metadata and conservative per-layer rotary/concat/GQA temporary storage.
        metadata = _python_bytes(signature) + _python_bytes(policy.binding()) + _python_bytes(stream_id) + 4096 + (2 * c.n_layers + 1) * 2048
        validation_bytes = 3 * batch * count + 1
        reserve = old_bytes + c.n_layers * kv + batch * length * 8 + metadata + kv * (4 * max(4, element) // element + c.n_heads // c.n_kv_heads) + processed * length + validation_bytes
        if reserve > policy.max_cache_bytes:
            raise ValueError("inference cache byte budget")
        if bool(((ids < 0) | (ids >= c.vocab_size)).any()):
            raise ValueError("token id outside vocabulary")
        policy.check()
        if count >= length:
            tokens = ids[:, -length:].clone()
        else:
            tokens = torch.cat((state._tokens[:, -(length-count):], ids), dim=1)
        active = tokens if rebuilt else ids
        x, staged = self.TokenEmb[active], []
        for i, block in enumerate(self.blocks):
            policy.check()
            x = block(x, cache=None if rebuilt else state._layers[i], offset=offset, collect=staged)
        x = self.final_norm(x)
        logits = x[:, -1] @ self.TokenEmb.t()
        policy.check()
        if _tensor_stamp(ids) != input_stamp or policy.binding() != policy_binding:
            raise ValueError("input or inference policy changed during inference")
        try:
            final_signature = self._inference_signature(weights_epoch)
        except ValueError as error:
            raise ValueError("model changed during inference") from error
        if final_signature != signature:
            raise ValueError("model changed during inference")
        if state is not None:
            state._validate_tensors()
        candidate = InferenceState(weakref.ref(self), signature, stream_id, policy.binding(), tuple(staged), tokens,
                                   (), total, 0, reserve, rebuilt)
        actual = candidate._seal()
        if old_bytes + actual > reserve or actual > policy.max_cache_bytes:
            raise ValueError("inference storage exceeds admitted reservation")
        candidate._validate_tensors()
        return logits, candidate

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    @torch.no_grad()
    def generate_greedy(self, ids: list[int], max_new: int, *, inference_policy: InferencePolicy | None = None,
                        stream_id: str | None = None, weights_epoch: int | None = None) -> list[int]:
        self.eval()
        out = list(ids)
        if inference_policy is not None:
            if type(max_new) is not int or max_new < 0 or not out:
                raise ValueError("cached generation requires nonempty ids and nonnegative max_new")
            state = None
            chunk = torch.tensor(out, dtype=torch.long, device=self.TokenEmb.device)[None, :]
            for _ in range(max_new):
                logits, candidate = self.inference_step(chunk, policy=inference_policy,
                                                       stream_id=stream_id, weights_epoch=weights_epoch, state=state)
                nxt = int(torch.argmax(logits[0]))
                inference_policy.check()
                out.append(nxt)
                state = candidate
                if nxt == self.cfg.eos_token_id:
                    break
                chunk = torch.tensor([[nxt]], dtype=torch.long, device=self.TokenEmb.device)
            return out
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
