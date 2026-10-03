from video_worker.config import Settings
from video_worker.storage import S3Storage
from video_worker.storage import IMMUTABLE_CACHE_CONTROL, PLAYLIST_CACHE_CONTROL


class FakeS3Client:
    def __init__(self):
        self.uploads = []

    def upload_file(self, filename, bucket, key, ExtraArgs):
        self.uploads.append((filename, bucket, key, ExtraArgs))


def test_upload_directory_uses_target_bucket_for_r2_urls_and_content_types(tmp_path):
    output_dir = tmp_path / "hls"
    (output_dir / "720p").mkdir(parents=True)
    (output_dir / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
    (output_dir / "720p" / "segment_00000.ts").write_bytes(b"segment")
    (output_dir / "thumbnail.jpg").write_bytes(b"jpg")
    (output_dir / "preview.mp4").write_bytes(b"mp4")

    storage = S3Storage(
        Settings.from_env(
            {
                "S3_BUCKET": "default-bucket",
                "S3_ENDPOINT_URL": "https://account.r2.cloudflarestorage.com",
            }
        )
    )
    client = FakeS3Client()
    storage._client = client

    result = storage.upload_directory(output_dir, "processed-videos", "videos/asset_1")

    assert result["master_url"] == (
        "https://account.r2.cloudflarestorage.com/processed-videos/videos/asset_1/master.m3u8"
    )
    assert result["thumbnail_url"] == (
        "https://account.r2.cloudflarestorage.com/processed-videos/videos/asset_1/thumbnail.jpg"
    )
    assert result["preview_url"] == (
        "https://account.r2.cloudflarestorage.com/processed-videos/videos/asset_1/preview.mp4"
    )
    assert ("processed-videos", "videos/asset_1/master.m3u8") in [
        (bucket, key) for _, bucket, key, _ in client.uploads
    ]
    content_types = {key: extra["ContentType"] for _, _, key, extra in client.uploads}
    assert content_types["videos/asset_1/master.m3u8"] == "application/vnd.apple.mpegurl"
    assert content_types["videos/asset_1/720p/segment_00000.ts"] == "video/mp2t"
    assert content_types["videos/asset_1/preview.mp4"] == "video/mp4"


def test_upload_directory_caches_segments_forever_but_not_playlists(tmp_path):
    """Segmentele sunt imutabile; playlist-urile nu au voie sa fie.

    Daca master.m3u8 prinde max-age=1 an, o re-transcodare nu mai ajunge
    niciodata la playerele care au deja versiunea veche in cache.
    """
    output_dir = tmp_path / "hls"
    (output_dir / "720p").mkdir(parents=True)
    (output_dir / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
    (output_dir / "720p" / "index.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
    (output_dir / "720p" / "segment_00000.ts").write_bytes(b"segment")
    (output_dir / "thumbnail.jpg").write_bytes(b"jpg")

    storage = S3Storage(Settings.from_env({"S3_BUCKET": "b"}))
    client = FakeS3Client()
    storage._client = client

    storage.upload_directory(output_dir, "processed-videos", "videos/asset_1")
    cache = {key: extra["CacheControl"] for _, _, key, extra in client.uploads}

    assert cache["videos/asset_1/720p/segment_00000.ts"] == IMMUTABLE_CACHE_CONTROL
    assert "immutable" in cache["videos/asset_1/720p/segment_00000.ts"]
    assert cache["videos/asset_1/master.m3u8"] == PLAYLIST_CACHE_CONTROL
    assert cache["videos/asset_1/720p/index.m3u8"] == PLAYLIST_CACHE_CONTROL
    assert "immutable" not in cache["videos/asset_1/master.m3u8"]


def test_upload_directory_reports_audio_track_only_when_present(tmp_path):
    output_dir = tmp_path / "hls"
    output_dir.mkdir()
    (output_dir / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
    (output_dir / "thumbnail.jpg").write_bytes(b"jpg")

    storage = S3Storage(Settings.from_env({"S3_BUCKET": "b", "S3_PUBLIC_BASE_URL": "https://cdn.test"}))
    storage._client = FakeS3Client()
    silent = storage.upload_directory(output_dir, "out", "videos/v1")

    assert silent["audio_key"] is None
    assert silent["audio_url"] is None

    (output_dir / "audio.m4a").write_bytes(b"m4a")
    client = FakeS3Client()
    storage._client = client
    voiced = storage.upload_directory(output_dir, "out", "videos/v1")

    assert voiced["audio_key"] == "videos/v1/audio.m4a"
    assert voiced["audio_url"] == "https://cdn.test/videos/v1/audio.m4a"
    content_types = {key: extra["ContentType"] for _, _, key, extra in client.uploads}
    assert content_types["videos/v1/audio.m4a"] == "audio/mp4"
    assert content_types["videos/v1/thumbnail.jpg"] == "image/jpeg"
