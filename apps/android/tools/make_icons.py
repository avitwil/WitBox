#!/usr/bin/env python3
"""Regenerates the Android launcher / splash artwork from the brand sources in <repo>/assets.

  python3 tools/make_icons.py

Outputs (app/src/main/res/drawable-nodpi):
  ic_launcher_foreground.png  432x432 adaptive-icon foreground. The whole mark (antennas and
                              side knobs included) sits inside a centred circle of 61% of the
                              canvas - launchers keep only the central 66% - and fades into
                              transparency (over the flat #101011 adaptive background) so no
                              square edge is ever visible. Also used as the Android 12+ splash
                              icon, which has the same 2/3 safe circle.
  splash_logo.webp            full logo (mark + wordmark) with feathered edges, for the
                              pre-Android-12 window background.
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
RES = Path(__file__).resolve().parents[1] / "app/src/main/res/drawable-nodpi"
BG = (0x10, 0x10, 0x11)

# Geometry of the mark inside assets/brand/witbox-mark-original.jpg (1408x768).
MARK_CX, MARK_CY = 703.5, 383.5
MARK_RADIUS = 310.0      # farthest mark pixel from the centre (frame corners / antenna tips)
FADE_END = 372.0         # source background has fully faded out here (image is 768 high)

CANVAS = 432
SAFE = 0.61              # diameter of the circle that must contain the mark


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def launcher_foreground():
    src = Image.open(ROOT / "assets/brand/witbox-mark-original.jpg").convert("RGB")
    # The source backdrop is a little lighter than #101011 around the mark, which would show
    # as a faint disc on the flat splash / icon background: move its black point onto #101011.
    px = np.asarray(src).astype(np.float32)
    sy, sx = np.mgrid[0:src.height, 0:src.width]
    sr = np.hypot(sx - MARK_CX, sy - MARK_CY)
    backdrop = np.median(px[(sr > MARK_RADIUS + 12) & (sr < FADE_END)], axis=0)
    flat = np.array(BG, dtype=np.float32)
    px = flat + (px - backdrop) * (255 - flat) / (255 - backdrop)
    src = Image.fromarray(np.clip(px, 0, 255).round().astype(np.uint8), "RGB")
    print("source backdrop near the mark:", backdrop)
    scale = (SAFE * CANVAS / 2) / MARK_RADIUS
    half = CANVAS / 2 / scale
    box = (MARK_CX - half, MARK_CY - half, MARK_CX + half, MARK_CY + half)
    # crop() pads the out-of-image area with black; the mask below hides it completely
    art = src.crop(tuple(int(round(v)) for v in box)).resize((CANVAS, CANVAS), Image.LANCZOS)
    yy, xx = np.mgrid[0:CANVAS, 0:CANVAS]
    r = np.hypot(xx - (CANVAS - 1) / 2, yy - (CANVAS - 1) / 2) / scale   # in source pixels
    alpha = 1.0 - smoothstep((r - (MARK_RADIUS + 4)) / (FADE_END - (MARK_RADIUS + 4)))
    # straight alpha: over the flat adaptive background this is art*a + #101011*(1-a)
    out = np.dstack([np.asarray(art), (alpha * 255).round().astype(np.uint8)])
    Image.fromarray(out, "RGBA").save(RES / "ic_launcher_foreground.png", optimize=True)
    # sanity: nothing of the mark outside the safe circle
    rr = np.hypot(xx - (CANVAS - 1) / 2, yy - (CANVAS - 1) / 2)
    a = out[..., 3:4].astype(np.float32) / 255
    comp = out[..., :3] * a + np.array(BG, dtype=np.float32) * (1 - a)
    diff = np.abs(comp - np.array(BG)).sum(2)
    outside = diff[rr > 0.66 * CANVAS / 2]
    corner = diff[rr > 0.86 * CANVAS / 2]
    print(f"foreground: mark radius {MARK_RADIUS * scale:.1f}px of {CANVAS / 2}px "
          f"({2 * MARK_RADIUS * scale / CANVAS:.0%}); max colour diff outside 66% circle {outside.max()}, "
          f"beyond 86% {corner.max()}")


def splash_logo():
    src = Image.open(ROOT / "assets/logo.jpg").convert("RGB")
    w, h = src.size
    feather = 56.0
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)
    alpha = smoothstep(edge / feather)
    out = np.dstack([np.asarray(src), (alpha * 255).round().astype(np.uint8)])
    for old in ("splash_logo.jpg", "splash_logo.png"):
        (RES / old).unlink(missing_ok=True)
    Image.fromarray(out, "RGBA").save(RES / "splash_logo.webp", quality=90, method=6)
    print("splash logo:", (RES / "splash_logo.webp").stat().st_size, "bytes")


if __name__ == "__main__":
    launcher_foreground()
    splash_logo()
