"""Background music: pick a track from assets/music, or synthesize a soft pad as a fallback."""
from __future__ import annotations

import logging
import random
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

from .config import Config
from .ffmpeg import ffmpeg_bin

log = logging.getLogger(__name__)

AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}


def list_tracks(cfg: Config) -> list[Path]:
    d = cfg.paths.music
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS)


def pick_track(cfg: Config, seed: str | None = None) -> Path | None:
    """Random track, but stable for a given seed (e.g. the date) so re-runs pick the same one."""
    tracks = list_tracks(cfg)
    if not tracks:
        return None
    rng = random.Random(seed)
    return rng.choice(tracks)


def fetch_track(url: str, dest_dir: Path, timeout: int = 180) -> Path:
    """Download a music track from a link.

    A direct audio URL (mp3/m4a/wav/ogg...) is downloaded as-is. Anything else (a YouTube
    or SoundCloud page) needs `yt-dlp` installed, and it is on you to have the rights to
    use that audio in a commercial post - Instagram removes reels with unlicensed music.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = Path(unquote(urlparse(url).path)).name or "track"
    ext = Path(name).suffix.lower()

    if ext in AUDIO_EXTS:
        dest = dest_dir / re.sub(r"[^\w.\-]+", "_", name)
        with requests.get(url, stream=True, timeout=timeout) as r:
            r.raise_for_status()
            ctype = r.headers.get("content-type", "")
            if ctype and not (ctype.startswith("audio/") or ctype in ("application/octet-stream", "binary/octet-stream")):
                raise RuntimeError(f"{url} returned {ctype}, not audio")
            with open(dest, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
        log.info("Downloaded music: %s (%.1f MB)", dest.name, dest.stat().st_size / 1e6)
        return dest

    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        raise RuntimeError(
            "This link is not a direct audio file. Install yt-dlp (pip install yt-dlp) to fetch it, "
            "or paste a direct .mp3/.m4a/.wav URL, or upload the file."
        )
    out = dest_dir / "track.%(ext)s"
    r = subprocess.run(
        [ytdlp, "-x", "--audio-format", "mp3", "--no-playlist", "-q", "-o", str(out), url],
        capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {r.stderr[-400:] or r.stdout[-400:]}")
    files = sorted(dest_dir.glob("track.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no file")
    log.info("Downloaded music via yt-dlp: %s", files[0].name)
    return files[0]


def synthesize_pad(out: Path, seconds: float, seed: str | None = None) -> Path:
    """Generate a gentle, slowly breathing chord pad with ffmpeg (no external assets needed).

    It is deliberately soft so it never fights the food. Real royalty-free tracks in
    assets/music always sound better; this is the "never post a silent reel" safety net.
    """
    rng = random.Random(seed)
    # A few warm chords (Hz). Pick one per reel.
    chords = [
        (220.00, 277.18, 329.63, 440.00),   # A major
        (196.00, 246.94, 293.66, 392.00),   # G major
        (174.61, 220.00, 261.63, 349.23),   # F major
        (146.83, 174.61, 220.00, 293.66),   # D minor
    ]
    f1, f2, f3, f4 = rng.choice(chords)
    expr = (
        f"0.11*sin(2*PI*{f1}*t)*(0.65+0.35*sin(2*PI*0.21*t))"
        f"+0.09*sin(2*PI*{f2}*t)*(0.65+0.35*sin(2*PI*0.17*t+1.3))"
        f"+0.09*sin(2*PI*{f3}*t)*(0.65+0.35*sin(2*PI*0.27*t+2.1))"
        f"+0.05*sin(2*PI*{f4}*t)*(0.55+0.45*sin(2*PI*0.13*t+0.7))"
        f"+0.03*sin(2*PI*{f1 / 2}*t)"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"aevalsrc={expr}:s=44100:d={seconds:.2f}",
        "-af", "lowpass=f=1800,aecho=0.8:0.6:120:0.25",
        "-c:a", "pcm_s16le", str(out),
    ]
    subprocess.run(cmd, check=True)
    return out


def choose_music(cfg: Config, total_seconds: float, workdir: Path, seed: str | None = None) -> Path | None:
    if not cfg.music.enabled:
        return None
    track = pick_track(cfg, seed)
    if track:
        log.info("Music: %s", track.name)
        return track
    if cfg.music.fallback_generated:
        log.info("Music: no tracks in %s, synthesizing a soft pad", cfg.paths.music)
        return synthesize_pad(workdir / "pad.wav", total_seconds + 2, seed)
    log.info("Music: none")
    return None
