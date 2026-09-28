from pathlib import Path

import pytest

from video_worker.config import Variant
from video_worker.ffmpeg_commands import (
    audio_command,
    encoder_args,
    preview_command,
    thumbnail_time_ms,
    variant_command,
)
from video_worker.ffmpeg_tools import (
    DEFAULT_FFMPEG_TIMEOUT_SECONDS,
    GOP_SIZE,
    HLS_SEGMENT_SECONDS,
    OUTPUT_FPS,
    FfmpegMissingError,
    FfmpegTimeoutError,
    FfmpegTranscoder,
    _ffmpeg_timeout_seconds,
    write_master_playlist,
)
from video_worker.models import Trim
from video_worker.probe import ClipWindow, ProbeResult

VERTICAL = ProbeResult(duration_ms=20_000, width=1080, height=1920, rotation=0, has_audio=True, video_codec="h264")
SILENT = ProbeResult(duration_ms=20_000, width=1080, height=1920, rotation=0, has_audio=False, video_codec="h264")
V720 = Variant(name="720p", width=720, height=1280, bitrate="2800k")


def _arg_after(command, flag):
    return command[command.index(flag) + 1]


def test_variant_command_pins_gop_so_hls_time_is_respected():
    """`-hls_time` e ignorat fara GOP fix: ffmpeg taie doar pe keyframe-uri."""
    command = variant_command(Path("in.mp4"), Path("out/360p/index.m3u8"), V720)

    assert _arg_after(command, "-g") == str(GOP_SIZE)
    assert _arg_after(command, "-keyint_min") == str(GOP_SIZE)
    assert _arg_after(command, "-r") == str(OUTPUT_FPS)
    assert _arg_after(command, "-sc_threshold") == "0"
    gop_seconds = GOP_SIZE / OUTPUT_FPS
    assert HLS_SEGMENT_SECONDS % gop_seconds == 0
    assert _arg_after(command, "-hls_time") == str(HLS_SEGMENT_SECONDS)


def test_variant_command_scales_to_exact_dims_without_pad():
    command = variant_command(Path("in.mp4"), Path("out/720p/index.m3u8"), V720)
    vf = _arg_after(command, "-vf")

    assert vf == "scale=720:1280,setsar=1"
    assert "pad" not in " ".join(command)
    assert "force_original_aspect_ratio" not in " ".join(command)


def test_encoder_args_libx264_vs_nvenc():
    x264 = variant_command(Path("in.mp4"), Path("o/index.m3u8"), V720, encoder="libx264")
    nvenc = variant_command(Path("in.mp4"), Path("o/index.m3u8"), V720, encoder="h264_nvenc")

    assert _arg_after(x264, "-c:v") == "libx264"
    assert _arg_after(x264, "-preset") == "veryfast"
    assert _arg_after(x264, "-profile:v") == "main"
    assert _arg_after(nvenc, "-c:v") == "h264_nvenc"
    assert _arg_after(nvenc, "-preset") == "p4"
    assert _arg_after(nvenc, "-profile:v") == "main"
    with pytest.raises(ValueError):
        encoder_args("vp9")


def test_trim_puts_seek_before_input_and_limits_duration():
    window = ClipWindow(start_ms=2500, duration_ms=10_000)
    commands = [
        variant_command(Path("in.mp4"), Path("o/index.m3u8"), V720, window=window),
        preview_command(Path("in.mp4"), Path("p.mp4"), width=720, height=1280, window=window),
        audio_command(Path("in.mp4"), Path("a.m4a"), window=window),
    ]
    for command in commands:
        assert command.index("-ss") < command.index("-i")
        assert _arg_after(command, "-ss") == "2.500"
        assert _arg_after(command, "-t") == "10.000"


def test_no_audio_uses_an_and_master_without_mp4a(tmp_path):
    command = variant_command(Path("in.mp4"), Path("o/index.m3u8"), V720, has_audio=False)
    assert "-an" in command
    assert "-c:a" not in command

    master = tmp_path / "master.m3u8"
    write_master_playlist(master, [V720], has_audio=False)
    content = master.read_text(encoding="utf-8")
    assert 'CODECS="avc1.4d401f"' in content
    assert "mp4a" not in content


