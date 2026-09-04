"""Smoke test: synthetic photos -> caption template -> rendered MP4 with audio."""
import time
from datetime import date
from pathlib import Path

import pytest

from reels_agent.caption import template_caption
from reels_agent.config import load_config
from reels_agent.demo import make_sample_photos
from reels_agent.ffmpeg import probe
from reels_agent.intake import archive_photos, collect_photos
from reels_agent.pipeline import render_reel, run_daily
from reels_agent.render import Renderer, clean_text


@pytest.fixture
def cfg(tmp_path: Path):
    (tmp_path / "config.toml").write_text(
        '[restaurant]\nname="בדיקה"\nhandle="@test"\n'
        '[video]\nfps=15\nseconds_per_photo=1.5\nintro_seconds=1.0\noutro_seconds=1.0\ntransition_seconds=0.3\ncrf=30\npreset="ultrafast"\n'
        '[ai]\nenabled=false\n', encoding="utf-8")
    return load_config(tmp_path / "config.toml")


def test_clean_text_strips_emoji():
    assert clean_text("בואו לטעום 🍴 עכשיו") == "בואו לטעום עכשיו"


def test_render_reel(cfg):
    photos = make_sample_photos(cfg.base_dir / "photos", n=3)
    cap = template_caption(cfg, len(photos))
    cap.dish_labels = ["סלט קיסר", "", "חומוס"]
    video, cover, duration = render_reel(cfg, photos, cap, date(2026, 9, 4))
    assert video.is_file() and cover.is_file()
    info = probe(video)
    assert (info["width"], info["height"]) == (1080, 1920)
    assert info["has_audio"]
    expected = 1.0 + 3 * 1.5 + 1.0 - 4 * 0.3
    assert abs(info["duration"] - expected) < 0.5
    assert (cfg.paths.output / "2026-09-04" / "caption.txt").read_text(encoding="utf-8").startswith("מה יש היום")


def test_run_daily_from_inbox_and_archive(cfg):
    make_sample_photos(cfg.paths.inbox, n=2)
    assert len(collect_photos(cfg)) == 2
    res = run_daily(cfg, publish=False, archive=True)
    assert res.video.is_file()
    assert collect_photos(cfg) == []
    assert len(list((cfg.paths.archive).rglob("*.jpg"))) == 2
    assert (cfg.paths.state / "posts.jsonl").is_file()


def test_segments_cap_under_90s(cfg):
    cfg.video.seconds_per_photo = 20
    cfg.video.max_photos = 10
    photos = make_sample_photos(cfg.base_dir / "many", n=6)
    r = Renderer(cfg)
    segs = r.make_segments(photos, [""] * 6, "hook", "bye", cfg.base_dir / "work", date.today())
    assert r.total_duration(segs) <= 88.5


def test_web_render_endpoint(cfg):
    """The browser UI can upload photos and get a rendered reel back."""
    from io import BytesIO

    from reels_agent.web import create_app

    photos = make_sample_photos(cfg.base_dir / "web-photos", n=2)
    app = create_app(cfg)
    client = app.test_client()
    assert client.get("/").status_code == 200
    assert client.get("/api/setup").get_json()["restaurant"] == "בדיקה"

    data = {"options": '{"use_ai": false, "music_choice": "none", "seconds_per_photo": 1.5}'}
    files = [(BytesIO(p.read_bytes()), p.name) for p in photos]
    data["photos"] = files
    r = client.post("/api/render", data=data, content_type="multipart/form-data")
    job = r.get_json()["job"]

    for _ in range(120):
        status = client.get(f"/api/job/{job}").get_json()
        if status["status"] in ("done", "error"):
            break
        time.sleep(0.5)
    assert status["status"] == "done", status.get("log")
    assert status["duration"] > 3
    assert client.get(status["video_url"]).status_code == 200
    assert client.get(status["cover_url"]).status_code == 200
