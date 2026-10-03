from video_worker.config import Settings
from video_worker.redis_queue import RedisQueue


class FakeStreamClient:
    def __init__(self):
        self.created_groups = []
        self.reads = []
        self.acks = []

    def xgroup_create(self, name, groupname, id, mkstream):
        self.created_groups.append((name, groupname, id, mkstream))

    def xreadgroup(self, groupname, consumername, streams, count, block):
        self.reads.append((groupname, consumername, streams, count, block))
        return [
            (
                b"video:stream",
                [
                    (
                        b"1715350000000-0",
                        {
                            b"job_id": b"job_1",
                            b"asset_id": b"asset_1",
                            b"source_key": b"uploads/raw/input.mp4",
                            b"source_bucket": b"raw-videos",
                            b"output_bucket": b"processed-videos",
                        },
                    )
                ],
            )
        ]

    def xack(self, stream, group, message_id):
        self.acks.append((stream, group, message_id))


def test_redis_queue_reads_stream_jobs_and_acks_by_message_id():
    settings = Settings.from_env(
        {
            "REDIS_URL": "redis://localhost:6379/0",
            "VIDEO_QUEUE_BACKEND": "stream",
            "VIDEO_QUEUE_NAME": "video:stream",
            "VIDEO_CONSUMER_GROUP": "video-workers",
            "VIDEO_CONSUMER_NAME": "worker-a",
            "VIDEO_POLL_TIMEOUT_SECONDS": "7",
        }
    )
    client = FakeStreamClient()
    queue = RedisQueue(settings)
    queue._client = client

    queued = queue.pop_message()

    assert client.created_groups == [("video:stream", "video-workers", "0", True)]
    assert client.reads == [
        ("video-workers", "worker-a", {"video:stream": ">"}, 1, 7000)
    ]
    assert queued.message_id == "1715350000000-0"
    assert queued.job.job_id == "job_1"
    assert queued.job.source_bucket == "raw-videos"
    assert queued.job.output_bucket == "processed-videos"

    queue.ack(queued)

    assert client.acks == [("video:stream", "video-workers", "1715350000000-0")]


def test_redis_queue_accepts_go_publisher_data_field():
    settings = Settings.from_env(
        {
            "REDIS_URL": "redis://localhost:6379/0",
            "VIDEO_QUEUE_BACKEND": "stream",
            "VIDEO_QUEUE_NAME": "video:stream",
        }
    )
    client = FakeStreamClient()
    client.xreadgroup = lambda *_args, **_kwargs: [
        (
            b"video:stream",
            [
                (
                    b"1715350000001-0",
                    {
                        b"data": (
                            b'{"job_id":"job_2","asset_id":"asset_2",'
                            b'"object_key":"uploads/raw/input.mp4","bucket":"raw-videos"}'
                        )
                    },
                )
            ],
        )
    ]
    queue = RedisQueue(settings)
    queue._client = client

    queued = queue.pop_message()

    assert queued.job.job_id == "job_2"
    assert queued.job.asset_id == "asset_2"
    assert queued.job.source_key == "uploads/raw/input.mp4"
    assert queued.job.bucket == "raw-videos"
