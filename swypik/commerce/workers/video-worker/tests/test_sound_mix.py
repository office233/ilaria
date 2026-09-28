"""„Adaugă sunet”: mixul piesei alese (ffmpeg amix), re-mix la schimbare, fallback,
moderarea vorbirii, try_claim fără optimism."""
import io
import json
from pathlib import Path

import pytest

from video_worker.ai_hooks import AzureAnalysisHook
from video_worker.azure_ai import AzureAIClient, AzureAISettings
from video_worker.ffmpeg_commands import av_input_args, preview_command, variant_command
from video_worker.config import Variant
from video_worker.io_helpers import download_http
from video_worker.probe import ClipWindow
from video_worker.sound_mix import SoundMixer, SoundSpec, mix_audio_command, sound_key, spec_from_row

from worker_fakes import FakeRepository, FakeTranscoder, _job, _processor

URL = "https://media.swypik.test/audio/library/a.mp3"


def test_spec_from_row_clamps_and_requires_https():
    assert spec_from_row(None) is None
    assert spec_from_row({"audio_track_id": 7, "audio_url": "http://x/a.mp3", "sound_mix": None}) is None
    assert spec_from_row({"audio_track_id": 0, "audio_url": URL}) is None
    spec = spec_from_row(
        {"audio_track_id": "7", "audio_url": URL,
         "sound_mix": {"volume": 999, "original_volume": 49.5, "keep_original": False, "loop": "yes", "start_ms": -3}}
    )
    assert spec == SoundSpec(track_id=7, audio_url=URL, volume=200, original_volume=50, keep_original=False, loop=True, start_ms=0)


def test_sound_key_matches_the_web_format():
    # Identic cu soundMixKey() din lib/video/sound-mix.ts (testat și acolo).
    spec = SoundSpec(track_id=7, audio_url=URL, volume=80, original_volume=50, keep_original=True, loop=False, start_ms=1500)
    assert sound_key(spec) == "t7-v80-o50-k1-l0-s1500"
    assert sound_key(None) == "none"


def test_mix_keeps_original_on_the_trimmed_window():
    spec = SoundSpec(track_id=1, audio_url=URL, volume=80, original_volume=50, loop=True, start_ms=2000)
    cmd = mix_audio_command(Path("src.mp4"), Path("t.mp3"), Path("mix.m4a"), spec,
                            window=ClipWindow(start_ms=1000, duration_ms=5000), source_has_audio=True)
    # original: -ss/-t ÎNAINTE de -i (opțiuni de input); piesa: buclă + start.
    assert cmd[:8] == ["ffmpeg", "-y", "-ss", "1.000", "-t", "5.000", "-i", "src.mp4"]
    assert cmd[8:14] == ["-stream_loop", "-1", "-ss", "2.000", "-i", "t.mp3"]
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "[0:a]aresample=48000,volume=0.50[o]" in graph
    assert "[1:a]aresample=48000,volume=0.80,apad[m]" in graph
    assert "amix=inputs=2:duration=first:dropout_transition=0:normalize=0" in graph
    assert cmd[-11:-1] == ["-t", "5.000", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "128k"]
    assert cmd[cmd.index("-map") + 1] == "[a]"
    assert cmd[-1] == "mix.m4a"


def test_mix_replaces_original_or_silent_source():
    spec = SoundSpec(track_id=1, audio_url=URL, keep_original=False, loop=False)
    cmd = mix_audio_command(Path("src.mp4"), Path("t.mp3"), Path("m.m4a"), spec,
                            window=ClipWindow(start_ms=0, duration_ms=3000), source_has_audio=True)
    assert "src.mp4" not in cmd and "-stream_loop" not in cmd
    assert cmd[cmd.index("-filter_complex") + 1] == "[0:a]aresample=48000,volume=1.00,apad[a]"
    silent = mix_audio_command(Path("src.mp4"), Path("t.mp3"), Path("m.m4a"), SoundSpec(track_id=1, audio_url=URL),
                               window=ClipWindow(start_ms=0, duration_ms=3000), source_has_audio=False)
    assert "amix" not in silent[silent.index("-filter_complex") + 1]


def test_variant_uses_video_from_source_and_audio_from_mix_with_output_duration():
    args = av_input_args(Path("s.mp4"), ClipWindow(start_ms=500, duration_ms=4000), Path("mix.m4a"))
    assert args == ["-ss", "0.500", "-i", "s.mp4", "-i", "mix.m4a", "-map", "0:v:0", "-map", "1:a:0", "-t", "4.000"]
    variant = Variant(name="720p", width=720, height=1280, bitrate="2500k")
    cmd = variant_command(Path("s.mp4"), Path("out/720p/index.m3u8"), variant, has_audio=False,
                          window=ClipWindow(start_ms=0, duration_ms=4000), audio_path=Path("mix.m4a"))
    assert "-an" not in cmd and "aac" in cmd
    prev = preview_command(Path("s.mp4"), Path("p.mp4"), width=360, height=640, has_audio=False, audio_path=Path("mix.m4a"))
    assert "1:a:0" in prev and "-an" not in prev


