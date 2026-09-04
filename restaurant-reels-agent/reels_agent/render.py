"""Turn a handful of food photos into a designed 9:16 reel.

Pillow draws the static design (title card, per-dish label overlays, outro card).
ffmpeg adds Ken Burns motion, crossfades, the music bed and encodes an Instagram-ready MP4.
"""
from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, features

from .config import Config
from .ffmpeg import ffmpeg_bin

try:  # iPhone HEIC support if the optional package is installed
    from pillow_heif import register_heif_opener  # type: ignore

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

log = logging.getLogger(__name__)

OVERSAMPLE = 1.5  # zoompan source is rendered larger than the output to avoid jitter
ACCENT = (242, 193, 78)  # warm gold
WHITE = (255, 255, 255)
HEBREW_RE = re.compile(r"[\u0590-\u05FF]")
# Emoji / pictographs are not in most text fonts (they render as boxes), so they are stripped
# from on-video text. They stay in the Instagram caption.
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\u2B50\u2B55\u203C\u2049\u2122\u2139"
    "\u3030\u303D\u3297\u3299\uFE0F\u200D\u20E3]+")


def clean_text(s: str) -> str:
    return re.sub(r"[ \t]{2,}", " ", EMOJI_RE.sub("", s)).strip()
HEBREW_DAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]

PHOTO_MOTIONS = ["in", "right", "out", "left", "in", "up"]
PHOTO_TRANSITIONS = ["fade", "smoothleft", "fade", "smoothup", "fade", "smoothright"]


@dataclass
class Segment:
    image: Path
    duration: float
    motion: str = "in"
    transition: str = "fade"  # transition *into* this segment
    overlay: Path | None = None


# ----------------------------------------------------------------------------- text helpers


