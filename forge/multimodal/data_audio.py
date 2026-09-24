"""forge/multimodal/data_audio.py -- stage 1 (ASR-alignment / captioning)
datasets for the "ears" BitNetVLM (audio_adapter.AudioAdapter spliced in
place of vision_adapter.VisionAdapter): streaming builders over real,
auth-free Hugging Face audio datasets, plus a fully offline
`iter_tiny_synthetic_audio` for --smoke. Mirrors data.py's shape as closely
as the audio modality allows (Sample dict, `<TOKEN>\\n{instruction}` prompts,
`_mixture`/`iter_*_samples` split, tiny-synthetic --smoke source).

Every sample is a plain dict: {"audio": np.ndarray[float32] (mono, 16 kHz),
"sampling_rate": int, "prompt": str, "answer": str} where `prompt` contains
AUDIO_TOKEN ("<audio>", matching mm_model.AUDIO_PLACEHOLDER) at the position
mm_model.BitNetVLM splices the projected audio embeddings.

Dataset choice (docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md
section 4 "Audio", plan step P4 -- "Whisper-small + proiector stack-and-
project pe LibriSpeech + Common Voice"):

  - PRIMARY, ASR-alignment: `openslr/librispeech_asr`, config "clean", split
    "train.100" (28,539 examples, CC-BY-4.0, gated=False -- confirmed via
    the HF API, checked 2026-09-24). Prompts: "<audio>\\nTranscribe the
    audio." -> the ground-truth transcript verbatim (LibriSpeech transcripts
    are upper-cased with no punctuation -- an upstream quirk, not something
    this file normalizes/invents).

  - SECONDARY, captioning: `OpenSound/AudioCaps` (a community re-host of the
    AudioCaps captions -- https://audiocaps.github.io -- paired with the
    actual downloaded 10 s YouTube-audio clips, CC-BY-NC-4.0 -- **non-
    commercial**, confirmed via the HF API's cardData/license tag, checked
    2026-09-24; the official `audiocaps` github repo only ships captions +
    YouTube ids, not audio, and is not `datasets`-streamable on its own).
    Prompts: "<audio>\\nDescribe the sound." -> the caption.

  Both repos report `gated: false` via `https://huggingface.co/api/datasets/
  <repo>` (checked 2026-09-24) -- no HF auth token needed for either.

  Audio-captioning sources ALSO checked and NOT used: `cvssp/WavCaps`
  (real, auth-free, CC-BY-4.0 -- gated=false, confirmed the same way -- but
  it ships audio as raw multi-part zip archives per source
  (Zip_files/<Source>/*.zNN + .zip) with only the caption JSON manifests
  (json_files/<Source>/*_final.json, schema verified: {"data": [{"id",
  "caption", "duration", ...}]}) living outside them; HF's own auto-parquet
  viewer conversion for this repo is a 37 KB metadata-only stub with no
  embedded audio, so `datasets.load_dataset(..., streaming=True)` cannot
  decode it. Reproducing the id -> extracted-audio-filename mapping inside
  each source's multi-part archive is undocumented in the README and was
  not verified here (would require downloading and unzipping several GB per
  source) -- rather than guess at that layout, this file does not implement
  a WavCaps builder. `mozilla-foundation/common_voice_*` was not pursued: it
  is an ASR (not captioning) dataset and LibriSpeech already covers that
  role for this stage.

  Both LibriSpeech and AudioCaps store audio as embedded file bytes
  (`{"bytes": ..., "path": ...}`) in an HF `Audio` feature column. This
  environment's `datasets==4.8.2` decodes that feature via the optional
  `torchcodec` package by default, which is NOT installed here (confirmed:
  the default decode path raises `ImportError: ... install 'torchcodec'`).
  The fallback this file uses instead -- `.cast_column("audio",
  Audio(decode=False))` to get the raw bytes back undecoded, then
  `soundfile.read` (already installed, a transformers/datasets dependency)
  -- is exactly the "fall back to datasets' Audio feature casting" the task
  spec anticipated. `torchaudio` (installed; `librosa` is NOT installed in
  this environment -- checked) resamples any clip whose native rate isn't
  16 kHz (AudioCaps ships at 24 kHz stereo; LibriSpeech already ships at
  16 kHz mono, so resampling is a no-op for it in practice, but every
  sample still goes through the same decode/resample path for a single
  code path rather than a LibriSpeech-only special case).
"""

