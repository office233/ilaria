"""Helperi de I/O pentru worker: descărcare HTTP (anti-SSRF) + heartbeat DB."""
from __future__ import annotations

import contextlib
import logging
import threading
from pathlib import Path
from typing import Any

from .models import VideoJob

logger = logging.getLogger(__name__)

# Cât de des împinge heartbeat-ul `updated_at` cât timp jobul rulează. Trebuie
# să fie confortabil sub pragul watchdog-ului (VIDEO_WATCHDOG_STALE_RUNNING_MIN,
# 30 min) ca un job legitim lung să nu fie niciodată considerat mort.
_HEARTBEAT_INTERVAL_SEC = 120


@contextlib.contextmanager
def heartbeat(repository: Any, job: VideoJob):
    """Bate `updated_at` pe job la fiecare _HEARTBEAT_INTERVAL_SEC, pe un thread
    daemon, cât durează transcodarea. Se oprește curat la ieșirea din bloc."""
    beat = getattr(repository, "heartbeat", None)
    if beat is None:
        yield
        return
    stop = threading.Event()

    def _loop() -> None:
        while not stop.wait(_HEARTBEAT_INTERVAL_SEC):
            try:
                beat(job)
            except Exception:
                logger.debug("heartbeat failed for job %s (continuing)", job.job_id)

    thread = threading.Thread(target=_loop, name=f"hb-{job.job_id}", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


def download_http(url: str, destination: Path, timeout: int = 120, max_bytes: int | None = None) -> None:
    """Stream an http(s) URL to disk. Used by the hybrid pipeline for
    external sources (URL http(s) direct către un .mp4).

    Uses the stdlib so the worker has no extra dependency. Follows redirects.
    Raises on non-2xx responses or content < 1KB (likely an error body).

    Anti-SSRF (audit 2026-08-10): refuză scheme non-http(s), IP-uri private/
    link-local (RFC-1918, 169.254.x — metadata cloud) și loopback, atât la
    rezolvarea inițială cât și implicit prin verificarea hostului.

    `max_bytes`: plafon (ex. piesa pentru mixul de sunet) — peste el descărcarea
    se oprește și fișierul parțial e șters.
    """
    import urllib.request
    import urllib.error
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError(f"Blocked non-http(s) source URL scheme: {parsed.scheme}")
    host = parsed.hostname or ""
    if not host:
        raise RuntimeError("Blocked source URL without host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise RuntimeError(f"Could not resolve source host {host}: {exc}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise RuntimeError(f"Blocked source URL resolving to non-public IP: {host} -> {ip}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "swypik-video-worker/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            if status >= 400:
                raise RuntimeError(f"HTTP {status} downloading {url}")
            written = 0
            with destination.open("wb") as fh:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    written += len(chunk)
                    if max_bytes is not None and written > max_bytes:
                        raise RuntimeError(f"Download from {url} exceeds {max_bytes} bytes")
                    fh.write(chunk)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code} downloading {url}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not download {url}: {exc.reason}") from exc
    except RuntimeError:
        destination.unlink(missing_ok=True)
        raise

    if destination.stat().st_size < 1024:
        raise RuntimeError(
            f"Downloaded source from {url} is suspiciously small "
            f"({destination.stat().st_size} bytes)"
        )
