# Blind comparison sheets for issue #197: the Cycles image on top, two Crucible images below it in random order, labelled only 1 and 2.
#   uv run --no-project --python 3.12 --with numpy --with pillow python -I bench/reference/depth-sheets.py <cycles directory> <before directory> <after directory> <output directory> <scene id>,<scene id>
# <cycles directory> holds <id>-cycles.npy, the other two hold <id>-gpu.png. The file key.txt in the output directory says which image is which.
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2
WIDTH = 960
HEIGHT = 540
LABEL_HEIGHT = 30


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def labelled(image, label):
    canvas = Image.new("RGB", (image.width, image.height + LABEL_HEIGHT), (24, 24, 24))
    canvas.paste(image, (0, LABEL_HEIGHT))
    ImageDraw.Draw(canvas).text((10, 9), label, fill=(235, 235, 235))
    return canvas


def main():
    cycles_directory, before_directory, after_directory, output_directory = (Path(argument) for argument in sys.argv[1:5])
    scene_ids = sys.argv[5].split(",")
    output_directory.mkdir(parents=True, exist_ok=True)
    generator = random.Random()
    key_lines = []
    for scene_id in scene_ids:
        cycles = Image.fromarray((tone_map_like_crucible(np.load(cycles_directory / f"{scene_id}-cycles.npy")) * 255).astype(np.uint8)).resize((WIDTH, HEIGHT), Image.LANCZOS)
        before = Image.open(before_directory / f"{scene_id}-gpu.png").convert("RGB")
        after = Image.open(after_directory / f"{scene_id}-gpu.png").convert("RGB")
        pair = [("before", before), ("after", after)]
        generator.shuffle(pair)
        sheet = Image.new("RGB", (WIDTH * 2, (HEIGHT + LABEL_HEIGHT) * 2), (24, 24, 24))
        sheet.paste(labelled(cycles, "Cycles"), (WIDTH // 2, 0))
        sheet.paste(labelled(pair[0][1], "1"), (0, HEIGHT + LABEL_HEIGHT))
        sheet.paste(labelled(pair[1][1], "2"), (WIDTH, HEIGHT + LABEL_HEIGHT))
        sheet.save(output_directory / f"{scene_id}.png")
        key_lines.append(f"{scene_id}: 1 = {pair[0][0]}, 2 = {pair[1][0]}")
    (output_directory / "key.txt").write_text("\n".join(key_lines) + "\n")


main()