from __future__ import annotations

import io
import random
from typing import Iterator, Optional

import numpy as np

AUDIO_TOKEN = "<audio>"

TARGET_SAMPLE_RATE = 16000
LIBRISPEECH_REPO = "openslr/librispeech_asr"
AUDIOCAPS_REPO = "OpenSound/AudioCaps"

DEFAULT_ASR_PROMPT = "Transcribe the audio."
DEFAULT_CAPTION_PROMPT = "Describe the sound."

Sample = dict  # {"audio": np.ndarray[float32] (mono, 16 kHz), "sampling_rate": int, "prompt": str, "answer": str}


# ---------------------------------------------------------------------------
# Shared decode/resample helpers
# ---------------------------------------------------------------------------

def _resample(arr: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    """torchaudio resample (installed in this environment; librosa is not --
    see module docstring)."""
    import torch
    import torchaudio.functional as taf

    t = torch.from_numpy(arr).unsqueeze(0)
    t = taf.resample(t, orig_sr, target_sr)
    return t.squeeze(0).numpy().astype("float32")


def _decode_audio_bytes(raw: bytes, target_sr: int = TARGET_SAMPLE_RATE) -> np.ndarray:
    """Decodes one `datasets` `Audio(decode=False)` entry's raw file bytes
    (flac/wav/whatever the source dataset stores) via `soundfile`, downmixes
    to mono (plain channel average -- fine for speech/sound-event content,
    not intended to be perceptually optimal) if the source is multi-channel,
    and resamples to `target_sr` if the source rate differs. See module
    docstring for why this manual path is used instead of the `datasets`
    Audio feature's own default decoding."""
    import soundfile as sf

    arr, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    if arr.ndim > 1:
        arr = arr.mean(axis=1).astype("float32")
    if sr != target_sr:
        arr = _resample(arr, sr, target_sr)
    return arr


def interleave_iterators(iterators: list, seed: int = 0) -> Iterator:
    """Round-robins over several already-built sample iterators, picking
    uniformly at random among the ones still alive at each step (equal
    probability, matching `datasets.interleave_datasets`' default policy,
    which data.py's cauldron_mixture relies on) -- a plain-Python equivalent
    that also works here since every source in this file is already a
    generator of plain dict samples, not a `datasets` IterableDataset object.
    Stops once every iterator is exhausted."""
    rng = random.Random(seed)
    pool = list(iterators)
    while pool:
        i = rng.randrange(len(pool))
        try:
            yield next(pool[i])
        except StopIteration:
            pool.pop(i)


# ---------------------------------------------------------------------------
# openslr/librispeech_asr (streaming) -- primary, ASR-alignment
# ---------------------------------------------------------------------------

def librispeech_stream(config: str = "clean", split: str = "train.100", streaming: bool = True):
    from datasets import Audio, load_dataset

    ds = load_dataset(LIBRISPEECH_REPO, config, split=split, streaming=streaming)
    return ds.cast_column("audio", Audio(decode=False))


def _librispeech_example_to_sample(ex: dict) -> Optional[Sample]:
    text = (ex.get("text") or "").strip()
    audio = ex.get("audio") or {}
    if not text or not audio.get("bytes"):
        return None
    arr = _decode_audio_bytes(audio["bytes"], TARGET_SAMPLE_RATE)
    return {"audio": arr, "sampling_rate": TARGET_SAMPLE_RATE,
            "prompt": f"{AUDIO_TOKEN}\n{DEFAULT_ASR_PROMPT}", "answer": text}


def iter_librispeech_samples(config: str = "clean", split: str = "train.100", streaming: bool = True,
                              max_samples: Optional[int] = None, seed: int = 0) -> Iterator[Sample]:
    n = 0
    ds = librispeech_stream(config=config, split=split, streaming=streaming)
    if streaming:
        ds = ds.shuffle(seed=seed, buffer_size=1000)  # LibriSpeech is sorted by speaker/chapter otherwise
    for ex in ds:
        s = _librispeech_example_to_sample(ex)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


# ---------------------------------------------------------------------------
# OpenSound/AudioCaps (streaming) -- secondary, captioning
# ---------------------------------------------------------------------------

def audiocaps_stream(split: str = "train", streaming: bool = True):
    from datasets import Audio, load_dataset

    ds = load_dataset(AUDIOCAPS_REPO, split=split, streaming=streaming)
    return ds.cast_column("audio", Audio(decode=False))


def _audiocaps_example_to_sample(ex: dict) -> Optional[Sample]:
    caption = (ex.get("caption") or "").strip()
    audio = ex.get("audio") or {}
    if not caption or not audio.get("bytes"):
        return None
    arr = _decode_audio_bytes(audio["bytes"], TARGET_SAMPLE_RATE)
    return {"audio": arr, "sampling_rate": TARGET_SAMPLE_RATE,
            "prompt": f"{AUDIO_TOKEN}\n{DEFAULT_CAPTION_PROMPT}", "answer": caption}


def iter_audiocaps_samples(split: str = "train", streaming: bool = True,
                            max_samples: Optional[int] = None, seed: int = 0) -> Iterator[Sample]:
    n = 0
    ds = audiocaps_stream(split=split, streaming=streaming)
    if streaming:
        ds = ds.shuffle(seed=seed, buffer_size=1000)
    for ex in ds:
        s = _audiocaps_example_to_sample(ex)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


# ---------------------------------------------------------------------------
# Mixture (LibriSpeech + AudioCaps, equal probability -- mirrors data.py's
# cauldron_mixture) and the top-level max_samples-capped iterator
# ---------------------------------------------------------------------------

def audio_mixture(config: str = "clean", split: str = "train.100", caption_split: str = "train",
                   streaming: bool = True, seed: int = 0, include_captions: bool = True) -> Iterator[Sample]:
    """Interleaves LibriSpeech (ASR transcript task, the primary source per
    the task spec) with AudioCaps (captioning task) at equal probability.
    Pass include_captions=False to train on LibriSpeech alone (e.g. to
    avoid AudioCaps' CC-BY-NC-4.0 non-commercial term for a downstream use
    that needs to avoid it)."""
    sources = [iter_librispeech_samples(config=config, split=split, streaming=streaming, seed=seed)]
    if include_captions:
        sources.append(iter_audiocaps_samples(split=caption_split, streaming=streaming, seed=seed))
    return interleave_iterators(sources, seed=seed)


def iter_audio_samples(config: str = "clean", split: str = "train.100", caption_split: str = "train",
                        streaming: bool = True, max_samples: Optional[int] = None, seed: int = 0,
                        include_captions: bool = True) -> Iterator[Sample]:
    n = 0
    for s in audio_mixture(config=config, split=split, caption_split=caption_split, streaming=streaming,
                            seed=seed, include_captions=include_captions):
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


# ---------------------------------------------------------------------------
# tiny_synthetic_audio -- fully offline, for --smoke (no network, no real audio)
# ---------------------------------------------------------------------------

_TONE_FREQS = [220, 330, 440, 550, 660]  # A3, E4, A4, C#5(ish), E5 -- arbitrary, just distinct/nameable tones


def iter_tiny_synthetic_audio(sample_rate: int = 16000, duration_s: float = 1.0, max_samples: int = 64,
                               seed: int = 0) -> Iterator[Sample]:
    """Procedurally generated pure sine tones with matching captions -- no
    download, no HF hub call. Mirrors data.py's iter_tiny_synthetic; used by
    train_stage1_audio.py --smoke and safe with any --encoder (including
    random-tiny)."""
    rng = random.Random(seed)
    n_samples = int(sample_rate * duration_s)
    t = (np.arange(n_samples, dtype="float32") / sample_rate)
    for _ in range(max_samples):
        freq = rng.choice(_TONE_FREQS)
        wave = (0.2 * np.sin(2.0 * np.pi * freq * t)).astype("float32")
        answer = f"a tone of {freq} Hz"
        yield {"audio": wave, "sampling_rate": sample_rate,
               "prompt": f"{AUDIO_TOKEN}\n{DEFAULT_CAPTION_PROMPT}", "answer": answer}
