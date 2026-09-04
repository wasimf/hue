"""Generate placeholder 'food' photos so the pipeline can be tried without real images."""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

PALETTES = [
    ((214, 92, 60), (246, 200, 120), (98, 140, 70)),    # shakshuka
    ((120, 170, 80), (240, 240, 210), (200, 60, 60)),   # salad
    ((230, 180, 110), (180, 100, 50), (255, 245, 220)), # hummus
    ((90, 60, 40), (220, 170, 90), (250, 230, 200)),    # grilled
    ((250, 240, 225), (140, 190, 90), (230, 100, 80)),  # caprese
]


def make_sample_photos(dest: Path, n: int = 4, seed: int = 7) -> list[Path]:
    rng = random.Random(seed)
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for i in range(n):
        bg, main, accent = PALETTES[i % len(PALETTES)]
        w, h = (1200, 1600) if i % 2 == 0 else (1600, 1200)
        im = Image.new("RGB", (w, h), bg)
        d = ImageDraw.Draw(im)
        # table texture
        for _ in range(400):
            x, y = rng.randrange(w), rng.randrange(h)
            c = tuple(max(0, min(255, v + rng.randint(-18, 18))) for v in bg)
            d.ellipse((x, y, x + rng.randint(8, 40), y + rng.randint(8, 40)), fill=c)
        # plate
        r = int(min(w, h) * 0.38)
        cx, cy = w // 2, h // 2
        d.ellipse((cx - r - 18, cy - r - 18, cx + r + 18, cy + r + 18), fill=(35, 30, 28))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(248, 246, 240))
        # food
        for _ in range(60):
            a = rng.uniform(0, 6.283)
            rad = rng.uniform(0, r * 0.75)
            x, y = cx + rad * __import__("math").cos(a), cy + rad * __import__("math").sin(a)
            s = rng.randint(30, 90)
            col = main if rng.random() < 0.7 else accent
            col = tuple(max(0, min(255, v + rng.randint(-25, 25))) for v in col)
            d.ellipse((x - s / 2, y - s / 2, x + s / 2, y + s / 2), fill=col)
        im = im.filter(ImageFilter.GaussianBlur(0.8))
        p = dest / f"sample_{i + 1}.jpg"
        im.save(p, quality=90)
        out.append(p)
    return out
