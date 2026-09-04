"""Photo intake: local inbox folder and an optional Telegram bot.

Folder layout:
    inbox/                 photos dropped here are picked up on the next run
    inbox/2026-09-04/      photos for a specific day (Telegram saves here)
    inbox/2026-09-04/notes.txt   free text from the owner (specials, mood) -> passed to the caption writer
"""
from __future__ import annotations

import json
import logging
import shutil
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import requests

from .config import Config

log = logging.getLogger(__name__)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def _day_dirs(cfg: Config, day: date) -> list[Path]:
    return [cfg.paths.inbox, cfg.paths.inbox / day.isoformat()]


def collect_photos(cfg: Config, day: date | None = None) -> list[Path]:
    """Photos waiting in the inbox (root + today's folder), oldest first, capped at max_photos."""
    day = day or date.today()
    found: list[Path] = []
    for d in _day_dirs(cfg, day):
        if not d.is_dir():
            continue
        for p in d.iterdir():
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."):
                found.append(p)
    found.sort(key=lambda p: (p.stat().st_mtime, p.name))
    if len(found) > cfg.video.max_photos:
        log.info("Found %d photos, using the first %d", len(found), cfg.video.max_photos)
    return found[: cfg.video.max_photos]


def read_notes(cfg: Config, day: date | None = None) -> str:
    day = day or date.today()
    notes = []
    for d in _day_dirs(cfg, day):
        f = d / "notes.txt"
        if f.is_file():
            notes.append(f.read_text(encoding="utf-8").strip())
    return "\n".join(n for n in notes if n)


def archive_photos(cfg: Config, photos: list[Path], day: date | None = None) -> Path:
    """Move used photos (and notes) to archive/<day>/ so they are not posted twice."""
    day = day or date.today()
    dest = cfg.paths.archive / day.isoformat()
    dest.mkdir(parents=True, exist_ok=True)
    for p in photos:
        target = dest / p.name
        i = 1
        while target.exists():
            target = dest / f"{p.stem}_{i}{p.suffix}"
            i += 1
        shutil.move(str(p), str(target))
    for d in _day_dirs(cfg, day):
        n = d / "notes.txt"
        if n.is_file():
            shutil.move(str(n), str(dest / f"notes_{d.name}.txt"))
    return dest


# --------------------------------------------------------------------------- Telegram


@dataclass
class TelegramEvent:
    """Commands the owner sent that the daemon should act on."""
    post_now: bool = False
    approve: bool = False
    skip: bool = False
    status: bool = False
    chat_id: int | None = None
    photos_saved: list[Path] = field(default_factory=list)


