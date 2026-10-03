import re

from video_worker import main as main_module
from video_worker.config import Settings
from video_worker.wakeup import Wakeup


class FakePubSub:
    def __init__(self, messages=None, error=None):
        self.messages = list(messages or [])
        self.error = error
        self.subscribed = []
        self.closed = False

    def subscribe(self, channel):
        self.subscribed.append(channel)

    def get_message(self, ignore_subscribe_messages, timeout):
        if self.error:
            raise self.error
        return self.messages.pop(0) if self.messages else None

    def close(self):
        self.closed = True


class FakeRedis:
    def __init__(self, pubsub):
        self._pubsub = pubsub

    def pubsub(self):
        return self._pubsub


def test_wakeup_without_redis_just_sleeps_the_poll_interval():
    sleeps = []
    assert Wakeup(Settings.from_env({}), sleep=sleeps.append).wait(2.0) is False
    assert sleeps == [2.0]


def test_wakeup_returns_early_on_message():
    pubsub, sleeps = FakePubSub(messages=[{"type": "message", "data": b"job"}]), []
    settings = Settings.from_env({"REDIS_URL": "redis://fake"})
    wakeup = Wakeup(settings, sleep=sleeps.append, client_factory=lambda _url: FakeRedis(pubsub))

    assert wakeup.wait(2.0) is True
    assert pubsub.subscribed == ["video:jobs:wakeup"]
    assert sleeps == []


def test_wakeup_falls_back_to_polling_when_redis_is_down():
    sleeps, attempts, now = [], [], [0.0]
    settings = Settings.from_env({"REDIS_URL": "redis://fake"})

    def factory(_url):
        attempts.append(1)
        raise ConnectionError("refused")

    wakeup = Wakeup(settings, sleep=sleeps.append, clock=lambda: now[0], client_factory=factory)
    wakeup.wait(2.0)
    wakeup.wait(2.0)
    assert sleeps == [2.0, 2.0] and len(attempts) == 1  # nu reîncearcă imediat
    now[0] = 61.0
    wakeup.wait(2.0)
    assert len(attempts) == 2


def test_wakeup_drops_broken_subscription():
    pubsub, sleeps = FakePubSub(error=ConnectionError("gone")), []
    settings = Settings.from_env({"REDIS_URL": "redis://fake"})
    wakeup = Wakeup(settings, sleep=sleeps.append, clock=lambda: 0.0, client_factory=lambda _u: FakeRedis(pubsub))

    assert wakeup.wait(2.0) is False
    assert pubsub.closed is True and sleeps == [2.0]


def test_main_postgres_backend_without_database_url_exits_2(monkeypatch, caplog):
    for key in ("DATABASE_URL", "POSTGRES_URL", "VIDEO_QUEUE_BACKEND"):
        monkeypatch.delenv(key, raising=False)

    assert main_module.main([]) == 2
    assert "DATABASE_URL" in caplog.text


def test_main_stats_prints_json(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(main_module.PostgresQueue, "stats", lambda self: {"queued": 3})

    assert main_module.main(["--stats"]) == 0
    assert capsys.readouterr().out.strip() == '{"queued": 3}'


def test_worker_id_default_format():
    settings = Settings.from_env({})
    assert re.fullmatch(r".+:\d+:[0-9a-f]{6}", settings.worker_id)
    assert Settings.from_env({}).worker_id != settings.worker_id
