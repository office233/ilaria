from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from typing import Any, Callable

from .models import AiJob


LOCAL_SOURCE = "local-deterministic-v1"
AiHandler = Callable[[AiJob], Mapping[str, Any]]


def build_default_handlers() -> dict[str, AiHandler]:
    return {
        "product_tags": product_tags_handler,
        "product_tagging": product_tags_handler,
        "video_tags": video_tags_handler,
        "video_tagging": video_tags_handler,
        "tags": video_tags_handler,
        "tagging": video_tags_handler,
        "caption_draft": caption_draft_handler,
        "captions": caption_draft_handler,
        "caption": caption_draft_handler,
        "moderation": moderation_handler,
        "moderation_stub": moderation_handler,
        "trend_summary": trend_summary_handler,
        "trends": trend_summary_handler,
        "trend": trend_summary_handler,
    }


def product_tags_handler(job: AiJob) -> Mapping[str, Any]:
    metadata = job.metadata
    product_outputs: list[dict[str, Any]] = []
    tags: list[str] = []

    tags.extend(_product_hashtag_slugs(metadata))
    category = _first_text(metadata, "product_category", "category", "vertical")
    if category:
        tags.append(_slug(category))

    for product in _products(metadata):
        product_tags = _product_tags(product)
        product_id = _first_text(product, "id", "product_id", "productId", "sourceProductId")
        product_outputs.append(
            {
                "id": product_id or _first_text(product, "title", "name") or job.asset_id,
                "tags": product_tags,
            }
        )
        tags.extend(product_tags)

    return {
        "source": LOCAL_SOURCE,
        "tags": _unique_sorted(tags),
        "products": product_outputs,
    }


def video_tags_handler(job: AiJob) -> Mapping[str, Any]:
    metadata = job.metadata
    tags = _hashtag_slugs(metadata)
    category = _first_text(metadata, "video_category", "category", "vertical")
    if category:
        tags.append(_slug(category))
    tags.extend(["product-video", "shopping"])

    return {
        "source": LOCAL_SOURCE,
        "asset_id": job.asset_id,
        "tags": _unique_sorted(tags),
    }


def caption_draft_handler(job: AiJob) -> Mapping[str, Any]:
    metadata = job.metadata
    title = _first_text(metadata, "caption_title", "title", "product_title")
    description = _first_text(metadata, "caption_hint", "description", "summary")
    language = _first_text(metadata, "language", "locale") or "und"
    featured = _featured_product_name(metadata) or job.asset_id

    if title and description:
        text = f"{_strip_sentence_end(title)}: {_strip_sentence_end(description)}. Featured: {featured}."
    elif title:
        text = f"{_strip_sentence_end(title)}. Featured: {featured}."
    elif description:
        text = f"{_strip_sentence_end(description)}. Featured: {featured}."
    else:
        text = f"Video {job.asset_id}. Featured: {featured}."

    return {
        "source": LOCAL_SOURCE,
        "language": language,
        "text": _squash_whitespace(text),
        "hashtags": _display_hashtags(metadata),
    }


def moderation_handler(job: AiJob) -> Mapping[str, Any]:
    text = " ".join(_text_fragments(job.metadata)).lower()
    labels = sorted(
        label
        for label, terms in _MODERATION_TERMS.items()
        if any(re.search(rf"\b{re.escape(term)}\b", text) for term in terms)
    )

    if not labels:
        return {
            "source": LOCAL_SOURCE,
            "status": "approved",
            "severity": "low",
            "review_required": False,
            "labels": [],
        }

    severity = "high" if {"self_harm", "violence"} & set(labels) else "medium"
    return {
        "source": LOCAL_SOURCE,
        "status": "needs_review",
        "severity": severity,
        "review_required": True,
        "labels": labels,
    }


def trend_summary_handler(job: AiJob) -> Mapping[str, Any]:
    metadata = job.metadata
    category = _first_text(metadata, "category", "vertical", "topic") or "Video"
    metrics = _metrics(metadata)
    topics = _unique_sorted(_hashtag_slugs(metadata))[:3]
    if not topics and category != "Video":
        topics = [_slug(category)]
    topic_text = ", ".join(topics) if topics else "general"

    return {
        "source": LOCAL_SOURCE,
        "summary": (
            f"{category} is trending with {metrics['views']} views, "
            f"{metrics['likes']} likes, and {metrics['saves']} saves. "
            f"Top topics: {topic_text}."
        ),
        "topics": topics,
        "metrics": metrics,
    }


