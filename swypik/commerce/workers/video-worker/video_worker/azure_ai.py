"""Client minimal Azure AI (stdlib): Whisper (transcriere) + Content Safety (imagine + text).

Oglinda lui `lib/ai/azure` din Next: timeout per încercare, retry pe 408/429/5xx
cu `Retry-After` / `retry-after-ms`, erori tipizate. Cheile nu apar în loguri.
"""
from __future__ import annotations

import base64
import json
import logging
import random
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping

logger = logging.getLogger(__name__)

WHISPER_API_VERSION = "2024-06-01"
WHISPER_MAX_BYTES = 25 * 1024 * 1024
SAFETY_IMAGE_MAX_BYTES = 4 * 1024 * 1024
#: text:analyze acceptă max 10k caractere per cerere.
SAFETY_TEXT_MAX_CHARS = 10_000
SAFETY_CATEGORIES = ("Hate", "SelfHarm", "Sexual", "Violence")


class AzureAIError(RuntimeError):
    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _env(values: Mapping[str, str], name: str) -> str:
    return (values.get(name) or "").strip()


def _severity(values: Mapping[str, str], name: str, fallback: int) -> int:
    try:
        n = int(_env(values, name))
    except ValueError:
        return fallback
    return n if 0 <= n <= 7 else fallback


@dataclass(frozen=True)
class AzureAISettings:
    openai_endpoint: str | None
    openai_key: str | None
    whisper_deployment: str | None
    safety_endpoint: str | None
    safety_key: str | None
    safety_api_version: str = "2024-09-01"
    image_review_at: int = 2
    image_block_at: int = 4
    text_review_at: int = 4
    text_block_at: int = 6
    auto_captions: bool = True
    image_moderation: bool = True
    speech_moderation: bool = True
    timeout_seconds: float = 120.0
    max_attempts: int = 3
    max_retry_wait_seconds: float = 8.0

    @classmethod
    def from_env(cls, values: Mapping[str, str]) -> "AzureAISettings":
        def flag(name: str) -> bool:
            return _env(values, name).lower() not in ("0", "false", "no", "off")

        return cls(
            openai_endpoint=_env(values, "AZURE_OPENAI_ENDPOINT").rstrip("/") or None,
            openai_key=_env(values, "AZURE_OPENAI_API_KEY") or None,
            whisper_deployment=_env(values, "AZURE_OPENAI_WHISPER_DEPLOYMENT") or None,
            safety_endpoint=_env(values, "AZURE_CONTENT_SAFETY_ENDPOINT").rstrip("/") or None,
            safety_key=_env(values, "AZURE_CONTENT_SAFETY_KEY") or None,
            safety_api_version=_env(values, "AZURE_CONTENT_SAFETY_API_VERSION") or "2024-09-01",
            image_review_at=_severity(values, "CONTENT_SAFETY_IMAGE_REVIEW_AT", 2),
            image_block_at=_severity(values, "CONTENT_SAFETY_IMAGE_BLOCK_AT", 4),
            # Aceleași praguri ca moderarea textului din Next (lib/ai/azure/config.ts).
            text_review_at=_severity(values, "CONTENT_SAFETY_TEXT_REVIEW_AT", 4),
            text_block_at=_severity(values, "CONTENT_SAFETY_TEXT_BLOCK_AT", 6),
            auto_captions=flag("VIDEO_AUTO_CAPTIONS"),
            image_moderation=flag("VIDEO_IMAGE_MODERATION"),
            speech_moderation=flag("VIDEO_SPEECH_MODERATION"),
        )

    @property
    def whisper_configured(self) -> bool:
        return bool(self.openai_endpoint and self.openai_key and self.whisper_deployment)

    @property
    def safety_configured(self) -> bool:
        return bool(self.safety_endpoint and self.safety_key)


Opener = Callable[..., Any]


def _retry_after_seconds(headers: Any) -> float | None:
    if headers is None:
        return None
    raw_ms = headers.get("retry-after-ms")
    if raw_ms:
        try:
            return max(0.0, float(raw_ms) / 1000)
        except ValueError:
            pass
    raw = headers.get("retry-after")
    if raw:
        try:
            return max(0.0, float(raw))
        except ValueError:
            return None
    return None


