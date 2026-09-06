"""Caption + per-dish labels, written by Claude from the actual photos.

Falls back to a template when the API is disabled or unavailable, so a reel
is always produced.
"""
from __future__ import annotations

import base64
import io
import json
import logging
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from PIL import Image, ImageOps

from .config import Config

log = logging.getLogger(__name__)

SCHEMA = {
    "type": "object",
    "properties": {
        "hook": {"type": "string", "description": "Short opening line for the title card, max 6 words"},
        "dish_labels": {
            "type": "array",
            "items": {"type": "string"},
            "description": "One short label (1-4 words) per photo, in the same order as the photos",
        },
        "caption": {"type": "string", "description": "Instagram caption, 2-4 short lines, no hashtags"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "outro": {"type": "string", "description": "Closing line for the last card, max 6 words"},
    },
    "required": ["hook", "dish_labels", "caption", "hashtags", "outro"],
    "additionalProperties": False,
}

SYSTEM = """You write short, warm Instagram Reels copy for a neighborhood restaurant.
You are given today's food photos and optional notes from the owner.
Rules:
- Write in {language}. For Hebrew, natural spoken Israeli Hebrew, no translationese.
- Look at each photo and name the dish accurately (e.g. "סלט קיסר", "חומוס עם פטריות"). If unsure, use a
  tasteful generic label ("סלט הבית", "מנת היום"). Never invent ingredients that are clearly not there.
- dish_labels must have exactly one entry per photo, in photo order.
- hook: max 6 words, appetizing, no emoji. outro: max 6 words, invites people to come, no emoji.
- caption: 2-4 short lines, may include 1-3 emoji, ends with a soft call to action. No hashtags inside.
- hashtags: {max_hashtags} max, mix of the restaurant's city/cuisine and generic food tags; include the
  extra ones given. Each starts with #, no spaces.
- Tone: {style}.
- Do not include quotes, markdown, or explanations."""


@dataclass
class CaptionResult:
    hook: str
    dish_labels: list[str]
    caption: str
    hashtags: list[str]
    outro: str
    source: str = "template"

    def full_caption(self) -> str:
        tags = " ".join(self.hashtags)
        return f"{self.caption.strip()}\n.\n.\n{tags}".strip()

    def to_dict(self) -> dict:
        return {
            "hook": self.hook, "dish_labels": self.dish_labels, "caption": self.caption,
            "hashtags": self.hashtags, "outro": self.outro, "source": self.source,
        }


def _prefixed(prefix: str, name: str) -> str:
    """Hebrew: the definite article is swallowed by a one-letter preposition.

    "ב" + "המסעדה שלי" -> "במסעדה שלי", not "בהמסעדה שלי".
    """
    return prefix + (name[1:] if name.startswith("ה") else name)


def template_caption(cfg: Config, n_photos: int, day: date | None = None) -> CaptionResult:
    day = day or date.today()
    r = cfg.restaurant
    tags = ["#food", "#foodie", "#instafood", "#restaurant", "#אוכל", "#מסעדה", "#סלטים", "#טרי"]
    if r.city:
        tags.append("#" + r.city.replace(" ", ""))
    tags += [t if t.startswith("#") else "#" + t for t in cfg.ai.extra_hashtags]
    seen, uniq = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    caption = f"מה יש היום {_prefixed('ב', r.name)}? 🥗\n{r.tagline}\n{r.cta}"
    return CaptionResult(
        hook=r.tagline or "מה יש היום?",
        dish_labels=[""] * n_photos,
        caption=caption,
        hashtags=uniq[: cfg.ai.max_hashtags],
        outro="בואו לטעום",
        source="template",
    )


def _image_block(path: Path, max_side: int = 1024) -> dict:
    """Downscale for the API (cheaper, faster) and send as JPEG base64."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg",
                   "data": base64.standard_b64encode(buf.getvalue()).decode()},
    }


def generate_caption(cfg: Config, photos: list[Path], notes: str = "", day: date | None = None) -> CaptionResult:
    """Ask Claude for hook/labels/caption/hashtags. Falls back to a template on any failure."""
    fallback = template_caption(cfg, len(photos), day)
    if not cfg.ai.enabled:
        return fallback
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic SDK not installed; using template caption")
        return fallback

    r = cfg.restaurant
    lang = {"he": "Hebrew", "en": "English", "ar": "Arabic", "ru": "Russian"}.get(cfg.ai.language, cfg.ai.language)
    system = SYSTEM.format(language=lang, max_hashtags=cfg.ai.max_hashtags, style=cfg.ai.style)
    content: list[dict] = []
    for i, p in enumerate(photos, 1):
        content.append({"type": "text", "text": f"Photo {i}:"})
        content.append(_image_block(p))
    content.append({"type": "text", "text": (
        f"Restaurant: {r.name} ({r.handle or 'no handle'}), city: {r.city or 'unknown'}. Tagline: {r.tagline}\n"
        f"Date: {(day or date.today()).isoformat()}\n"
        f"Extra hashtags to include: {' '.join(cfg.ai.extra_hashtags) or 'none'}\n"
        f"Owner notes for today: {notes.strip() or 'none'}\n"
        f"There are {len(photos)} photos. Return the JSON."
    )})

    try:
        client = anthropic.Anthropic()
        # Server-side refusal fallback keeps the daily post flowing even if the safety
        # classifier declines a request (rare for food photos, but it costs nothing).
        resp = client.beta.messages.create(
            model=cfg.ai.model,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError as e:
        log.warning("Claude rate limited (%s); using template caption", e)
        return fallback
    except anthropic.APIStatusError as e:
        log.warning("Claude API error %s: %s; using template caption", e.status_code, e.message)
        return fallback
    except anthropic.APIConnectionError as e:
        log.warning("Claude connection error (%s); using template caption", e)
        return fallback
    except TypeError as e:
        # The SDK raises this at request time when no credentials could be resolved.
        log.warning("No Claude credentials (%s). Set ANTHROPIC_API_KEY or run `ant auth login`; "
                    "using template caption", e)
        return fallback
    except Exception as e:  # a caption is never worth failing the daily post over
        log.warning("Claude call failed (%s: %s); using template caption", type(e).__name__, e)
        return fallback

    if resp.stop_reason == "refusal":
        log.warning("Claude declined the request (%s); using template caption", resp.stop_details)
        return fallback

    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("Claude returned non-JSON; using template caption")
        return fallback

    labels = [str(x).strip() for x in data.get("dish_labels", [])]
    labels = (labels + [""] * len(photos))[: len(photos)]
    tags = []
    for t in data.get("hashtags", []):
        t = str(t).strip().replace(" ", "")
        if t and not t.startswith("#"):
            t = "#" + t
        if t and t not in tags:
            tags.append(t)
    for t in cfg.ai.extra_hashtags:
        t = t if t.startswith("#") else "#" + t
        if t not in tags:
            tags.append(t)
    result = CaptionResult(
        hook=str(data.get("hook") or fallback.hook).strip(),
        dish_labels=labels,
        caption=str(data.get("caption") or fallback.caption).strip(),
        hashtags=tags[: cfg.ai.max_hashtags],
        outro=str(data.get("outro") or fallback.outro).strip(),
        source=f"claude:{cfg.ai.model}",
    )
    log.info("Caption written by %s (%s)", cfg.ai.model, resp.usage)
    return result
