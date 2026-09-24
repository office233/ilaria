"""bitnet_tiny_reference.py — produce the Go<->PyTorch equivalence fixture
for BitNet b1.58 inference (cortex/bitnet.go, cortex/bitnet_linear.go).

Ground truth for the math is the installed `transformers` package:
  - transformers/models/bitnet/modeling_bitnet.py   (BitNetRMSNorm, RoPE,
    GQA repeat_kv, eager attention, BitNetMLP, BitNetDecoderLayer,
    BitNetModel/BitNetForCausalLM composition)
  - transformers/integrations/bitnet.py             (AutoBitLinear — the
    "offline" forward path actually used by the real 2B4T checkpoint:
    weight is already-ternary {-1,0,1}, activations go through ActQuant,
    then the matmul output is rescaled by the stored `weight_scale`.)

This script builds a real BitNetForCausalLM with tiny dimensions (2 layers,
hidden 32, 4 heads / 2 kv heads, ffn 48, vocab 64), so BitNetRMSNorm /
apply_rotary_pos_emb / repeat_kv / eager_attention_forward / BitNetMLP /
BitNetDecoderLayer all run as the real HF code. Every nn.Linear that HF
would replace with AutoBitLinear (q/k/v/o/gate/up/down — NOT lm_head, which
stays a plain tied float linear per the Go API contract) is swapped for a
FixedBitLinear module that reproduces AutoBitLinear.forward's offline branch
exactly, reusing the real `ActQuant` autograd Function for activation
quantization (so the fixture captures PyTorch's actual round-half-to-even
behaviour, not an approximation of it):

    AutoBitLinear.forward (offline branch), transformers/integrations/bitnet.py:299-312
        weight = self.weight                    # already ternary, no WeightQuant
        input = ActQuant.apply(input)            # per-token int8 fake-quant
        output = F.linear(input, weight, bias)   # bias is always None here
        output = output * self.weight_scale      # rescale by the absmean weight scale

The ternary weight + weight_scale pair for each linear is generated the same
way BitNet's offline quantizer would: scale = mean(|W|).clamp(min=1e-5),
T = round(W / scale).clamp(-1, 1) — see WeightQuant.forward in the same file
(transformers/integrations/bitnet.py:219-226) for the reference formula.

Dumps a JSON fixture (weights + a fixed input + reference logits) that
cortex/bitnet_test.go reads to build an equivalent cortex.BitNetModel and
compare Forward() logits.

    python forge/bitnet_tiny_reference.py
"""

from __future__ import annotations

import json
import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")  # torch.compile needs a
# C compiler that isn't available in this environment; ActQuant/WeightQuant
# are @torch.compile-decorated in transformers/integrations/bitnet.py, so
# disable dynamo and fall back to eager instead of failing the build.

import torch
import torch.nn as nn
import torch.nn.functional as F

from transformers.integrations.bitnet import ActQuant
from transformers.models.bitnet.configuration_bitnet import BitNetConfig
from transformers.models.bitnet.modeling_bitnet import BitNetForCausalLM

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

VOCAB = 64
HIDDEN = 32
FFN = 48
LAYERS = 2
HEADS = 4
KV_HEADS = 2
ROPE_THETA = 10000.0
RMS_EPS = 1e-5
SEED = 0


class FixedBitLinear(nn.Module):
    """Mirrors AutoBitLinear.forward's offline branch exactly (see module
    docstring). `weight` holds pre-ternarized {-1,0,1} values; bias is
    always absent (attention_bias=False, BitNetMLP linears are bias=False).
    """

    def __init__(self, weight: torch.Tensor, weight_scale: torch.Tensor):
        super().__init__()
        self.register_buffer("weight", weight)
        self.register_buffer("weight_scale", weight_scale)
        self.in_features = weight.shape[1]
        self.out_features = weight.shape[0]

    def forward(self, x):
        q = ActQuant.apply(x)
        y = F.linear(q, self.weight)
        return y * self.weight_scale


def ternarize(out_f: int, in_f: int, gen: torch.Generator, std: float = 1.0):
    w = torch.randn(out_f, in_f, generator=gen) * std
    scale = w.abs().mean().clamp(min=1e-5)
    t = torch.clamp(torch.round(w / scale), -1, 1)
    return t, scale


def dump_bitlinear(mod: FixedBitLinear) -> dict:
    return {
        "in": mod.in_features,
        "out": mod.out_features,
        "weight": mod.weight.to(torch.int8).tolist(),
        "scale": float(mod.weight_scale.item()),
    }


