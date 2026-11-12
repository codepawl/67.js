"""Builds the denoised comparison picture of docs/cook-denoised-comparison.jpg.

Top row: Cook raw, Cook + OIDN, Cycles + OIDN and the Cycles 4096 spp reference of one scene at one sample count.
Bottom row: the same four images cropped on one region and enlarged 2x with nearest-neighbour pixels (not smoothed).
Each label carries the relMSE and the total seconds (sampling plus denoise) of that image.

    uv run --no-project --with numpy --with pillow python bench/cycles-parity/make-denoised-comparison-figure.py \
        --rows rows.json --images <folder with the *.half.npy files> --reference <scene>-cycles-4096-seed1.npy \
        --scene many-lights-500 --samples 64 --crop-x 600 --crop-y 60 --output docs/cook-denoised-comparison.jpg
"""
import argparse
import importlib.util
import json
import os
import statistics
import sys

import numpy
from PIL import Image, ImageDraw, ImageFont

PANEL_WIDTH = 480
PANEL_HEIGHT = 270
LABEL_HEIGHT = 44
CROP_WIDTH = PANEL_WIDTH // 2
CROP_HEIGHT = PANEL_HEIGHT // 2
VARIANTS = [
    ("cook-raw", "Cook raw"),
    ("cook-oidn-cuda", "Cook + OIDN"),
    ("cycles-oidn", "Cycles + OIDN"),
]


def load_settle_function():
    """The summary script owns how Cycles' denoise seconds are derived; the picture labels must use the same numbers."""
    summary_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "summarize-denoised-comparison.py")
    specification = importlib.util.spec_from_file_location("summarize_denoised_comparison", summary_path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module.settle_cycles_denoise_seconds


def srgb_of(linear, exposure):
    scaled = numpy.clip(linear * exposure, 0.0, 1.0)
    return numpy.where(scaled <= 0.0031308, scaled * 12.92, 1.055 * numpy.power(scaled, 1 / 2.4) - 0.055)


def exposure_for(reference):
    luminance = reference[..., 0] * 0.2126 + reference[..., 1] * 0.7152 + reference[..., 2] * 0.0722
    return 0.4 / max(float(luminance.mean()), 1e-4)


def to_picture(linear, exposure):
    return Image.fromarray((srgb_of(linear.astype(numpy.float64), exposure) * 255 + 0.5).astype(numpy.uint8))


def median_total_seconds(rows, variant, scene, samples):
    totals = [row["samplingSeconds"] + row["denoiseSeconds"] for row in rows
              if row.get("variant") == variant and row.get("scene") == scene and row.get("samples") == samples and "relMse" in row]
    return statistics.median(totals)


def round_one_relative_mse(rows, variant, scene, samples):
    for row in rows:
        if row.get("variant") == variant and row.get("scene") == scene and row.get("samples") == samples and row.get("round") == 1 and "relMse" in row:
            return row["relMse"]
    raise SystemExit(f"No round 1 row for {variant} {scene} {samples} spp.")


def draw_label(canvas, left, top, title, detail):
    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.load_default(size=15)
    detail_font = ImageFont.load_default(size=13)
    draw.text((left + 8, top + 4), title, fill=(235, 235, 235), font=title_font)
    draw.text((left + 8, top + 24), detail, fill=(170, 170, 170), font=detail_font)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", required=True)
    parser.add_argument("--images", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--scene", default="many-lights-500")
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--crop-x", type=int, required=True, help="left edge of the crop in full-resolution pixels")
    parser.add_argument("--crop-y", type=int, required=True, help="top edge of the crop in full-resolution pixels")
    parser.add_argument("--output", required=True)
    parser.add_argument("--quality", type=int, default=82)
    arguments = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    with open(arguments.rows, encoding="utf-8") as handle:
        rows = load_settle_function()(json.load(handle))
    reference = numpy.load(arguments.reference)[..., :3].astype(numpy.float64)
    exposure = exposure_for(reference)

    panels = []
    for variant, title in VARIANTS:
        path = f"{arguments.images}/{variant}-{arguments.scene}-s{arguments.samples}-r1.half.npy"
        image = numpy.load(path)[..., :3]
        relative_mse = round_one_relative_mse(rows, variant, arguments.scene, arguments.samples)
        seconds = median_total_seconds(rows, variant, arguments.scene, arguments.samples)
        panels.append((title, f"relMSE {relative_mse:.4f}   {seconds:.1f} s", to_picture(image, exposure)))
    panels.append(("Cycles 4096 spp", "reference", to_picture(reference, exposure)))

    width = PANEL_WIDTH * len(panels)
    height = (PANEL_HEIGHT + LABEL_HEIGHT) * 2
    canvas = Image.new("RGB", (width, height), (24, 24, 24))
    crop_box = (arguments.crop_x, arguments.crop_y, arguments.crop_x + CROP_WIDTH, arguments.crop_y + CROP_HEIGHT)
    for column, (title, detail, picture) in enumerate(panels):
        left = column * PANEL_WIDTH
        whole = picture.resize((PANEL_WIDTH, PANEL_HEIGHT), Image.BOX)
        canvas.paste(whole, (left, LABEL_HEIGHT))
        draw_label(canvas, left, 0, title, detail)
        enlarged = picture.crop(crop_box).resize((PANEL_WIDTH, PANEL_HEIGHT), Image.NEAREST)
        canvas.paste(enlarged, (left, PANEL_HEIGHT + LABEL_HEIGHT * 2))
        draw_label(canvas, left, PANEL_HEIGHT + LABEL_HEIGHT, f"{title}, crop 2x", f"{CROP_WIDTH}x{CROP_HEIGHT} px at {arguments.crop_x},{arguments.crop_y}")
    canvas.save(arguments.output, "JPEG", quality=arguments.quality, optimize=True, subsampling=0)
    print(f"wrote {arguments.output}")


if __name__ == "__main__":
    main()
