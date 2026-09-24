"""forge/multimodal/data.py -- stage 1 (captioning/alignment) datasets for
BitNetVLM: streaming builders over HuggingFaceM4/the_cauldron caption-style
subsets, plus a fully offline `tiny_synthetic` dataset for --smoke.

Every sample is a plain dict: {"image": PIL.Image, "prompt": str, "answer": str}
where `prompt` contains the IMAGE_TOKEN marker mm_model.BitNetVLM splices the
projected image embeddings at (see mm_model.py's module docstring).

Dataset choice (docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md
section 4, plan step P3): HuggingFaceM4/the_cauldron packages 50
vision-language datasets behind one schema ("images": list[Image], "texts":
list[{user, assistant, source}]); confirmed live via the dataset card and its
per-config dataset_info (huggingface.co/datasets/HuggingFaceM4/the_cauldron,
checked 2026-09-24). Of those 50, three are genuinely caption/alignment style
(one short free-text description per image, not multi-turn VQA/OCR/reasoning):

  - localized_narratives (199,998 examples) -- long, free-form spoken-style
    image descriptions (Google Localized Narratives, over Open
    Images/MS-COCO/ADE20K/Flickr30k source images).
  - screen2words (15,730 examples) -- one-sentence summaries of mobile UI
    screenshots (RICO dataset derivative).
  - textcaps (21,953 examples) -- captions of images that contain text,
    written to require reading that text (over Open Images/TextVQA source
    images, CC-BY-4.0-derived).

  Each subset keeps its own upstream source-dataset license; the_cauldron's
  own README says the prompts ("user" turns) it added are CC-BY-4.0
  (HuggingFaceM4), and that each sub-dataset "must be considered" under its
  own license -- see the dataset card for the exact per-subset terms before
  any broad redistribution of derived data.

  lmms-lab/LLaVA-OneVision-Data (Apache-2.0) is OneVision's *instruction*
  mixture (single/multi-image + video, ~120 named configs) -- there is no
  dedicated 558K-style pure-caption split in that repo. The actual
  "LLaVA-558K" alignment set lives in a separate repo,
  liuhaotian/LLaVA-Pretrain (BLIP-recaptioned CC3M+SBU, license "other" /
  research-use), shipped as one images.zip + one JSON file rather than
  sharded parquet, so it is not `datasets`-streaming-friendly out of the
  box. `build_llava_pretrain_558k` below reads it from a local extraction
  for anyone who has already downloaded it (Colab, not this PC); it is not
  used by --datasets' default and not exercised by --smoke.
"""

from __future__ import annotations

import random
from typing import Iterable, Iterator, Optional

from PIL import Image

IMAGE_TOKEN = "<image>"

CAULDRON_CAPTION_SUBSETS = ["localized_narratives", "screen2words", "textcaps"]

DEFAULT_CAPTION_PROMPT = "Describe the image."

Sample = dict  # {"image": PIL.Image.Image, "prompt": str, "answer": str}


# ---------------------------------------------------------------------------
# HuggingFaceM4/the_cauldron (streaming)
# ---------------------------------------------------------------------------

def _cauldron_example_to_sample(ex: dict) -> Optional[Sample]:
    images = ex.get("images") or []
    texts = ex.get("texts") or []
    if not images or not texts:
        return None
    image = images[0]
    if not isinstance(image, Image.Image):
        return None  # decoding failed / not an Image feature
    turn = texts[0]
    user = (turn.get("user") or DEFAULT_CAPTION_PROMPT).strip()
    answer = (turn.get("assistant") or "").strip()
    if not answer:
        return None
    return {"image": image.convert("RGB"), "prompt": f"{IMAGE_TOKEN}\n{user}", "answer": answer}


def cauldron_subset(subset: str, split: str = "train", streaming: bool = True) -> Iterable[dict]:
    from datasets import load_dataset
    return load_dataset("HuggingFaceM4/the_cauldron", subset, split=split, streaming=streaming)


