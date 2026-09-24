"""forge/bitnet_reference.py — ground-truth logits from the real
`transformers` BitNet implementation, for cortex/bitnet_equivalence_test.go
to check the Go engine (cortex/bitnet.go, cortex/bitnet_linear.go) against.

Two modes:

  (default) loads the real 2.4B microsoft/bitnet-b1.58-2B-4T checkpoint
    from --hf-dir with `AutoModelForCausalLM.from_pretrained(...,
    torch_dtype=torch.float32, low_cpu_mem_usage=True)`, tokenizes 6
    prompts (3 English, 3 Romanian), and writes
    data/forge/bitnet-2b4t/logits_ref.json.

  --tiny builds a small synthetic BitNet (2 layers, hidden 32, 4 heads /
    2 kv heads, ffn 48, vocab 64) with ONLINE ternary quantization, runs
    it on synthetic token-id prompts, and exports the ternary weights it
    actually used through forge/import_bitnet.py's write_top/write_layer
    — the SAME importer code path the real checkpoint goes through — to
    forge/fixtures/bitnet_tiny.nxtf, with matching reference logits at
    forge/fixtures/bitnet_tiny.json. This exercises the whole chain
    (quantize -> pack -> NXTF -> Go load -> Go forward) without needing
    the 2.4B checkpoint.

IMPORTANT: `transformers`' BitNet quantization ops (WeightQuant.forward,
ActQuant.forward, BitLinear.activation_quant/post_quant_process, and the
top-level unpack_weights used by AutoBitLinear's state-dict load hook) are
all decorated with @torch.compile. On this machine that tries to invoke
MSVC (`cl.exe`) via the inductor backend and fails with "Compiler: cl is
not found". Disabling TorchDynamo makes @torch.compile a no-op (falls back
to eager — bit-exact, just slower), so the env var below is set before
`torch` is imported anywhere in the process.

    python forge/bitnet_reference.py --tiny
    python forge/bitnet_reference.py --hf-dir data/pretrained/bitnet-b1.58-2B-4T \
        --out-dir data/forge/bitnet-2b4t
"""

from __future__ import annotations

import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import argparse  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_bitnet import NXTFWriter, write_layer, write_top  # noqa: E402

EN_PROMPTS = [
    "The capital of France is",
    "In machine learning, a neural network is",
    "She opened the door and",
]
RO_PROMPTS = [
    "Capitala Romaniei este",
    "Inteligenta artificiala este un domeniu care",
    "A deschis usa si",
]

GREEDY_TOKENS_REAL = 8
GREEDY_TOKENS_TINY = 5


def greedy_generate(model, ids: list[int], max_new: int, eos_token_id: int | None) -> list[int]:
    """Manual no-KV-cache greedy loop — matches
    BitNetModel.GenerateGreedy's "recompute Forward over the whole
    sequence so far" approach exactly, so both sides do the identical
    sequence of forward passes."""
    cur = torch.tensor([ids], dtype=torch.long)
    generated: list[int] = []
    for _ in range(max_new):
        with torch.no_grad():
            out = model(cur)
        nxt = int(out.logits[0, -1].argmax())
        generated.append(nxt)
        cur = torch.cat([cur, torch.tensor([[nxt]], dtype=torch.long)], dim=1)
        if eos_token_id is not None and nxt == eos_token_id:
            break
    return generated


def run_prompt(model, ids: list[int], max_new: int, eos_token_id: int | None) -> dict:
    input_ids = torch.tensor([ids], dtype=torch.long)
    with torch.no_grad():
        out = model(input_ids)
    logits = out.logits[0].to(torch.float32)  # (T, V)
    return {
        "ids": ids,
        "logits_last": [round(float(x), 6) for x in logits[-1].tolist()],
        "argmax": [int(v) for v in logits.argmax(dim=-1).tolist()],
        "greedy_continuation": greedy_generate(model, ids, max_new, eos_token_id),
    }


# ---------------------------------------------------------------------------
# Real 2.4B checkpoint
# ---------------------------------------------------------------------------

