# Turns the generated originals in src/ into the icon files the config points at.
# uv run --with pillow --with numpy python assets/icon/build.py
#
# The image model cannot emit alpha, so every subject was generated on flat
# #00FF00 and is keyed here: alpha comes from how far green dominates the other
# two channels, measured against the backdrop sampled from the corners, and the
# colour is un-mixed from that backdrop so edges and shadows carry no green.
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
SRC = HERE / "src"
SIZE = 1024


def key_green(path: Path) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    corners = np.concatenate([rgb[:24, :24], rgb[:24, -24:], rgb[-24:, :24], rgb[-24:, -24:]]).reshape(-1, 3)
    bg = np.median(corners, axis=0)
    bg_dom = bg[1] - max(bg[0], bg[2])
    dom = rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])
    alpha = 1.0 - np.clip(dom / bg_dom, 0.0, 1.0)
    # JPEG noise leaves a faint veil over the backdrop and nibbles solid edges.
    alpha = np.clip((alpha - 0.06) / 0.88, 0.0, 1.0)
    a = np.maximum(alpha, 1e-3)[..., None]
    fg = (rgb - (1.0 - a) * bg) / a
    fg[..., 1] = np.minimum(fg[..., 1], np.maximum(fg[..., 0], fg[..., 2]) + 12)
    fg = np.clip(fg, 0, 255)
    out = np.dstack([fg, alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def fit(img: Image.Image, scale: float, offset=(0, 0)) -> Image.Image:
    """Crops to the opaque bounds, scales the longer side to `scale` of the
    canvas and centres it, nudged by `offset` pixels."""
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    img = img.crop(box)
    k = scale * SIZE / max(img.size)
    img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE))
    canvas.alpha_composite(img, ((SIZE - img.width) // 2 + offset[0], (SIZE - img.height) // 2 + offset[1]))
    return canvas


def main() -> None:
    # Linux: the whole Pantheon tile, shadow included. elementary draws app
    # icons inside a 128px canvas with a few pixels of air, so the tile and
    # its shadow take 88% of the square.
    fit(key_green(SRC / "pantheon.jpg"), 0.88).save(HERE / "linux.png", optimize=True)

    # macOS: two Icon Composer layers. The background is opaque and
    # full-bleed (the system masks it to the icon shape); the chevron sits low
    # and left so the brush stroke runs along its outer edge, as on lynk.formalsnake.dev.
    Image.open(SRC / "mac-background.jpg").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS) \
        .save(HERE / "mac-background.png", optimize=True)
    fg = fit(key_green(SRC / "mac-foreground.jpg"), 0.62, (-56, 64))
    fg.save(HERE / "mac-foreground.png", optimize=True)

    preview = Image.open(HERE / "mac-background.png").convert("RGBA")
    preview.alpha_composite(fg)
    mask = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=230, fill=255)
    flat = Image.new("RGBA", (SIZE, SIZE))
    flat.paste(preview, mask=mask.filter(ImageFilter.GaussianBlur(1)))
    flat.save(HERE / "candidates" / "mac-flat-preview.png")


if __name__ == "__main__":
    main()
