"""Conexiuni Postgres (pool lazy psycopg_pool, fallback conexiune directă)."""
from __future__ import annotations

import contextlib
import threading
from typing import Iterator


class DatabaseUnavailableError(RuntimeError):
    pass


class PooledConnections:
    """Mixin: `_connect` / `_release` + `cursor()` (tranzacție scurtă).

    2026-08-10 (audit P1): pool de conexiuni reutilizabile în loc de o conexiune
    nouă per operație (fiecare job deschidea 4-5 conexiuni → risc de epuizare
    max_connections sub burst). Pool lazy, thread-safe (heartbeat-ul lease-ului
    rulează pe alt thread).
    """

    database_url: str | None

    def _init_pool(self) -> None:
        self._pool = None
        self._pool_lock = threading.Lock()

    @contextlib.contextmanager
    def cursor(self) -> Iterator[object]:
        """Un cursor într-o tranzacție: commit la ieșire, rollback la excepție."""
        connection = self._connect()
        # psycopg3: `with connection:` face commit ȘI închide conexiunea — cu
        # pool, fiecare operație (inclusiv heartbeat-ul lease-ului) ar deschide
        # o conexiune nouă. Pe conexiunile din pool folosim `transaction()`
        # (commit/rollback, conexiunea rămâne deschisă și se întoarce în pool).
        transaction = getattr(connection, "transaction", None)
        scope = transaction() if self._pool and callable(transaction) else connection
        try:
            with scope:
                with connection.cursor() as cursor:
                    yield cursor
        finally:
            self._release(connection)

    def _connect(self):
        try:
            import psycopg
        except ImportError as exc:
            raise DatabaseUnavailableError(
                "psycopg is not installed; install requirements.txt to enable Postgres updates"
            ) from exc
        if self._pool is None:
            with self._pool_lock:
                if self._pool is None:
                    try:
                        from psycopg_pool import ConnectionPool

                        self._pool = ConnectionPool(
                            self.database_url,
                            min_size=1,
                            max_size=4,
                            open=True,
                            timeout=10,
                        )
                    except ImportError:
                        self._pool = False  # marcaj: pool indisponibil → conexiuni directe
        if self._pool:
            return self._pool.getconn()
        return psycopg.connect(self.database_url)

    def _release(self, connection) -> None:
        """Întoarce conexiunea în pool (dacă există) sau o închide."""
        if self._pool:
            try:
                self._pool.putconn(connection)
                return
            except Exception:
                pass
        try:
            connection.close()
        except Exception:
            pass
