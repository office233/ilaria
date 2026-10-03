"""Mixarea sunetului ales de creator („Adaugă sunet”) în clip.

Setările vin din DB (`videos.audio_track_id` + `videos.metadata.sound_mix`, scrise
de PATCH /api/creator/videos/[id]); doar piese active și licențiate comercial
(`audio_tracks.is_active AND licensed_for_commercial`). Workerul:

1. descarcă piesa (https, anti-SSRF, plafon de mărime);
2. produce `mix.m4a` pe fereastra tăiată a clipului: piesa (volum, start, buclă)
   + opțional audio-ul original (volum), cu `amix` fără normalizare;
3. transcodează cu video-ul sursei + pista mixată (ffmpeg_commands, `audio_path`).

Cheia mixului (`sound_key`) e identică cu `soundMixKey()` din lib/video/sound-mix.ts;
workerul o scrie în `metadata.sound_mixed_key`, ca web-ul să știe ce s-a mixat efectiv.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from .ffmpeg_commands import seconds
from .io_helpers import download_http
from .probe import ClipWindow

logger = logging.getLogger(__name__)

#: Plafonul piesei descărcate (o piesă de câteva minute are 3-10 MB).
MAX_TRACK_BYTES = 40 * 1024 * 1024
VOLUME_MAX_PCT = 200
START_MAX_MS = 10 * 60 * 1000
DEFAULT_VOLUME_PCT = 100
NO_SOUND_KEY = "none"


@dataclass(frozen=True)
class SoundSpec:
    track_id: int
    audio_url: str
    volume: int = DEFAULT_VOLUME_PCT
    original_volume: int = DEFAULT_VOLUME_PCT
    keep_original: bool = True
    loop: bool = True
    start_ms: int = 0

    @property
    def key(self) -> str:
        return (
            f"t{self.track_id}-v{self.volume}-o{self.original_volume}"
            f"-k{1 if self.keep_original else 0}-l{1 if self.loop else 0}-s{self.start_ms}"
        )


def _clamp_int(value: Any, fallback: int, maximum: int) -> int:
    if value is None or isinstance(value, bool):
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    # Rotunjire „half up”, ca Math.round din TS (round() din Python e bancară).
    return int(min(maximum, max(0.0, number)) + 0.5)


def _flag(value: Any, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def spec_from_row(row: Mapping[str, Any] | None) -> SoundSpec | None:
    """Rândul din `load_sound_spec` → SoundSpec; None dacă nu e nimic de mixat (pur)."""
    if not row:
        return None
    try:
        track_id = int(row.get("audio_track_id") or 0)
    except (TypeError, ValueError):
        return None
    url = str(row.get("audio_url") or "").strip()
    if track_id <= 0 or not url.lower().startswith("https://"):
        return None
    mix = row.get("sound_mix")
    mix = mix if isinstance(mix, Mapping) else {}
    return SoundSpec(
        track_id=track_id,
        audio_url=url,
        volume=_clamp_int(mix.get("volume"), DEFAULT_VOLUME_PCT, VOLUME_MAX_PCT),
        original_volume=_clamp_int(mix.get("original_volume"), DEFAULT_VOLUME_PCT, VOLUME_MAX_PCT),
        keep_original=_flag(mix.get("keep_original"), True),
        loop=_flag(mix.get("loop"), True),
        start_ms=_clamp_int(mix.get("start_ms"), 0, START_MAX_MS),
    )


def sound_key(spec: SoundSpec | None) -> str:
    return spec.key if spec is not None else NO_SOUND_KEY


def _gain(pct: int) -> str:
    return f"{pct / 100:.2f}"


def mix_audio_command(
    source_path: Path,
    track_path: Path,
    output: Path,
    spec: SoundSpec,
    *,
    window: ClipWindow,
    source_has_audio: bool,
) -> list[str]:
    """Pista finală (stereo 48 kHz AAC) pe fereastra clipului: piesă [+ original]."""
    duration = seconds(window.duration_ms)
    command = ["ffmpeg", "-y"]
    use_original = spec.keep_original and source_has_audio
    if use_original:
        if window.start_ms > 0:
            command += ["-ss", seconds(window.start_ms)]
        # `-t` ÎNAINTEA lui `-i` = opțiune de input (limitează doar originalul).
        command += ["-t", duration, "-i", str(source_path)]
    if spec.loop:
        command += ["-stream_loop", "-1"]
    if spec.start_ms > 0:
        command += ["-ss", seconds(spec.start_ms)]
    command += ["-i", str(track_path)]
    track_input = 1 if use_original else 0
    music = f"[{track_input}:a]aresample=48000,volume={_gain(spec.volume)},apad"
    if use_original:
        graph = (
            f"[0:a]aresample=48000,volume={_gain(spec.original_volume)}[o];{music}[m];"
            "[o][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,apad[a]"
        )
    else:
        graph = f"{music}[a]"
    command += [
        "-filter_complex", graph,
        "-map", "[a]",
        "-t", duration,
        "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "128k",
        str(output),
    ]
    return command


CommandRunner = Callable[[list[str]], None]
Downloader = Callable[..., None]


class SoundMixer:
    """Descarcă piesa și produce `mix.m4a`. Erorile urcă la apelant (workerul decide)."""

    def __init__(self, run_command: CommandRunner, download: Downloader = download_http) -> None:
        self._run = run_command
        self._download = download

    def prepare(
        self,
        spec: SoundSpec,
        source_path: Path,
        window: ClipWindow,
        *,
        source_has_audio: bool,
        work_dir: Path,
    ) -> Path:
        work_dir.mkdir(parents=True, exist_ok=True)
        track = work_dir / f"track-{spec.track_id}"
        self._download(spec.audio_url, track, max_bytes=MAX_TRACK_BYTES)
        output = work_dir / "mix.m4a"
        self._run(
            mix_audio_command(
                source_path, track, output, spec, window=window, source_has_audio=source_has_audio
            )
        )
        return output
