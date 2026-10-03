"""Așteptare între revendicări goale: Redis pub/sub ca semnal de trezire, opțional.

Redis NU e sursa de adevăr: dacă lipsește REDIS_URL sau Redis e căzut, workerul
doar doarme `VIDEO_POLL_INTERVAL_SECONDS` și revendică din nou din Postgres.
Producătorii pot face `PUBLISH video:jobs:wakeup <job_id>` după INSERT ca
workerii inactivi să pornească imediat.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

from .config import Settings

logger = logging.getLogger(__name__)

#: După o eroare Redis, câte secunde nu mai încercăm să ne abonăm.
RESUBSCRIBE_AFTER_SECONDS = 60.0


def _redis_client(url: str) -> Any:
    import redis

    return redis.Redis.from_url(url, socket_connect_timeout=2)


class Wakeup:
    def __init__(
        self,
        settings: Settings,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        client_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self.settings = settings
        self._sleep = sleep
        self._clock = clock
        self._client_factory = client_factory or _redis_client
        self._pubsub = None
        self._retry_at: float | None = None

    def wait(self, timeout: float) -> bool:
        """Blochează până la `timeout` s; True dacă a venit un semnal de trezire."""
        pubsub = self._subscribe()
        if pubsub is None:
            self._sleep(timeout)
            return False
        try:
            message = pubsub.get_message(ignore_subscribe_messages=True, timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - Redis e opțional
            logger.warning("Wake-up channel failed (%s); falling back to polling", exc)
            self._drop()
            self._sleep(timeout)
            return False
        return message is not None

    def close(self) -> None:
        self._drop(retry=False)

    def _subscribe(self):
        if self._pubsub is not None:
            return self._pubsub
        if not self.settings.redis_url:
            return None
        if self._retry_at is not None and self._clock() < self._retry_at:
            return None
        try:
            pubsub = self._client_factory(self.settings.redis_url).pubsub()
            pubsub.subscribe(self.settings.wakeup_channel)
        except Exception as exc:  # noqa: BLE001
            logger.info("Wake-up channel unavailable (%s); polling every %ss", exc, self.settings.poll_interval_seconds)
            self._retry_at = self._clock() + RESUBSCRIBE_AFTER_SECONDS
            return None
        self._pubsub = pubsub
        return pubsub

    def _drop(self, retry: bool = True) -> None:
        pubsub, self._pubsub = self._pubsub, None
        if retry:
            self._retry_at = self._clock() + RESUBSCRIBE_AFTER_SECONDS
        if pubsub is not None:
            try:
                pubsub.close()
            except Exception:
                pass
