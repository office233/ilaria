"""Erori tipizate + clasificarea lor în (error_code, transient).

`error_code` ajunge în `video_processing_jobs.error_code` și e tradus în UI
(duration_too_long, no_video_stream, …). `transient` decide dacă workerul
reîncearcă inline jobul.
"""
from __future__ import annotations


class PermanentJobError(RuntimeError):
    """Eroare care nu se rezolvă prin reîncercare (sursă invalidă, limite)."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


class FfmpegMissingError(RuntimeError):
    pass


class ShutdownRequested(BaseException):
    """SIGTERM/SIGINT în timpul unui job (VIDEO_SHUTDOWN_MODE=release).

    Subclasă de BaseException ca `except Exception` din procesor să NU o
    înghită: urcă până în bucla principală, care eliberează jobul în coadă.
    """


class FfmpegTimeoutError(RuntimeError):
    """ffmpeg a depășit bugetul de timp alocat și a fost omorât."""


FFMPEG_FAILED_PREFIX = "ffmpeg command failed"

# Nume de clase botocore/urllib3 (fără import botocore aici).
_STORAGE_CLASS_MARKERS = ("Endpoint", "ClientError", "ConnectionError", "ReadTimeout")
# Dependențe lipsă în imagine (boto3/psycopg) — retry nu ajută.
_MISCONFIGURED_CLASS_NAMES = {"StorageUnavailableError", "DatabaseUnavailableError"}


def classify_error(exc: BaseException) -> tuple[str, bool]:
    """Întoarce (error_code, transient) pentru o excepție ridicată de pipeline."""
    if isinstance(exc, PermanentJobError):
        return exc.code, False
    if isinstance(exc, FfmpegMissingError):
        return "worker_misconfigured", False
    if isinstance(exc, FfmpegTimeoutError):
        return "timeout", False
    names = [cls.__name__ for cls in type(exc).__mro__]
    if any(name in _MISCONFIGURED_CLASS_NAMES for name in names):
        return "worker_misconfigured", False
    if isinstance(exc, RuntimeError) and str(exc).startswith(FFMPEG_FAILED_PREFIX):
        return "transcode_failed", False
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return "storage_error", True
    if any(marker in name for name in names for marker in _STORAGE_CLASS_MARKERS):
        return "storage_error", True
    return "internal_error", True
