"""forge/multimodal/data_instruct.py -- stage 2 (instruction tuning / VQA)
streaming datasets for BitNetVLM: HuggingFaceM4/FineVision instruction
subsets (primary), HuggingFaceM4/the_cauldron instruction subsets (fallback,
same "images"/"texts" schema, reusing data.py's already-thin `cauldron_
subset` loader wrapper), a text-only instruction stream (HuggingFaceTB/
smoltalk) to fight catastrophic forgetting, and a fully offline
`tiny_synthetic_vqa` for train_stage2.py --smoke.

Every sample here is `{"images": list[PIL.Image] (0-2), "turns":
list[(user, answer)]}` -- unlike data.py's stage-1 `Sample` (exactly one
image, one turn), this is MULTI-TURN and MULTI-IMAGE (capped at 2 images)
from the start, matching train_stage2.BitNetVLMStage2.build_multiturn_sample
(see that method's docstring for the exact chat-template splicing this
feeds: images are spliced as `<image>` markers prepended to the FIRST turn
only, one marker per image, in order; text-only samples carry `images: []`
and no markers at all).

Dataset choice (docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md
section 4/6, plan step P3 "stage 2 LoRA on FineVision"):

HuggingFaceM4/FineVision (24.3M samples, 17.3M images, 88.9M turns, 9.5B
answer tokens across 185 named configs; confirmed live via the dataset card
and HF's datasets-server `/splits`, `/size`, `/info` endpoints, checked
2026-09-24 -- https://huggingface.co/datasets/HuggingFaceM4/FineVision).
Every config shares one schema: `images: list[Image]`, `texts:
list[{user: str, assistant: str}]`, plus a `source` string and several
`*_ratings`/`*_min` int quality-rating columns this module does not use
(FineVision's own per-turn relevance/visual-dependency/formatting scores --
worth revisiting for a quality filter later, e.g. dropping turns with
`relevance_min < 3`, but out of scope here). Per the dataset card's own
"Licensing Information": FineVision's own prompts are CC-BY-4.0
(HuggingFaceM4); each sub-dataset otherwise keeps its OWN upstream license
-- check the specific subset's own card before broad redistribution of
derived data, same caveat data.py's module docstring already states for
Cauldron.

`FINEVISION_SUBSETS` (6, one per --datasets default), chosen to cover
general VQA / OCR-TextVQA-like / documents / charts / dense captions /
diagrams (row counts + on-disk parquet size via datasets-server `/size`,
checked 2026-09-24):

  - vqav2         (82,772 rows, ~4.3 GB)  -- general VQA; COCO images
    (CC-BY-4.0) + VQA v2 annotations (visualqa.org terms: free for
    academic/research use).
  - textvqa       (21,943 rows, ~2.1 GB)  -- OCR/TextVQA-like (answering
    questions that require reading text IN the image); OpenImages-derived
    images (CC-BY-2.0) + TextVQA annotations (CC-BY-4.0).
  - docvqa        (10,189 rows, ~12.0 GB) -- scanned documents; UCSF
    Industry Documents Library source images, DocVQA/Robust Reading
    Competition terms (research/non-commercial use).
  - chartqa       (18,265 rows, ~0.80 GB) -- charts; ChartQA is MIT-licensed,
    chart images sourced from Statista/Pew/OWID/OECD.
  - sharegpt4v(llava) (29,986 rows, ~5.6 GB) -- dense, instruction-style
    image descriptions (GPT-4V-rewritten captions over COCO/LAION/etc.
    source images) -- NOT the same 3 caption subsets train_stage1.py already
    trained on (localized_narratives/screen2words/textcaps), so this adds
    coverage rather than repeating stage 1's data; check ShareGPT4V's own
    terms (GPT-4V-generated content carries its own usage restrictions)
    before broad redistribution.
  - ai2d_merged   (4,858 rows, ~0.86 GB)  -- science-diagram VQA (Allen
    Institute AI2D, CC-BY-4.0), rounds out chart/document understanding
    with multi-choice diagram reasoning.

  Total ~168K samples, ~25.7 GB (parquet, streamed -- never fully downloaded
  on this PC; only a Colab run pulls these, via `--streaming`, the default).
  185 configs exist in total (see FineVision's dataset card /
  `get_dataset_config_names`); these 6 are this project's pick, not an
  exhaustive list -- swap `--datasets` for a different subset of the other
  179 (e.g. `infographic_vqa`, `ocrvqa`, `st_vqa`, `tabmwp`) freely.

Fallback: HuggingFaceM4/the_cauldron (already used, caption-only subsets,
by data.py) ALSO packages genuinely instructional subsets under the same
"images"/"texts" schema (`CAULDRON_INSTRUCT_FALLBACK_SUBSETS` below) --
selected with `--source cauldron`, for a run where FineVision itself is
unreachable. Not exercised by default.

Text-only instruction stream (`--text-ratio`, default 0 = disabled):
HuggingFaceTB/smoltalk, config "all" (1,098,865 rows, schema `messages:
list[{role, content}]` + `source: str`; confirmed via datasets-server,
checked 2026-09-24), Apache-2.0 licensed, `datasets`-streaming-friendly.
Mixed in at a small ratio purely to counter catastrophic forgetting of
plain-text instruction-following while the LLM's LoRA adapters train on
image-heavy data (the task's own rationale) -- system-role turns are
dropped (the BitNet chat template mm_model.BitNetVLM implements has no
system slot; see mm_model.py's module docstring), consecutive
user/assistant messages are paired into `(user, answer)` turns.

`tiny_synthetic_vqa`: procedurally generated colored-shape images with
matching Q/A turns ("What color is the square?" -> "red"), plus a second,
unrelated yes/no turn per sample to exercise multi-turn loss end to end --
no download, no HF hub call. Used by train_stage2.py --smoke.
"""

