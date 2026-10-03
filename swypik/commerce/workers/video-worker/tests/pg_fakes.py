"""Dubluri Postgres cu rezultate scriptate (fără DB real)."""
from video_worker.config import Settings
from video_worker.db import PostgresRepository


class ScriptedCursor:
    """Fiecare execute() consumă următorul rezultat: {"rows": [...], "rowcount": n}."""

    def __init__(self, log, results):
        self.log = log
        self.results = results
        self.rows = []
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self.log.append((" ".join(sql.split()), params))
        result = self.results.pop(0) if self.results else {}
        self.rows = list(result.get("rows", []))
        self.rowcount = result.get("rowcount", len(self.rows) if "rows" in result else 1)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class ScriptedConnection:
    def __init__(self, results=None):
        self.log = []
        self.results = list(results or [])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return ScriptedCursor(self.log, self.results)


def scripted_repo(monkeypatch, results=None, *, lease_owner=None, **env):
    settings = Settings.from_env({"DATABASE_URL": "postgresql://fake", "VIDEO_WORKER_ID": "w1", **env})
    repo = PostgresRepository(settings, lease_owner=lease_owner)
    connection = ScriptedConnection(results)
    monkeypatch.setattr(repo, "_connect", lambda: connection)
    monkeypatch.setattr(repo, "_release", lambda _c: None)
    return repo, connection
