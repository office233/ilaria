from ai_worker.models import AiJob
from ai_worker.worker import AiProcessor


def test_default_processor_runs_local_handlers_without_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    job = AiJob(
        job_id="ai_local_1",
        asset_id="asset_ring_1",
        media_key="videos/asset_ring_1/master.m3u8",
        tasks=(
            "product_tags",
            "video_tags",
            "caption_draft",
            "moderation",
            "trend_summary",
        ),
        metadata={
            "language": "ro",
            "title": "LED Ring Light for Phone",
            "description": "Creator shows a portable tripod light for livestream product demos.",
            "category": "Creator Tools",
            "products": [
                {
                    "id": "prod_1",
                    "title": "LED Ring Light",
                    "category": "Lighting",
                    "price_cents": 12900,
                }
            ],
            "hashtags": ["#Live", "#Beauty", "#Live"],
            "metrics": {"views": 2450, "likes": 310, "saves": 48},
        },
    )

    result = AiProcessor().process(job)

    assert result.ok is True
    assert result.outputs == {
        "product_tags": {
            "source": "local-deterministic-v1",
            "tags": [
                "beauty",
                "creator-tools",
                "led-ring-light",
                "lighting",
                "mid-price",
            ],
            "products": [
                {
                    "id": "prod_1",
                    "tags": ["led-ring-light", "lighting", "mid-price"],
                }
            ],
        },
        "video_tags": {
            "source": "local-deterministic-v1",
            "asset_id": "asset_ring_1",
            "tags": ["beauty", "creator-tools", "live", "product-video", "shopping"],
        },
        "caption_draft": {
            "source": "local-deterministic-v1",
            "language": "ro",
            "text": (
                "LED Ring Light for Phone: Creator shows a portable tripod light "
                "for livestream product demos. Featured: LED Ring Light."
            ),
            "hashtags": ["#Beauty", "#Live"],
        },
        "moderation": {
            "source": "local-deterministic-v1",
            "status": "approved",
            "severity": "low",
            "review_required": False,
            "labels": [],
        },
        "trend_summary": {
            "source": "local-deterministic-v1",
            "summary": (
                "Creator Tools is trending with 2450 views, 310 likes, and 48 saves. "
                "Top topics: beauty, live."
            ),
            "topics": ["beauty", "live"],
            "metrics": {"views": 2450, "likes": 310, "saves": 48},
        },
    }


def test_default_processor_aliases_are_deterministic_without_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    job = AiJob(
        job_id="ai_local_2",
        asset_id="asset_home_1",
        media_key="videos/asset_home_1/master.m3u8",
        tasks=("tags", "captions", "trends"),
        metadata={
            "language": "en",
            "title": "Desk Organizer Setup",
            "category": "Home Office",
            "hashtags": ["desk", "setup"],
            "metrics": {"views": "75", "likes": "9", "saves": "3"},
        },
    )

    processor = AiProcessor()

    assert processor.process(job).outputs == processor.process(job).outputs
    assert processor.process(job).outputs == {
        "tags": {
            "source": "local-deterministic-v1",
            "asset_id": "asset_home_1",
            "tags": ["desk", "home-office", "product-video", "setup", "shopping"],
        },
        "captions": {
            "source": "local-deterministic-v1",
            "language": "en",
            "text": "Desk Organizer Setup. Featured: asset_home_1.",
            "hashtags": ["#desk", "#setup"],
        },
        "trends": {
            "source": "local-deterministic-v1",
            "summary": (
                "Home Office is trending with 75 views, 9 likes, and 3 saves. "
                "Top topics: desk, setup."
            ),
            "topics": ["desk", "setup"],
            "metrics": {"views": 75, "likes": 9, "saves": 3},
        },
    }


def test_moderation_stub_flags_review_keywords_without_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    job = AiJob(
        job_id="ai_local_3",
        asset_id="asset_report_1",
        media_key="videos/asset_report_1/master.m3u8",
        tasks=("moderation",),
        metadata={
            "title": "Scam giveaway warning",
            "description": "Viewer reported hate speech in the video.",
        },
    )

    result = AiProcessor().process(job)

    assert result.ok is True
    assert result.outputs["moderation"] == {
        "source": "local-deterministic-v1",
        "status": "needs_review",
        "severity": "medium",
        "review_required": True,
        "labels": ["hate", "scam"],
    }