class TelegramIntake:
    """Minimal Telegram Bot API client (long polling). Saves photos into inbox/<today>/.

    The owner sends photos to the bot from their phone. Sending as a *file* (document)
    keeps full quality; sending as a photo is compressed by Telegram but still fine for reels.
    Text messages are appended to notes.txt and passed to the caption writer.
    Commands: /post  (post now)   /approve   /skip   /status
    """

    def __init__(self, cfg: Config):
        if not cfg.telegram.bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN is not set")
        self.cfg = cfg
        self.api = f"https://api.telegram.org/bot{cfg.telegram.bot_token}"
        self.file_api = f"https://api.telegram.org/file/bot{cfg.telegram.bot_token}"
        self.state_file = cfg.paths.state / "telegram_offset.json"
        self.offset = self._load_offset()

    # -- state
    def _load_offset(self) -> int:
        try:
            return json.loads(self.state_file.read_text())["offset"]
        except Exception:
            return 0

    def _save_offset(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps({"offset": self.offset}))

    # -- api helpers
    def _call(self, method: str, **params):
        r = requests.post(f"{self.api}/{method}", json=params, timeout=60)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method} failed: {data}")
        return data["result"]

    def send_text(self, chat_id: int, text: str) -> None:
        try:
            self._call("sendMessage", chat_id=chat_id, text=text)
        except Exception as e:  # never crash the daemon on a notification
            log.warning("Telegram sendMessage failed: %s", e)

    def send_video(self, chat_id: int, video: Path, caption: str = "") -> None:
        try:
            with open(video, "rb") as fh:
                r = requests.post(
                    f"{self.api}/sendVideo",
                    data={"chat_id": chat_id, "caption": caption[:1000], "supports_streaming": "true"},
                    files={"video": (video.name, fh, "video/mp4")},
                    timeout=300,
                )
            if not r.json().get("ok"):
                log.warning("Telegram sendVideo failed: %s", r.text[:300])
        except Exception as e:
            log.warning("Telegram sendVideo failed: %s", e)

    def broadcast(self, text: str) -> None:
        for cid in self.cfg.telegram.allowed_chat_ids:
            self.send_text(cid, text)

    def _allowed(self, chat_id: int) -> bool:
        allowed = self.cfg.telegram.allowed_chat_ids
        return not allowed or chat_id in allowed

    def _download(self, file_id: str, dest: Path) -> Path:
        info = self._call("getFile", file_id=file_id)
        url = f"{self.file_api}/{info['file_path']}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(dest, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
        return dest

    # -- main loop step
    def poll_once(self, timeout: int = 20) -> TelegramEvent:
        """Fetch new updates (long poll). Returns commands found; photos are saved to disk."""
        ev = TelegramEvent()
        try:
            updates = self._call("getUpdates", offset=self.offset, timeout=timeout, allowed_updates=["message"])
        except requests.RequestException as e:
            log.warning("Telegram getUpdates network error: %s", e)
            time.sleep(5)
            return ev
        for upd in updates:
            self.offset = upd["update_id"] + 1
            msg = upd.get("message")
            if not msg:
                continue
            chat_id = msg["chat"]["id"]
            if not self._allowed(chat_id):
                log.warning("Ignoring message from unknown chat %s", chat_id)
                self.send_text(chat_id, f"Chat id {chat_id} is not allowed. Add it to allowed_chat_ids.")
                continue
            ev.chat_id = chat_id
            self._handle_message(msg, ev)
        self._save_offset()
        return ev

    def _handle_message(self, msg: dict, ev: TelegramEvent) -> None:
        chat_id = msg["chat"]["id"]
        today = date.today().isoformat()
        day_dir = self.cfg.paths.inbox / today
        text = (msg.get("text") or "").strip()
        caption = (msg.get("caption") or "").strip()

        if text.startswith("/"):
            cmd = text.split()[0].split("@")[0].lower()
            if cmd == "/post":
                ev.post_now = True
            elif cmd == "/approve":
                ev.approve = True
            elif cmd == "/skip":
                ev.skip = True
            elif cmd in ("/status", "/start", "/help"):
                ev.status = True
            else:
                self.send_text(chat_id, "פקודות: /post  /approve  /skip  /status")
            return

        saved: Path | None = None
        if msg.get("photo"):
            best = max(msg["photo"], key=lambda p: p.get("file_size", 0))
            saved = self._download(best["file_id"], day_dir / f"tg_{msg['message_id']}.jpg")
        elif msg.get("document") and str(msg["document"].get("mime_type", "")).startswith("image/"):
            name = msg["document"].get("file_name") or f"tg_{msg['message_id']}.jpg"
            saved = self._download(msg["document"]["file_id"], day_dir / f"tg_{msg['message_id']}_{name}")

        if saved:
            ev.photos_saved.append(saved)
            log.info("Saved photo from Telegram: %s", saved)
            n = len(collect_photos(self.cfg))
            self.send_text(chat_id, f"📸 נשמר! יש עכשיו {n} תמונות לרילס של היום.")

        note = caption if saved else text
        if note:
            day_dir.mkdir(parents=True, exist_ok=True)
            with open(day_dir / "notes.txt", "a", encoding="utf-8") as fh:
                fh.write(note + "\n")
            if not saved:
                self.send_text(chat_id, "📝 נרשם. זה ישמש את כותב הכיתוב של היום.")