def test_master_playlist_declares_codecs_and_real_resolution(tmp_path):
    master = tmp_path / "master.m3u8"
    write_master_playlist(
        master,
        [
            Variant(name="360p", width=360, height=640, bitrate="800k"),
            V720,
            Variant(name="1080p", width=1080, height=1920, bitrate="5000k"),
        ],
    )
    content = master.read_text(encoding="utf-8")

    assert 'CODECS="avc1.4d401e,mp4a.40.2"' in content  # Main @ L3.0
    assert 'CODECS="avc1.4d401f,mp4a.40.2"' in content  # Main @ L3.1
    assert 'CODECS="avc1.4d4028,mp4a.40.2"' in content  # Main @ L4.0
    assert "RESOLUTION=720x1280" in content
    assert "RESOLUTION=1080x1920" in content
    assert "BANDWIDTH=2800000" in content


def test_preview_keeps_full_duration_and_has_no_pad():
    command = preview_command(Path("in.mp4"), Path("p.mp4"), width=720, height=1280)

    assert "-t" not in command  # fara fereastra de trim nu se mai taie la 30s
    assert _arg_after(command, "-crf") == "24"
    assert _arg_after(command, "-vf") == "scale=720:1280,setsar=1"
    assert "+faststart" in command


def test_thumbnail_time_rule():
    assert thumbnail_time_ms(20_000, None) == 1000
    assert thumbnail_time_ms(1_200, None) == 600
    assert thumbnail_time_ms(20_000, 4_000) == 4_000
    assert thumbnail_time_ms(5_000, 9_000) == 4_900  # nu trece de ultimul cadru


def test_audio_command_is_mono_16k():
    command = audio_command(Path("in.mp4"), Path("audio.m4a"))
    assert "-vn" in command
    assert _arg_after(command, "-ac") == "1"
    assert _arg_after(command, "-ar") == "16000"
    assert _arg_after(command, "-b:a") == "48k"


def test_transcoder_reports_missing_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr("video_worker.ffmpeg_tools.shutil.which", lambda _: None)
    source = tmp_path / "input.mp4"
    source.write_bytes(b"not a real video")

    with pytest.raises(FfmpegMissingError) as exc:
        FfmpegTranscoder().transcode(source, tmp_path / "out", [V720], probe=VERTICAL)

    assert "ffmpeg" in str(exc.value)


def _fake_runner(commands):
    def run(command):
        commands.append(command)
        output = Path(command[-1])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("#EXTM3U\n", encoding="utf-8")

    return run


def test_transcoder_builds_outputs_with_trim_thumbnail_audio_and_progress(monkeypatch, tmp_path):
    monkeypatch.setattr("video_worker.ffmpeg_tools.shutil.which", lambda name: f"/usr/bin/{name}")
    commands = []
    progress = []
    source = tmp_path / "input.mp4"
    source.write_bytes(b"fake")

    result = FfmpegTranscoder(run_command=_fake_runner(commands)).transcode(
        source,
        tmp_path / "out",
        [Variant(name="360p", width=360, height=640, bitrate="800k"), V720],
        probe=VERTICAL,
        trim=Trim(start_ms=2000, end_ms=12_000),
        thumbnail_time_ms=3000,
        progress=lambda stage, pct: progress.append((stage, pct)),
    )

    assert result.variant_playlists == {
        "360p": tmp_path / "out" / "360p" / "index.m3u8",
        "720p": tmp_path / "out" / "720p" / "index.m3u8",
    }
    assert result.preview.name == "preview.mp4"
    assert result.thumbnail.name == "thumbnail.jpg"
    assert result.audio == tmp_path / "out" / "audio.m4a"
    assert len(commands) == 5  # 2 variante + preview + thumbnail + audio
    for command in commands[:3] + commands[4:]:
        assert _arg_after(command, "-ss") == "2.000"
        assert _arg_after(command, "-t") == "10.000"
    thumb = commands[3]
    assert _arg_after(thumb, "-ss") == "5.000"  # trim start + 3s
    assert _arg_after(thumb, "-frames:v") == "1"
    assert _arg_after(thumb, "-vf") == "scale=720:1280,setsar=1"
    assert progress[-1] == ("transcoding", 100)
    assert [pct for _, pct in progress] == sorted(pct for _, pct in progress)


