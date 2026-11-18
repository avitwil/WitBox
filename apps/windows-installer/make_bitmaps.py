#!/usr/bin/env python3
"""Generates the installer artwork (24-bit BMP) from the brand sources in <repo>/assets.

  make_bitmaps.py <out-dir>   ->  welcome.bmp (164x314, welcome/finish side image)
                                  header.bmp  (150x57, page header image)
Both are drawn on the flat brand background #101011 with feathered edges, so no seam of the
source images' own (slightly lighter, vignetted) background is visible.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BG = (0x10, 0x10, 0x11)
SS = 4  # supersampling factor


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def edge_feather(img, feather):
    """RGBA copy of `img` whose alpha fades to 0 over `feather` px at the four edges."""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)
    alpha = (smoothstep(edge / feather) * 255).round().astype(np.uint8)
    return Image.fromarray(np.dstack([np.asarray(img.convert("RGB")), alpha]), "RGBA")


def radial_feather(img, inner, outer):
    """RGBA copy of the square `img`: opaque inside radius `inner`, transparent beyond `outer`."""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - (w - 1) / 2, yy - (h - 1) / 2)
    alpha = ((1 - smoothstep((r - inner) / (outer - inner))) * 255).round().astype(np.uint8)
    return Image.fromarray(np.dstack([np.asarray(img.convert("RGB")), alpha]), "RGBA")


def paste_fit(canvas, art, box):
    """Scales `art` to fit inside box=(x, y, w, h) of `canvas`, centred, alpha-composited."""
    x, y, w, h = box
    s = min(w / art.width, h / art.height)
    size = (max(1, round(art.width * s)), max(1, round(art.height * s)))
    art = art.resize(size, Image.LANCZOS)
    canvas.alpha_composite(art, (x + (w - size[0]) // 2, y + (h - size[1]) // 2))


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    logo = Image.open(ROOT / "assets/logo.jpg").convert("RGB")                       # 720x708
    mark_src = Image.open(ROOT / "assets/brand/witbox-mark-original.jpg").convert("RGB")
    # the mark: centre (703.5, 383.5), farthest pixel 310 px from it
    mark = radial_feather(mark_src.crop((332, 12, 1076, 756)), 314, 370)
    # the "WitBox" wordmark as it appears in the full logo
    word = edge_feather(logo.crop((100, 498, 630, 632)), 14)

    # welcome / finish side image: the full logo, upper third
    w, h = 164, 314
    c = Image.new("RGBA", (w * SS, h * SS), BG + (255,))
    paste_fit(c, edge_feather(logo, 60), (0, 52 * SS, w * SS, 164 * SS))
    c.resize((w, h), Image.LANCZOS).convert("RGB").save(out / "welcome.bmp")

    # header image: mark + wordmark
    w, h = 150, 57
    c = Image.new("RGBA", (w * SS, h * SS), BG + (255,))
    paste_fit(c, mark, (0, 0, 58 * SS, h * SS))
    paste_fit(c, word, (54 * SS, 12 * SS, 90 * SS, 34 * SS))
    c.resize((w, h), Image.LANCZOS).convert("RGB").save(out / "header.bmp")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent / "build")
