"""Puts the Cycles and Cook renders of each variant side by side in one JPEG, tone-mapped the way compare.py does.

  uv run --no-project --with numpy --with pillow python packages/blender-addon/tests/make_side_by_side.py <outputJpg> <label>=<directory> ...

Each directory holds cycles.npy and cook.npy. One row per label: Cycles on the left, Cook on the right.
"""
import importlib.util
import os
import sys

import numpy
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
REPOSITORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
LABEL_HEIGHT = 22


def load_tone_map():
    path = os.path.join(REPOSITORY_ROOT, "bench", "cycles-parity", "compare.py")
    specification = importlib.util.spec_from_file_location("compare", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module.tone_map_like_crucible


def labelled_tile(tone_map, directory, engine_name, label):
    linear = numpy.load(os.path.join(directory, f"{engine_name.lower()}.npy"))
    picture = Image.fromarray((tone_map(linear) * 255.0 + 0.5).astype(numpy.uint8))
    canvas = Image.new("RGB", (picture.width, picture.height + LABEL_HEIGHT), (20, 20, 20))
    canvas.paste(picture, (0, LABEL_HEIGHT))
    ImageDraw.Draw(canvas).text((6, 5), f"{label}: {engine_name}", fill=(235, 235, 235))
    return canvas


def main():
    if len(sys.argv) < 3 or any("=" not in argument for argument in sys.argv[2:]):
        raise ValueError("Usage: make_side_by_side.py <outputJpg> <label>=<directory> [<label>=<directory> ...]")
    tone_map = load_tone_map()
    rows = []
    for argument in sys.argv[2:]:
        label, directory = argument.split("=", 1)
        rows.append([labelled_tile(tone_map, directory, engine_name, label) for engine_name in ("Cycles", "Cook")])
    row_height = rows[0][0].height
    sheet = Image.new("RGB", (rows[0][0].width * 2, row_height * len(rows)))
    for row_index, (left, right) in enumerate(rows):
        sheet.paste(left, (0, row_index * row_height))
        sheet.paste(right, (left.width, row_index * row_height))
    os.makedirs(os.path.dirname(os.path.abspath(sys.argv[1])), exist_ok=True)
    sheet.save(sys.argv[1], quality=88)
    print(f"wrote {sys.argv[1]} {sheet.width}x{sheet.height}")


main()
