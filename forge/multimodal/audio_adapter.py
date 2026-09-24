"""forge/multimodal/audio_adapter.py -- frozen Whisper encoder -> "stack and
project" token reduction -> 2-layer MLP projector, producing BitNet-hidden-
sized audio embeddings for stage P4 "ears" (docs/research/2026-09-24-ilaria-
1.58-multimodal-studiu.md section 4 "Audio", plan step P4). Mirrors
vision_adapter.py's VisionAdapter as closely as the audio modality allows --
same config/adapter/`--tower random-tiny`-style shape, different token-
reduction op (temporal stacking instead of spatial pixel shuffle).

Architecture (Ultravox recipe, https://huggingface.co/fixie-ai/ultravox-v0_3):

    waveform (16 kHz, mono)
        -> WhisperFeatureExtractor: log-mel spectrogram, 80 mel bins,
           padded/truncated to the encoder's chunk_length window (30 s ->
           3000 mel frames for real whisper-small/base)
        -> frozen Whisper encoder (WhisperModel.from_pretrained(repo).encoder)
           -> [B, T_full, audio_hidden] (T_full = 1500 for whisper-small/
              -base's 30 s window: the encoder's stride-2 conv halves the
              mel frame rate, 100 mel-frames/s -> 50 encoder-frames/s)
        -> crop each sample to its REAL frame count (see `real_frame_count`)
           -- the feature extractor always pads short clips up to the full
           chunk_length window, so most of T_full is silence for any clip
           shorter than 30 s; cropping before stacking keeps that silence
           out of the LLM's input entirely, rather than feeding it padded
           embeddings the LLM would have to learn to ignore.
        -> stack_frames(k=8): concatenate each contiguous run of k encoder
           frames along the feature dim -- [T,768] -> [T/8, 8*768] for
           whisper-small (d_model=768), zero-padding T up to a multiple of
           k first if needed
        -> 2-layer MLP projector (Linear -> GELU -> Linear) -> [N, llm_hidden]
           (6144 -> 2560 -> 2560 for whisper-small at stack_factor 8 against
           BitNet b1.58 2B4T's 2560-wide embedding table)

Tensor layout for a future Go port (mirrors vision_adapter.py's own note):
stacked token j's k*audio_hidden-wide vector is the CHRONOLOGICAL
concatenation of encoder frames [j*k, (j+1)*k) -- frame 0 (earliest) occupies
feature columns [0, audio_hidden), frame k-1 (latest) occupies
[(k-1)*audio_hidden, k*audio_hidden). This module's own convention (not
required to bit-match any reference implementation, per stack_frames's own
docstring) -- a Go importer of the exported projector (export_audio_adapter.
py) must reproduce this exact concatenation order, and must independently
replicate real_frame_count's cropping (or the Go Whisper encoder's own
attention mask) so it never feeds padding-silence frames into the projector
either.

`--encoder random-tiny` builds a tiny, randomly-initialized WhisperModel (2
mel-frame-rate-preserving but otherwise shrunk: chunk_length 2 s instead of
30 s, d_model 32, 2 encoder layers) for train_stage1_audio.py's --smoke path
-- no download, no network.
"""

from __future__ import annotations

import gc
import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

ENCODER_REPOS = {
    "whisper-small": "openai/whisper-small",
    "whisper-base": "openai/whisper-base",
}

# Whisper mel front-end + encoder downsampling constants (architecture
# constants shared by every openai/whisper-* checkpoint, independent of
# model size -- see WhisperFeatureExtractor's default hop_length=160 @
# 16 kHz = 10 ms mel hop = 100 mel-frames/s, and WhisperEncoder.conv2's
# stride=2 halving that to 50 encoder-frames/s). The random-tiny encoder
# below keeps both constants so `real_frame_count` needs no config branch.
_WHISPER_MEL_HOP_SECONDS = 0.01
_WHISPER_ENCODER_STRIDE = 2


@dataclass
class AudioAdapterConfig:
    encoder: str = "whisper-small"  # "whisper-small" | "whisper-base" | "random-tiny" | any HF WhisperModel repo id
    stack_factor: int = 8           # k consecutive encoder frames concatenated along the feature dim
    llm_hidden: int = 2560          # microsoft/bitnet-b1.58-2B-4T hidden_size
    mlp_hidden: int = 0             # 0 -> defaults to llm_hidden
    freeze_encoder: bool = True

    def __post_init__(self):
        if self.stack_factor < 1:
            raise ValueError(f"stack_factor must be >= 1, got {self.stack_factor}")
        if self.mlp_hidden <= 0:
            self.mlp_hidden = self.llm_hidden

    def encoder_repo(self) -> str:
        return ENCODER_REPOS.get(self.encoder, self.encoder)

    def to_json(self) -> dict:
        return {
            "encoder": self.encoder,
            "encoder_repo": None if self.encoder == "random-tiny" else self.encoder_repo(),
            "stack_factor": self.stack_factor,
            "llm_hidden": self.llm_hidden,
            "mlp_hidden": self.mlp_hidden,
        }