def main() -> None:
    gen = torch.Generator().manual_seed(SEED)
    torch.manual_seed(SEED)

    cfg = BitNetConfig(
        vocab_size=VOCAB,
        hidden_size=HIDDEN,
        intermediate_size=FFN,
        num_hidden_layers=LAYERS,
        num_attention_heads=HEADS,
        num_key_value_heads=KV_HEADS,
        max_position_embeddings=64,
        rms_norm_eps=RMS_EPS,
        rope_parameters={"rope_type": "default", "rope_theta": ROPE_THETA},
        attention_bias=False,
        tie_word_embeddings=True,
    )
    model = BitNetForCausalLM(cfg).float()
    model.eval()

    # Randomize every RMSNorm weight away from the default all-ones so the
    # fixture actually exercises the elementwise scale (BitNetRMSNorm.weight
    # is nn.Parameter(torch.ones(hidden_size)) at construction — see
    # modeling_bitnet.py:50).
    def randomize_norm(w: nn.Parameter):
        w.data = 1.0 + 0.2 * torch.randn(w.shape, generator=gen)

    randomize_norm(model.model.norm.weight)
    for layer in model.model.layers:
        randomize_norm(layer.input_layernorm.weight)
        randomize_norm(layer.post_attention_layernorm.weight)
        randomize_norm(layer.self_attn.attn_sub_norm.weight)
        randomize_norm(layer.mlp.ffn_sub_norm.weight)

    layer_fixtures = []
    for layer in model.model.layers:
        attn = layer.self_attn
        mlp = layer.mlp

        bl = {}
        for attr, name in [
            ("q", "q_proj"), ("k", "k_proj"), ("v", "v_proj"), ("o", "o_proj"),
        ]:
            lin = getattr(attn, name)
            t, s = ternarize(lin.out_features, lin.in_features, gen)
            fb = FixedBitLinear(t, s)
            setattr(attn, name, fb)
            bl[attr] = fb
        for attr, name in [
            ("gate", "gate_proj"), ("up", "up_proj"), ("down", "down_proj"),
        ]:
            lin = getattr(mlp, name)
            t, s = ternarize(lin.out_features, lin.in_features, gen)
            fb = FixedBitLinear(t, s)
            setattr(mlp, name, fb)
            bl[attr] = fb

        layer_fixtures.append({
            "attn_norm": layer.input_layernorm.weight.tolist(),
            "ffn_norm": layer.post_attention_layernorm.weight.tolist(),
            "attn_sub_norm": attn.attn_sub_norm.weight.tolist(),
            "ffn_sub_norm": mlp.ffn_sub_norm.weight.tolist(),
            "q": dump_bitlinear(bl["q"]),
            "k": dump_bitlinear(bl["k"]),
            "v": dump_bitlinear(bl["v"]),
            "o": dump_bitlinear(bl["o"]),
            "gate": dump_bitlinear(bl["gate"]),
            "up": dump_bitlinear(bl["up"]),
            "down": dump_bitlinear(bl["down"]),
        })

    # lm_head stays a plain tied float linear (no BitLinear) — the Go
    # contract computes logits as hidden . Embed[v], so force the tie
    # explicitly rather than trust the constructor's tie_word_embeddings
    # bookkeeping.
    model.lm_head.weight.data = model.model.embed_tokens.weight.data.clone()

    ids = [2, 5, 11, 7, 4, 9, 13, 3]
    with torch.no_grad():
        out = model(input_ids=torch.tensor([ids]))
    logits = out.logits[0]  # [T, V]

    fixture = {
        "config": {
            "vocab_size": VOCAB,
            "hidden_size": HIDDEN,
            "num_layers": LAYERS,
            "num_heads": HEADS,
            "num_kv_heads": KV_HEADS,
            "ffn_dim": FFN,
            "rope_theta": ROPE_THETA,
            "rms_norm_eps": RMS_EPS,
        },
        "embed": model.model.embed_tokens.weight.tolist(),
        "final_norm": model.model.norm.weight.tolist(),
        "layers": layer_fixtures,
        "input_ids": ids,
        "logits_last": logits[-1].tolist(),
        "logits_first": logits[0].tolist(),
        "argmax_last": int(torch.argmax(logits[-1]).item()),
    }

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "bitnet_linear_tiny.json")
    with open(path, "w") as f:
        json.dump(fixture, f)
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
