"""Instagram's API downloads the video from a public URL, so the MP4 must be hosted somewhere.

Backends:
  s3      Any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Uses a presigned
          URL by default, so the bucket can stay private.
  static  Copy the file into a directory that your web server already serves (e.g. /var/www/reels)
          and build the URL from static_base_url.
  none    Skip. `run --dry-run` and `render` work without it; `publish` will refuse.
"""
from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from .config import Config

log = logging.getLogger(__name__)


class Storage:
    def upload(self, path: Path, content_type: str = "video/mp4") -> str:
        raise NotImplementedError


class NoStorage(Storage):
    def upload(self, path: Path, content_type: str = "video/mp4") -> str:
        raise RuntimeError(
            "No storage configured. Instagram needs a public URL for the video: set [storage] kind = \"s3\" or \"static\" in config.toml."
        )


class StaticDirStorage(Storage):
    def __init__(self, cfg: Config):
        if not cfg.storage.static_dir or not cfg.storage.static_base_url:
            raise ValueError("[storage] static_dir and static_base_url are required for kind = \"static\"")
        self.dir = cfg.resolve(cfg.storage.static_dir)
        self.base = cfg.storage.static_base_url.rstrip("/")

    def upload(self, path: Path, content_type: str = "video/mp4") -> str:
        self.dir.mkdir(parents=True, exist_ok=True)
        name = f"{path.stem}-{uuid.uuid4().hex[:8]}{path.suffix}"
        shutil.copy2(path, self.dir / name)
        url = f"{self.base}/{name}"
        log.info("Copied %s -> %s", path.name, url)
        return url


class S3Storage(Storage):
    def __init__(self, cfg: Config):
        try:
            import boto3
        except ImportError as e:
            raise RuntimeError("pip install boto3 to use [storage] kind = \"s3\"") from e
        s = cfg.storage
        if not s.bucket:
            raise ValueError("[storage] bucket (or S3_BUCKET) is required for kind = \"s3\"")
        kwargs = {}
        if s.endpoint_url:
            kwargs["endpoint_url"] = s.endpoint_url
        if s.region and s.region != "auto":
            kwargs["region_name"] = s.region
        if s.access_key and s.secret_key:
            kwargs["aws_access_key_id"] = s.access_key
            kwargs["aws_secret_access_key"] = s.secret_key
        self.client = boto3.client("s3", **kwargs)
        self.cfg = s

    def upload(self, path: Path, content_type: str = "video/mp4") -> str:
        key = f"{self.cfg.prefix}{path.stem}-{uuid.uuid4().hex[:8]}{path.suffix}"
        extra = {"ContentType": content_type}
        if self.cfg.public_base_url:
            extra["ACL"] = "public-read"
        self.client.upload_file(str(path), self.cfg.bucket, key, ExtraArgs=extra)
        if self.cfg.public_base_url:
            url = f"{self.cfg.public_base_url.rstrip('/')}/{key}"
        else:
            url = self.client.generate_presigned_url(
                "get_object", Params={"Bucket": self.cfg.bucket, "Key": key}, ExpiresIn=self.cfg.presign_seconds)
        log.info("Uploaded %s -> s3://%s/%s", path.name, self.cfg.bucket, key)
        return url


def get_storage(cfg: Config) -> Storage:
    kind = cfg.storage.kind.lower()
    if kind == "s3":
        return S3Storage(cfg)
    if kind == "static":
        return StaticDirStorage(cfg)
    return NoStorage()
