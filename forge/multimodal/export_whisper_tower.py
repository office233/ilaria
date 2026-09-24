"""forge/multimodal/export_whisper_tower.py -- exports the frozen Whisper
ENCODER (openai/whisper-small by default -- never fine-tuned by
train_stage1_audio.py, see audio_adapter.AudioAdapterConfig.freeze_encoder)
plus the log-mel front end's mel filterbank into NXTF v3
(`whisper_small_encoder.nxtf`, magic "NXTF3BIN", arch "whisper_encoder"),
the format cortex.LoadWhisperEncoderTower (cortex/audio_whisper_persist.go)
reads.

`--tiny` exports audio_adapter._build_tiny_encoder()'s random,
undownloaded encoder instead -- the SAME construction code
forge/multimodal/audio_adapter.py's own `--encoder random-tiny` /
tests/test_audio_adapter.py smoke path uses (chunk_length=2s, d_model=32,
2 layers, no network) -- so the Go "synthetic small-config" test
(cortex/audio_whisper_test.go) exercises a real (if tiny) trained-shape
encoder rather than a hand-rolled duplicate. `--seed` (default 0) is set
via torch.manual_seed immediately before construction so a paired
dump_audio_reference.py --tiny --seed <same> run reproduces the identical
random weights.

Ground truth: forge/multimodal/audio_adapter.py's `_load_real_encoder` /
`_build_tiny_encoder` (the exact loading code this script reuses) and the
installed `transformers` 5.3.0 source (transformers/models/whisper/
modeling_whisper.py: WhisperEncoder/WhisperEncoderLayer/WhisperAttention;
transformers/models/whisper/feature_extraction_whisper.py:
WhisperFeatureExtractor) for openai/whisper-small -- see
cortex/audio_whisper.go's own doc comment for the full architecture
writeup this mirrors.

Checkpoint facts (openai/whisper-small, verified via config.json +
preprocessor_config.json in the downloaded HF cache):

  - d_model=768, encoder_layers=12, encoder_attention_heads=12,
    encoder_ffn_dim=3072, num_mel_bins=80, max_source_positions=1500,
    activation_function="gelu" -- transformers' ACT2FN["gelu"] is
    GELUActivation() -> nn.functional.gelu with approximate="none", the
    EXACT erf formula (confirmed by reading activations.py directly), the
    same variant SigLIP2's projector GELU uses (see geluExactInPlace's doc
    comment in cortex/vision_siglip.go, reused unchanged by
    cortex/audio_whisper.go) -- NOT gelu_pytorch_tanh (the vision TOWER's
    own activation, which this encoder does not use).
  - LayerNorm eps: PyTorch's nn.LayerNorm default (1e-5) --
    WhisperEncoderLayer never passes an eps override, unlike SigLIP2's
    custom 1e-6.
  - self_attn.k_proj has bias=False in WhisperAttention.__init__
    (`nn.Linear(embed_dim, embed_dim, bias=False)`) -- every other
    projection (q/v/out) has a bias. A zero bias vector is written for
    k_proj instead of omitting it, so cortex/audio_whisper.go's attention
    code can add a bias to every projection uniformly (adding zero is a
    no-op) rather than special-casing k.
  - WhisperAttention scales Q by head_dim**-0.5 BEFORE reshaping to heads
    and calls the attention kernel with scaling=1.0 baked in -- this is
    mathematically identical to scaling the Q.K^T score matrix afterward
    (as cortex/vision_siglip.go's siglipAttention and this file's
    whisperAttention both do), just a different place to multiply the same
    scalar -- not a separate thing to port.
  - Feature extractor (preprocessor_config.json): n_fft=400, hop_length=160,
    chunk_length=30 (-> n_samples=chunk_length*sampling_rate=480000,
    nb_max_frames=n_samples//hop_length=3000 at the default 16 kHz),
    mel_filters shape (num_freq_bins=1+n_fft//2=201, num_mel_filters=80).
    Exported TRANSPOSED to [num_mel_bins,num_freq_bins]=[80,201]
    (mel-major, one dot product per output mel bin) as a plain f32 tensor,
    so the Go loader needs no librosa/slaney-mel-filter implementation at
    all -- see cortex/audio_whisper.go's LogMel doc comment for the STFT
    math (reflect-padded framing, periodic Hann window, real DFT) it must
    still implement itself, since only the mel filterbank matrix is
    exported.

Tensor layout: every tensor float32, kind "f32" (no ternary weights).
nn.Linear stores weight [out,in]; cortex's own dense-layer convention is
the opposite -- row-vector y = x @ W laid out [in,out] (same convention
forge/multimodal/export_tower.py uses for SigLIP2) -- so every q/k/v/
out_proj/fc1/fc2 weight is transposed before writing. nn.Conv1d stores
weight [out_channels,in_channels,kernel_size]; flattened per-output-channel
(in_channels,kernel) cube row-major (in_channels outermost, kernel
innermost -- one dimension shorter than SigLIP2's Conv2d flatten, same
principle: matches cortex/audio_whisper.go's conv1dGeluForward unfold
order exactly) then transposed to cortex's [in_channels*kernel,out].

Tensor names (per-layer i, 0-based) match
cortex/audio_whisper_persist.go's LoadWhisperEncoderTower exactly:

    conv1.weight [in=num_mel_bins*3,out=hidden] / conv1.bias [hidden]
    conv2.weight [in=hidden*3,out=hidden] / conv2.bias [hidden]
    embed_positions.weight [max_source_positions,hidden]
    layers.<i>.ln1.weight / .bias          (self_attn_layer_norm)
    layers.<i>.ln2.weight / .bias          (final_layer_norm)
    layers.<i>.attn.q.weight [hidden,hidden] / .q.bias [hidden]
    layers.<i>.attn.k.weight / .k.bias     (.bias is zeros -- see above)
    layers.<i>.attn.v.weight / .v.bias
    layers.<i>.attn.out.weight / .out.bias (WhisperAttention.out_proj)
    layers.<i>.mlp.fc1.weight [hidden,intermediate] / .fc1.bias [intermediate]
    layers.<i>.mlp.fc2.weight [intermediate,hidden] / .fc2.bias [hidden]
    final_layernorm.weight / .bias         (WhisperEncoder.layer_norm)
    mel_filters.weight [num_mel_bins,num_freq_bins]

Usage:
    python forge/multimodal/export_whisper_tower.py \\
        --repo openai/whisper-small \\
        --out data/forge/ears/whisper_small_encoder.nxtf
    python forge/multimodal/export_whisper_tower.py --tiny \\
        --out data/forge/ears/whisper_tiny_encoder.nxtf
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from nxtf3 import NXTFWriter, f32_bytes  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audio_adapter as aa  # noqa: E402


def _transpose(w: np.ndarray) -> np.ndarray:
    """nn.Linear weight [out,in] -> cortex [in,out]."""
    return np.ascontiguousarray(w.T)


def _flatten_conv1d(conv_weight: np.ndarray) -> np.ndarray:
    """Conv1d weight [out,in_ch,kernel] -> cortex linear [in=in_ch*kernel,out]
    -- flatten each output channel's (in_ch,kernel) cube row-major (matches
    cortex/audio_whisper.go's conv1dGeluForward unfold order exactly), then
    transpose [out,in] -> [in,out]."""
    out_c = conv_weight.shape[0]
    flat = conv_weight.reshape(out_c, -1)  # [out, in_ch*kernel], row-major over (in_ch,kernel)
    return _transpose(flat)


def export_whisper_encoder(encoder, feature_extractor, out_path: str) -> None:
    """encoder: a `transformers` WhisperEncoder nn.Module (from
    audio_adapter._load_real_encoder or _build_tiny_encoder -- either way,
    weights are read directly off the live module via .state_dict()-style
    attribute access, no safetensors file needed for the --tiny path,
    which has none). feature_extractor: the matching WhisperFeatureExtractor
    (supplies n_fft/hop_length/chunk_length/sampling_rate/mel_filters)."""
    encoder.eval()
    cfg = encoder.config

    num_mel_bins = cfg.num_mel_bins
    hidden = cfg.d_model
    num_layers = cfg.encoder_layers
    num_heads = cfg.encoder_attention_heads
    intermediate = cfg.encoder_ffn_dim
    max_source_positions = cfg.max_source_positions
    activation = cfg.activation_function
    if activation != "gelu":
        raise ValueError(
            f"unsupported activation_function {activation!r} -- "
            "cortex/audio_whisper.go only implements the exact erf-based gelu"
        )

    n_fft = feature_extractor.n_fft
    hop_length = feature_extractor.hop_length
    chunk_length = feature_extractor.chunk_length
    sampling_rate = feature_extractor.sampling_rate
    num_freq_bins = 1 + n_fft // 2

    header_cfg = {
        "num_mel_bins": num_mel_bins,
        "hidden_size": hidden,
        "num_layers": num_layers,
        "num_heads": num_heads,
        "intermediate_size": intermediate,
        "max_source_positions": max_source_positions,
        "n_fft": n_fft,
        "hop_length": hop_length,
        "chunk_length": chunk_length,
        "sampling_rate": sampling_rate,
        "num_freq_bins": num_freq_bins,
        "layer_norm_eps": 1e-5,
        "hidden_act": activation,
    }

    writer = NXTFWriter(out_path, "whisper_encoder", header_cfg)

    def f32(t: torch.Tensor) -> np.ndarray:
        return t.detach().to(torch.float32).contiguous().numpy()

    conv1_w = _flatten_conv1d(f32(encoder.conv1.weight))
    writer.add("conv1.weight", "f32", list(conv1_w.shape), f32_bytes(conv1_w))
    conv1_b = f32(encoder.conv1.bias)
    writer.add("conv1.bias", "f32", list(conv1_b.shape), f32_bytes(conv1_b))

    conv2_w = _flatten_conv1d(f32(encoder.conv2.weight))
    writer.add("conv2.weight", "f32", list(conv2_w.shape), f32_bytes(conv2_w))
    conv2_b = f32(encoder.conv2.bias)
    writer.add("conv2.bias", "f32", list(conv2_b.shape), f32_bytes(conv2_b))

    pos_w = f32(encoder.embed_positions.weight)  # [max_source_positions,hidden] already
    writer.add("embed_positions.weight", "f32", list(pos_w.shape), f32_bytes(pos_w))

    for li in range(num_layers):
        layer = encoder.layers[li]
        gp = f"layers.{li}."

        ln1_w, ln1_b = f32(layer.self_attn_layer_norm.weight), f32(layer.self_attn_layer_norm.bias)
        writer.add(gp + "ln1.weight", "f32", list(ln1_w.shape), f32_bytes(ln1_w))
        writer.add(gp + "ln1.bias", "f32", list(ln1_b.shape), f32_bytes(ln1_b))
        ln2_w, ln2_b = f32(layer.final_layer_norm.weight), f32(layer.final_layer_norm.bias)
        writer.add(gp + "ln2.weight", "f32", list(ln2_w.shape), f32_bytes(ln2_w))
        writer.add(gp + "ln2.bias", "f32", list(ln2_b.shape), f32_bytes(ln2_b))

        attn = layer.self_attn
        q_w = _transpose(f32(attn.q_proj.weight))
        q_b = f32(attn.q_proj.bias)
        writer.add(gp + "attn.q.weight", "f32", list(q_w.shape), f32_bytes(q_w))
        writer.add(gp + "attn.q.bias", "f32", list(q_b.shape), f32_bytes(q_b))

        k_w = _transpose(f32(attn.k_proj.weight))
        k_b = np.zeros((hidden,), dtype="<f4")  # k_proj has bias=False -- see module docstring
        writer.add(gp + "attn.k.weight", "f32", list(k_w.shape), f32_bytes(k_w))
        writer.add(gp + "attn.k.bias", "f32", list(k_b.shape), f32_bytes(k_b))

        v_w = _transpose(f32(attn.v_proj.weight))
        v_b = f32(attn.v_proj.bias)
        writer.add(gp + "attn.v.weight", "f32", list(v_w.shape), f32_bytes(v_w))
        writer.add(gp + "attn.v.bias", "f32", list(v_b.shape), f32_bytes(v_b))

        o_w = _transpose(f32(attn.out_proj.weight))
        o_b = f32(attn.out_proj.bias)
        writer.add(gp + "attn.out.weight", "f32", list(o_w.shape), f32_bytes(o_w))
        writer.add(gp + "attn.out.bias", "f32", list(o_b.shape), f32_bytes(o_b))

        fc1_w = _transpose(f32(layer.fc1.weight))
        fc1_b = f32(layer.fc1.bias)
        writer.add(gp + "mlp.fc1.weight", "f32", list(fc1_w.shape), f32_bytes(fc1_w))
        writer.add(gp + "mlp.fc1.bias", "f32", list(fc1_b.shape), f32_bytes(fc1_b))

        fc2_w = _transpose(f32(layer.fc2.weight))
        fc2_b = f32(layer.fc2.bias)
        writer.add(gp + "mlp.fc2.weight", "f32", list(fc2_w.shape), f32_bytes(fc2_w))
        writer.add(gp + "mlp.fc2.bias", "f32", list(fc2_b.shape), f32_bytes(fc2_b))

    final_w, final_b = f32(encoder.layer_norm.weight), f32(encoder.layer_norm.bias)
    writer.add("final_layernorm.weight", "f32", list(final_w.shape), f32_bytes(final_w))
    writer.add("final_layernorm.bias", "f32", list(final_b.shape), f32_bytes(final_b))

    mel_filters = np.asarray(feature_extractor.mel_filters, dtype="<f4")  # [num_freq_bins,num_mel_bins]
    mel_filters_t = _transpose(mel_filters)  # -> [num_mel_bins,num_freq_bins]
    writer.add("mel_filters.weight", "f32", list(mel_filters_t.shape), f32_bytes(mel_filters_t))

    writer.finalize()
    print(
        f"[export_whisper_tower] wrote {out_path} (mel_bins={num_mel_bins} hidden={hidden} "
        f"layers={num_layers} heads={num_heads} intermediate={intermediate} "
        f"max_source_positions={max_source_positions} n_fft={n_fft} hop_length={hop_length} "
        f"chunk_length={chunk_length}s sampling_rate={sampling_rate})"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="openai/whisper-small")
    ap.add_argument(
        "--tiny", action="store_true",
        help="Export audio_adapter._build_tiny_encoder()'s random, undownloaded encoder "
             "instead (no network -- for the Go synthetic-config test)",
    )
    ap.add_argument("--seed", type=int, default=0, help="torch.manual_seed for --tiny (must match dump_audio_reference.py --tiny --seed)")
    ap.add_argument("--out", default="data/forge/ears/whisper_small_encoder.nxtf")
    args = ap.parse_args()

    if args.tiny:
        torch.manual_seed(args.seed)
        encoder, feature_extractor = aa._build_tiny_encoder()
    else:
        encoder, feature_extractor = aa._load_real_encoder(args.repo)

    export_whisper_encoder(encoder, feature_extractor, args.out)


if __name__ == "__main__":
    main()