def test_mixer_downloads_with_a_size_cap_then_runs_ffmpeg(tmp_path):
    downloads, commands = [], []

    def download(url, dest, max_bytes=None):
        downloads.append((url, max_bytes))
        Path(dest).write_bytes(b"x" * 2048)

    mixer = SoundMixer(commands.append, download=download)
    out = mixer.prepare(SoundSpec(track_id=3, audio_url=URL), Path("s.mp4"), ClipWindow(0, 2000),
                        source_has_audio=True, work_dir=tmp_path / "snd")
    assert out == tmp_path / "snd" / "mix.m4a"
    assert downloads[0][0] == URL and downloads[0][1] > 0
    assert commands[0][0] == "ffmpeg"


def test_download_http_enforces_max_bytes(tmp_path, monkeypatch):
    import socket
    import urllib.request

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: [(None, None, None, None, ("93.184.216.34", 0))])

    class Resp(io.BytesIO):
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_k: Resp(b"y" * 5000))
    dest = tmp_path / "t.mp3"
    with pytest.raises(RuntimeError, match="exceeds"):
        download_http(URL, dest, max_bytes=1000)
    assert not dest.exists()


class KwTranscoder(FakeTranscoder):
    def __init__(self):
        super().__init__()
        self.kwargs = []

    def transcode(self, source_path, output_dir, variants, *, probe, trim, thumbnail_time_ms, progress=None, **kwargs):
        self.kwargs.append(kwargs)
        return super().transcode(source_path, output_dir, variants, probe=probe, trim=trim,
                                 thumbnail_time_ms=thumbnail_time_ms, progress=progress)


class SoundRepo(FakeRepository):
    def __init__(self, rows):
        super().__init__()
        self.rows = list(rows)

    def load_sound_spec(self, job):
        return self.rows.pop(0) if len(self.rows) > 1 else self.rows[0]


class FakeMixer:
    def __init__(self, error=None):
        self.specs = []
        self.error = error

    def prepare(self, spec, source_path, window, *, source_has_audio, work_dir):
        self.specs.append(spec)
        if self.error:
            raise self.error
        work_dir.mkdir(parents=True, exist_ok=True)
        return work_dir / "mix.m4a"


ROW = {"audio_track_id": 5, "audio_url": URL, "sound_mix": {"volume": 70, "keep_original": False}}


def test_processor_mixes_the_selected_sound_and_records_the_key(tmp_path):
    transcoder, repo, mixer = KwTranscoder(), SoundRepo([ROW]), FakeMixer()
    result = _processor(tmp_path, transcoder=transcoder, repository=repo, sound_mixer=mixer).process(_job(video_id="v1"))
    assert result.ok
    assert transcoder.kwargs[0]["audio_override"].name == "mix.m4a"
    assert transcoder.kwargs[0]["speech_audio"] is False  # originalul înlocuit → fără Whisper pe muzică
    assert repo.ready_results[0]["sound_mixed_key"] == "t5-v70-o100-k0-l1-s0"
    assert repo.ready_results[0]["has_audio"] is True


def test_processor_remixes_when_the_sound_changes_during_processing(tmp_path):
    changed = {**ROW, "sound_mix": {"volume": 30}}
    transcoder, mixer = KwTranscoder(), FakeMixer()
    repo = SoundRepo([ROW, changed, changed])
    _processor(tmp_path, transcoder=transcoder, repository=repo, sound_mixer=mixer).process(_job(video_id="v1"))
    assert [s.volume for s in mixer.specs] == [70, 30]
    assert len(transcoder.calls) == 2
    assert repo.ready_results[0]["sound_mixed_key"].startswith("t5-v30-")


def test_failed_mix_keeps_original_audio_and_does_not_fail_the_job(tmp_path):
    transcoder, repo = KwTranscoder(), SoundRepo([ROW])
    result = _processor(tmp_path, transcoder=transcoder, repository=repo, sound_mixer=FakeMixer(RuntimeError("404"))).process(
        _job(video_id="v1")
    )
    assert result.ok
    assert transcoder.kwargs[0] == {}
    assert repo.ready_results[0]["sound_mixed_key"] == "none"


def test_no_sound_selected_is_the_plain_pipeline(tmp_path):
    transcoder, repo = KwTranscoder(), SoundRepo([None])
    _processor(tmp_path, transcoder=transcoder, repository=repo, sound_mixer=FakeMixer()).process(_job(video_id="v1"))
    assert transcoder.kwargs == [{}]
    assert repo.ready_results[0]["sound_mixed_key"] == "none"