from __future__ import annotations

import random
from typing import Iterable, Iterator, Optional

from PIL import Image

IMAGE_TOKEN = "<image>"

FINEVISION_DATASET = "HuggingFaceM4/FineVision"
FINEVISION_SUBSETS = ["vqav2", "textvqa", "docvqa", "chartqa", "sharegpt4v(llava)", "ai2d_merged"]

CAULDRON_DATASET = "HuggingFaceM4/the_cauldron"
CAULDRON_INSTRUCT_FALLBACK_SUBSETS = ["vqav2", "ocrvqa", "chartqa", "ai2d"]

TEXT_INSTRUCT_DATASET = "HuggingFaceTB/smoltalk"
TEXT_INSTRUCT_CONFIG = "all"

DEFAULT_MAX_IMAGES = 2
DEFAULT_MAX_TURNS = 4

Sample = dict  # {"images": list[PIL.Image.Image], "turns": list[tuple[str, str]]}


# ---------------------------------------------------------------------------
# FineVision / Cauldron (streaming) -- shared "images"/"texts" schema
# ---------------------------------------------------------------------------

def _vlm_example_to_sample(ex: dict, max_images: int = DEFAULT_MAX_IMAGES,
                            max_turns: int = DEFAULT_MAX_TURNS) -> Optional[Sample]:
    images = ex.get("images") or []
    texts = ex.get("texts") or []
    if not images or not texts:
        return None
    imgs = []
    for im in images[:max_images]:
        if not isinstance(im, Image.Image):
            return None  # decoding failed / not an Image feature
        imgs.append(im.convert("RGB"))
    if not imgs:
        return None
    turns = []
    for t in texts[:max_turns]:
        user = (t.get("user") or "").strip()
        answer = (t.get("assistant") or "").strip()
        if not user or not answer:
            continue
        # Markers are spliced in explicitly by train_stage2.BitNetVLMStage2.
        # build_multiturn_sample (one per image, prepended to the first
        # turn) -- strip any literal marker text a source dataset happens to
        # already carry so it is never double-counted or tokenized as plain
        # text.
        user = user.replace(IMAGE_TOKEN, "").strip()
        if user:
            turns.append((user, answer))
    if not turns:
        return None
    return {"images": imgs, "turns": turns}


def finevision_subset(subset: str, split: str = "train", streaming: bool = True) -> Iterable[dict]:
    from datasets import load_dataset
    return load_dataset(FINEVISION_DATASET, subset, split=split, streaming=streaming)


