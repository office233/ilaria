"""ffprobe: dimensiuni de AFIȘARE (rotația aplicată), durată, audio, codec."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from .errors import FfmpegMissingError, FfmpegTimeoutError, PermanentJobError
from .models import Trim

ProbeRunner = Callable[[list[str]], str]

#: ffprobe citește doar headerele; un minut e deja generos.
PROBE_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class ProbeResult:
    duration_ms: int
    width: int
    height: int
    rotation: int
    has_audio: bool
    video_codec: str | None


@dataclass(frozen=True)
class ClipWindow:
    """Porțiunea din sursă care se procesează efectiv (după trim)."""

    start_ms: int
    duration_ms: int


def probe_command(source_path: Path) -> list[str]:
    return [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(source_path),
    ]


def parse_probe_output(raw: str | bytes | Mapping[str, Any]) -> ProbeResult:
    if isinstance(raw, Mapping):
        data: Any = raw
    else:
        try:
            data = json.loads(raw or "{}")
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise PermanentJobError("invalid_source", "ffprobe output is not valid JSON") from exc
    if not isinstance(data, Mapping):
        raise PermanentJobError("invalid_source", "ffprobe output is not an object")

    streams = [s for s in data.get("streams") or [] if isinstance(s, Mapping)]
    video = next((s for s in streams if s.get("codec_type") == "video" and not _is_cover_art(s)), None)
    if video is None:
        raise PermanentJobError("no_video_stream", "source has no video stream")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    fmt = data.get("format") if isinstance(data.get("format"), Mapping) else {}
    duration_ms = _seconds_to_ms(fmt.get("duration")) or _seconds_to_ms(video.get("duration"))
    width = _positive_int(video.get("width"))
    height = _positive_int(video.get("height"))
    if not duration_ms or not width or not height:
        raise PermanentJobError("invalid_source", "source has no usable duration or dimensions")

    rotation = _rotation(video)
    if rotation in (90, 270):
        width, height = height, width
    return ProbeResult(
        duration_ms=duration_ms,
        width=width,
        height=height,
        rotation=rotation,
        has_audio=has_audio,
        video_codec=str(video["codec_name"]) if video.get("codec_name") else None,
    )


def clip_window(probe: ProbeResult, trim: Trim | None) -> ClipWindow:
    """Aplică trim-ul peste durata sursei. Un trim invalid (end ≤ start) dă durată 0,
    pe care validarea de limite o respinge ca `duration_too_short`."""
    start = min(max(0, (trim.start_ms if trim else None) or 0), probe.duration_ms)
    end = probe.duration_ms
    if trim and trim.end_ms is not None:
        end = min(trim.end_ms, probe.duration_ms)
    return ClipWindow(start_ms=start, duration_ms=max(0, end - start))


class FfprobeProber:
    def __init__(self, run_command: ProbeRunner | None = None) -> None:
        self._run_command = run_command or _default_runner

    def probe(self, source_path: Path) -> ProbeResult:
        return parse_probe_output(self._run_command(probe_command(source_path)))


def _default_runner(command: list[str]) -> str:
    try:
        completed = subprocess.run(
            command, check=True, capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS
        )
    except FileNotFoundError as exc:
        raise FfmpegMissingError("ffprobe is not installed or is not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise FfmpegTimeoutError(f"ffprobe timed out after {PROBE_TIMEOUT_SECONDS}s") from exc
    except subprocess.CalledProcessError as exc:
        # ffprobe eșuează doar pe fișiere pe care nu le poate citi → sursă invalidă.
        stderr = (exc.stderr or "").strip()[:500]
        raise PermanentJobError("invalid_source", f"ffprobe failed: {stderr or exc}") from exc
    return completed.stdout


def _is_cover_art(stream: Mapping[str, Any]) -> bool:
    disposition = stream.get("disposition")
    return isinstance(disposition, Mapping) and bool(disposition.get("attached_pic"))


def _rotation(video: Mapping[str, Any]) -> int:
    raw: Any = None
    for side_data in video.get("side_data_list") or []:
        if isinstance(side_data, Mapping) and side_data.get("rotation") not in (None, ""):
            raw = side_data.get("rotation")
            break
    if raw is None:
        tags = video.get("tags")
        if isinstance(tags, Mapping):
            raw = tags.get("rotate")
    try:
        return int(round(float(raw))) % 360 if raw is not None else 0
    except (TypeError, ValueError):
        return 0


def _seconds_to_ms(value: Any) -> int:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return 0
    if seconds != seconds or seconds <= 0 or seconds == float("inf"):
        return 0
    return int(round(seconds * 1000))


def _positive_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0