def _fix_unmaterialized_offline_weights(model, hf_dir: str) -> int:
    """Works around a loading bug observed with the installed transformers
    5.3.0 + this checkpoint: `AutoModelForCausalLM.from_pretrained(...,
    torch_dtype=torch.float32, low_cpu_mem_usage=True)` completes without
    error and produces a model whose AutoBitLinear.weight_scale buffers are
    correctly loaded, but whose `.weight` tensors are LEFT PACKED — dtype
    torch.uint8 instead of the unpacked ternary float the offline
    (non-online-quant) AutoBitLinear.forward requires. Forward then raises:

        RuntimeError: expected m1 and m2 to have the same dtype,
        but got: float != unsigned char
        (transformers/integrations/bitnet.py:309, AutoBitLinear.forward,
         output = F.linear(input, weight, self.bias))

    AutoBitLinear.load_hook (bitnet.py:288-297) is supposed to unpack the
    checkpoint's raw uint8 tensor via `unpack_weights(..., dtype=self.
    weight.dtype)` before torch's normal state-dict copy runs, but
    apparently doesn't fire (or fires with the wrong target dtype) on this
    from_pretrained code path — root cause not fully isolated, but the
    symptom is 100% reproducible: after loading, every offline AutoBitLinear
    module's `.weight` is still torch.uint8 (confirmed via
    `mod.weight.dtype` on `model.model.layers[0].self_attn.q_proj` right
    after `from_pretrained` returns).

    Rather than silently reporting a failure or downloading the separate
    bf16 (non-quantized) repo this task allows as a fallback, this re-reads
    each affected module's raw packed tensor straight from the SAME
    already-local model.safetensors and unpacks it with
    forge/import_bitnet.py's hf_unpack_packed — the exact function this
    file's own NXTF importer uses and that cortex/bitnet_equivalence_test.go
    already validates end-to-end via the tiny fixture — then assigns the
    result as the module's new weight Parameter. No network access, no
    extra files. Returns the number of modules fixed (210 for the real
    checkpoint: 30 layers x 7 BitLinear projections)."""
    from safetensors import safe_open
    from transformers.integrations.bitnet import AutoBitLinear

    fixed = 0
    st_path = os.path.join(hf_dir, "model.safetensors")
    with safe_open(st_path, framework="pt", device="cpu") as f:
        for name, mod in model.named_modules():
            if isinstance(mod, AutoBitLinear) and not mod.online_quant and mod.weight.dtype == torch.uint8:
                packed = f.get_tensor(name + ".weight").numpy()
                from import_bitnet import hf_unpack_packed  # local import: keeps the fix self-contained
                ternary = hf_unpack_packed(packed, mod.out_features)
                if ternary.shape != (mod.out_features, mod.in_features):
                    raise ValueError(f"{name}: unpacked shape {ternary.shape}, want {(mod.out_features, mod.in_features)}")
                mod.weight = torch.nn.Parameter(torch.from_numpy(ternary.astype(np.float32)), requires_grad=False)
                fixed += 1
    return fixed


def run_real(hf_dir: str, out_dir: str) -> None:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(hf_dir)
    try:
        model = AutoModelForCausalLM.from_pretrained(
            hf_dir, torch_dtype=torch.float32, low_cpu_mem_usage=True,
        )
    except Exception as e:
        print(f"[bitnet_reference] FAILED to load the offline-packed checkpoint from {hf_dir!r}: {type(e).__name__}: {e}")
        print("[bitnet_reference] Not falling back to any other repo / downloading anything else automatically.")
        raise
    n_fixed = _fix_unmaterialized_offline_weights(model, hf_dir)
    print(f"[bitnet_reference] worked around from_pretrained's unmaterialized-weight bug: re-unpacked {n_fixed} AutoBitLinear modules directly from {hf_dir}/model.safetensors")
    model.eval()
    print(f"[bitnet_reference] loaded {hf_dir} in {time.time() - t0:.1f}s")

    prompts_text = EN_PROMPTS + RO_PROMPTS
    results = []
    for text in prompts_text:
        ids = tokenizer(text)["input_ids"]
        t1 = time.time()
        r = run_prompt(model, ids, GREEDY_TOKENS_REAL, model.config.eos_token_id)
        r["text"] = text
        results.append(r)
        print(f"[bitnet_reference] {text!r}: {len(ids)} ids, {time.time() - t1:.1f}s")

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "logits_ref.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"hf_dir": hf_dir, "prompts": results}, f, indent=2)
    print(f"[bitnet_reference] wrote {out_path}")


# ---------------------------------------------------------------------------
# Tiny synthetic model (online quantization) — exercises the whole chain
# without the 2.4B checkpoint.
# ---------------------------------------------------------------------------

