"""Scara de calitate pe latura SCURTĂ: păstrează aspectul sursei (9:16, 3:4, 16:9…)
fără pad și fără upscaling."""
from __future__ import annotations

import math

from .config import LadderRung, Variant


def orientation(width: int, height: int) -> str:
    if height > width:
        return "vertical"
    if width > height:
        return "landscape"
    return "square"


def round_even(value: float) -> int:
    """Rotunjire la cel mai apropiat număr PAR (minim 2) — H.264 cere dimensiuni pare."""
    return max(2, int(math.floor(value / 2 + 0.5)) * 2)


def floor_even(value: int) -> int:
    return max(2, int(value) - int(value) % 2)


def dims_for_short_side(src_w: int, src_h: int, short: int) -> tuple[int, int]:
    """(width, height) cu latura scurtă = `short` (par) și aspectul sursei."""
    src_short, src_long = min(src_w, src_h), max(src_w, src_h)
    short = floor_even(short)
    long = round_even(short * src_long / src_short)
    if src_h > src_w:
        return short, long
    if src_w > src_h:
        return long, short
    return short, short


def compute_renditions(src_w: int, src_h: int, ladder: list[LadderRung]) -> list[Variant]:
    if src_w <= 0 or src_h <= 0:
        raise ValueError("source dimensions must be positive")
    if not ladder:
        raise ValueError("ladder must contain at least one rung")
    rungs = sorted(ladder, key=lambda rung: rung.short)
    src_short = min(src_w, src_h)

    selected = [(rung.short, rung.bitrate) for rung in rungs if rung.short <= src_short]
    if not selected:
        # Sursă mai mică decât cea mai mică treaptă: o singură variantă la
        # rezoluția nativă (rotunjită în jos la par), cu bitrate-ul minim.
        selected = [(floor_even(src_short), rungs[0].bitrate)]

    variants: list[Variant] = []
    for short, bitrate in selected:
        width, height = dims_for_short_side(src_w, src_h, short)
        variants.append(Variant(name=f"{floor_even(short)}p", width=width, height=height, bitrate=bitrate))
    return variants
