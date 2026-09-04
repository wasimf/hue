"""Command line: run | render | caption | publish | demo | daemon | check"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import __version__
from .caption import CaptionResult, generate_caption
from .config import Config, load_config
from .intake import TelegramEvent, TelegramIntake, archive_photos, collect_photos, read_notes
from .pipeline import RunResult, publish_reel, record, run_daily

log = logging.getLogger("reels")


def _photos_arg(cfg: Config, args, day: date) -> list[Path] | None:
    if getattr(args, "photos", None):
        return [Path(p) for p in args.photos]
    return None


def cmd_run(cfg: Config, args) -> int:
    day = date.fromisoformat(args.date) if args.date else date.today()
    res = run_daily(cfg, day=day, photos=_photos_arg(cfg, args, day), publish=not args.no_publish,
                    archive=not args.no_archive, dry_run=args.dry_run)
    print(res.summary())
    print("\n--- caption ---\n" + res.caption.full_caption())
    return 1 if res.errors else 0


def cmd_caption(cfg: Config, args) -> int:
    day = date.today()
    photos = _photos_arg(cfg, args, day) or collect_photos(cfg, day)
    if not photos:
        print("No photos found", file=sys.stderr)
        return 1
    cap = generate_caption(cfg, photos, args.notes or read_notes(cfg, day), day)
    print(json.dumps(cap.to_dict(), ensure_ascii=False, indent=2))
    print("\n" + cap.full_caption())
    return 0


def cmd_publish(cfg: Config, args) -> int:
    video = Path(args.video)
    caption = Path(args.caption).read_text(encoding="utf-8") if args.caption else ""
    cover = Path(args.cover) if args.cover else None
    result, url = publish_reel(cfg, video, caption, cover)
    print(json.dumps({**result, "video_url": url}, ensure_ascii=False, indent=2))
    return 0


def cmd_demo(cfg: Config, args) -> int:
    from .demo import make_sample_photos

    photos = make_sample_photos(cfg.paths.output / "demo-photos", n=args.count)
    cap = CaptionResult(
        hook="מה טרי היום במטבח?",
        dish_labels=["שקשוקה של הבית", "סלט ירוק עם עשבי תיבול", "חומוס עם פטריות", "ירקות על הגריל", "קפרזה"][: len(photos)],
        caption="יום חדש, צלחות חדשות 🥗\nהכל נחתך הבוקר, הכל מוגש עכשיו.\nמחכים לכם.",
        hashtags=["#אוכל", "#מסעדה", "#סלטים", "#foodie", "#instafood"],
        outro="בואו לטעום",
        source="demo",
    )
    if args.ai:
        cap = generate_caption(cfg, photos, "demo run", date.today())
    res = run_daily(cfg, photos=photos, notes="", publish=False, archive=False, caption=cap)
    print(res.summary())
    return 0


def cmd_check(cfg: Config, args) -> int:
    from .ffmpeg import ffmpeg_bin
    from .music import list_tracks
    from .render import Text

    ok = True

    def line(good: bool | None, msg: str):
        nonlocal ok
        icon = "✅" if good else ("⚠️ " if good is None else "❌")
        if good is False:
            ok = False
        print(f"{icon} {msg}")

    try:
        line(True, f"ffmpeg: {ffmpeg_bin()}")
    except Exception as e:
        line(False, f"ffmpeg: {e}")
    t = Text(cfg)
    line(bool(t.regular), f"font: {t.regular or 'none (put a Hebrew TTF in assets/fonts/)'}  raqm={t.raqm}")
    line(cfg.paths.inbox.is_dir() or None, f"inbox: {cfg.paths.inbox} ({len(collect_photos(cfg))} photos waiting)")
    tracks = list_tracks(cfg)
    line(bool(tracks) or None, f"music: {len(tracks)} track(s) in {cfg.paths.music}" + ("" if tracks else " - will synthesize a pad"))
    import os
    line(bool(os.environ.get("ANTHROPIC_API_KEY")) or None,
         "Claude: ANTHROPIC_API_KEY " + ("set" if os.environ.get("ANTHROPIC_API_KEY") else "missing - template captions only"))
    if cfg.instagram.user_id and cfg.instagram.access_token:
        try:
            from .publish import InstagramPublisher
            me = InstagramPublisher(cfg).whoami()
            line(True, f"Instagram: @{me.get('username')} ({me.get('id')})")
        except Exception as e:
            line(False, f"Instagram: {e}")
    else:
        line(None, "Instagram: IG_USER_ID / IG_ACCESS_TOKEN not set - publishing disabled")
    try:
        from .storage import NoStorage, get_storage
        st = get_storage(cfg)
        line(not isinstance(st, NoStorage) or None, f"storage: {cfg.storage.kind}")
    except Exception as e:
        line(False, f"storage: {e}")
    if cfg.telegram.bot_token:
        try:
            tg = TelegramIntake(cfg)
            me = tg._call("getMe")
            line(True, f"Telegram: @{me.get('username')}  allowed chats: {cfg.telegram.allowed_chat_ids or 'ALL (set allowed_chat_ids!)'}")
        except Exception as e:
            line(False, f"Telegram: {e}")
    else:
        line(None, "Telegram: not configured (folder intake only)")
    return 0 if ok else 1


# ----------------------------------------------------------------------------- daemon


def _parse_time(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def cmd_daemon(cfg: Config, args) -> int:
    """Poll Telegram (if configured) and post once a day at schedule.post_time."""
    tz = ZoneInfo(cfg.schedule.timezone)
    post_h, post_m = _parse_time(cfg.schedule.post_time)
    tg = TelegramIntake(cfg) if (cfg.telegram.enabled and cfg.telegram.bot_token) else None
    state_file = cfg.paths.state / "daemon.json"
    cfg.paths.state.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(state_file.read_text())
    except Exception:
        state = {}
    last_run_day: str | None = state.get("last_run_day")
    pending: RunResult | None = None
    require_approval = bool(tg) and cfg.telegram.require_approval

    log.info("Daemon started. Posting daily at %s %s. Telegram: %s. Approval: %s",
             cfg.schedule.post_time, cfg.schedule.timezone, "on" if tg else "off", "required" if require_approval else "auto")
    if tg:
        tg.broadcast(f"🤖 הסוכן פעיל. שלחו תמונות, ואני אפרסם כל יום ב-{cfg.schedule.post_time}. "
                     f"פקודות: /post /approve /skip /status")

    def save_state():
        state_file.write_text(json.dumps({"last_run_day": last_run_day}))

    def reply(text: str, chat_id: int | None = None):
        if not tg:
            return
        if chat_id:
            tg.send_text(chat_id, text)
        else:
            tg.broadcast(text)

    while True:
        try:
            ev = tg.poll_once(timeout=20) if tg else TelegramEvent()
            if not tg:
                time.sleep(30)
            now = datetime.now(tz)
            today = now.date()
            photos = collect_photos(cfg, today)

            if ev.status:
                msg = f"📸 {len(photos)} תמונות ממתינות. פרסום יומי ב-{cfg.schedule.post_time}."
                if pending:
                    msg += "\n⏳ יש רילס שממתין לאישור: /approve או /skip"
                reply(msg, ev.chat_id)

            if pending and ev.skip:
                reply("👌 דילגתי. התמונות נשארות בתיבה לפעם הבאה.", ev.chat_id)
                pending = None
            elif pending and ev.approve:
                reply("🚀 מפרסם...", ev.chat_id)
                try:
                    pending.published, pending.video_url = publish_reel(cfg, pending.video, pending.caption.full_caption(), pending.cover)
                    archive_photos(cfg, pending.photos, pending.day)
                    reply(pending.summary(), ev.chat_id)
                except Exception as e:
                    log.exception("Publish failed")
                    pending.errors.append(str(e))
                    reply(f"❌ הפרסום נכשל: {e}", ev.chat_id)
                record(cfg, pending)
                pending = None

            due = (now.hour, now.minute) >= (post_h, post_m) and last_run_day != today.isoformat()
            if (ev.post_now or due) and pending is None:
                if len(photos) < cfg.video.min_photos:
                    if ev.post_now:
                        reply("אין תמונות בתיבה. שלחו תמונות ואז /post", ev.chat_id)
                    # when due but empty: keep waiting, post as soon as photos arrive today
                    continue
                reply(f"🎬 מכין רילס מ-{len(photos)} תמונות...", ev.chat_id)
                try:
                    res = run_daily(cfg, day=today, photos=photos, publish=not require_approval, archive=not require_approval)
                except Exception as e:
                    log.exception("Run failed")
                    reply(f"❌ נכשל: {e}", ev.chat_id)
                    last_run_day = today.isoformat() if due else last_run_day
                    save_state()
                    continue
                if tg and cfg.telegram.send_preview:
                    for cid in cfg.telegram.allowed_chat_ids or ([ev.chat_id] if ev.chat_id else []):
                        tg.send_video(cid, res.video, res.caption.full_caption())
                if require_approval:
                    pending = res
                    reply("👆 זה הרילס של היום. לפרסם? /approve   לדלג? /skip", ev.chat_id)
                else:
                    reply(res.summary(), ev.chat_id)
                last_run_day = today.isoformat()
                save_state()
        except KeyboardInterrupt:
            log.info("Daemon stopped")
            return 0
        except Exception:
            log.exception("Daemon loop error; continuing")
            time.sleep(10)


# ----------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="reels-agent", description="Daily restaurant reels agent")
    p.add_argument("--config", "-c", help="path to config.toml (default: ./config.toml or $REELS_CONFIG)")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("run", help="caption + render + publish today's photos")
    s.add_argument("--photos", nargs="*", help="explicit photo paths instead of the inbox")
    s.add_argument("--date", help="YYYY-MM-DD (default today)")
    s.add_argument("--dry-run", action="store_true", help="render but do not upload/publish/archive")
    s.add_argument("--no-publish", action="store_true", help="render only (photos are archived)")
    s.add_argument("--no-archive", action="store_true")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("render", help="alias for run --no-publish --no-archive")
    s.add_argument("--photos", nargs="*")
    s.add_argument("--date")
    s.set_defaults(fn=cmd_run, no_publish=True, no_archive=True, dry_run=False)

    s = sub.add_parser("caption", help="only write the caption for the inbox photos")
    s.add_argument("--photos", nargs="*")
    s.add_argument("--notes", default="")
    s.set_defaults(fn=cmd_caption)

    s = sub.add_parser("publish", help="publish an existing MP4 to Instagram")
    s.add_argument("--video", required=True)
    s.add_argument("--caption", help="text file with the caption")
    s.add_argument("--cover", help="optional cover JPG")
    s.set_defaults(fn=cmd_publish)

    s = sub.add_parser("demo", help="render a sample reel with generated placeholder photos")
    s.add_argument("--count", type=int, default=4)
    s.add_argument("--ai", action="store_true", help="also call Claude for the caption")
    s.set_defaults(fn=cmd_demo)

    s = sub.add_parser("daemon", help="Telegram intake + daily scheduled posting")
    s.set_defaults(fn=cmd_daemon)

    s = sub.add_parser("check", help="verify ffmpeg, fonts, Instagram, storage and Telegram setup")
    s.set_defaults(fn=cmd_check)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("botocore").setLevel(logging.WARNING)
    cfg = load_config(args.config)
    return args.fn(cfg, args)


if __name__ == "__main__":
    sys.exit(main())
