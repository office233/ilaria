"""cursor(): conexiunile din pool folosesc transaction() (rămân deschise pentru reutilizare)."""
from video_worker.config import Settings
from video_worker.db import PostgresRepository


class _Scope:
    def __init__(self, log, name):
        self.log, self.name = log, name

    def __enter__(self):
        self.log.append(f"{self.name}:enter")
        return self

    def __exit__(self, *exc):
        self.log.append(f"{self.name}:exit")
        return False


class _Cursor(_Scope):
    def execute(self, sql, params):
        self.log.append("execute")


class _Connection:
    def __init__(self):
        self.log = []

    def __enter__(self):  # psycopg3: ieșirea din `with connection` ÎNCHIDE conexiunea
        self.log.append("connection:enter")
        return self

    def __exit__(self, *exc):
        self.log.append("connection:exit(close)")
        return False

    def transaction(self):
        return _Scope(self.log, "transaction")

    def cursor(self):
        return _Cursor(self.log, "cursor")


def _repo(monkeypatch, pooled):
    repo = PostgresRepository(Settings.from_env({"DATABASE_URL": "postgresql://fake"}))
    connection = _Connection()
    released = []
    repo._pool = object() if pooled else False
    monkeypatch.setattr(repo, "_connect", lambda: connection)
    monkeypatch.setattr(repo, "_release", released.append)
    return repo, connection, released


def test_pooled_connection_uses_transaction_and_is_returned_open(monkeypatch):
    repo, connection, released = _repo(monkeypatch, pooled=True)
    with repo.cursor() as cursor:
        cursor.execute("SELECT 1", ())
    assert "transaction:enter" in connection.log and "transaction:exit" in connection.log
    assert "connection:exit(close)" not in connection.log
    assert released == [connection]


def test_direct_connection_keeps_connection_context(monkeypatch):
    repo, connection, released = _repo(monkeypatch, pooled=False)
    with repo.cursor() as cursor:
        cursor.execute("SELECT 1", ())
    assert connection.log[0] == "connection:enter"
    assert "transaction:enter" not in connection.log
    assert released == [connection]