def test_try_claim_error_skips_instead_of_processing(tmp_path):
    class Repo(FakeRepository):
        def try_claim(self, job):
            raise ConnectionError("db down")

    transcoder = FakeTranscoder()
    result = _processor(tmp_path, transcoder=transcoder, repository=Repo()).process(_job())
    assert result.message == "JOB_SKIPPED"
    assert transcoder.calls == []


# ── moderarea vorbirii (transcriere Whisper → Content Safety text) ──

ENV = {
    "AZURE_OPENAI_ENDPOINT": "https://res.openai.azure.com/",
    "AZURE_OPENAI_API_KEY": "k",
    "AZURE_OPENAI_WHISPER_DEPLOYMENT": "whisper",
    "AZURE_CONTENT_SAFETY_ENDPOINT": "https://cs.cognitiveservices.azure.com",
    "AZURE_CONTENT_SAFETY_KEY": "k2",
    "VIDEO_IMAGE_MODERATION": "0",
}


class Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Repo:
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


def _hook(responses, env=ENV):
    requests = []

    def opener(request, timeout=None):
        requests.append(request)
        return Resp(responses.pop(0))

    settings = AzureAISettings.from_env(env)
    return AzureAnalysisHook(settings, Repo(), client=AzureAIClient(settings, opener=opener, sleep=lambda _s: None)), requests


def _video_job():
    from video_worker.models import VideoJob

    return VideoJob.from_payload({"job_id": "j", "asset_id": "a", "video_id": "v1", "source_key": "k", "output_prefix": "p"})


WHISPER = {"text": "vorbire urâtă", "language": "romanian", "segments": [{"start": 0, "end": 1, "text": "vorbire urâtă"}]}


def test_flagged_speech_opens_a_case_and_holds_the_clip(tmp_path):
    (tmp_path / "audio.m4a").write_bytes(b"aac")
    hook, requests = _hook([WHISPER, {"categoriesAnalysis": [{"category": "Hate", "severity": 6}]}])
    out = hook.after_transcode(_video_job(), None, tmp_path, None, {})
    assert out["speech_moderation"]["decision"] == "block"
    assert "text:analyze" in requests[1].full_url
    assert json.loads(requests[1].data)["text"] == "vorbire urâtă"
    sqls = [s for s, _ in hook.repository.executed]
    assert any("'speech_ai'" in s for s in sqls)
    assert any("pending_review" in s for s in sqls)


def test_clean_speech_is_allowed_and_can_be_disabled(tmp_path):
    (tmp_path / "audio.m4a").write_bytes(b"aac")
    hook, _ = _hook([WHISPER, {"categoriesAnalysis": [{"category": "Hate", "severity": 2}]}])
    out = hook.after_transcode(_video_job(), None, tmp_path, None, {})
    assert out["speech_moderation"] == {"decision": "allow"}
    assert "_transcript" not in out
    off, requests = _hook([WHISPER], env={**ENV, "VIDEO_SPEECH_MODERATION": "0"})
    out = off.after_transcode(_video_job(), None, tmp_path, None, {})
    assert "speech_moderation" not in out and len(requests) == 1


def test_repository_loads_only_active_licensed_tracks_and_stores_the_mixed_key(monkeypatch):
    from video_worker.config import Settings
    from video_worker.db import PostgresRepository
    from video_worker.models import VideoJob

    log = []

    class Cur:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params):
            log.append((" ".join(sql.split()), params))

        def fetchone(self):
            return (5, {"volume": 70}, URL)

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return Cur()

    repo = PostgresRepository(Settings.from_env({"DATABASE_URL": "postgresql://fake"}))
    monkeypatch.setattr(repo, "_connect", lambda: Conn())
    monkeypatch.setattr(repo, "_release", lambda _c: None)
    job = VideoJob(job_id="j", asset_id="a", source_key="k", output_prefix="p", video_id="v1")
    assert repo.load_sound_spec(job) == {"audio_track_id": 5, "sound_mix": {"volume": 70}, "audio_url": URL}
    assert "at.is_active = true AND at.licensed_for_commercial = true" in log[0][0]
    repo.mark_ready(job, {"master_url": "m", "sound_mixed_key": "t5-v70-o100-k1-l1-s0"})
    video_update = [p for s, p in log if s.startswith("UPDATE videos SET status")][0]
    assert json.loads(video_update[6])["sound_mixed_key"] == "t5-v70-o100-k1-l1-s0"
    assert repo.load_sound_spec(VideoJob(job_id="j", asset_id="a", source_key="k", output_prefix="p")) is None
