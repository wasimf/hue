"""One daily run: photos -> caption -> reel -> (upload) -> Instagram -> archive."""
from __future__ import annotations

import json
import logging
import shutil
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from .caption import CaptionResult, generate_caption
from .config import Config
from .ffmpeg import probe
from .intake import archive_photos, collect_photos, read_notes
from .music import choose_music
from .render import Renderer

log = logging.getLogger(__name__)


@dataclass
class RunResult:
    day: date
    photos: list[Path]
    caption: CaptionResult
    video: Path
    cover: Path
    duration: float
    published: dict | None = None
    video_url: str = ""
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [f"🎬 רילס ל-{self.day.isoformat()}: {len(self.photos)} תמונות, {self.duration:.0f} שניות",
                 f"📁 {self.video}"]
        if self.published:
            lines.append(f"✅ פורסם: {self.published.get('permalink') or self.published.get('media_id')}")
        for e in self.errors:
            lines.append(f"⚠️ {e}")
        return "\n".join(lines)


def render_reel(cfg: Config, photos: list[Path], caption: CaptionResult, day: date,
                workdir: Path | None = None) -> tuple[Path, Path, float]:
    """Render the MP4 (+cover JPG). Returns (video, cover, duration_seconds)."""
    out_dir = cfg.paths.output / day.isoformat()
    workdir = workdir or out_dir / "work"
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)

    renderer = Renderer(cfg)
    segs = renderer.make_segments(photos, caption.dish_labels, caption.hook, caption.outro, workdir, day)
    total = renderer.total_duration(segs)
    music = choose_music(cfg, total, workdir, seed=day.isoformat())
    stamp = datetime.now().strftime("%H%M%S")
    video = renderer.build_video(segs, music, out_dir / f"reel-{day.isoformat()}-{stamp}.mp4")
    cover = renderer.cover_image(segs, out_dir / f"cover-{day.isoformat()}-{stamp}.jpg")
    info = probe(video)
    (out_dir / "caption.txt").write_text(caption.full_caption(), encoding="utf-8")
    (out_dir / "caption.json").write_text(json.dumps(caption.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(workdir, ignore_errors=True)
    return video, cover, info.get("duration", total)


def publish_reel(cfg: Config, video: Path, caption_text: str, cover: Path | None = None) -> tuple[dict, str]:
    from .publish import InstagramPublisher
    from .storage import get_storage

    storage = get_storage(cfg)
    video_url = storage.upload(video, "video/mp4")
    cover_url = None
    if cover and cover.is_file():
        try:
            cover_url = storage.upload(cover, "image/jpeg")
        except Exception as e:  # cover is optional
            log.warning("Cover upload failed (%s); Instagram will pick a frame", e)
    publisher = InstagramPublisher(cfg)
    result = publisher.publish_reel(video_url, caption_text, cover_url)
    return result, video_url


def record(cfg: Config, res: RunResult) -> None:
    cfg.paths.state.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "day": res.day.isoformat(),
        "photos": [p.name for p in res.photos],
        "video": str(res.video),
        "duration": res.duration,
        "caption": res.caption.to_dict(),
        "published": res.published,
        "video_url": res.video_url,
        "errors": res.errors,
    }
    with open(cfg.paths.state / "posts.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def run_daily(cfg: Config, day: date | None = None, photos: list[Path] | None = None, notes: str | None = None,
              publish: bool = True, archive: bool = True, dry_run: bool = False,
              caption: CaptionResult | None = None) -> RunResult:
    day = day or date.today()
    photos = photos if photos is not None else collect_photos(cfg, day)
    if len(photos) < cfg.video.min_photos:
        raise RuntimeError(f"Need at least {cfg.video.min_photos} photo(s) in {cfg.paths.inbox}, found {len(photos)}")
    notes = notes if notes is not None else read_notes(cfg, day)
    log.info("Photos for %s: %s", day, ", ".join(p.name for p in photos))

    t0 = time.time()
    caption = caption or generate_caption(cfg, photos, notes, day)
    log.info("Caption (%s): %s | labels=%s", caption.source, caption.hook, caption.dish_labels)
    video, cover, duration = render_reel(cfg, photos, caption, day)
    log.info("Rendered %s (%.1fs) in %.0fs", video.name, duration, time.time() - t0)

    res = RunResult(day=day, photos=photos, caption=caption, video=video, cover=cover, duration=duration)
    if publish and not dry_run:
        try:
            res.published, res.video_url = publish_reel(cfg, video, caption.full_caption(), cover)
        except Exception as e:
            log.error("Publishing failed: %s", e)
            res.errors.append(f"publish failed: {e}")
    elif publish and dry_run:
        log.info("[dry-run] would publish %s with caption:\n%s", video, caption.full_caption())

    if archive and not dry_run and (res.published or not publish):
        archive_photos(cfg, photos, day)
    record(cfg, res)
    return res
