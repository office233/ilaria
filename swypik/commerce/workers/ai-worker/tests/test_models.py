import json

import pytest

from ai_worker.models import AiJob, InvalidAiJobPayload


def test_ai_job_parses_stream_payload_for_future_ai_tasks():
    job = AiJob.from_payload(
        json.dumps(
            {
                "job_id": "ai_1",
                "asset_id": "asset_1",
                "media_key": "videos/asset_1/master.m3u8",
                "tasks": ["captions", "tags", "moderation"],
                "metadata": {"language": "ro"},
            }
        ).encode("utf-8")
    )

    assert job.job_id == "ai_1"
    assert job.asset_id == "asset_1"
    assert job.media_key == "videos/asset_1/master.m3u8"
    assert job.tasks == ("captions", "tags", "moderation")
    assert job.metadata == {"language": "ro"}


def test_ai_job_rejects_payload_without_required_fields():
    with pytest.raises(InvalidAiJobPayload) as exc:
        AiJob.from_payload({"job_id": "ai_1", "tasks": ["tags"]})

    assert "asset_id" in str(exc.value)
    assert "media_key" in str(exc.value)