class AzureAIClient:
    def __init__(self, settings: AzureAISettings, opener: Opener | None = None, sleep: Callable[[float], None] | None = None) -> None:
        self.settings = settings
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep or time.sleep

    def _post(self, op: str, url: str, headers: dict[str, str], body: bytes) -> dict[str, Any]:
        last: AzureAIError | None = None
        attempts = max(1, self.settings.max_attempts)
        for attempt in range(1, attempts + 1):
            request = urllib.request.Request(url, data=body, headers=headers, method="POST")
            wait: float | None = None
            try:
                with self._open(request, timeout=self.settings.timeout_seconds) as response:
                    return json.loads(response.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as exc:
                status = exc.code
                code = "rate_limited" if status == 429 else "http"
                last = AzureAIError(code, f"{op}: HTTP {status}", status)
                if not (status in (408, 429) or status >= 500):
                    break
                wait = _retry_after_seconds(exc.headers)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last = AzureAIError("network", f"{op}: {exc.__class__.__name__}")
            except ValueError:
                raise AzureAIError("bad_response", f"{op}: invalid JSON")
            if attempt == attempts:
                break
            delay = wait if wait is not None else min(4.0, 0.4 * 2 ** (attempt - 1)) + random.random() * 0.2
            if delay > self.settings.max_retry_wait_seconds:
                break
            logger.warning("[azure-ai] %s retry %d/%d in %.1fs", op, attempt, attempts, delay)
            self._sleep(delay)
        raise last or AzureAIError("network", f"{op}: failed")

    def transcribe(self, audio: bytes, *, language: str | None = None, filename: str = "audio.m4a") -> dict[str, Any]:
        s = self.settings
        if not s.whisper_configured:
            raise AzureAIError("not_configured", "Azure Whisper is not configured")
        if len(audio) > WHISPER_MAX_BYTES:
            raise AzureAIError("http", "whisper: audio exceeds 25 MB", 413)
        boundary = f"swypik-{uuid.uuid4().hex}"
        fields = [("response_format", "verbose_json")]
        if language:
            fields.append(("language", language))
        body = bytearray()
        for name, value in fields:
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            "Content-Type: audio/mp4\r\n\r\n"
        ).encode()
        body += audio + f"\r\n--{boundary}--\r\n".encode()
        url = (
            f"{s.openai_endpoint}/openai/deployments/{urllib.request.quote(s.whisper_deployment or '')}"
            f"/audio/transcriptions?api-version={WHISPER_API_VERSION}"
        )
        started = time.monotonic()
        result = self._post(
            "whisper", url,
            {"api-key": s.openai_key or "", "Content-Type": f"multipart/form-data; boundary={boundary}"},
            bytes(body),
        )
        logger.info(
            "[azure-ai] usage op=whisper feature=captions audio_seconds=%s ms=%d",
            result.get("duration"), int((time.monotonic() - started) * 1000),
        )
        return result

    def analyze_image(self, image: bytes) -> dict[str, int]:
        s = self.settings
        if not s.safety_configured:
            raise AzureAIError("not_configured", "Azure Content Safety is not configured")
        if len(image) > SAFETY_IMAGE_MAX_BYTES:
            raise AzureAIError("http", "safety.image: image exceeds 4 MB", 413)
        payload = {
            "image": {"content": base64.b64encode(image).decode("ascii")},
            "categories": list(SAFETY_CATEGORIES),
            "outputType": "FourSeverityLevels",
        }
        url = f"{s.safety_endpoint}/contentsafety/image:analyze?api-version={s.safety_api_version}"
        result = self._post(
            "safety.image", url,
            {"Ocp-Apim-Subscription-Key": s.safety_key or "", "Content-Type": "application/json"},
            json.dumps(payload).encode("utf-8"),
        )
        logger.info("[azure-ai] usage op=safety.image feature=video-thumbnail")
        scores = {cat: 0 for cat in SAFETY_CATEGORIES}
        for item in result.get("categoriesAnalysis") or []:
            cat = item.get("category")
            if cat in scores:
                try:
                    scores[cat] = max(0, min(7, int(item.get("severity") or 0)))
                except (TypeError, ValueError):
                    pass
        return scores


def _scores(result: Mapping[str, Any]) -> dict[str, int]:
    scores = {cat: 0 for cat in SAFETY_CATEGORIES}
    for item in result.get("categoriesAnalysis") or []:
        cat = item.get("category")
        if cat in scores:
            try:
                scores[cat] = max(0, min(7, int(item.get("severity") or 0)))
            except (TypeError, ValueError):
                pass
    return scores


def analyze_text(client: "AzureAIClient", text: str, feature: str = "video-speech") -> dict[str, int]:
    """Content Safety text:analyze (transcrierea vorbirii din clip)."""
    s = client.settings
    if not s.safety_configured:
        raise AzureAIError("not_configured", "Azure Content Safety is not configured")
    payload = {
        "text": text[:SAFETY_TEXT_MAX_CHARS],
        "categories": list(SAFETY_CATEGORIES),
        "outputType": "FourSeverityLevels",
    }
    url = f"{s.safety_endpoint}/contentsafety/text:analyze?api-version={s.safety_api_version}"
    result = client._post(  # noqa: SLF001 — același retry/timeout ca imaginea
        "safety.text", url,
        {"Ocp-Apim-Subscription-Key": s.safety_key or "", "Content-Type": "application/json"},
        json.dumps(payload).encode("utf-8"),
    )
    logger.info("[azure-ai] usage op=safety.text feature=%s", feature)
    return _scores(result)


def image_verdict(scores: Mapping[str, int], review_at: int, block_at: int) -> tuple[str, list[str]]:
    """(allow|review|block, motive "sexual:4")."""
    top = max(scores.values(), default=0)
    reasons = [f"{cat.lower()}:{sev}" for cat, sev in scores.items() if sev >= review_at]
    if top >= block_at:
        return "block", reasons
    if top >= review_at:
        return "review", reasons
    return "allow", reasons