def finevision_mixture(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                        seed: int = 0) -> Iterable[dict]:
    """Interleaves several FineVision subsets (equal probability, stops at
    the shortest by default -- fine here, stage 2 trains by step count, not
    epoch, same as train_stage1.py's cauldron_mixture)."""
    from datasets import interleave_datasets
    subsets = subsets or FINEVISION_SUBSETS
    parts = [finevision_subset(s, split=split, streaming=streaming) for s in subsets]
    if len(parts) == 1:
        return parts[0]
    return interleave_datasets(parts, seed=seed)


def iter_finevision_samples(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                             max_samples: Optional[int] = None, max_images: int = DEFAULT_MAX_IMAGES,
                             max_turns: int = DEFAULT_MAX_TURNS, seed: int = 0) -> Iterator[Sample]:
    n = 0
    for ex in finevision_mixture(subsets, split=split, streaming=streaming, seed=seed):
        s = _vlm_example_to_sample(ex, max_images=max_images, max_turns=max_turns)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


def cauldron_instruct_subset(subset: str, split: str = "train", streaming: bool = True) -> Iterable[dict]:
    from datasets import load_dataset
    return load_dataset(CAULDRON_DATASET, subset, split=split, streaming=streaming)


def cauldron_instruct_mixture(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                               seed: int = 0) -> Iterable[dict]:
    from datasets import interleave_datasets
    subsets = subsets or CAULDRON_INSTRUCT_FALLBACK_SUBSETS
    parts = [cauldron_instruct_subset(s, split=split, streaming=streaming) for s in subsets]
    if len(parts) == 1:
        return parts[0]
    return interleave_datasets(parts, seed=seed)


def iter_cauldron_instruct_samples(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                                    max_samples: Optional[int] = None, max_images: int = DEFAULT_MAX_IMAGES,
                                    max_turns: int = DEFAULT_MAX_TURNS, seed: int = 0) -> Iterator[Sample]:
    n = 0
    for ex in cauldron_instruct_mixture(subsets, split=split, streaming=streaming, seed=seed):
        s = _vlm_example_to_sample(ex, max_images=max_images, max_turns=max_turns)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


def build_vision_stream(source: str = "finevision", subsets: Optional[list] = None, split: str = "train",
                         streaming: bool = True, max_samples: Optional[int] = None,
                         max_images: int = DEFAULT_MAX_IMAGES, max_turns: int = DEFAULT_MAX_TURNS,
                         seed: int = 0) -> Iterator[Sample]:
    """`source`: "finevision" (default) | "cauldron" (fallback). One pass
    over the chosen mixture -- callers that need an unbounded stream should
    wrap the zero-arg factory that calls this in train_stage1.cycle (stage
    2 does exactly that, see train_stage2.py)."""
    if source == "finevision":
        return iter_finevision_samples(subsets, split=split, streaming=streaming, max_samples=max_samples,
                                        max_images=max_images, max_turns=max_turns, seed=seed)
    if source == "cauldron":
        return iter_cauldron_instruct_samples(subsets, split=split, streaming=streaming, max_samples=max_samples,
                                               max_images=max_images, max_turns=max_turns, seed=seed)
    raise ValueError(f"build_vision_stream: source must be 'finevision' or 'cauldron', got {source!r}")


# ---------------------------------------------------------------------------
# Text-only instruction stream (HuggingFaceTB/smoltalk) -- catastrophic-
# forgetting guard, mixed in at --text-ratio
# ---------------------------------------------------------------------------

def _smoltalk_example_to_sample(ex: dict, max_turns: int = DEFAULT_MAX_TURNS) -> Optional[Sample]:
    msgs = ex.get("messages") or []
    turns = []
    pending_user = None
    for m in msgs:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            continue  # no system slot in the BitNet chat template (mm_model.py)
        if role == "user":
            pending_user = content
        elif role == "assistant" and pending_user is not None:
            turns.append((pending_user, content))
            pending_user = None
            if len(turns) >= max_turns:
                break
    if not turns:
        return None
    return {"images": [], "turns": turns}