def real_frame_count(n_samples: int, sampling_rate: int, max_frames: int) -> int:
    """Real (unpadded) Whisper encoder frame count for a clip of `n_samples`
    raw audio samples at `sampling_rate` Hz: ceil(seconds * 50), capped to
    `max_frames` (the encoder's own max_source_positions, i.e. the mel
    window's full length after the stride-2 conv). 50 = (1 /
    _WHISPER_MEL_HOP_SECONDS) / _WHISPER_ENCODER_STRIDE -- see this module's
    docstring for why that holds for every whisper-*/random-tiny encoder
    built here. Floored at 1 so a degenerate zero-length clip still stacks
    into exactly one (all-zero-ish) token rather than none."""
    frames_per_second = (1.0 / _WHISPER_MEL_HOP_SECONDS) / _WHISPER_ENCODER_STRIDE
    seconds = n_samples / float(sampling_rate)
    return min(max_frames, max(1, math.ceil(seconds * frames_per_second)))


def stacked_token_count(real_frames: int, k: int) -> int:
    """ceil(real_frames / k) -- the number of stacked tokens `stack_frames`
    (and therefore `AudioAdapter.forward`) produces for a clip with
    `real_frames` real (post-crop) encoder frames. Exposed standalone so
    train_stage1_audio.py / tests can size things without a full forward."""
    return -(-real_frames // k)


def stack_frames(x: torch.Tensor, k: int) -> torch.Tensor:
    """[B,T,C] encoder frames -> [B, ceil(T/k), k*C] by concatenating each
    contiguous run of k consecutive frames along the feature dim (the
    Ultravox "stack and project" recipe). Zero-pads T up to a multiple of k
    first (trailing pad) if it does not already divide evenly -- the padded
    frames are zeros, not attended-to audio, so they only slightly dilute
    the LAST stacked token's projector input; they never fabricate signal
    in any other token. See the module docstring for the exact
    (chronological) concatenation order within a stacked token, which a
    future Go port must reproduce -- this module's own convention, not
    required to bit-match any reference implementation (same caveat
    vision_adapter.pixel_shuffle documents for its own channel-concat
    order)."""
    b, t, c = x.shape
    pad = (-t) % k
    if pad:
        x = F.pad(x, (0, 0, 0, pad))  # F.pad on [B,T,C] pads the last dim first: (c_lo,c_hi, t_lo,t_hi)
        t = t + pad
    return x.reshape(b, t // k, k * c)


def _build_tiny_encoder():
    """A randomly-initialized, undownloaded Whisper encoder (+ a matching
    tiny WhisperFeatureExtractor) for --encoder random-tiny (smoke tests
    only -- not a real audio encoder). chunk_length=2s (Whisper's real
    checkpoints use 30s) keeps the smoke path fast: 200 mel frames -> 100
    encoder frames instead of 3000 -> 1500, while keeping the same mel hop
    (10 ms) and encoder stride (2) as every real whisper-* checkpoint, so
    `real_frame_count`'s 50-frames/s constant still applies unchanged."""
    from transformers import WhisperFeatureExtractor
    from transformers.models.whisper.configuration_whisper import WhisperConfig
    from transformers.models.whisper.modeling_whisper import WhisperModel

    feature_extractor = WhisperFeatureExtractor(
        feature_size=80, sampling_rate=16000, hop_length=160, chunk_length=2, n_fft=400, padding_value=0.0,
    )
    cfg = WhisperConfig(
        num_mel_bins=80, d_model=32, encoder_layers=2, encoder_attention_heads=2, encoder_ffn_dim=64,
        decoder_layers=1, decoder_attention_heads=2, decoder_ffn_dim=64,
        max_source_positions=100, max_target_positions=64,
    )
    full = WhisperModel(cfg)
    encoder = full.encoder
    full.decoder = None  # detach so `del full; gc.collect()` can reclaim the unused decoder
    del full
    gc.collect()
    return encoder, feature_extractor


def _load_real_encoder(repo: str):
    """WhisperModel.from_pretrained(repo).encoder + that repo's own
    WhisperFeatureExtractor (16 kHz, 30 s window -> 1500 encoder frames for
    whisper-small/-base, per the task spec). We keep only `.encoder` and
    drop the decoder to save memory -- same pattern as vision_adapter.py's
    _load_real_tower dropping SigLIP2's text tower."""
    from transformers import WhisperFeatureExtractor, WhisperModel

    full = WhisperModel.from_pretrained(repo, torch_dtype=torch.float32)
    encoder = full.encoder
    full.decoder = None
    del full
    gc.collect()
    feature_extractor = WhisperFeatureExtractor.from_pretrained(repo)
    return encoder, feature_extractor


class AudioAdapter(nn.Module):
    """Frozen Whisper encoder -> stack-and-project -> trainable 2-layer MLP
    projector. `.trainable_parameters()` gives the stage-1 optimizer's only
    param group (the projector)."""

    def __init__(self, config: AudioAdapterConfig):
        super().__init__()
        self.config = config
        if config.encoder == "random-tiny":
            self.encoder, self.feature_extractor = _build_tiny_encoder()
        else:
            self.encoder, self.feature_extractor = _load_real_encoder(config.encoder_repo())

        enc_cfg = self.encoder.config
        self.audio_hidden = enc_cfg.d_model
        self.max_encoder_frames = enc_cfg.max_source_positions
        self.sampling_rate = self.feature_extractor.sampling_rate

        if config.freeze_encoder:
            for p in self.encoder.parameters():
                p.requires_grad = False
            self.encoder.eval()

        proj_in = self.audio_hidden * config.stack_factor
        self.projector = nn.Sequential(
            nn.Linear(proj_in, config.mlp_hidden),
            nn.GELU(),
            nn.Linear(config.mlp_hidden, config.llm_hidden),
        )

    def trainable_parameters(self):
        return self.projector.parameters()

    def train(self, mode: bool = True):
        super().train(mode)
        if self.config.freeze_encoder:
            self.encoder.eval()  # keep the frozen encoder's dropout/etc off regardless of vlm.train()/.eval()
        return self

    def prepare_features(self, waveforms: list, sampling_rate: int = 16000):
        """waveforms: list of B 1-D numpy float32 arrays already resampled
        to `sampling_rate` (must equal self.sampling_rate, 16 kHz for every
        real Whisper checkpoint and this module's random-tiny encoder).
        Runs the frozen WhisperFeatureExtractor (log-mel, padded/truncated
        to the encoder's chunk_length window) and computes each clip's REAL
        encoder-frame count from its own raw length. Returns
        (input_features [B, n_mels, T_mel], num_frames LongTensor[B]) --
        exactly the pair `forward` expects."""
        if sampling_rate != self.sampling_rate:
            raise ValueError(f"AudioAdapter's feature extractor expects {self.sampling_rate} Hz, got {sampling_rate}")
        waveforms = list(waveforms)
        feats = self.feature_extractor(waveforms, sampling_rate=sampling_rate, return_tensors="pt")
        num_frames = torch.tensor(
            [real_frame_count(len(w), sampling_rate, self.max_encoder_frames) for w in waveforms],
            dtype=torch.long,
        )
        return feats["input_features"], num_frames

    def _encode_frames(self, input_features: torch.Tensor) -> torch.Tensor:
        if self.config.freeze_encoder:
            with torch.no_grad():
                return self.encoder(input_features).last_hidden_state
        return self.encoder(input_features).last_hidden_state

    def forward(self, input_features: torch.Tensor, num_frames=None):
        """input_features: [B, n_mels, T_mel] log-mel spectrogram (see
        `prepare_features`). num_frames: optional per-sample REAL encoder
        frame count (LongTensor or list[int], length B) -- each sample's
        encoder output is cropped to num_frames[i] BEFORE stacking, so the
        silence the feature extractor zero-padded up to its chunk_length
        window is never fed into the LLM. Omitting num_frames uses the full
        encoder length for every sample (no cropping).

        Returns [B, ceil(L/stack_factor), llm_hidden] when every sample's
        cropped length L is equal (the common case: a fixed-duration batch,
        or num_frames omitted entirely) -- OTHERWISE a length-B list of
        [ceil(L_i/stack_factor), llm_hidden] tensors, since real clip
        durations differ across a batch in general. Either return value
        indexes correctly with `embeds[i]` for sample i, which is all
        mm_model.BitNetVLM's splicing code ever does -- it does not care
        whether `embeds` is a tensor or a list."""
        encoded = self._encode_frames(input_features)  # [B, T_full, audio_hidden]
        b, t_full, _ = encoded.shape
        if num_frames is None:
            lengths = [t_full] * b
        else:
            nf = num_frames.tolist() if torch.is_tensor(num_frames) else list(num_frames)
            if len(nf) != b:
                raise ValueError(f"num_frames has {len(nf)} entries, expected batch size {b}")
            lengths = [min(int(n), t_full) for n in nf]

        dtype = self.projector[0].weight.dtype
        projected = []
        for i in range(b):
            cropped = encoded[i:i + 1, :lengths[i], :]                    # [1, L_i, audio_hidden]
            stacked = stack_frames(cropped, self.config.stack_factor)     # [1, ceil(L_i/k), k*audio_hidden]
            projected.append(self.projector(stacked[0].to(dtype)))        # [ceil(L_i/k), llm_hidden]

        if len(set(lengths)) <= 1:
            return torch.stack(projected, dim=0)
        return projected
