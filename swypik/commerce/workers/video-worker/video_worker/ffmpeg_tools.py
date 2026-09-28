from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import Variant
from .errors import FFMPEG_FAILED_PREFIX, FfmpegMissingError, FfmpegTimeoutError
from .ffmpeg_commands import (
    GOP_SIZE,
    HLS_SEGMENT_SECONDS,
    OUTPUT_FPS,
    PREVIEW_MAX_SHORT_SIDE,
    audio_command,
    bitrate_to_bandwidth,
    preview_command,
    thumbnail_command,
    variant_command,
)
from .ffmpeg_commands import (
    # alias: parametrul `thumbnail_time_ms` din transcode() ar umbri funcția
    thumbnail_time_ms as thumbnail_time_ms_for,
)
from .models import Trim
from .probe import ProbeResult, clip_window
from .renditions import dims_for_short_side

__all__ = [
    "DEFAULT_FFMPEG_TIMEOUT_SECONDS",
    "GOP_SIZE",
    "HLS_SEGMENT_SECONDS",
    "OUTPUT_FPS",
    "FfmpegMissingError",
    "FfmpegTimeoutError",
    "FfmpegTranscoder",
    "TranscodeResult",
    "write_master_playlist",
]

#: Bugetul implicit (secunde) pentru o singură comandă ffmpeg. Suprascriere via
#: FFMPEG_TIMEOUT_SECONDS. Fără el, un fișier sursă malformat blochează la
#: infinit bucla single-threaded din main.py → toată coada de transcodare stă.
DEFAULT_FFMPEG_TIMEOUT_SECONDS = 900


def _ffmpeg_timeout_seconds() -> int:
    raw = os.environ.get("FFMPEG_TIMEOUT_SECONDS")
    if not raw:
        return DEFAULT_FFMPEG_TIMEOUT_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_FFMPEG_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_FFMPEG_TIMEOUT_SECONDS


CommandRunner = Callable[[list[str]], None]
ProgressCallback = Callable[[str, int], None]


def codec_string(variant: Variant, has_audio: bool = True) -> str:
    """Atributul CODECS pentru EXT-X-STREAM-INF (RFC 6381).

    Fără CODECS, playerul trebuie să descarce câte un segment din fiecare
    variantă ca să afle ce conține; Safari/AVPlayer pot respinge varianta.
    `avc1.4d40XX`: 4d = profil Main, XX = nivelul × 10 în hex. `mp4a.40.2`: AAC-LC,
    declarat DOAR dacă sursa are audio (altfel playerul așteaptă o pistă inexistentă).
    """
    pixels = variant.width * variant.height
    if pixels <= 640 * 360:
        level = "1e"  # 3.0
    elif pixels <= 1280 * 720:
        level = "1f"  # 3.1
    else:
        level = "28"  # 4.0
    video = f"avc1.4d40{level}"
    return f"{video},mp4a.40.2" if has_audio else video


def write_master_playlist(path: Path, variants: list[Variant], has_audio: bool = True) -> None:
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for variant in variants:
        lines.extend(
            [
                f"#EXT-X-STREAM-INF:BANDWIDTH={bitrate_to_bandwidth(variant.bitrate)}"
                f",RESOLUTION={variant.width}x{variant.height}"
                f',CODECS="{codec_string(variant, has_audio)}"',
                f"{variant.name}/index.m3u8",
            ]
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class TranscodeResult:
    master_playlist: Path
    variant_playlists: dict[str, Path]
    thumbnail: Path
    preview: Path
    audio: Path | None = None


class FfmpegTranscoder:
    def __init__(self, run_command: CommandRunner | None = None, encoder: str = "libx264") -> None:
        self._run_command = run_command or self._default_runner
        self.encoder = encoder

    def transcode(
        self,
        source_path: Path,
        output_dir: Path,
        variants: list[Variant],
        *,
        probe: ProbeResult,
        trim: Trim | None = None,
        thumbnail_time_ms: int | None = None,
        progress: ProgressCallback | None = None,
        audio_override: Path | None = None,
        speech_audio: bool = True,
    ) -> TranscodeResult:
        """`audio_override`: pista mixată (sunetul ales, sound_mix.py) folosită în
        locul audio-ului sursei. `speech_audio=False`: originalul a fost înlocuit,
        deci nu se scoate `audio.m4a` pentru subtitrări (vorbirea nu mai e în clip)."""
        self._ensure_ffmpeg()
        output_dir.mkdir(parents=True, exist_ok=True)
        window = clip_window(probe, trim)
        small_w, small_h = dims_for_short_side(
            probe.width, probe.height, min(PREVIEW_MAX_SHORT_SIDE, min(probe.width, probe.height))
        )

        has_audio = probe.has_audio or audio_override is not None
        speech = probe.has_audio and speech_audio
        total_steps = len(variants) + 2 + (1 if speech else 0)
        done = 0

        def step(command: list[str]) -> None:
            nonlocal done
            self._run_command(command)
            done += 1
            if progress is not None:
                progress("transcoding", int(done * 100 / total_steps))

        playlists: dict[str, Path] = {}
        for variant in variants:
            variant_dir = output_dir / variant.name
            variant_dir.mkdir(parents=True, exist_ok=True)
            playlist = variant_dir / "index.m3u8"
            step(
                variant_command(
                    source_path, playlist, variant,
                    encoder=self.encoder, has_audio=has_audio, window=window, audio_path=audio_override,
                )
            )
            playlists[variant.name] = playlist

        master_playlist = output_dir / "master.m3u8"
        write_master_playlist(master_playlist, variants, has_audio=has_audio)

        preview = output_dir / "preview.mp4"
        step(
            preview_command(
                source_path, preview, width=small_w, height=small_h,
                encoder=self.encoder, has_audio=has_audio, window=window, audio_path=audio_override,
            )
        )

        thumbnail = output_dir / "thumbnail.jpg"
        at_ms = window.start_ms + thumbnail_time_ms_for(window.duration_ms, thumbnail_time_ms)
        step(thumbnail_command(source_path, thumbnail, at_ms=at_ms, width=small_w, height=small_h))

        audio: Path | None = None
        if speech:
            audio = output_dir / "audio.m4a"
            step(audio_command(source_path, audio, window=window))

        return TranscodeResult(
            master_playlist=master_playlist,
            variant_playlists=playlists,
            thumbnail=thumbnail,
            preview=preview,
            audio=audio,
        )

    def _ensure_ffmpeg(self) -> None:
        if not shutil.which("ffmpeg"):
            raise FfmpegMissingError(
                "ffmpeg is not installed or is not on PATH; install ffmpeg to process videos"
            )

    @staticmethod
    def _default_runner(command: list[str]) -> None:
        timeout_s = _ffmpeg_timeout_seconds()
        try:
            subprocess.run(
                command, check=True, capture_output=True, text=True, timeout=timeout_s
            )
        except FileNotFoundError as exc:
            raise FfmpegMissingError(
                "ffmpeg is not installed or is not on PATH; install ffmpeg to process videos"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            # subprocess.run omoară procesul copil înainte de a ridica excepția.
            raise FfmpegTimeoutError(
                f"ffmpeg command timed out after {timeout_s}s: {' '.join(command[:3])}"
            ) from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()[-2000:]
            raise RuntimeError(f"{FFMPEG_FAILED_PREFIX}: {stderr or exc}") from exc

