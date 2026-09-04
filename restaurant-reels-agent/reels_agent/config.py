"""Configuration loading: config.toml + environment variables for secrets."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _get(d: dict, *keys: str, default: Any = None) -> Any:
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


@dataclass
class RestaurantCfg:
    name: str = "המסעדה שלי"
    handle: str = ""
    tagline: str = "טרי מהמטבח, כל יום"
    cta: str = "בואו לטעום 🍴 הזמנת מקום בלינק בביו"
    logo: str = ""
    city: str = ""


@dataclass
class PathsCfg:
    inbox: Path = Path("inbox")
    archive: Path = Path("archive")
    output: Path = Path("output")
    music: Path = Path("assets/music")
    state: Path = Path("state")
    font: str = ""
    font_bold: str = ""


@dataclass
class VideoCfg:
    width: int = 1080
    height: int = 1920
    fps: int = 30
    seconds_per_photo: float = 3.5
    transition_seconds: float = 0.6
    intro_seconds: float = 2.5
    outro_seconds: float = 3.0
    layout: str = "auto"  # auto | cover | card
    max_photos: int = 10
    min_photos: int = 1
    crf: int = 20
    preset: str = "medium"


@dataclass
class MusicCfg:
    enabled: bool = True
    volume: float = 0.8
    fallback_generated: bool = True


@dataclass
class AICfg:
    enabled: bool = True
    model: str = "claude-opus-5"
    language: str = "he"
    style: str = "חם, מזמין, קצר, כמו שמסעדה שכונתית אהובה הייתה כותבת"
    extra_hashtags: list[str] = field(default_factory=list)
    max_hashtags: int = 12


@dataclass
class InstagramCfg:
    api_base: str = "https://graph.facebook.com/v21.0"
    user_id: str = ""
    access_token: str = ""
    share_to_feed: bool = True
    poll_seconds: int = 10
    poll_timeout_seconds: int = 900


@dataclass
class StorageCfg:
    kind: str = "none"  # s3 | static | none
    bucket: str = ""
    endpoint_url: str = ""
    region: str = "auto"
    prefix: str = "reels/"
    presign_seconds: int = 3600
    public_base_url: str = ""
    access_key: str = ""
    secret_key: str = ""
    static_dir: str = ""
    static_base_url: str = ""


@dataclass
class ScheduleCfg:
    post_time: str = "12:30"
    timezone: str = "Asia/Jerusalem"


@dataclass
class TelegramCfg:
    enabled: bool = False
    bot_token: str = ""
    allowed_chat_ids: list[int] = field(default_factory=list)
    require_approval: bool = True
    send_preview: bool = True


@dataclass
class Config:
    restaurant: RestaurantCfg
    paths: PathsCfg
    video: VideoCfg
    music: MusicCfg
    ai: AICfg
    instagram: InstagramCfg
    storage: StorageCfg
    schedule: ScheduleCfg
    telegram: TelegramCfg
    base_dir: Path

    def resolve(self, p: str | Path) -> Path:
        p = Path(p)
        return p if p.is_absolute() else self.base_dir / p


def _fill(cls, data: dict | None):
    data = data or {}
    kwargs = {}
    for f in cls.__dataclass_fields__.values():  # type: ignore[attr-defined]
        if f.name in data:
            val = data[f.name]
            if f.type == "Path" or isinstance(f.default, Path):
                val = Path(val)
            kwargs[f.name] = val
    return cls(**kwargs)


def load_config(path: str | os.PathLike | None = None) -> Config:
    """Load config.toml (or REELS_CONFIG env var). Secrets can come from env vars."""
    cfg_path = Path(path or os.environ.get("REELS_CONFIG", "config.toml"))
    data: dict = {}
    if cfg_path.exists():
        with open(cfg_path, "rb") as fh:
            data = tomllib.load(fh)
        base_dir = cfg_path.resolve().parent
    else:
        base_dir = Path.cwd()

    cfg = Config(
        restaurant=_fill(RestaurantCfg, data.get("restaurant")),
        paths=_fill(PathsCfg, data.get("paths")),
        video=_fill(VideoCfg, data.get("video")),
        music=_fill(MusicCfg, data.get("music")),
        ai=_fill(AICfg, data.get("ai")),
        instagram=_fill(InstagramCfg, data.get("instagram")),
        storage=_fill(StorageCfg, data.get("storage")),
        schedule=_fill(ScheduleCfg, data.get("schedule")),
        telegram=_fill(TelegramCfg, data.get("telegram")),
        base_dir=base_dir,
    )

    env = os.environ
    cfg.instagram.user_id = env.get("IG_USER_ID", cfg.instagram.user_id)
    cfg.instagram.access_token = env.get("IG_ACCESS_TOKEN", cfg.instagram.access_token)
    cfg.telegram.bot_token = env.get("TELEGRAM_BOT_TOKEN", cfg.telegram.bot_token)
    cfg.storage.access_key = env.get("S3_ACCESS_KEY", env.get("AWS_ACCESS_KEY_ID", cfg.storage.access_key))
    cfg.storage.secret_key = env.get("S3_SECRET_KEY", env.get("AWS_SECRET_ACCESS_KEY", cfg.storage.secret_key))
    cfg.storage.bucket = env.get("S3_BUCKET", cfg.storage.bucket)
    cfg.storage.endpoint_url = env.get("S3_ENDPOINT_URL", cfg.storage.endpoint_url)
    if cfg.telegram.bot_token and "telegram" in data and "enabled" not in data["telegram"]:
        cfg.telegram.enabled = True

    for attr in ("inbox", "archive", "output", "music", "state"):
        setattr(cfg.paths, attr, cfg.resolve(getattr(cfg.paths, attr)))
    return cfg
