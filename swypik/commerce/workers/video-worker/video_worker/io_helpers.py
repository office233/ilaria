"""Helperi de I/O pentru worker: descărcare HTTP (anti-SSRF) + heartbeat DB."""
from __future__ import annotations

import contextlib
import http.client
import ipaddress
import logging
import socket
import ssl
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from .errors import PermanentJobError
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


def _public_target(url: str):
    """Validate and resolve once. Every returned socket address is public."""
    if any(ord(char) <= 32 or ord(char) == 127 for char in url) or "\\" in url:
        raise PermanentJobError("invalid_source", "Blocked malformed source URL")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        host = host.encode("idna").decode("ascii")
    except (ValueError, UnicodeError) as exc:
        raise PermanentJobError("invalid_source", "Blocked malformed source URL") from exc
    if parsed.scheme not in ("http", "https") or not host or "%" in host or port == 0:
        raise PermanentJobError("invalid_source", "Blocked source URL scheme or host")
    if parsed.username is not None or parsed.password is not None:
        raise PermanentJobError("invalid_source", "Blocked source URL credentials")
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos:
        raise OSError("Source host returned no addresses")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        # is_private alone permits shared address space (100.64.0.0/10).
        if not ip.is_global or ip.is_multicast or ip.is_reserved:
            raise PermanentJobError("invalid_source", "Blocked source URL resolving to non-public IP")
    return parsed, host, port, infos


@contextlib.contextmanager
def _open_public_http(url: str, timeout: int):
    """Connect to a validated address, retaining the hostname for Host and TLS.

    Connecting the resolved sockaddr directly prevents DNS rebinding between
    validation and connect. No environment proxy or automatic redirect is used.
    """
    parsed, host, port, infos = _public_target(url)
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    last_error = None
    try:
        for family, socktype, proto, _canonname, address in infos:
            raw = socket.socket(family, socktype, proto)
            try:
                raw.settimeout(timeout)
                raw.connect(address)
                if parsed.scheme == "https":
                    context = ssl.create_default_context()
                    context.set_alpn_protocols(["http/1.1"])
                    raw = context.wrap_socket(raw, server_hostname=host)
                connection.sock = raw
                break
            except OSError as exc:
                raw.close()
                last_error = exc
        else:
            raise OSError("Could not connect to source host") from last_error
        target = parsed.path or "/"
        if parsed.query:
            target += "?" + parsed.query
        connection.request("GET", target, headers={"User-Agent": "swypik-video-worker/1.0", "Connection": "close"})
        with connection.getresponse() as response:
            yield response
    finally:
        connection.close()


def download_http(url: str, destination: Path, timeout: int = 120, max_bytes: int | None = None) -> None:
    """Download public HTTP(S) media, validating and pinning every redirect hop.

    Partial files are removed on all failures, including network timeouts and
    invalid responses. Error text deliberately omits signed source URLs.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    started_writing = False
    try:
        for hop in range(6):
            with _open_public_http(url, timeout) as response:
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or hop == 5:
                        raise PermanentJobError("invalid_source", "Source redirect missing or limit exceeded")
                    url = urljoin(url, location)
                    continue
                if not 200 <= response.status < 300:
                    raise RuntimeError(f"HTTP {response.status} downloading source media")
                written = 0
                started_writing = True
                with destination.open("wb") as fh:
                    while chunk := response.read(1024 * 256):
                        written += len(chunk)
                        if max_bytes is not None and written > max_bytes:
                            raise PermanentJobError("invalid_source", f"Source download exceeds {max_bytes} bytes")
                        fh.write(chunk)
                if written < 1024:
                    raise PermanentJobError("invalid_source", "Downloaded source is suspiciously small")
                return
    except BaseException:
        if started_writing:
            destination.unlink(missing_ok=True)
        raise
