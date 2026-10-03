from ai_worker.models import AiJob
from ai_worker.worker import AiProcessor


def test_ai_processor_routes_registered_caption_tag_and_moderation_handlers():
    job = AiJob(
        job_id="ai_1",
        asset_id="asset_1",
        media_key="videos/asset_1/master.m3u8",
        tasks=("captions", "tags", "moderation"),
        metadata={"language": "ro"},
    )
    processor = AiProcessor(
        handlers={
            "captions": lambda received: {"text": f"caption:{received.asset_id}"},
            "tags": lambda received: {"tags": ["demo"]},
            "moderation": lambda received: {"status": "queued"},
        }
    )

    result = processor.process(job)

    assert result.ok is True
    assert result.outputs == {
        "captions": {"text": "caption:asset_1"},
        "tags": {"tags": ["demo"]},
        "moderation": {"status": "queued"},
    }


def test_ai_processor_reports_unsupported_tasks_without_crashing():
    job = AiJob(
        job_id="ai_2",
        asset_id="asset_2",
        media_key="videos/asset_2/master.m3u8",
        tasks=("moderation",),
    )

    result = AiProcessor(handlers={}).process(job)

    assert result.ok is False
    assert "Unsupported AI task: moderation" == result.message