def iter_text_instruct_samples(dataset: str = TEXT_INSTRUCT_DATASET, config: str = TEXT_INSTRUCT_CONFIG,
                                split: str = "train", streaming: bool = True, max_samples: Optional[int] = None,
                                max_turns: int = DEFAULT_MAX_TURNS, seed: int = 0) -> Iterator[Sample]:
    from datasets import load_dataset
    ds = load_dataset(dataset, config, split=split, streaming=streaming)
    if streaming:
        ds = ds.shuffle(seed=seed, buffer_size=10_000)
    n = 0
    for ex in ds:
        s = _smoltalk_example_to_sample(ex, max_turns=max_turns)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


def instruct_mixture(vision_iter_factory, text_ratio: float = 0.0, text_dataset: str = TEXT_INSTRUCT_DATASET,
                      text_config: str = TEXT_INSTRUCT_CONFIG, streaming: bool = True,
                      max_turns: int = DEFAULT_MAX_TURNS, seed: int = 0) -> Iterator[Sample]:
    """One pass: probabilistically interleaves `vision_iter_factory()` (a
    zero-arg callable returning a FRESH vision-sample iterator, e.g.
    `lambda: build_vision_stream(...)`) with the text-only instruction
    stream at `text_ratio` in [0, 1) (0, the default, disables text mixing
    entirely -- the smoltalk `load_dataset` call never even happens). Stops
    as soon as EITHER sub-stream is exhausted, mirroring `datasets.
    interleave_datasets`'s default "stop at the shortest" policy. The caller
    (train_stage2.py) is expected to wrap this whole function in train_
    stage1.cycle (the same helper train_stage1.py itself uses) to restart a
    fresh pass indefinitely for a step-count-based training loop -- this
    function itself does not loop forever."""
    if not (0.0 <= text_ratio < 1.0):
        raise ValueError(f"text_ratio must be in [0, 1), got {text_ratio}")
    rng = random.Random(seed)
    vision_it = vision_iter_factory()
    text_it = None
    if text_ratio > 0.0:
        text_it = iter_text_instruct_samples(text_dataset, text_config, streaming=streaming, max_turns=max_turns,
                                              seed=seed)
    while True:
        use_text = text_it is not None and rng.random() < text_ratio
        try:
            yield next(text_it) if use_text else next(vision_it)
        except StopIteration:
            return


# ---------------------------------------------------------------------------
# tiny_synthetic_vqa -- fully offline, for --smoke (no network, no real
# images, no real HF datasets)
# ---------------------------------------------------------------------------

_COLORS = [("red", (220, 40, 40)), ("green", (40, 180, 70)), ("blue", (40, 90, 220)),
           ("yellow", (230, 200, 30)), ("purple", (150, 60, 190))]
_SHAPES = ["square", "circle", "stripe"]


def _paint_shape(size: int, rgb: tuple, shape: str) -> Image.Image:
    from PIL import ImageDraw
    img = Image.new("RGB", (size, size), color=(255, 255, 255))
    d = ImageDraw.Draw(img)
    margin = size // 4
    if shape == "square":
        d.rectangle([margin, margin, size - margin, size - margin], fill=rgb)
    elif shape == "circle":
        d.ellipse([margin, margin, size - margin, size - margin], fill=rgb)
    else:  # stripe
        d.rectangle([0, size // 2 - size // 8, size, size // 2 + size // 8], fill=rgb)
    return img


def iter_tiny_synthetic_vqa(image_size: int = 64, max_samples: int = 64, seed: int = 0) -> Iterator[Sample]:
    """Two-turn Q/A per image: "What color is the {shape}?" -> the true
    color, then a yes/no question about an unrelated shape -- exercises
    both VQA-style question answering AND multi-turn loss (loss on both
    assistant spans) without any download. Used by train_stage2.py --smoke
    and safe with any tower (including --tower random-tiny)."""
    rng = random.Random(seed)
    for _ in range(max_samples):
        color_name, rgb = rng.choice(_COLORS)
        shape = rng.choice(_SHAPES)
        img = _paint_shape(image_size, rgb, shape)
        other_shape = rng.choice([s for s in _SHAPES if s != shape])
        turns = [
            (f"What color is the {shape}?", color_name),
            (f"Is there a {other_shape} in the image?", "no"),
        ]
        yield {"images": [img], "turns": turns}
