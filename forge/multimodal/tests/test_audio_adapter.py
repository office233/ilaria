"""Unit tests for forge/multimodal/audio_adapter.py and mm_model.BitNetVLM's
generalization to the "ears" (audio) modality (P4). Mirrors
tests/test_train_stage2.py's approach: a tiny stand-in tokenizer + a tiny
random-tiny encoder/LLM, no real checkpoint download, no network.

Gate items (task spec) covered below:
  - stack_frames shapes and pad behaviour -> StackFramesTests
  - AudioAdapter random-tiny output shape [B, ceil(T/8), 2560] ->
    AudioAdapterRandomTinyTests.test_uniform_batch_shape_matches_spec
  - BitNetVLM splice with the "<audio>" placeholder (labels mask correct)
    -> BitNetVLMAudioSpliceTests
  - a tiny end-to-end forward+backward step giving a finite loss with the
    projector receiving a gradient and the encoder/LLM receiving none ->
    ForwardBackwardTests

Run:  python -m unittest forge.multimodal.tests.test_audio_adapter -v
  or: python forge/multimodal/tests/test_audio_adapter.py
"""

from __future__ import annotations

import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import sys  # noqa: E402
import unittest  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import audio_adapter as aa  # noqa: E402
from mm_model import AUDIO_PLACEHOLDER, BitNetVLM, build_tiny_bitnet_llm  # noqa: E402


def _sine_batch(n: int, sample_rate: int = 16000, seconds: float = 1.0, freq: float = 440.0) -> list:
    t = np.arange(int(sample_rate * seconds), dtype="float32") / sample_rate
    return [(0.1 * np.sin(2.0 * np.pi * freq * t)).astype("float32") for _ in range(n)]


# ---------------------------------------------------------------------------
# stack_frames: shapes and pad behaviour
# ---------------------------------------------------------------------------

class StackFramesTests(unittest.TestCase):
    def test_exact_multiple_no_padding(self):
        # 4 frames, C=2, k=2 -> no padding needed. Values per frame = frame
        # index replicated across channels, so the chronological concat
        # order is directly checkable.
        x = torch.tensor([[[0., 0.], [1., 1.], [2., 2.], [3., 3.]]])  # [1,4,2]
        out = aa.stack_frames(x, k=2)
        self.assertEqual(out.shape, (1, 2, 4))
        self.assertTrue(torch.equal(out[0, 0], torch.tensor([0., 0., 1., 1.])))
        self.assertTrue(torch.equal(out[0, 1], torch.tensor([2., 2., 3., 3.])))

    def test_pads_to_multiple_with_zeros(self):
        # 5 frames, C=2, k=2 -> pads 1 zero frame at the end -> 3 tokens.
        x = torch.tensor([[[0., 0.], [1., 1.], [2., 2.], [3., 3.], [4., 4.]]])  # [1,5,2]
        out = aa.stack_frames(x, k=2)
        self.assertEqual(out.shape, (1, 3, 4))
        self.assertTrue(torch.equal(out[0, 0], torch.tensor([0., 0., 1., 1.])))
        self.assertTrue(torch.equal(out[0, 1], torch.tensor([2., 2., 3., 3.])))
        # Last token: real frame 4 followed by the zero-padded frame.
        self.assertTrue(torch.equal(out[0, 2], torch.tensor([4., 4., 0., 0.])))

    def test_batch_dim_preserved(self):
        x = torch.randn(3, 9, 5)
        out = aa.stack_frames(x, k=4)
        self.assertEqual(out.shape[0], 3)
        self.assertEqual(out.shape, (3, 3, 20))  # ceil(9/4)=3 tokens, 4*5=20 wide

    def test_stacked_token_count_matches_shape(self):
        for t, k in [(50, 8), (100, 8), (1, 8), (16, 4), (17, 4)]:
            x = torch.randn(1, t, 3)
            out = aa.stack_frames(x, k)
            self.assertEqual(out.shape[1], aa.stacked_token_count(t, k))


class RealFrameCountTests(unittest.TestCase):
    def test_one_second_at_16khz_is_fifty_frames(self):
        self.assertEqual(aa.real_frame_count(16000, 16000, max_frames=1500), 50)

    def test_capped_at_max_frames(self):
        self.assertEqual(aa.real_frame_count(16000 * 60, 16000, max_frames=100), 100)

    def test_floors_at_one_frame(self):
        self.assertEqual(aa.real_frame_count(0, 16000, max_frames=100), 1)


# ---------------------------------------------------------------------------
# AudioAdapter (--encoder random-tiny)
# ---------------------------------------------------------------------------

class AudioAdapterRandomTinyTests(unittest.TestCase):
    def setUp(self):
        self.cfg = aa.AudioAdapterConfig(encoder="random-tiny")  # stack_factor=8, llm_hidden=2560 (task spec)
        self.adapter = aa.AudioAdapter(self.cfg)

    def test_uniform_batch_shape_matches_spec(self):
        waves = _sine_batch(3, seconds=1.0)  # every clip the same duration -> uniform real length
        feats, num_frames = self.adapter.prepare_features(waves, sampling_rate=16000)
        out = self.adapter(feats, num_frames)
        expected_tokens = aa.stacked_token_count(int(num_frames[0]), self.cfg.stack_factor)
        self.assertTrue(torch.is_tensor(out))
        self.assertEqual(out.shape, (3, expected_tokens, 2560))

    def test_variable_length_batch_returns_list(self):
        waves = [np.zeros(16000, dtype="float32"), np.zeros(8000, dtype="float32")]
        feats, num_frames = self.adapter.prepare_features(waves, sampling_rate=16000)
        out = self.adapter(feats, num_frames)
        self.assertIsInstance(out, list)
        self.assertEqual(len(out), 2)
        for i, o in enumerate(out):
            expected_tokens = aa.stacked_token_count(int(num_frames[i]), self.cfg.stack_factor)
            self.assertEqual(o.shape, (expected_tokens, 2560))

    def test_encoder_frozen_projector_trainable(self):
        for p in self.adapter.encoder.parameters():
            self.assertFalse(p.requires_grad)
        for p in self.adapter.trainable_parameters():
            self.assertTrue(p.requires_grad)

    def test_wrong_sampling_rate_rejected(self):
        waves = _sine_batch(1, sample_rate=8000, seconds=1.0)
        with self.assertRaises(ValueError):
            self.adapter.prepare_features(waves, sampling_rate=8000)