class Text:
    """Font loading + Hebrew-aware drawing (RTL via raqm, python-bidi fallback)."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.raqm = features.check("raqm")
        self.regular = self._find_font(cfg.paths.font, bold=False)
        self.bold = self._find_font(cfg.paths.font_bold, bold=True) or self.regular
        if not self.regular:
            log.warning("No TTF font with Hebrew glyphs found; text will look wrong. Put a font in assets/fonts/")
        else:
            log.debug("Fonts: %s / %s", self.regular, self.bold)

    def _find_font(self, configured: str, bold: bool) -> str | None:
        if configured:
            p = self.cfg.resolve(configured)
            if p.is_file():
                return str(p)
            log.warning("Configured font not found: %s", p)
        local = self.cfg.resolve("assets/fonts")
        if local.is_dir():
            fonts = sorted(p for p in local.iterdir() if p.suffix.lower() in (".ttf", ".otf"))
            pref = [p for p in fonts if ("bold" in p.name.lower()) == bold]
            if pref:
                return str(pref[0])
            if fonts:
                return str(fonts[0])
        for cand in (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial Hebrew.ttf",
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        ):
            if Path(cand).is_file():
                return cand
        return None

    def font(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        path = self.bold if bold else self.regular
        if path:
            return ImageFont.truetype(path, size=size)
        return ImageFont.load_default(size=size)

    def prepare(self, s: str) -> tuple[str, dict]:
        """Return (string, extra kwargs for draw.text) so Hebrew renders right-to-left."""
        if HEBREW_RE.search(s):
            if self.raqm:
                return s, {"direction": "rtl"}
            from bidi.algorithm import get_display

            return get_display(s), {}
        return s, {}

    def width(self, draw: ImageDraw.ImageDraw, s: str, font) -> float:
        s2, kw = self.prepare(s)
        try:
            return draw.textlength(s2, font=font, **kw)
        except Exception:
            return draw.textlength(s2, font=font)

    def wrap(self, draw: ImageDraw.ImageDraw, s: str, font, max_w: float) -> list[str]:
        lines: list[str] = []
        for para in s.splitlines() or [""]:
            words, cur = para.split(), ""
            for w in words:
                trial = (cur + " " + w).strip()
                if cur and self.width(draw, trial, font) > max_w:
                    lines.append(cur)
                    cur = w
                else:
                    cur = trial
            lines.append(cur)
        return [ln for ln in lines if ln != ""] or [""]

    def draw_centered(self, draw: ImageDraw.ImageDraw, s: str, font, cx: float, y: float,
                      fill=WHITE, max_w: float | None = None, shadow: bool = True, spacing: float = 1.25) -> float:
        """Draw (wrapped) centered text; returns the y below the last line."""
        s = clean_text(s)
        lines = self.wrap(draw, s, font, max_w) if max_w else [s]
        lh = font.size * spacing
        for ln in lines:
            s2, kw = self.prepare(ln)
            w = self.width(draw, ln, font)
            x = cx - w / 2
            if shadow:
                off = max(2, font.size // 22)
                draw.text((x + off, y + off), s2, font=font, fill=(0, 0, 0, 150), **kw)
            draw.text((x, y), s2, font=font, fill=fill, **kw)
            y += lh
        return y


# ----------------------------------------------------------------------------- image helpers


def load_photo(path: Path) -> Image.Image:
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def cover(im: Image.Image, w: int, h: int, centering=(0.5, 0.45)) -> Image.Image:
    return ImageOps.fit(im, (w, h), Image.LANCZOS, centering=centering)


def blurred_backdrop(im: Image.Image, w: int, h: int, darken: float = 0.45, blur: float = 0.035) -> Image.Image:
    bg = cover(im, w // 4, h // 4).filter(ImageFilter.GaussianBlur(max(2, int(w // 4 * blur))))
    bg = bg.resize((w, h), Image.BICUBIC)
    return ImageEnhance.Brightness(bg).enhance(darken)


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


def vertical_gradient(w: int, h: int, top_alpha: int, bottom_alpha: int) -> Image.Image:
    """RGBA black layer whose alpha runs linearly from top_alpha to bottom_alpha."""
    grad = Image.linear_gradient("L").resize((w, h))  # 0 at top -> 255 at bottom
    lo, hi = top_alpha, bottom_alpha
    alpha = grad.point(lambda v: int(lo + (hi - lo) * v / 255))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer.putalpha(alpha)
    return layer


# ----------------------------------------------------------------------------- renderer


class Renderer:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.W, self.H = cfg.video.width, cfg.video.height
        self.SW, self.SH = int(self.W * OVERSAMPLE), int(self.H * OVERSAMPLE)
        self.text = Text(cfg)
        self.logo = self._load_logo()

    def _load_logo(self) -> Image.Image | None:
        if not self.cfg.restaurant.logo:
            return None
        p = self.cfg.resolve(self.cfg.restaurant.logo)
        if not p.is_file():
            log.warning("Logo not found: %s", p)
            return None
        with Image.open(p) as im:
            return im.convert("RGBA")

    # -- frames -----------------------------------------------------------------------------

    def photo_frame(self, im: Image.Image) -> Image.Image:
        """Full-bleed for portrait shots, floating card on a blurred backdrop for the rest."""
        layout = self.cfg.video.layout
        if layout == "auto":
            layout = "cover" if im.height / im.width >= 1.3 else "card"
        W, H = self.SW, self.SH
        if layout == "cover":
            return cover(im, W, H)

        frame = blurred_backdrop(im, W, H)
        fg = im.copy()
        fg.thumbnail((int(W * 0.9), int(H * 0.68)), Image.LANCZOS)
        radius = int(W * 0.035)
        mask = rounded_mask(fg.size, radius)
        x = (W - fg.width) // 2
        y = int(H * 0.44 - fg.height / 2)
        shadow = Image.new("RGBA", (fg.width + radius * 2, fg.height + radius * 2), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            (radius, radius, radius + fg.width, radius + fg.height), radius=radius, fill=(0, 0, 0, 140))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius // 2))
        frame.paste(shadow, (x - radius, y - radius + radius // 3), shadow)
        frame.paste(fg, (x, y), mask)
        return frame

    def label_overlay(self, label: str) -> Image.Image:
        """Transparent 1080x1920 layer: legibility gradients, dish label, watermark, logo."""
        W, H = self.W, self.H
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        top = vertical_gradient(W, int(H * 0.16), 110, 0)
        layer.alpha_composite(top, (0, 0))
        if label:
            g_top = int(H * 0.58)
            layer.alpha_composite(vertical_gradient(W, H - g_top, 0, 185), (0, g_top))
        draw = ImageDraw.Draw(layer)

        # watermark (top-right, inside Instagram's safe zone)
        handle = self.cfg.restaurant.handle or self.cfg.restaurant.name
        if handle:
            f = self.text.font(int(W * 0.032), bold=True)
            s2, kw = self.text.prepare(handle)
            tw = self.text.width(draw, handle, f)
            pad_x, pad_y = int(W * 0.022), int(W * 0.012)
            x1 = W - int(W * 0.06)
            y0 = int(H * 0.145)
            box = (x1 - tw - 2 * pad_x, y0, x1, y0 + f.size + 2 * pad_y)
            draw.rounded_rectangle(box, radius=(box[3] - box[1]) // 2, fill=(0, 0, 0, 110))
            draw.text((box[0] + pad_x, y0 + pad_y - f.size * 0.08), s2, font=f, fill=WHITE, **kw)

        if self.logo is not None:
            lh = int(H * 0.05)
            logo = self.logo.copy()
            logo.thumbnail((int(W * 0.3), lh), Image.LANCZOS)
            layer.alpha_composite(logo, (int(W * 0.06), int(H * 0.145)))

        if label:
            y = int(H * 0.70)
            lw = int(W * 0.12)
            draw.rounded_rectangle((W // 2 - lw // 2, y, W // 2 + lw // 2, y + 5), radius=3, fill=ACCENT)
            f = self.text.font(int(W * 0.062), bold=True)
            self.text.draw_centered(draw, label, f, W / 2, y + int(H * 0.018), max_w=W * 0.86)
        return layer

    def _card_base(self, photo: Image.Image | None, tint=(70, 32, 12, 110)) -> Image.Image:
        W, H = self.SW, self.SH
        if photo is not None:
            base = blurred_backdrop(photo, W, H, darken=0.32, blur=0.06).convert("RGBA")
        else:
            base = Image.new("RGBA", (W, H), (28, 18, 12, 255))
        base.alpha_composite(Image.new("RGBA", (W, H), tint))
        base.alpha_composite(vertical_gradient(W, H, 60, 140))
        return base

    def title_card(self, hook: str, first_photo: Image.Image | None, day: date) -> Image.Image:
        W, H = self.SW, self.SH
        r = self.cfg.restaurant
        im = self._card_base(first_photo)
        draw = ImageDraw.Draw(im)

        if self.logo is not None:
            logo = self.logo.copy()
            logo.thumbnail((int(W * 0.42), int(H * 0.11)), Image.LANCZOS)
            im.alpha_composite(logo, ((W - logo.width) // 2, int(H * 0.26)))
            draw = ImageDraw.Draw(im)

        # date chip
        chip = f"יום {HEBREW_DAYS[day.weekday()]} · {day.day}.{day.month}"
        f = self.text.font(int(W * 0.03), bold=False)
        cw = self.text.width(draw, chip, f)
        px, py = int(W * 0.03), int(W * 0.014)
        cy = int(H * 0.19)
        box = (W / 2 - cw / 2 - px, cy, W / 2 + cw / 2 + px, cy + f.size + 2 * py)
        draw.rounded_rectangle(box, radius=int((box[3] - box[1]) / 2), fill=(0, 0, 0, 120), outline=ACCENT + (200,), width=2)
        s2, kw = self.text.prepare(chip)
        draw.text((W / 2 - cw / 2, cy + py - f.size * 0.08), s2, font=f, fill=WHITE, **kw)

        y = int(H * 0.40)
        y = self.text.draw_centered(draw, r.name, self.text.font(int(W * 0.10), bold=True), W / 2, y, max_w=W * 0.86)
        lw = int(W * 0.14)
        y += int(H * 0.012)
        draw.rounded_rectangle((W // 2 - lw // 2, y, W // 2 + lw // 2, y + 6), radius=3, fill=ACCENT)
        y += int(H * 0.03)
        y = self.text.draw_centered(draw, hook, self.text.font(int(W * 0.056), bold=False), W / 2, y, max_w=W * 0.8)
        if r.handle:
            self.text.draw_centered(draw, r.handle, self.text.font(int(W * 0.034)), W / 2, y + int(H * 0.02),
                                    fill=ACCENT, shadow=False)
        return im.convert("RGB")

    def outro_card(self, outro: str, last_photo: Image.Image | None) -> Image.Image:
        W, H = self.SW, self.SH
        r = self.cfg.restaurant
        im = self._card_base(last_photo)
        draw = ImageDraw.Draw(im)
        y = int(H * 0.36)
        if self.logo is not None:
            logo = self.logo.copy()
            logo.thumbnail((int(W * 0.36), int(H * 0.10)), Image.LANCZOS)
            im.alpha_composite(logo, ((W - logo.width) // 2, y - logo.height - int(H * 0.03)))
            draw = ImageDraw.Draw(im)
        y = self.text.draw_centered(draw, outro, self.text.font(int(W * 0.082), bold=True), W / 2, y, max_w=W * 0.86)
        y += int(H * 0.02)
        y = self.text.draw_centered(draw, r.cta, self.text.font(int(W * 0.046)), W / 2, y, max_w=W * 0.78, spacing=1.35)
        y += int(H * 0.025)
        lw = int(W * 0.14)
        draw.rounded_rectangle((W // 2 - lw // 2, y, W // 2 + lw // 2, y + 6), radius=3, fill=ACCENT)
        y += int(H * 0.03)
        who = r.handle or r.name
        self.text.draw_centered(draw, who, self.text.font(int(W * 0.04), bold=True), W / 2, y, fill=ACCENT, shadow=False)
        return im.convert("RGB")

    # -- assembly ------------------------------------------------------------------------------

    def make_segments(self, photos: list[Path], labels: list[str], hook: str, outro: str,
                      workdir: Path, day: date) -> list[Segment]:
        workdir.mkdir(parents=True, exist_ok=True)
        v = self.cfg.video
        images = [load_photo(p) for p in photos]
        segs: list[Segment] = []

        title = workdir / "00_title.jpg"
        self.title_card(hook, images[0] if images else None, day).save(title, quality=93)
        segs.append(Segment(title, v.intro_seconds, motion="card", transition="fade"))

        for i, im in enumerate(images):
            frame = workdir / f"{i + 1:02d}_frame.jpg"
            self.photo_frame(im).save(frame, quality=93)
            ov = workdir / f"{i + 1:02d}_label.png"
            self.label_overlay(labels[i] if i < len(labels) else "").save(ov)
            segs.append(Segment(frame, v.seconds_per_photo,
                                motion=PHOTO_MOTIONS[i % len(PHOTO_MOTIONS)],
                                transition=PHOTO_TRANSITIONS[i % len(PHOTO_TRANSITIONS)],
                                overlay=ov))

        end = workdir / "99_outro.jpg"
        self.outro_card(outro, images[-1] if images else None).save(end, quality=93)
        segs.append(Segment(end, v.outro_seconds, motion="card", transition="fade"))

        # Instagram Reels: keep under 90s.
        total = self.total_duration(segs)
        if total > 88:
            scale = (88 - v.intro_seconds - v.outro_seconds) / (total - v.intro_seconds - v.outro_seconds)
            for s in segs[1:-1]:
                s.duration = max(2.0, s.duration * scale)
        return segs

    def total_duration(self, segs: list[Segment]) -> float:
        t = self.cfg.video.transition_seconds
        return sum(s.duration for s in segs) - t * (len(segs) - 1)

    def _motion(self, motion: str, n: int) -> tuple[str, str, str]:
        cx, cy = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
        if motion == "in":
            return f"1+0.12*on/{n}", cx, cy
        if motion == "out":
            return f"1.12-0.12*on/{n}", cx, cy
        if motion == "right":
            return "1.08", f"(iw-iw/zoom)*on/{n}", cy
        if motion == "left":
            return "1.08", f"(iw-iw/zoom)*(1-on/{n})", cy
        if motion == "up":
            return "1.08", cx, f"(ih-ih/zoom)*(1-on/{n})"
        return f"1+0.04*on/{n}", cx, cy  # "card": barely-there drift

    def build_video(self, segs: list[Segment], music: Path | None, out: Path, music_start: float = 0.0) -> Path:
        v = self.cfg.video
        fps, W, H, T = v.fps, self.W, self.H, v.transition_seconds
        cmd = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error", "-stats"]
        for s in segs:
            cmd += ["-i", str(s.image)]
        ov_index: dict[int, int] = {}
        for i, s in enumerate(segs):
            if s.overlay:
                ov_index[i] = len(segs) + len(ov_index)
                cmd += ["-i", str(s.overlay)]
        music_index = None
        if music:
            music_index = len(segs) + len(ov_index)
            cmd += ["-stream_loop", "-1", "-i", str(music)]

        parts: list[str] = []
        for i, s in enumerate(segs):
            n = max(2, round(s.duration * fps))
            z, x, y = self._motion(s.motion, n)
            chain = (f"[{i}:v]scale={self.SW}:{self.SH}:flags=lanczos,setsar=1,"
                     f"zoompan=z='{z}':x='{x}':y='{y}':d={n}:s={W}x{H}:fps={fps}")
            if i in ov_index:
                parts.append(f"{chain}[z{i}]")
                parts.append(f"[z{i}][{ov_index[i]}:v]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[s{i}]")
            else:
                parts.append(f"{chain},format=yuv420p[s{i}]")

        # xfade chain: offset_k = (length so far) - T
        prev, length = "s0", segs[0].duration
        for k in range(1, len(segs)):
            offset = length - T
            outl = "vout" if k == len(segs) - 1 else f"x{k}"
            parts.append(f"[{prev}][s{k}]xfade=transition={segs[k].transition}:duration={T:.3f}:offset={offset:.3f}[{outl}]")
            length += segs[k].duration - T
            prev = outl
        if len(segs) == 1:
            parts.append("[s0]copy[vout]")
        total = length

        maps = ["-map", "[vout]"]
        if music_index is not None:
            fade_out = max(0.5, min(2.5, total / 4))
            start = max(0.0, music_start)
            parts.append(
                f"[{music_index}:a]atrim={start:.3f}:{start + total:.3f},asetpts=PTS-STARTPTS,volume={self.cfg.music.volume},"
                f"afade=t=in:st=0:d=1.2,afade=t=out:st={max(0.0, total - fade_out):.3f}:d={fade_out:.3f}[aout]")
            maps += ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-ar", "44100"]

        out.parent.mkdir(parents=True, exist_ok=True)
        cmd += ["-filter_complex", ";".join(parts), *maps,
                "-c:v", "libx264", "-preset", v.preset, "-crf", str(v.crf), "-pix_fmt", "yuv420p",
                "-profile:v", "high", "-level", "4.1", "-r", str(fps), "-t", f"{total:.3f}",
                "-movflags", "+faststart", str(out)]
        log.info("Rendering %d segments (%.1fs) -> %s", len(segs), total, out)
        log.debug("ffmpeg: %s", " ".join(cmd))
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg failed:\n{r.stderr[-4000:]}")
        return out

    def cover_image(self, segs: list[Segment], out: Path) -> Path:
        """First photo frame at output size, used as the reel's cover/thumbnail."""
        src = segs[1].image if len(segs) > 2 else segs[0].image
        with Image.open(src) as im:
            im = im.convert("RGB").resize((self.W, self.H), Image.LANCZOS)
            if len(segs) > 2 and segs[1].overlay:
                with Image.open(segs[1].overlay) as ov:
                    im = Image.alpha_composite(im.convert("RGBA"), ov.convert("RGBA")).convert("RGB")
            im.save(out, quality=90)
        return out