def run_tiny(out_dir: str) -> None:
    from transformers.integrations.bitnet import AutoBitLinear, replace_with_bitnet_linear
    from transformers.models.bitnet.configuration_bitnet import BitNetConfig as HFBitNetConfig
    from transformers.models.bitnet.modeling_bitnet import BitNetForCausalLM

    torch.manual_seed(1234)
    hidden, ffn, num_layers, heads, kv_heads, vocab = 32, 48, 2, 4, 2, 64
    # Sentinel ids clearly outside the tiny vocab so greedy generation never
    # early-stops on EOS on either the Python or the Go side — keeps the
    # continuation length fixed and the comparison unambiguous.
    bos_id, eos_id = 9998, 9999

    hf_cfg = HFBitNetConfig(
        vocab_size=vocab, hidden_size=hidden, intermediate_size=ffn,
        num_hidden_layers=num_layers, num_attention_heads=heads, num_key_value_heads=kv_heads,
        max_position_embeddings=64, rope_theta=10000.0, rms_norm_eps=1e-5,
        tie_word_embeddings=True, attention_bias=False,
        bos_token_id=bos_id, eos_token_id=eos_id,
    )
    model = BitNetForCausalLM(hf_cfg)

    class _QC:
        linear_class = "autobitlinear"
        quantization_mode = "online"
        use_rms_norm = False
        rms_norm_eps = 1e-5

    replace_with_bitnet_linear(model, modules_to_not_convert=["lm_head"], quantization_config=_QC())

    # replace_with_bitnet_linear builds the new AutoBitLinear modules under
    # `with torch.device("meta")` (it's designed for the from_pretrained
    # loading path, where a state-dict load materializes them afterward).
    # We aren't loading a checkpoint, so `.weight` is left as an empty meta
    # tensor here. Left alone, F.linear(real_input, meta_weight) does NOT
    # raise — this torch version silently returns a real all-zero tensor —
    # so a forward pass "succeeds" but is meaningless. Materialize each
    # converted module's weight with real random values before running
    # anything.
    for mod in model.modules():
        if isinstance(mod, AutoBitLinear):
            w = torch.empty(mod.weight.shape, dtype=torch.float32)
            w.normal_(mean=0.0, std=1.0)
            mod.weight = torch.nn.Parameter(w, requires_grad=False)
    model.eval()

    cfg = {
        "vocab_size": vocab, "embed_dim": hidden, "num_layers": num_layers,
        "num_heads": heads, "num_kv_heads": kv_heads, "ffn_dim": ffn,
        "max_seq_len": 64, "rope_theta": 10000.0, "rms_norm_eps": 1e-5,
        "bos_token_id": bos_id, "eos_token_id": eos_id,
    }

    def ternary_and_scale(mod: "AutoBitLinear") -> tuple[np.ndarray, float]:
        """Reproduces WeightQuant.forward's formula exactly (the ternary
        codes + dequant scale AutoBitLinear.forward actually used for this
        module during the forward passes below), read straight from
        mod.weight rather than through the torch.compile-wrapped autograd
        Function — the formula is deterministic, so this is bit-exact."""
        w = mod.weight.detach().float()
        mean_abs = w.abs().mean().clamp(min=1e-5)
        scale_pt = 1.0 / mean_abs
        ternary = (w * scale_pt).round().clamp(-1, 1)
        return ternary.to(torch.int8).numpy(), float(mean_abs.item())

    os.makedirs(out_dir, exist_ok=True)
    nxtf_path = os.path.join(out_dir, "bitnet_tiny.nxtf")
    writer = NXTFWriter(nxtf_path, "bitnet", cfg)
    embed = model.model.embed_tokens.weight.detach().float().numpy()
    final_norm = model.model.norm.weight.detach().float().numpy()
    write_top(writer, embed, final_norm)

    for li in range(num_layers):
        dl = model.model.layers[li]
        layer = {
            "attn_norm": dl.input_layernorm.weight.detach().float().numpy(),
            "ffn_norm": dl.post_attention_layernorm.weight.detach().float().numpy(),
            "attn_sub_norm": dl.self_attn.attn_sub_norm.weight.detach().float().numpy(),
            "ffn_sub_norm": dl.mlp.ffn_sub_norm.weight.detach().float().numpy(),
            "q": ternary_and_scale(dl.self_attn.q_proj),
            "k": ternary_and_scale(dl.self_attn.k_proj),
            "v": ternary_and_scale(dl.self_attn.v_proj),
            "o": ternary_and_scale(dl.self_attn.o_proj),
            "gate": ternary_and_scale(dl.mlp.gate_proj),
            "up": ternary_and_scale(dl.mlp.up_proj),
            "down": ternary_and_scale(dl.mlp.down_proj),
        }
        write_layer(writer, li, layer)
    writer.finalize()
    print(f"[bitnet_reference] wrote {nxtf_path}")

    rng = np.random.default_rng(99)
    prompts = [
        [int(x) for x in rng.integers(2, vocab, size=6)],
        [int(x) for x in rng.integers(2, vocab, size=4)],
        [int(x) for x in rng.integers(2, vocab, size=8)],
    ]
    results = []
    for ids in prompts:
        r = run_prompt(model, ids, GREEDY_TOKENS_TINY, eos_id)
        r["text"] = None
        results.append(r)

    json_path = os.path.join(out_dir, "bitnet_tiny.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"config": cfg, "prompts": results}, f, indent=2)
    print(f"[bitnet_reference] wrote {json_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiny", action="store_true", help="build+run the tiny synthetic model instead of the real checkpoint")
    ap.add_argument("--hf-dir", default="data/pretrained/bitnet-b1.58-2B-4T")
    ap.add_argument("--out-dir", default="data/forge/bitnet-2b4t")
    ap.add_argument("--tiny-out-dir", default="forge/fixtures")
    args = ap.parse_args()
    if args.tiny:
        run_tiny(args.tiny_out_dir)
    else:
        run_real(args.hf_dir, args.out_dir)


if __name__ == "__main__":
    main()
