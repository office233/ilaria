"""Lease-ul unui job din coada Postgres: heartbeat pe thread + backoff pentru retry."""
from __future__ import annotations

import logging
import random
import threading
from typing import Callable

logger = logging.getLogger(__name__)


class LeaseHeartbeat:
    """Prelungește lease-ul la fiecare `interval` secunde cât durează blocul `with`.

    `beat()` întoarce True dacă lease-ul a fost prelungit, False dacă rândul nu
    mai e al nostru (alt worker l-a revendicat după expirare / admin l-a mutat):
    atunci setăm `lost`, logăm și oprim heartbeat-ul. Scrierile finale sunt
    oricum protejate de fencing (`locked_by`) în repository. Excepțiile (DB
    indisponibil moment) sunt logate și heartbeat-ul continuă.
    """

    def __init__(self, beat: Callable[[], bool], interval: float, *, name: str = "lease-heartbeat") -> None:
        self._beat = beat
        self.interval = max(0.001, float(interval))
        self._name = name
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lost = False
        self.beats = 0

    def __enter__(self) -> "LeaseHeartbeat":
        self._thread = threading.Thread(target=self._loop, name=self._name, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> bool:
        self.stop()
        return False

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                ok = self._beat()
            except Exception:
                logger.warning("Lease heartbeat failed (%s); will retry", self._name, exc_info=True)
                continue
            self.beats += 1
            if not ok:
                self.lost = True
                logger.warning("Lease lost (%s): job row no longer owned by this worker", self._name)
                return


def retry_backoff(
    attempt: int,
    base_seconds: float,
    max_seconds: float,
    rand: Callable[[], float] = random.random,
) -> float:
    """min(base * 2^(attempt-1), max) + jitter (0..10%)."""
    exponent = max(0, int(attempt) - 1)
    delay = min(float(base_seconds) * (2 ** min(exponent, 30)), float(max_seconds))
    return delay + delay * 0.1 * rand()