# ---------------------------------------------------------------------------
# BitNetVLM splice with AUDIO_PLACEHOLDER
# ---------------------------------------------------------------------------

HIDDEN = 64


def _build_tiny_audio_vlm(vocab=48, bos_id=40, eos_id=41):
    llm, _ = build_tiny_bitnet_llm(hidden=HIDDEN, vocab=vocab, bos_id=bos_id, eos_id=eos_id,
                                    layers=2, heads=4, kv_heads=2, ffn=48)
    aa_cfg = aa.AudioAdapterConfig(encoder="random-tiny", llm_hidden=HIDDEN, mlp_hidden=HIDDEN)
    audio_adapter = aa.AudioAdapter(aa_cfg)

    class _Tok:
        """Minimal stand-in tokenizer -- avoids needing a real HF tokenizer
        checkpoint just to test the sample-building/forward plumbing (same
        approach as tests/test_train_stage2.py's own _Tok)."""

        def __init__(self):
            self.pad_token_id = eos_id
            self.bos_token_id = bos_id
            self.eos_token_id = eos_id

        def convert_tokens_to_ids(self, tok):
            return -1  # forces BitNetVLM.__init__ to fall back to eos_token_id as eot_id

        def __call__(self, text, add_special_tokens=False):
            ids = [2 + (ord(c) % (vocab - 4)) for c in text]
            return {"input_ids": ids}

    vlm = BitNetVLM(llm, _Tok(), audio_adapter, max_text_len=64, placeholder=AUDIO_PLACEHOLDER)
    return vlm, audio_adapter


class BitNetVLMAudioSpliceTests(unittest.TestCase):
    def setUp(self):
        self.vlm, self.audio_adapter = _build_tiny_audio_vlm()

    def test_prompt_without_marker_gets_audio_prefixed(self):
        before, after = self.vlm._split_prompt("no marker here")
        self.assertEqual(before, "")
        self.assertEqual(after, "\nno marker here")

    def test_prompt_with_marker_splits_around_it(self):
        before, after = self.vlm._split_prompt(f"listen: {AUDIO_PLACEHOLDER} what is it?")
        self.assertEqual(before, "listen: ")
        self.assertEqual(after, " what is it?")

    def test_build_sample_labels_mask_correct(self):
        waves = _sine_batch(1, seconds=1.0)
        feats, num_frames = self.audio_adapter.prepare_features(waves, sampling_rate=16000)
        audio_embeds = self.vlm.encode((feats, num_frames))  # tensor [1,N,H] (uniform batch of 1)
        prompt = f"{AUDIO_PLACEHOLDER}\nTranscribe the audio."
        answer = "hello world"
        inputs_embeds, labels = self.vlm.build_sample(prompt, answer, audio_embeds[0])

        self.assertEqual(inputs_embeds.shape[0], labels.shape[0])
        answer_ids = self.vlm._encode_text(answer.strip() + "<|eot_id|>")
        n_answer = len(answer_ids)
        # Exactly the answer span is unmasked, and it is the tail of the sequence.
        self.assertEqual(int((labels != -100).sum()), n_answer)
        self.assertEqual(labels[-n_answer:].tolist(), answer_ids)
        self.assertTrue((labels[:-n_answer] == -100).all())


# ---------------------------------------------------------------------------
# End-to-end forward/backward: finite loss, gradient isolation
# ---------------------------------------------------------------------------

class ForwardBackwardTests(unittest.TestCase):
    def test_finite_loss_and_gradient_isolation(self):
        vlm, audio_adapter = _build_tiny_audio_vlm()
        vlm.train()
        waves = _sine_batch(2, seconds=1.0)
        prompts = [f"{AUDIO_PLACEHOLDER}\nTranscribe the audio."] * 2
        answers = ["one two three", "four five six"]
        feats, num_frames = audio_adapter.prepare_features(waves, sampling_rate=16000)

        loss, logits = vlm(prompts, answers, (feats, num_frames))
        self.assertTrue(torch.isfinite(loss))
        loss.backward()

        proj_params = list(audio_adapter.trainable_parameters())
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for p in proj_params),
                         "projector got no gradient")

        for p in audio_adapter.encoder.parameters():
            self.assertIsNone(p.grad, "frozen Whisper encoder must not receive gradients")

        from transformers.integrations.bitnet import AutoBitLinear
        n_checked = 0
        for mod in vlm.llm.modules():
            if isinstance(mod, AutoBitLinear):
                self.assertFalse(mod.weight.requires_grad)
                self.assertIsNone(mod.weight.grad)
                n_checked += 1
        self.assertGreater(n_checked, 0, "sanity: the tiny LLM should have at least one AutoBitLinear module")


if __name__ == "__main__":
    unittest.main()
