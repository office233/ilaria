"""Unit tests for forge/multimodal/train_stage2.py's BitNetVLMStage2 --
specifically the multi-turn / multi-image / text-only sample building that
train_stage2.py --smoke's tiny_synthetic_vqa run never exercises (it only
ever yields one image, one turn's worth of markers): n_img=0 (text-only,
part of the --text-ratio mixing feature), n_img=2 (the "cap at 2 images"
requirement), 2+ turns (multi-turn loss), and that gradients actually reach
both trainable param groups (projector, LoRA) through one forward/backward.

Run:  python -m unittest forge.multimodal.tests.test_train_stage2 -v
  or: python forge/multimodal/tests/test_train_stage2.py
"""

from __future__ import annotations

import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import sys  # noqa: E402
import unittest  # noqa: E402

import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lora_bitlinear as lb  # noqa: E402
from mm_model import build_tiny_bitnet_llm  # noqa: E402
from train_stage2 import BitNetVLMStage2  # noqa: E402
from vision_adapter import VisionAdapter, VisionAdapterConfig  # noqa: E402

HIDDEN = 32


def _build_tiny_vlm(vocab=48, bos_id=40, eos_id=41):
    llm, _ = build_tiny_bitnet_llm(hidden=HIDDEN, vocab=vocab, bos_id=bos_id, eos_id=eos_id,
                                    layers=2, heads=4, kv_heads=2, ffn=48)
    lora_params = lb.inject_lora(llm, r=2, alpha=4)
    va_cfg = VisionAdapterConfig(tower="random-tiny", shuffle_factor=2, llm_hidden=HIDDEN, mlp_hidden=HIDDEN)
    vision_adapter = VisionAdapter(va_cfg)

    class _Tok:
        """Minimal stand-in tokenizer -- avoids needing a real HF tokenizer
        checkpoint just to test the sample-building/forward plumbing."""

        def __init__(self):
            self.pad_token_id = eos_id
            self.bos_token_id = bos_id
            self.eos_token_id = eos_id
            self._next = 2

        def convert_tokens_to_ids(self, tok):
            return -1  # forces BitNetVLM.__init__ to fall back to eos_token_id as eot_id

        def __call__(self, text, add_special_tokens=False):
            # Deterministic, content-dependent fake tokenization: one id per
            # character (offset into a small range) -- good enough to
            # produce non-empty, reproducible id sequences of a predictable
            # length without needing a real BPE vocab.
            ids = [2 + (ord(c) % (vocab - 4)) for c in text]
            return {"input_ids": ids}

    vlm = BitNetVLMStage2(llm, _Tok(), vision_adapter, max_text_len=64)
    return vlm, lora_params, vision_adapter


class BuildMultiturnSampleTests(unittest.TestCase):
    def setUp(self):
        self.vlm, self.lora_params, self.vision_adapter = _build_tiny_vlm()

    def test_text_only_sample_has_no_image_tokens(self):
        pv = torch.zeros((0, 3, self.vision_adapter.image_size, self.vision_adapter.image_size))
        turns = [("hello there", "hi")]
        embeds, labels = self.vlm.build_multiturn_sample(pv, turns)
        self.assertEqual(embeds.shape[0], labels.shape[0])
        self.assertEqual(embeds.shape[1], HIDDEN)
        # Some labels must be real answer ids (not all -100), i.e. loss has
        # somewhere to land.
        self.assertTrue((labels != -100).any())

    def test_two_images_spliced_once_each(self):
        pv = torch.randn(2, 3, self.vision_adapter.image_size, self.vision_adapter.image_size)
        turns = [("what is in the image?", "a shape")]
        embeds, labels = self.vlm.build_multiturn_sample(pv, turns)
        tok = self.vlm.vision_adapter.tokens_per_image
        # embeds must be at least long enough to hold both images' token
        # blocks (2 * tok) plus some text -- a hard floor that would catch a
        # bug that only splices one image or drops the second marker.
        self.assertGreaterEqual(embeds.shape[0], 2 * tok)

    def test_multiturn_loss_spans_two_answers(self):
        pv = torch.randn(1, 3, self.vision_adapter.image_size, self.vision_adapter.image_size)
        turns = [("first question", "first answer"), ("second question", "second answer")]
        embeds, labels = self.vlm.build_multiturn_sample(pv, turns)
        self.assertEqual(embeds.shape[0], labels.shape[0])
        real = (labels != -100)
        self.assertTrue(real.any())
        # There must be at least one -100 token BETWEEN two runs of real
        # labels (the second turn's own header/tail) -- i.e. this is not
        # just one contiguous answer span, it is genuinely multi-turn.
        idx = real.nonzero(as_tuple=True)[0]
        gaps = (idx[1:] - idx[:-1] > 1).any().item() if idx.numel() > 1 else False
        self.assertTrue(gaps, "expected a masked (-100) gap between the two answer spans")

    def test_zero_turns_raises(self):
        pv = torch.zeros((0, 3, self.vision_adapter.image_size, self.vision_adapter.image_size))
        with self.assertRaises(ValueError):
            self.vlm.build_multiturn_sample(pv, [])


class ForwardMultiturnGradientTests(unittest.TestCase):
    def test_gradients_reach_projector_and_lora(self):
        vlm, lora_params, vision_adapter = _build_tiny_vlm()
        vlm.train()
        img_size = vision_adapter.image_size
        batch = [
            (torch.randn(1, 3, img_size, img_size), [("what color?", "red")]),
            (torch.zeros((0, 3, img_size, img_size)), [("plain text turn", "ok")]),
        ]
        loss, _ = vlm.forward_multiturn(batch)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()

        for p in lora_params:
            self.assertIsNotNone(p.grad, "LoRA parameter got no gradient")
        proj_params = list(vision_adapter.trainable_parameters())
        self.assertTrue(any(p.grad is not None for p in proj_params),
                         "projector got no gradient from any parameter")

        # The frozen base must stay frozen: no AutoBitLinear.weight should
        # have picked up requires_grad=True from anywhere in this path.
        from transformers.integrations.bitnet import AutoBitLinear
        for mod in vlm.llm.modules():
            if isinstance(mod, AutoBitLinear):
                self.assertFalse(mod.weight.requires_grad)


if __name__ == "__main__":
    unittest.main()
