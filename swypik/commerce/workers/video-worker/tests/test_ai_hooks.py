"""Hook-ul Azure AI: subtitrări Whisper + moderarea thumbnail-ului, retry 429, cale neconfigurată."""
import io
import json
import urllib.error

import pytest

from video_worker.ai_hooks import AzureAnalysisHook, caption_language, to_segments
from video_worker.azure_ai import AzureAIClient, AzureAIError, AzureAISettings, image_verdict
from video_worker.models import VideoJob

ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://res.openai.azure.com/",
    "AZURE_OPENAI_API_KEY": "k",
    "AZURE_OPENAI_WHISPER_DEPLOYMENT": "whisper",
    "AZURE_CONTENT_SAFETY_ENDPOINT": "https://cs.cognitiveservices.azure.com",
    "AZURE_CONTENT_SAFETY_KEY": "k2",
}


def job(**over):
    base = {"job_id": "j1", "asset_id": "a1", "video_id": "v1", "source_key": "raw/x.mp4",
            "output_prefix": "videos/hls/v1", "metadata": {}}
    base.update(over)
    return VideoJob.from_payload(base)


class FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(status, headers=None):
    return urllib.error.HTTPError("https://x", status, "err", headers or {}, io.BytesIO(b"{}"))


class FakeOpener:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeResponse(outcome)


class FakeRepo:
    class _Settings:
        database_url = "postgres://x"

    def __init__(self):
        self.settings = self._Settings()
        self.executed = []

    def _connect(self):
        repo = self

        class Cursor:
            def execute(self, sql, params):
                repo.executed.append((sql, params))

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        class Conn:
            def cursor(self):
                return Cursor()

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Conn()

    def _release(self, connection):
        pass


def test_settings_not_configured_path():
    s = AzureAISettings.from_env({})
    assert not s.whisper_configured and not s.safety_configured
    assert not AzureAnalysisHook(s, FakeRepo()).enabled
    with pytest.raises(AzureAIError) as exc:
        AzureAIClient(s).transcribe(b"x")
    assert exc.value.code == "not_configured"


def test_client_retries_429_with_retry_after_then_succeeds():
    sleeps = []
    opener = FakeOpener([http_error(429, {"retry-after": "1"}), {"text": "ok", "segments": []}])
    client = AzureAIClient(AzureAISettings.from_env(ENV), opener=opener, sleep=sleeps.append)
    assert client.transcribe(b"audio", language="ro")["text"] == "ok"
    assert sleeps == [1.0]
    assert len(opener.requests) == 2
    assert "api-version=2024-06-01" in opener.requests[0].full_url
    assert b'name="language"\r\n\r\nro' in opener.requests[0].data


def test_client_gives_up_when_retry_after_too_long():
    opener = FakeOpener([http_error(429, {"retry-after": "60"})])
    client = AzureAIClient(AzureAISettings.from_env(ENV), opener=opener, sleep=lambda _s: None)
    with pytest.raises(AzureAIError) as exc:
        client.analyze_image(b"img")
    assert exc.value.code == "rate_limited"


def test_client_does_not_retry_4xx():
    opener = FakeOpener([http_error(400)])
    client = AzureAIClient(AzureAISettings.from_env(ENV), opener=opener, sleep=lambda _s: None)
    with pytest.raises(AzureAIError):
        client.analyze_image(b"img")
    assert len(opener.requests) == 1


def test_image_verdict_thresholds():
    assert image_verdict({"Sexual": 0, "Violence": 0}, 2, 4) == ("allow", [])
    assert image_verdict({"Sexual": 2, "Violence": 0}, 2, 4) == ("review", ["sexual:2"])
    assert image_verdict({"Sexual": 6, "Violence": 4}, 2, 4)[0] == "block"


def test_caption_language_prefers_job_then_detected():
    assert caption_language(job(metadata={"language": "RO"}), "english") == "ro"
    assert caption_language(job(), "romanian") == "ro"
    assert caption_language(job(), "klingon") is None


def test_to_segments_drops_empty_and_inverted():
    raw = [{"start": 0, "end": 1.5, "text": " Salut "}, {"start": 2, "end": 1, "text": "x"}, {"start": 3, "end": 4, "text": ""}]
    assert to_segments(raw) == [{"start": 0.0, "end": 1.5, "text": "Salut"}]


class FakeClient:
    def __init__(self, transcript=None, scores=None, error=None):
        self.transcript = transcript
        self.scores = scores
        self.error = error

    def transcribe(self, audio, *, language=None, filename="audio.m4a"):
        if self.error:
            raise self.error
        return self.transcript

    def analyze_image(self, image):
        if self.error:
            raise self.error
        return self.scores


def test_hook_writes_captions_and_holds_flagged_thumbnail(tmp_path):
    (tmp_path / "audio.m4a").write_bytes(b"aac")
    (tmp_path / "thumbnail.jpg").write_bytes(b"jpg")
    repo = FakeRepo()
    client = FakeClient(
        transcript={"text": "Salut lume", "language": "romanian", "segments": [{"start": 0, "end": 2, "text": "Salut lume"}]},
        scores={"Hate": 0, "SelfHarm": 0, "Sexual": 4, "Violence": 0},
    )
    hook = AzureAnalysisHook(AzureAISettings.from_env(ENV), repo, client=client)
    out = hook.after_transcode(job(), None, tmp_path, None, {})
    assert out["captions"] == {"status": "generated", "lang": "ro", "segments": 1}
    assert out["image_moderation"]["decision"] == "block"
    sqls = [sql for sql, _ in repo.executed]
    assert any("video_captions" in s and "is_auto = true" in s for s in sqls)
    assert any("moderation_cases" in s for s in sqls)
    assert any("pending_review" in s for s in sqls)


def test_hook_degrades_to_pending_review_when_safety_rate_limited(tmp_path):
    (tmp_path / "thumbnail.jpg").write_bytes(b"jpg")
    repo = FakeRepo()
    hook = AzureAnalysisHook(AzureAISettings.from_env(ENV), repo, client=FakeClient(error=AzureAIError("rate_limited", "429", 429)))
    out = hook.after_transcode(job(), None, tmp_path, None, {})
    assert out["image_moderation"]["decision"] == "unavailable"
    case_params = [p for sql, p in repo.executed if "moderation_cases" in sql][0]
    assert case_params[1] == "low"
    assert json.loads(case_params[2])["reasons"] == ["moderation_unavailable"]


def test_hook_never_raises(tmp_path):
    (tmp_path / "audio.m4a").write_bytes(b"aac")
    hook = AzureAnalysisHook(AzureAISettings.from_env(ENV), FakeRepo(), client=FakeClient(error=RuntimeError("boom")))
    assert hook.after_transcode(job(), None, tmp_path, None, {}) is None
