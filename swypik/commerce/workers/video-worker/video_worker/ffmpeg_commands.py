"""Constructori PURI de comenzi ffmpeg (testabili fără ffmpeg instalat)."""
from __future__ import annotations

from pathlib import Path

from .config import Variant
from .probe import ClipWindow

#: Durata țintă a unui segment HLS (secunde).
HLS_SEGMENT_SECONDS = 6

#: Cadre pe secundă impuse la ieșire. Fără o rată fixă nu putem calcula un GOP
#: care să corespundă exact duratei de segment.
OUTPUT_FPS = 24

#: Distanța dintre keyframe-uri, în cadre. `-hls_time` e doar o *sugestie*:
#: ffmpeg poate tăia un segment numai pe un keyframe. Cu GOP-ul implicit
#: (250 de cadre ≈ 10.4s la 24fps) segmentele ieșeau de ~10.4s în loc de 6s.
#: Un GOP de 48 de cadre = 2s se împarte exact în 6s.
GOP_SIZE = OUTPUT_FPS * 2

#: Latura scurtă maximă pentru preview.mp4 și thumbnail.jpg.
PREVIEW_MAX_SHORT_SIDE = 720

#: Poster implicit: la 1s (sau la jumătatea clipurilor sub 2s).
DEFAULT_THUMBNAIL_MS = 1000


def seconds(ms: int) -> str:
    return f"{max(0, ms) / 1000:.3f}"


def input_args(source_path: Path, window: ClipWindow | None) -> list[str]:
    """`-ss` ÎNAINTE de `-i` (seek rapid pe input) + `-t` = durata efectivă."""
    args: list[str] = []
    if window is not None and window.start_ms > 0:
        args += ["-ss", seconds(window.start_ms)]
    args += ["-i", str(source_path)]
    if window is not None and window.duration_ms > 0:
        args += ["-t", seconds(window.duration_ms)]
    return args


def av_input_args(source_path: Path, window: ClipWindow | None, audio_path: Path | None) -> list[str]:
    """Intrările pentru o ieșire audio+video. Cu `audio_path` (mixul de sunet, deja
    tăiat pe fereastra clipului): video din sursă, audio din mix; `-t` devine
    opțiune de ieșire (după al doilea `-i` ar limita altfel doar mixul)."""
    if audio_path is None:
        return input_args(source_path, window)
    args: list[str] = []
    if window is not None and window.start_ms > 0:
        args += ["-ss", seconds(window.start_ms)]
    args += ["-i", str(source_path), "-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0"]
    if window is not None and window.duration_ms > 0:
        args += ["-t", seconds(window.duration_ms)]
    return args


def encoder_args(encoder: str) -> list[str]:
    if encoder == "libx264":
        return ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main"]
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-profile:v", "main"]
    raise ValueError(f"Unsupported video encoder: {encoder}")


def _quality_args(encoder: str, quality: int) -> list[str]:
    # libx264 folosește CRF; NVENC nu are -crf, echivalentul e VBR cu -cq.
    if encoder == "h264_nvenc":
        return ["-rc", "vbr", "-cq", str(quality), "-b:v", "0"]
    return ["-crf", str(quality)]


def variant_command(
    source_path: Path,
    playlist: Path,
    variant: Variant,
    *,
    encoder: str = "libx264",
    has_audio: bool = True,
    window: ClipWindow | None = None,
    audio_path: Path | None = None,
) -> list[str]:
    segment_pattern = playlist.parent / "segment_%05d.ts"
    has_audio = has_audio or audio_path is not None
    command = ["ffmpeg", "-y", *av_input_args(source_path, window, audio_path)]
    # Dimensiuni EXACTE calculate din aspectul sursei — fără pad (fără benzi negre).
    command += ["-vf", f"scale={variant.width}:{variant.height},setsar=1"]
    command += encoder_args(encoder)
    # Rată de cadre fixă + GOP fix: obligatorii ca `-hls_time` să fie respectat
    # și ca variantele să aibă keyframe-uri aliniate între ele.
    command += [
        "-r", str(OUTPUT_FPS),
        "-g", str(GOP_SIZE),
        "-keyint_min", str(GOP_SIZE),
        # Fără asta ffmpeg inserează keyframe-uri la schimbările de scenă.
        "-sc_threshold", "0",
    ]
    if encoder == "h264_nvenc":
        command += ["-no-scenecut", "1"]
    command += [
        "-b:v", variant.bitrate,
        "-maxrate", variant.bitrate,
        "-bufsize", double_bitrate(variant.bitrate),
    ]
    command += ["-c:a", "aac", "-ar", "48000", "-b:a", "128k"] if has_audio else ["-an"]
    command += [
        "-hls_time", str(HLS_SEGMENT_SECONDS),
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", str(segment_pattern),
        str(playlist),
    ]
    return command


def preview_command(
    source_path: Path,
    preview: Path,
    *,
    width: int,
    height: int,
    encoder: str = "libx264",
    has_audio: bool = True,
    window: ClipWindow | None = None,
    audio_path: Path | None = None,
) -> list[str]:
    has_audio = has_audio or audio_path is not None
    command = ["ffmpeg", "-y", *av_input_args(source_path, window, audio_path)]
    command += ["-vf", f"scale={width}:{height},setsar=1"]
    command += encoder_args(encoder)
    command += _quality_args(encoder, 24)
    command += ["-c:a", "aac", "-b:a", "128k"] if has_audio else ["-an"]
    command += ["-movflags", "+faststart", str(preview)]
    return command


def thumbnail_time_ms(duration_ms: int, requested_ms: int | None) -> int:
    """Momentul posterului, relativ la începutul clipului tăiat."""
    if requested_ms is not None:
        # Nu trecem de ultimul cadru (altfel ffmpeg nu scoate nicio imagine).
        return max(0, min(requested_ms, duration_ms - 100))
    return min(DEFAULT_THUMBNAIL_MS, duration_ms // 2)


def thumbnail_command(
    source_path: Path,
    thumbnail: Path,
    *,
    at_ms: int,
    width: int,
    height: int,
) -> list[str]:
    """`at_ms` e ABSOLUT în sursă (trim.start + timpul relativ)."""
    return [
        "ffmpeg", "-y",
        "-ss", seconds(at_ms),
        "-i", str(source_path),
        "-frames:v", "1",
        "-vf", f"scale={width}:{height},setsar=1",
        "-q:v", "2",
        str(thumbnail),
    ]


def audio_command(source_path: Path, output: Path, *, window: ClipWindow | None = None) -> list[str]:
    """Pistă mono 16 kHz, mică — intrare pentru speech-to-text (subtitrări)."""
    return [
        "ffmpeg", "-y", *input_args(source_path, window),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k",
        str(output),
    ]


def bitrate_to_bandwidth(value: str) -> int:
    stripped = value.strip().lower()
    if stripped.endswith("k"):
        return int(float(stripped[:-1]) * 1000)
    if stripped.endswith("m"):
        return int(float(stripped[:-1]) * 1000 * 1000)
    return int(stripped)


def double_bitrate(value: str) -> str:
    stripped = value.strip().lower()
    if stripped.endswith("k"):
        return f"{int(float(stripped[:-1]) * 2)}k"
    if stripped.endswith("m"):
        return f"{float(stripped[:-1]) * 2:g}m"
    return str(int(stripped) * 2)
