"""Unit tests for forge/multimodal/lora_bitlinear.py.

Run:  python -m unittest forge.multimodal.tests.test_lora_bitlinear -v
  or: python forge/multimodal/tests/test_lora_bitlinear.py

Gate item (task spec): "a unit test that LoRABitLinear with B=0 reproduces
the base output exactly and with random A/B matches a reference
computation." Both are covered below (test_zero_b_matches_base_exactly,
test_random_ab_matches_reference_computation), parametrized over BOTH
AutoBitLinear quantization modes (online -- the --base bf16 case; offline --
the --base offline case) since LoRABitLinear must be correct for either.
"""

from __future__ import annotations

import os

# Must be set before torch is imported -- see lora_bitlinear.py's / forge/
# bitnet_reference.py's module docstrings (transformers' BitNet
# quantization ops are @torch.compile-decorated; the inductor backend fails
# on this machine for lack of a working C compiler / Triton).
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import sys  # noqa: E402
import unittest  # noqa: E402

import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lora_bitlinear as lb  # noqa: E402


def _make_base(online_quant: bool, in_features=12, out_features=8, bias=False, seed=0):
    from transformers.integrations.bitnet import AutoBitLinear

    torch.manual_seed(seed)
    base = AutoBitLinear(in_features=in_features, out_features=out_features, bias=bias, online_quant=online_quant)
    if not online_quant:
        # offline mode dequantizes via `output * self.weight_scale`; give it
        # a non-trivial scale so a bug that ignores weight_scale would show
        # up as a mismatch, not accidentally cancel out.
        base.weight_scale.data.fill_(1.7)
    return base


class LoRABitLinearTests(unittest.TestCase):
    def _check_zero_b_matches_base(self, online_quant: bool):
        base = _make_base(online_quant, seed=1)
        wrapped = lb.LoRABitLinear(base, r=4, alpha=8, dropout=0.0)
        x = torch.randn(3, 5, base.in_features)

        base_out = base(x)
        wrapped_out = wrapped(x)

        self.assertTrue(torch.equal(base_out, wrapped_out),
                         f"online_quant={online_quant}: B=0 should reproduce base(x) exactly")

    def test_zero_b_matches_base_exactly_online(self):
        self._check_zero_b_matches_base(online_quant=True)

    def test_zero_b_matches_base_exactly_offline(self):
        self._check_zero_b_matches_base(online_quant=False)

    def _check_random_ab_matches_reference(self, online_quant: bool):
        base = _make_base(online_quant, seed=2)
        r, alpha = 4, 10  # alpha/r = 2.5, deliberately not 1 or an integer multiple of r
        wrapped = lb.LoRABitLinear(base, r=r, alpha=alpha, dropout=0.0)

        torch.manual_seed(3)
        with torch.no_grad():
            wrapped.lora_A.copy_(torch.randn(r, base.in_features))
            wrapped.lora_B.copy_(torch.randn(base.out_features, r))

        x = torch.randn(6, base.in_features)

        with torch.no_grad():
            base_out = base(x)
            scaling = alpha / r
            expected_delta = (x @ wrapped.lora_A.T @ wrapped.lora_B.T) * scaling
            expected = base_out + expected_delta

            actual = wrapped(x)

        torch.testing.assert_close(actual, expected, rtol=1e-5, atol=1e-6)

    def test_random_ab_matches_reference_computation_online(self):
        self._check_random_ab_matches_reference(online_quant=True)

    def test_random_ab_matches_reference_computation_offline(self):
        self._check_random_ab_matches_reference(online_quant=False)

    def test_dropout_present_is_identity_in_eval(self):
        # With dropout > 0, forward should still equal the reference
        # computation once the module is in eval() (nn.Dropout is a no-op
        # then) -- catches an accidental always-on dropout bug.
        base = _make_base(online_quant=True, seed=4)
        r, alpha = 4, 8
        wrapped = lb.LoRABitLinear(base, r=r, alpha=alpha, dropout=0.3)
        wrapped.eval()
        torch.manual_seed(5)
        with torch.no_grad():
            wrapped.lora_A.copy_(torch.randn(r, base.in_features))
            wrapped.lora_B.copy_(torch.randn(base.out_features, r))
        x = torch.randn(4, base.in_features)
        with torch.no_grad():
            expected = base(x) + (x @ wrapped.lora_A.T @ wrapped.lora_B.T) * (alpha / r)
            actual = wrapped(x)
        torch.testing.assert_close(actual, expected, rtol=1e-5, atol=1e-6)

    def test_merge_lora_raises(self):
        base = _make_base(online_quant=False, seed=6)
        with self.assertRaises(NotImplementedError):
            lb.merge_lora(base)

    def test_inject_lora_and_state_dict_roundtrip(self):
        # Uses the project's own tiny BitNet stand-in (same one
        # train_stage1.py --smoke / train_stage2.py --smoke use) so this
        # exercises inject_lora/lora_state_dict/load_lora_state_dict against
        # a real (if tiny) BitNetForCausalLM module tree, not a hand-rolled
        # AutoBitLinear.
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from mm_model import build_tiny_bitnet_llm  # noqa: E402

        llm, _ = build_tiny_bitnet_llm(hidden=16, vocab=32, bos_id=0, eos_id=1, layers=2, heads=2, kv_heads=1, ffn=24)
        trainable = lb.inject_lora(llm, r=2, alpha=4)
        n_modules = len(lb.lora_modules(llm))
        self.assertEqual(n_modules, 2 * len(lb.DEFAULT_TARGETS))  # 2 layers x 7 targets
        self.assertEqual(len(trainable), 2 * n_modules)  # lora_A + lora_B per module
        for p in trainable:
            self.assertTrue(p.requires_grad)

        state = lb.lora_state_dict(llm)
        self.assertEqual(set(state.keys()), set(lb.lora_modules(llm).keys()))

        # Perturb one module's A, then reload the saved state and check it
        # is restored exactly.
        some_name, some_mod = next(iter(lb.lora_modules(llm).items()))
        with torch.no_grad():
            some_mod.lora_A.add_(1.0)
        n_loaded = lb.load_lora_state_dict(llm, state, strict=True)
        self.assertEqual(n_loaded, n_modules)
        torch.testing.assert_close(some_mod.lora_A, state[some_name]["A"])

    def test_inject_lora_no_matches_raises(self):
        import torch.nn as nn
        plain = nn.Sequential(nn.Linear(4, 4))
        with self.assertRaises(ValueError):
            lb.inject_lora(plain, targets=["q_proj"])

    def test_export_key_parses_layer_and_proj(self):
        self.assertEqual(lb.export_key("model.layers.3.self_attn.q_proj"), "lora.layers.3.q_proj")
        self.assertEqual(lb.export_key("model.layers.12.mlp.down_proj"), "lora.layers.12.down_proj")
        with self.assertRaises(ValueError):
            lb.export_key("model.embed_tokens")


if __name__ == "__main__":
    unittest.main()
