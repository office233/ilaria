from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

from .ffmpeg_tools import TranscodeResult
from .models import VideoJob


@dataclass(frozen=True)
class StatusEvent:
    job: VideoJob
    status: str
    message: str | None = None
    result: Mapping[str, Any] | None = None


class StatusHook(Protocol):
    def handle(self, event: StatusEvent) -> None:
        ...


class VideoAnalysisHook(Protocol):
    def before_transcode(self, job: VideoJob, source_path: Path) -> None:
        ...

    def after_transcode(
        self,
        job: VideoJob,
        source_path: Path,
        output_dir: Path,
        transcode_result: TranscodeResult,
        upload_result: Mapping[str, Any],
    ) -> Mapping[str, Any] | None:
        ...
