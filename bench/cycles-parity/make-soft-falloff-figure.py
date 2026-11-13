"""Builds the comparison picture of docs/cook-soft-falloff-comparison.jpg (#1060).

Three panels of one lamp scene at one exposure: Cook with the lamp as a sphere, Cook with `softFalloff: true`, and Cycles with
`use_soft_falloff` on. Each label carries the mean radiance and its ratio to the Cycles panel.

    uv run --no-project --with numpy --with pillow python bench/cycles-parity/make-soft-falloff-figure.py \
        --cook-sphere renders/poking-r0.18-cook.npy --cook-soft renders/poking-r0.18-soft-cook.npy \
        --cycles-soft renders/poking-r0.18-soft-cycles-scene.npy --output docs/cook-soft-falloff-comparison.jpg
"""
import argparse

import numpy
from PIL import Image, ImageDraw, ImageFont

LABEL_HEIGHT = 44
TARGET_MEAN_DISPLAY = 0.4


def srgb_of(linear, exposure):
    scaled = numpy.clip(linear * exposure, 0.0, 1.0)
    return numpy.where(scaled <= 0.0031308, scaled * 12.92, 1.055 * numpy.power(scaled, 1 / 2.4) - 0.055)


def mean_radiance(image):
    return float(image[..., :3].mean())


def load_image(path):
    return numpy.load(path).astype(numpy.float64)[..., :3]


def draw_label(canvas, left, title, detail):
    draw = ImageDraw.Draw(canvas)
    draw.text((left + 8, 4), title, fill=(235, 235, 235), font=ImageFont.load_default(size=15))
    draw.text((left + 8, 24), detail, fill=(170, 170, 170), font=ImageFont.load_default(size=13))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cook-sphere", required=True)
    parser.add_argument("--cook-soft", required=True)
    parser.add_argument("--cycles-soft", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    cycles = load_image(arguments.cycles_soft)
    cycles_mean = mean_radiance(cycles)
    exposure = TARGET_MEAN_DISPLAY / max(cycles_mean, 1e-6)
    panels = [
        ("Cook, sphere", load_image(arguments.cook_sphere)),
        ("Cook, soft falloff", load_image(arguments.cook_soft)),
        ("Cycles, soft falloff on", cycles),
    ]
    height, width = cycles.shape[0], cycles.shape[1]
    canvas = Image.new("RGB", (width * len(panels), height + LABEL_HEIGHT), (24, 24, 24))
    for index, (title, image) in enumerate(panels):
        picture = Image.fromarray((srgb_of(image, exposure) * 255 + 0.5).astype(numpy.uint8))
        canvas.paste(picture, (index * width, LABEL_HEIGHT))
        mean = mean_radiance(image)
        draw_label(canvas, index * width, title, f"mean radiance {mean:.4f}, {mean / cycles_mean:.3f} of Cycles")
    canvas.save(arguments.output, quality=88)


if __name__ == "__main__":
    main()