def test_transcoder_skips_audio_for_silent_source(monkeypatch, tmp_path):
    monkeypatch.setattr("video_worker.ffmpeg_tools.shutil.which", lambda name: f"/usr/bin/{name}")
    commands = []
    source = tmp_path / "input.mp4"
    source.write_bytes(b"fake")

    result = FfmpegTranscoder(run_command=_fake_runner(commands)).transcode(
        source, tmp_path / "out", [V720], probe=SILENT
    )

    assert result.audio is None
    assert len(commands) == 3
    assert all("audio.m4a" not in c[-1] for c in commands)
    assert "-an" in commands[1]  # preview fara pista audio
    assert "mp4a" not in result.master_playlist.read_text(encoding="utf-8")


def test_small_source_preview_is_not_upscaled(monkeypatch, tmp_path):
    monkeypatch.setattr("video_worker.ffmpeg_tools.shutil.which", lambda name: f"/usr/bin/{name}")
    commands = []
    source = tmp_path / "input.mp4"
    source.write_bytes(b"fake")
    small = ProbeResult(duration_ms=5000, width=480, height=640, rotation=0, has_audio=False, video_codec=None)

    FfmpegTranscoder(run_command=_fake_runner(commands)).transcode(
        source, tmp_path / "out", [Variant("360p", 360, 480, "800k")], probe=small
    )

    assert _arg_after(commands[1], "-vf") == "scale=480:640,setsar=1"


def test_default_runner_passes_timeout_to_subprocess(monkeypatch):
    """ffmpeg trebuie invocat MEREU cu un buget de timp (P1-01)."""
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return None

    monkeypatch.setattr("video_worker.ffmpeg_tools.subprocess.run", fake_run)
    monkeypatch.delenv("FFMPEG_TIMEOUT_SECONDS", raising=False)

    FfmpegTranscoder._default_runner(["ffmpeg", "-i", "in.mp4", "out.mp4"])

    assert captured["kwargs"]["timeout"] == DEFAULT_FFMPEG_TIMEOUT_SECONDS
    assert captured["kwargs"]["check"] is True


def test_slow_runner_raises_ffmpeg_timeout_error(monkeypatch):
    """Un ffmpeg care nu se mai termină e omorât și raportat, nu blochează coada."""
    import subprocess as _subprocess

    monkeypatch.setenv("FFMPEG_TIMEOUT_SECONDS", "1")

    def slow_run(command, **kwargs):
        raise _subprocess.TimeoutExpired(cmd=command, timeout=kwargs["timeout"])

    monkeypatch.setattr("video_worker.ffmpeg_tools.subprocess.run", slow_run)

    with pytest.raises(FfmpegTimeoutError) as exc:
        FfmpegTranscoder._default_runner(["ffmpeg", "-i", "hang.mp4", "out.mp4"])

    assert "timed out after 1s" in str(exc.value)


def test_failed_ffmpeg_raises_runtime_error_with_known_prefix(monkeypatch):
    import subprocess as _subprocess

    def failing_run(command, **kwargs):
        raise _subprocess.CalledProcessError(1, command, stderr="moov atom not found")

    monkeypatch.setattr("video_worker.ffmpeg_tools.subprocess.run", failing_run)

    with pytest.raises(RuntimeError, match="^ffmpeg command failed: moov atom not found"):
        FfmpegTranscoder._default_runner(["ffmpeg", "-i", "bad.mp4", "out.mp4"])


def test_timeout_env_override_and_fallbacks(monkeypatch):
    monkeypatch.setenv("FFMPEG_TIMEOUT_SECONDS", "42")
    assert _ffmpeg_timeout_seconds() == 42

    for bad in ("0", "-5", "abc", ""):
        monkeypatch.setenv("FFMPEG_TIMEOUT_SECONDS", bad)
        assert _ffmpeg_timeout_seconds() == DEFAULT_FFMPEG_TIMEOUT_SECONDS

    monkeypatch.delenv("FFMPEG_TIMEOUT_SECONDS", raising=False)
    assert _ffmpeg_timeout_seconds() == DEFAULT_FFMPEG_TIMEOUT_SECONDS
