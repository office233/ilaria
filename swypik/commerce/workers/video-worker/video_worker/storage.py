from __future__ import annotations

import mimetypes
from pathlib import Path

from .config import Settings


class StorageUnavailableError(RuntimeError):
    pass


class S3Storage:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None

    @property
    def client(self):
        if self._client is None:
            try:
                import boto3
            except ImportError as exc:
                raise StorageUnavailableError(
                    "boto3 is not installed; install requirements.txt to enable S3/R2 storage"
                ) from exc
            self._client = boto3.client(
                "s3",
                endpoint_url=self.settings.s3_endpoint_url,
                region_name=self.settings.s3_region,
                aws_access_key_id=self.settings.aws_access_key_id,
                aws_secret_access_key=self.settings.aws_secret_access_key,
            )
        return self._client

    def download(self, bucket: str, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        self.client.download_file(bucket, key, str(destination))

    def upload_directory(self, directory: Path, bucket: str, prefix: str) -> dict[str, object]:
        prefix = prefix.strip("/")
        uploaded_keys: list[str] = []
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(directory).as_posix()
            key = f"{prefix}/{relative}"
            content_type = _content_type(path)
            self.client.upload_file(
                str(path),
                bucket,
                key,
                ExtraArgs={
                    "ContentType": content_type,
                    "CacheControl": _cache_control(path),
                },
            )
            uploaded_keys.append(key)

        has_audio_track = (directory / "audio.m4a").is_file()
        audio_key = f"{prefix}/audio.m4a" if has_audio_track else None
        return {
            "bucket": bucket,
            "prefix": prefix,
            "master_key": f"{prefix}/master.m3u8",
            "thumbnail_key": f"{prefix}/thumbnail.jpg",
            "preview_key": f"{prefix}/preview.mp4",
            "master_url": self.object_url(f"{prefix}/master.m3u8", bucket=bucket),
            "thumbnail_url": self.object_url(f"{prefix}/thumbnail.jpg", bucket=bucket),
            "preview_url": self.object_url(f"{prefix}/preview.mp4", bucket=bucket),
            # Pistă audio pentru speech-to-text; lipsește la clipurile fără sunet.
            "audio_key": audio_key,
            "audio_url": self.object_url(audio_key, bucket=bucket) if audio_key else None,
            "uploaded_keys": uploaded_keys,
        }

    def object_url(self, key: str, bucket: str | None = None) -> str:
        bucket = bucket or self.settings.bucket
        if self.settings.public_base_url:
            return f"{self.settings.public_base_url}/{key.lstrip('/')}"
        if self.settings.s3_endpoint_url:
            return f"{self.settings.s3_endpoint_url.rstrip('/')}/{bucket}/{key.lstrip('/')}"
        return f"s3://{bucket}/{key.lstrip('/')}"


_CONTENT_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
}


def _content_type(path: Path) -> str:
    # Explicit: `mimetypes` depinde de registry/OS (pe Windows .m4a → audio/x-m4a).
    known = _CONTENT_TYPES.get(path.suffix.lower())
    if known:
        return known
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


#: Un segment .ts e imutabil: numele lui conține indexul, iar conținutul nu se
#: schimbă niciodată după transcodare. Poate fi ținut în cache la nesfârșit.
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

#: Playlist-urile NU pot fi imutabile. Dacă master.m3u8 sau index.m3u8 e prins
#: într-un cache de un an, o re-transcodare (variantă nouă, corecție) nu mai
#: ajunge niciodată la playerele care au deja versiunea veche.
PLAYLIST_CACHE_CONTROL = "public, max-age=60"


def _cache_control(path: Path) -> str:
    if path.suffix == ".m3u8":
        return PLAYLIST_CACHE_CONTROL
    return IMMUTABLE_CACHE_CONTROL
