"""Publish a reel through the Instagram Graph API (Business / Creator accounts).

Flow: create a REELS media container from a public video URL -> wait until Instagram
has processed it -> publish. Requires IG_USER_ID and a long-lived IG_ACCESS_TOKEN with
instagram_basic + instagram_content_publish (see README).
"""
from __future__ import annotations

import logging
import time

import requests

from .config import Config

log = logging.getLogger(__name__)


class InstagramError(RuntimeError):
    pass


class InstagramPublisher:
    def __init__(self, cfg: Config):
        ig = cfg.instagram
        if not ig.user_id or not ig.access_token:
            raise InstagramError("IG_USER_ID and IG_ACCESS_TOKEN are required to publish")
        self.cfg = ig
        self.base = ig.api_base.rstrip("/")

    def _req(self, method: str, path: str, **params) -> dict:
        params["access_token"] = self.cfg.access_token
        url = f"{self.base}/{path.lstrip('/')}"
        try:
            r = requests.request(method, url, params=params if method == "GET" else None,
                                 data=None if method == "GET" else params, timeout=60)
        except requests.RequestException as e:
            raise InstagramError(f"network error calling {path}: {e}") from e
        try:
            data = r.json()
        except ValueError:
            raise InstagramError(f"non-JSON response from {path}: {r.status_code} {r.text[:200]}")
        if "error" in data:
            err = data["error"]
            raise InstagramError(
                f"{err.get('message')} (code {err.get('code')}, subcode {err.get('error_subcode')}, "
                f"user msg: {err.get('error_user_msg') or '-'})")
        return data

    def whoami(self) -> dict:
        return self._req("GET", self.cfg.user_id, fields="id,username,name")

    def create_container(self, video_url: str, caption: str, cover_url: str | None = None) -> str:
        params = {
            "media_type": "REELS",
            "video_url": video_url,
            "caption": caption[:2200],
            "share_to_feed": "true" if self.cfg.share_to_feed else "false",
        }
        if cover_url:
            params["cover_url"] = cover_url
        data = self._req("POST", f"{self.cfg.user_id}/media", **params)
        log.info("Created reel container %s", data["id"])
        return data["id"]

    def wait_until_ready(self, container_id: str) -> None:
        deadline = time.time() + self.cfg.poll_timeout_seconds
        while True:
            data = self._req("GET", container_id, fields="status_code,status")
            code = data.get("status_code")
            if code == "FINISHED":
                return
            if code in ("ERROR", "EXPIRED"):
                raise InstagramError(f"container {container_id} failed: {data.get('status')}")
            if time.time() > deadline:
                raise InstagramError(f"timed out waiting for container {container_id} (last: {data})")
            log.info("Instagram is processing the video (%s)...", code)
            time.sleep(self.cfg.poll_seconds)

    def publish(self, container_id: str) -> str:
        data = self._req("POST", f"{self.cfg.user_id}/media_publish", creation_id=container_id)
        return data["id"]

    def permalink(self, media_id: str) -> str:
        try:
            return self._req("GET", media_id, fields="permalink").get("permalink", "")
        except InstagramError:
            return ""

    def publish_reel(self, video_url: str, caption: str, cover_url: str | None = None) -> dict:
        cid = self.create_container(video_url, caption, cover_url)
        self.wait_until_ready(cid)
        media_id = self.publish(cid)
        link = self.permalink(media_id)
        log.info("Published reel %s %s", media_id, link)
        return {"media_id": media_id, "permalink": link, "container_id": cid}
