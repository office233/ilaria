"""Hook de analiză post-transcodare pe Azure AI:

1. Subtitrări automate: `audio.m4a` (mono 16 kHz @ 48 kbps ≈ 0,36 MB/min, deci
   sub limita Whisper de 25 MB pentru orice clip sub ~69 min) → Whisper verbose_json →
   segmente în `video_captions` (is_auto = true; un text editat de creator nu se
   suprascrie). WebVTT-ul se servește din segmente de GET /api/videos/[id]/captions.
2. Moderarea vorbirii: transcrierea Whisper → Content Safety text:analyze (praguri
   CONTENT_SAFETY_TEXT_*). review / block / indisponibil → caz `speech_ai` + clipul
   ține `pending_review` (aceeași regulă ca thumbnail-ul). VIDEO_SPEECH_MODERATION=0 oprește.
3. Moderarea thumbnail-ului: `thumbnail.jpg` → Content Safety image:analyze.
   review / block / indisponibil (429 F0) → caz `image_ai` în `moderation_cases` +
   `moderation_status = 'pending_review'` dacă era aprobat. Gate-ul de publicare
   nu aprobă automat cât timp cazul e deschis.

Hook-ul nu pică niciodată jobul: orice eroare e logată și ignorată.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Mapping

from .azure_ai import AzureAIClient, AzureAIError, AzureAISettings, analyze_text, image_verdict
from .models import VideoJob

logger = logging.getLogger(__name__)

#: Nume de limbă întoarse de Whisper → cod ISO (locale-le Swypik + vecine frecvente).
WHISPER_LANGUAGES = {
    "romanian": "ro", "english": "en", "spanish": "es", "french": "fr", "german": "de",
    "portuguese": "pt", "italian": "it", "hungarian": "hu", "russian": "ru", "ukrainian": "uk",
    "polish": "pl", "turkish": "tr", "dutch": "nl", "bulgarian": "bg", "moldavian": "ro",
}

CAPTIONS_SQL = (
    "INSERT INTO video_captions (video_id, lang, text, segments, is_auto, updated_at) "
    "VALUES (%s, %s, %s, %s::jsonb, true, NOW()) "
    "ON CONFLICT (video_id, lang) DO UPDATE "
    "SET text = EXCLUDED.text, segments = EXCLUDED.segments, is_auto = true, updated_at = NOW() "
    "WHERE video_captions.is_auto = true"
)
CASE_SQL = (
    "INSERT INTO moderation_cases (target_video_id, severity, status, metadata, created_at, updated_at) "
    "SELECT %s, %s, 'open', %s::jsonb, NOW(), NOW() "
    "WHERE NOT EXISTS (SELECT 1 FROM moderation_cases WHERE target_video_id = %s "
    "AND status = 'open' AND metadata->>'source' = 'image_ai')"
)
SPEECH_CASE_SQL = (
    "INSERT INTO moderation_cases (target_video_id, severity, status, metadata, created_at, updated_at) "
    "SELECT %s, %s, 'open', %s::jsonb, NOW(), NOW() "
    "WHERE NOT EXISTS (SELECT 1 FROM moderation_cases WHERE target_video_id = %s "
    "AND status = 'open' AND metadata->>'source' = 'speech_ai')"
)
HOLD_SQL = (
    "UPDATE videos SET moderation_status = 'pending_review', updated_at = NOW() "
    "WHERE id = %s AND moderation_status = 'approved'"
)


def caption_language(job: VideoJob, detected: Any) -> str | None:
    requested = job.metadata.get("language") if isinstance(job.metadata, Mapping) else None
    if isinstance(requested, str) and 2 <= len(requested.strip()) <= 5:
        return requested.strip().lower()[:2]
    if isinstance(detected, str):
        name = detected.strip().lower()
        if len(name) == 2:
            return name
        return WHISPER_LANGUAGES.get(name)
    return None


def to_segments(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for seg in raw or []:
        try:
            start, end = float(seg.get("start") or 0), float(seg.get("end") or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        text = str(seg.get("text") or "").strip()
        if text and end > start:
            out.append({"start": start, "end": end, "text": text})
    return out


class AzureAnalysisHook:
    def __init__(self, settings: AzureAISettings, repository: Any, client: AzureAIClient | None = None) -> None:
        self.settings = settings
        self.repository = repository
        self.client = client or AzureAIClient(settings)

    @property
    def enabled(self) -> bool:
        s = self.settings
        return (s.auto_captions and s.whisper_configured) or (s.image_moderation and s.safety_configured)

    def before_transcode(self, job: VideoJob, source_path: Path) -> None:
        del job, source_path

    def after_transcode(self, job, source_path, output_dir, transcode_result, upload_result) -> Mapping[str, Any] | None:
        del source_path, transcode_result, upload_result
        if not job.video_id:
            return None
        analysis: dict[str, Any] = {}
        transcript: str | None = None
        try:
            captions = self._captions(job, Path(output_dir) / "audio.m4a")
            transcript = captions.pop("_transcript", None)
            analysis.update(captions)
        except Exception:  # noqa: BLE001 — subtitrările nu au voie să pice jobul
            logger.exception("Job %s: auto-captions failed", job.job_id)
        try:
            analysis.update(self._speech(job, transcript))
        except Exception:  # noqa: BLE001
            logger.exception("Job %s: speech moderation failed", job.job_id)
        try:
            analysis.update(self._thumbnail(job, Path(output_dir) / "thumbnail.jpg"))
        except Exception:  # noqa: BLE001
            logger.exception("Job %s: thumbnail moderation failed", job.job_id)
        return analysis or None

    def _captions(self, job: VideoJob, audio: Path) -> dict[str, Any]:
        if not (self.settings.auto_captions and self.settings.whisper_configured) or not audio.is_file():
            return {}
        requested = caption_language(job, None)
        try:
            result = self.client.transcribe(audio.read_bytes(), language=requested)
        except AzureAIError as exc:
            logger.warning("Job %s: whisper unavailable (%s)", job.job_id, exc.code)
            return {"captions": {"status": "unavailable", "code": exc.code}}
        segments = to_segments(result.get("segments"))
        lang = requested or caption_language(job, result.get("language"))
        text = str(result.get("text") or "").strip()
        if not segments or not text or not lang:
            # Vorbirea se moderează chiar dacă nu iese o pistă de subtitrare utilizabilă.
            return {"captions": {"status": "empty"}, "_transcript": text or None}
        self._execute(CAPTIONS_SQL, (job.video_id, lang, text, json.dumps(segments)))
        return {"captions": {"status": "generated", "lang": lang, "segments": len(segments)}, "_transcript": text}

    def _speech(self, job: VideoJob, transcript: str | None) -> dict[str, Any]:
        s = self.settings
        text = " ".join((transcript or "").split())
        if not (s.speech_moderation and s.safety_configured) or not text:
            return {}
        try:
            scores = analyze_text(self.client, text)
            decision, reasons = image_verdict(scores, s.text_review_at, s.text_block_at)
        except AzureAIError as exc:
            logger.warning("Job %s: content safety (text) unavailable (%s)", job.job_id, exc.code)
            decision, reasons = "unavailable", ["moderation_unavailable"]
        if decision == "allow":
            return {"speech_moderation": {"decision": "allow"}}
        severity = "low" if decision == "unavailable" else "high" if decision == "block" else "medium"
        metadata = json.dumps({
            "source": "speech_ai", "reasons": reasons, "kind": "speech", "decision": decision, "text": text[:500],
        })
        self._execute(SPEECH_CASE_SQL, (job.video_id, severity, metadata, job.video_id))
        self._execute(HOLD_SQL, (job.video_id,))
        return {"speech_moderation": {"decision": decision, "reasons": reasons}}

    def _thumbnail(self, job: VideoJob, thumbnail: Path) -> dict[str, Any]:
        s = self.settings
        if not (s.image_moderation and s.safety_configured) or not thumbnail.is_file():
            return {}
        try:
            scores = self.client.analyze_image(thumbnail.read_bytes())
            decision, reasons = image_verdict(scores, s.image_review_at, s.image_block_at)
        except AzureAIError as exc:
            logger.warning("Job %s: content safety unavailable (%s)", job.job_id, exc.code)
            decision, reasons = "unavailable", ["moderation_unavailable"]
        if decision == "allow":
            return {"image_moderation": {"decision": "allow"}}
        severity = "low" if decision == "unavailable" else "high" if decision == "block" else "medium"
        metadata = json.dumps({"source": "image_ai", "reasons": reasons, "kind": "thumbnail", "decision": decision})
        self._execute(CASE_SQL, (job.video_id, severity, metadata, job.video_id))
        self._execute(HOLD_SQL, (job.video_id,))
        return {"image_moderation": {"decision": decision, "reasons": reasons}}

    def _execute(self, sql: str, params: tuple[Any, ...]) -> None:
        settings = getattr(self.repository, "settings", None)
        if settings is None or not getattr(settings, "database_url", None):
            return
        connection = self.repository._connect()  # noqa: SLF001 — refolosim pool-ul repository-ului
        try:
            with connection:
                with connection.cursor() as cursor:
                    cursor.execute(sql, params)
        finally:
            self.repository._release(connection)  # noqa: SLF001