def cauldron_mixture(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                      seed: int = 0) -> Iterable[dict]:
    """Interleaves several Cauldron caption subsets (equal probability,
    stops at the shortest by default -- fine for stage 1, which trains by
    step count, not epoch)."""
    from datasets import interleave_datasets
    subsets = subsets or CAULDRON_CAPTION_SUBSETS
    parts = [cauldron_subset(s, split=split, streaming=streaming) for s in subsets]
    if len(parts) == 1:
        return parts[0]
    return interleave_datasets(parts, seed=seed)


def iter_caption_samples(subsets: Optional[list] = None, split: str = "train", streaming: bool = True,
                          max_samples: Optional[int] = None, seed: int = 0) -> Iterator[Sample]:
    n = 0
    for ex in cauldron_mixture(subsets, split=split, streaming=streaming, seed=seed):
        s = _cauldron_example_to_sample(ex)
        if s is None:
            continue
        yield s
        n += 1
        if max_samples is not None and n >= max_samples:
            return


# ---------------------------------------------------------------------------
# tiny_synthetic -- fully offline, for --smoke (no network, no real images)
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


def iter_tiny_synthetic(image_size: int = 64, max_samples: int = 64, seed: int = 0) -> Iterator[Sample]:
    """Procedurally generated colored-shape images with matching captions --
    no download, no HF hub call. Used by train_stage1.py --smoke and safe to
    call with any --tower (including random-tiny)."""
    rng = random.Random(seed)
    for _ in range(max_samples):
        color_name, rgb = rng.choice(_COLORS)
        shape = rng.choice(_SHAPES)
        img = _paint_shape(image_size, rgb, shape)
        answer = f"a {color_name} {shape}"
        yield {"image": img, "prompt": f"{IMAGE_TOKEN}\n{DEFAULT_CAPTION_PROMPT}", "answer": answer}


# ---------------------------------------------------------------------------
# Optional: liuhaotian/LLaVA-Pretrain (LLaVA-558K), local-only
# ---------------------------------------------------------------------------

def build_llava_pretrain_558k(json_path: str, images_dir: str,
                               max_samples: Optional[int] = None) -> Iterator[Sample]:
    """Reads a LOCALLY EXTRACTED copy of liuhaotian/LLaVA-Pretrain
    (blip_laion_cc_sbu_558k.json + images/ from images.zip) -- not
    `datasets`-streamable, see module docstring. Not used by
    train_stage1.py's default --datasets or --smoke; provided for a Colab
    run that has already fetched the zip itself."""
    import json
    import os

    with open(json_path, encoding="utf-8") as f:
        records = json.load(f)
    n = 0
    for rec in records:
        img_path = os.path.join(images_dir, rec["image"])
        convs = rec.get("conversations") or []
        if len(convs) < 2:
            continue
        user = convs[0].get("value", "").replace("<image>", "").strip() or DEFAULT_CAPTION_PROMPT
        answer = convs[1].get("value", "").strip()
        if not answer or not os.path.exists(img_path):
            continue
        yield {"image": Image.open(img_path).convert("RGB"), "prompt": f"{IMAGE_TOKEN}\n{user}", "answer": answer}
        n += 1
        if max_samples is not None and n >= max_samples:
            return


# ---------------------------------------------------------------------------
# Image preprocessing (SigLIP2 processor) + collation helpers
# ---------------------------------------------------------------------------

def build_image_processor(tower_repo: str):
    from transformers import AutoImageProcessor
    return AutoImageProcessor.from_pretrained(tower_repo)


def preprocess_images(processor, images: list):
    """Matches SigLIP2's own preprocessing (resize to the tower's square
    image_size, rescale to [0,1], normalize mean=std=0.5) via the real HF
    processor -- returns pixel_values [B,3,H,W] float32."""
    return processor(images=images, return_tensors="pt")["pixel_values"]


def tiny_pixel_values(images: list, image_size: int):
    """--tower random-tiny has no real processor (no repo to download) --
    resize to the tiny tower's own image_size and normalize the same way
    (rescale to [0,1], mean/std 0.5) by hand."""
    import numpy as np
    import torch

    arrs = []
    for img in images:
        img = img.resize((image_size, image_size), Image.BILINEAR)
        a = (np.asarray(img).astype("float32") / 255.0 - 0.5) / 0.5
        arrs.append(a.transpose(2, 0, 1))
    return torch.from_numpy(np.stack(arrs, axis=0))