_MODERATION_TERMS = {
    "hate": ("hate", "hateful", "harassment", "slur"),
    "scam": ("scam", "fraud", "phishing", "giveaway"),
    "self_harm": ("self harm", "suicide"),
    "sexual": ("adult", "nudity", "nsfw", "sexual"),
    "violence": ("blood", "kill", "threat", "violence", "weapon"),
}
_VIDEO_CONTEXT_TAGS = {
    "demo",
    "haul",
    "live",
    "review",
    "setup",
    "tutorial",
    "unboxing",
}


def _product_tags(product: Mapping[str, Any]) -> list[str]:
    tags: list[str] = []
    title = _first_text(product, "title", "name", "product_title")
    category = _first_text(product, "category", "product_category", "vertical")
    price_band = _price_band(_first(product, "price_cents", "priceCents", "price"))
    if title:
        tags.append(_slug(title))
    if category:
        tags.append(_slug(category))
    if price_band:
        tags.append(price_band)
    return _unique_preserved(tags)


def _products(metadata: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    value = _first(metadata, "products", "linked_products", "product_links")
    if isinstance(value, Mapping):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, Mapping)]

    single_product = _first(metadata, "product")
    if isinstance(single_product, Mapping):
        return [single_product]
    return []


def _featured_product_name(metadata: Mapping[str, Any]) -> str | None:
    for product in _products(metadata):
        name = _first_text(product, "title", "name", "product_title")
        if name:
            return name
    return _first_text(metadata, "product_title", "product_name")


def _metrics(metadata: Mapping[str, Any]) -> dict[str, int]:
    source = _first(metadata, "metrics", "trend_metrics", "stats")
    if not isinstance(source, Mapping):
        source = metadata
    return {
        "views": _int_value(_first(source, "views", "view_count", "viewCount")),
        "likes": _int_value(_first(source, "likes", "like_count", "likeCount")),
        "saves": _int_value(_first(source, "saves", "save_count", "saveCount")),
    }


def _hashtag_slugs(metadata: Mapping[str, Any]) -> list[str]:
    return [_slug(tag) for tag in _raw_hashtags(metadata) if _slug(tag)]


def _product_hashtag_slugs(metadata: Mapping[str, Any]) -> list[str]:
    return [tag for tag in _hashtag_slugs(metadata) if tag not in _VIDEO_CONTEXT_TAGS]


def _display_hashtags(metadata: Mapping[str, Any]) -> list[str]:
    seen: set[str] = set()
    tags: list[tuple[str, str]] = []
    for raw in _raw_hashtags(metadata):
        text = str(raw).strip()
        if not text:
            continue
        display = text if text.startswith("#") else f"#{text}"
        slug = _slug(display)
        if not slug or slug in seen:
            continue
        seen.add(slug)
        tags.append((slug, display))
    return [display for _, display in sorted(tags, key=lambda item: item[0])]


def _raw_hashtags(metadata: Mapping[str, Any]) -> list[Any]:
    value = _first(metadata, "hashtags", "hash_tags", "tags")
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.replace(",", " ").split()]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return []


def _text_fragments(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        fragments: list[str] = []
        for nested in value.values():
            fragments.extend(_text_fragments(nested))
        return fragments
    if isinstance(value, (list, tuple, set)):
        fragments = []
        for nested in value:
            fragments.extend(_text_fragments(nested))
        return fragments
    return [str(value)]


def _first(data: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return None


def _first_text(data: Mapping[str, Any], *keys: str) -> str | None:
    value = _first(data, *keys)
    if value in (None, ""):
        return None
    return _squash_whitespace(str(value))


def _price_band(value: Any) -> str | None:
    amount = _float_value(value)
    if amount is None:
        return None
    if amount > 1000:
        amount = amount / 100
    if amount < 50:
        return "budget"
    if amount <= 200:
        return "mid-price"
    return "premium"


def _int_value(value: Any) -> int:
    if value in (None, ""):
        return 0
    try:
        return int(float(str(value).replace(",", "")))
    except (TypeError, ValueError):
        return 0


def _float_value(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _slug(value: Any) -> str:
    normalized = unicodedata.normalize("NFKD", str(value).strip().lstrip("#"))
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return slug


def _strip_sentence_end(value: str) -> str:
    return _squash_whitespace(value).rstrip(".!? ")


def _squash_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _unique_sorted(values: list[str]) -> list[str]:
    return sorted(_unique_preserved(values))


def _unique_preserved(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
