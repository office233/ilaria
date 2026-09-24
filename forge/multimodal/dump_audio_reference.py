"""forge/multimodal/dump_audio_reference.py -- runs the real HF Whisper
encoder (or, --tiny, audio_adapter's random undownloaded tiny encoder --
the SAME weights export_whisper_tower.py --tiny writes, given the same
--seed) on one deterministic synthetic audio clip and dumps every stage the
Go equivalence test (cortex/audio_whisper_test.go) needs to check
cortex/audio_whisper.go against: the raw waveform (as a real WAV file),
log-mel features, the conv-stack output, per-layer hidden states (after
encoder layers 0, 5, 11), the final encoder output, the real (unpadded)
frame count, and the stack_frames-reduced tokens.

Test signal (--tiny off; the default 3 s / 16 kHz case): a fixed-seed,
RNG-free synthetic tone -- sum of two sines (220 Hz + 880 Hz) plus a linear
chirp sweeping 300 Hz -> 3000 Hz -- written to a real 16-bit PCM mono WAV
file (<out_dir>/test_tone.wav, via Python's stdlib `wave` module, no
scipy/soundfile dependency) so cmd/ilaria-hear has a real file to point at
(the gate command runs it). No randomness anywhere in the signal itself --
reproducible byte-for-byte across runs.

Per-stage "hidden state" definitions (mirrors WhisperEncoder.forward,
transformers/models/whisper/modeling_whisper.py, exactly, replicated here
step by step rather than relying on output_hidden_states=True's tuple
indexing convention, which the module docstring on that method would
otherwise force a reader to work out): "conv_output" is
gelu(conv2(gelu(conv1(input_features)))).permute(0,2,1) -- BEFORE the
position embedding is added (the direct counterpart of SigLIP2's
patch-embed-before-position-add stage in dump_vision_reference.py).
"hidden_layers[i]" is the hidden state immediately AFTER encoder layer i
runs (0-based; layer 11 is whisper-small's last layer) -- i.e. BEFORE the
final LayerNorm even when i is the last layer index. "final_output" is
AFTER the final LayerNorm (WhisperEncoder.layer_norm) -- a separate value
from hidden_layers[11], not the same tensor.

Every stage's full tensor is written to a separate raw little-endian
float32 .bin file next to --out (named <out-stem>_<stage>.bin) rather than
inline JSON -- same reasoning as dump_vision_reference.py's tower dump
(full-precision float32, and several of these tensors are >1MB: log-mel is
80*3000=240,000 floats, each hidden-state stage is 1500*768=1,152,000
floats for the real whisper-small config).

Output (--out, default data/forge/ears/audio_reference.json) -- see
cortex/audio_whisper_test.go's audioRefFile struct for the exact schema
consumed on the Go side:

    {
      "audio": {"path", "sampling_rate", "num_samples", "seconds"},
      "real_frame_count": <int>, "max_source_positions": <int>,
      "stack_factor": 8, "audio_hidden": <int>,
      "log_mel": {"shape":[80,T], "bin_path", "first64":[...]},
      "conv_output": {"shape":[T',hidden], "bin_path", "mean", "std"},
      "hidden_layers": {"0": {...}, "5": {...}, "11": {...}},
      "final_output": {"shape":[T',hidden], "bin_path", "mean", "std"},
      "stacked_tokens": {"shape":[N,stack_factor*hidden], "bin_path", "mean", "std"},
      "projector_prefix": "projector_seed42" (or "..._tiny"),
      "projector": {"shape":[N,llm_hidden], "values": [[...]*N]}
    }

Usage:
    python forge/multimodal/dump_audio_reference.py \\
        --repo openai/whisper-small \\
        --out data/forge/ears/audio_reference.json
    python forge/multimodal/dump_audio_reference.py --tiny \\
        --out data/forge/ears/audio_reference_tiny.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import wave

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audio_adapter as aa  # noqa: E402
import export_audio_adapter  # noqa: E402


def _synth_waveform(seconds: float, sampling_rate: int) -> np.ndarray:
    """Deterministic (no RNG) mono waveform: two sines (220 Hz, 880 Hz) plus
    a linear chirp sweeping 300 Hz -> 3000 Hz over the clip, summed and
    peak-normalized to 0.8 -- see module docstring."""
    n = int(round(seconds * sampling_rate))
    t = np.arange(n, dtype=np.float64) / sampling_rate
    tone = 0.2 * np.sin(2 * np.pi * 220.0 * t) + 0.15 * np.sin(2 * np.pi * 880.0 * t)
    f0, f1 = 300.0, 3000.0
    chirp_phase = 2 * np.pi * (f0 * t + (f1 - f0) / (2 * max(seconds, 1e-9)) * t * t)
    chirp = 0.15 * np.sin(chirp_phase)
    x = tone + chirp
    peak = float(np.abs(x).max())
    if peak > 0:
        x = (x / peak) * 0.8
    return x.astype(np.float32)


def _write_wav(path: str, samples: np.ndarray, sampling_rate: int) -> None:
    """16-bit PCM mono WAV via the stdlib `wave` module -- no scipy/
    soundfile dependency."""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sampling_rate)
        f.writeframes(pcm16.tobytes())


def _build_and_export_projector(out_dir: str, seed: int, audio_hidden: int, stack_factor: int, llm_hidden: int, name: str):
    """Builds a fixed-seed randomly-initialized AudioAdapter-shaped
    projector (nn.Sequential(Linear(audio_hidden*stack_factor,llm_hidden),
    GELU,Linear(llm_hidden,llm_hidden)) -- AudioAdapterConfig's
    mlp_hidden defaults to llm_hidden, same as audio_adapter.py's own
    __post_init__) and exports it through the REAL
    forge/multimodal/export_audio_adapter.py:export() (via an in-memory
    checkpoint dict shaped exactly like train_stage1_audio.py's own
    checkpoint.pt: {"projector": state_dict, "audio_adapter_config": ...,
    "step": None}) -- same approach dump_vision_reference.py's
    `_load_or_build_projector` uses for the vision projector, so the
    exported file is produced by the same code path a real trained
    checkpoint would go through, not a hand-rolled duplicate writer.
    Returns (projector, prefix_basename)."""
    torch.manual_seed(seed)
    proj_in = audio_hidden * stack_factor
    projector = torch.nn.Sequential(
        torch.nn.Linear(proj_in, llm_hidden), torch.nn.GELU(), torch.nn.Linear(llm_hidden, llm_hidden)
    )
    projector.eval()

    aa_cfg = aa.AudioAdapterConfig(encoder="whisper-small", stack_factor=stack_factor, llm_hidden=llm_hidden, mlp_hidden=llm_hidden)
    out_prefix = os.path.join(out_dir, name)
    ck = {"projector": projector.state_dict(), "audio_adapter_config": aa_cfg.to_json(), "step": None}
    with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as tf:
        tmp_path = tf.name
    try:
        torch.save(ck, tmp_path)
        export_audio_adapter.export(tmp_path, out_prefix)  # real export code path -- see docstring above
    finally:
        os.unlink(tmp_path)

    return projector, os.path.basename(out_prefix)


def _run_encoder_debug(encoder, mel: torch.Tensor, capture_layers=(0, 5, 11)):
    """mel: [1, n_mels, T_mel] log-mel input_features. Returns
    (conv_out [T',H], hidden_by_layer {i: [T',H]}, final [T',H]) -- batch
    dim stripped, all detached -- replicating WhisperEncoder.forward's own
    steps one at a time (modeling_whisper.py) rather than the
    output_hidden_states tuple convention -- see module docstring for the
    exact per-stage definitions."""
    with torch.no_grad():
        x = F.gelu(encoder.conv1(mel))
        x = F.gelu(encoder.conv2(x))
        x = x.permute(0, 2, 1)  # [1,T',H]
        conv_out = x[0].clone()

        positions = torch.arange(encoder.embed_positions.num_embeddings)
        hidden = x + encoder.embed_positions(positions)

        captured = {}
        for i, layer in enumerate(encoder.layers):
            hidden = layer(hidden, attention_mask=None, output_attentions=False)[0]
            if i in capture_layers:
                captured[i] = hidden[0].clone()

        final = encoder.layer_norm(hidden)[0]
    return conv_out, captured, final


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="openai/whisper-small")
    ap.add_argument("--tiny", action="store_true", help="Use audio_adapter._build_tiny_encoder() instead of a real download -- see export_whisper_tower.py --tiny")
    ap.add_argument("--seed", type=int, default=0, help="torch.manual_seed for --tiny (must match export_whisper_tower.py --tiny --seed)")
    ap.add_argument("--seconds", type=float, default=None,
                     help="Synthetic test-tone duration (default: 3.0, or 1.0 for --tiny, whose chunk_length is "
                          "only 2s -- 1.0s keeps real_frame_count below max_source_positions so cropping is "
                          "actually exercised instead of capped to a no-op)")
    ap.add_argument("--capture-layers", type=int, nargs="*", default=[0, 5, 11])
    ap.add_argument("--out", default="data/forge/ears/audio_reference.json")
    args = ap.parse_args()

    if args.seconds is None:
        args.seconds = 1.0 if args.tiny else 3.0

    out_dir = os.path.dirname(os.path.abspath(args.out)) or "."
    os.makedirs(out_dir, exist_ok=True)

    if args.tiny:
        torch.manual_seed(args.seed)
        encoder, feature_extractor = aa._build_tiny_encoder()
    else:
        encoder, feature_extractor = aa._load_real_encoder(args.repo)
    encoder.eval()

    sampling_rate = feature_extractor.sampling_rate
    waveform = _synth_waveform(args.seconds, sampling_rate)
    wav_name = "test_tone_tiny.wav" if args.tiny else "test_tone.wav"
    wav_path = os.path.join(out_dir, wav_name)
    _write_wav(wav_path, waveform, sampling_rate)

    feats = feature_extractor([waveform], sampling_rate=sampling_rate, return_tensors="pt")["input_features"]  # [1,n_mels,T_mel]

    max_frames = encoder.config.max_source_positions
    real_frames = aa.real_frame_count(len(waveform), sampling_rate, max_frames)
    capture_layers = tuple(i for i in args.capture_layers if 0 <= i < encoder.config.encoder_layers)

    conv_out, captured, final = _run_encoder_debug(encoder, feats, capture_layers=capture_layers)

    stack_factor = 8  # AudioAdapterConfig's default stack_factor (task spec) -- matches the "stack_factor" field below
    cropped = final[:real_frames]
    stacked = aa.stack_frames(cropped.unsqueeze(0), stack_factor)[0]

    # Fixed-seed random projector, exported through the real export code
    # path and run on `stacked` here -- the Go-side round-trip test
    # (cortex/audio_whisper_test.go) loads the SAME exported file via
    # cortex.LoadAudioProjector and checks its Forward(stacked) output
    # against "projector.values" below, exactly as
    # cortex/vision_siglip_test.go's TestSigLIPEquivalence does for the
    # vision projector. llm_hidden is kept small for --tiny so the fixture
    # stays fast/tiny; the real run uses the task-spec 2560 (BitNet
    # b1.58 2B4T's hidden size).
    llm_hidden = 64 if args.tiny else 2560
    proj_name = f"projector_seed42{'_tiny' if args.tiny else ''}"
    projector, proj_prefix_name = _build_and_export_projector(
        out_dir, seed=42, audio_hidden=encoder.config.d_model, stack_factor=stack_factor,
        llm_hidden=llm_hidden, name=proj_name,
    )
    with torch.no_grad():
        projected = projector(stacked)  # [N, llm_hidden]

    def _bin_dump(name: str, tensor: torch.Tensor) -> dict:
        arr = tensor.detach().contiguous().numpy().astype("<f4")
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(arr.tobytes())
        return {
            "shape": list(arr.shape),
            "bin_path": name,
            "mean": float(arr.mean()),
            "std": float(arr.std()),
        }

    stem = os.path.splitext(os.path.basename(args.out))[0]
    log_mel_entry = _bin_dump(f"{stem}_logmel.bin", feats[0])
    log_mel_entry["first64"] = feats[0].flatten()[:64].tolist()

    ref = {
        "audio": {
            "path": wav_name,
            "sampling_rate": sampling_rate,
            "num_samples": int(len(waveform)),
            "seconds": args.seconds,
        },
        "real_frame_count": real_frames,
        "max_source_positions": max_frames,
        "stack_factor": stack_factor,
        "audio_hidden": encoder.config.d_model,
        "log_mel": log_mel_entry,
        "conv_output": _bin_dump(f"{stem}_conv.bin", conv_out),
        "hidden_layers": {str(i): _bin_dump(f"{stem}_layer{i}.bin", h) for i, h in captured.items()},
        "final_output": _bin_dump(f"{stem}_final.bin", final),
        "stacked_tokens": _bin_dump(f"{stem}_stacked.bin", stacked),
        "projector_prefix": proj_prefix_name,
        "projector": {
            "shape": list(projected.shape),
            "values": projected.detach().numpy().astype("float64").tolist(),
        },
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(ref, f)

    print(
        f"[dump_audio_reference] wav={wav_path} mel={tuple(feats.shape)} "
        f"real_frames={real_frames} final={tuple(final.shape)} stacked={tuple(stacked.shape)}"
    )
    print(f"[dump_audio_reference] wrote {args.out}")


if __name__ == "__main__":
    main()
