"""Content-based partitions shared by training and evaluation (no dependencies)."""
import hashlib
import json
import unicodedata


def sample_key(sample):
    h = hashlib.sha256()
    images = sample.get("images") or []
    if images:
        # Keep all questions about the same image set on the same side.
        for image in images:
            image = image.convert("RGB")
            h.update(str(image.size).encode("ascii"))
            h.update(image.tobytes())
    else:
        prompts = [q for q, _ in sample["turns"]]
        text = unicodedata.normalize("NFKC", json.dumps(prompts, ensure_ascii=False))
        h.update(" ".join(text.split()).casefold().encode("utf-8"))
    return h.hexdigest()


def is_validation(key, fraction=0.05):
    if not 0 < fraction < 1:
        raise ValueError("validation fraction must lie between zero and one")
    return int(key[:16], 16) / 2**64 < fraction


def partition_samples(samples, validation=False, fraction=0.05):
    for sample in samples:
        images = sample.get("images") or []
        if images:
            # Mixed-side image sets are dropped: otherwise the same image
            # could leak via a different multi-image combination.
            sides = [is_validation(sample_key({"images": [im]}), fraction) for im in images]
            selected = all(side == validation for side in sides)
        else:
            selected = is_validation(sample_key(sample), fraction) == validation
        if selected:
            yield sample
