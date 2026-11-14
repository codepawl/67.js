"""Contact sheet of the three picked grand scenes (issue #168): one row per scene, the Crucible GPU frame beside the Cycles frame.

    uv run --no-project --with pillow --with numpy python -I bench/reference/final-sheet.py artifacts/reference-grand artifacts/look-168/final.png
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SCENES = ["mountain-valley-dawn", "temple-hall-rose", "megacity-dusk-blue-hour"]
GAMMA = 2.2


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def labelled(image, text):
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 8 * len(text) + 12, 20], fill=(0, 0, 0))
    draw.text((6, 4), text, fill=(255, 255, 255))
    return image


def main():
    work_directory, output_path = Path(sys.argv[1]), Path(sys.argv[2])
    rows = []
    for scene in SCENES:
        gpu = Image.open(work_directory / f"{scene}-gpu.png").convert("RGB")
        cycles_array = tone_map_like_crucible(np.load(work_directory / f"{scene}-cycles.npy"))
        cycles = Image.fromarray((np.clip(cycles_array, 0, 1) * 255).astype(np.uint8)).convert("RGB").resize(gpu.size)
        row = Image.new("RGB", (gpu.width * 2, gpu.height))
        row.paste(labelled(gpu, f"Crucible GPU  {scene}"), (0, 0))
        row.paste(labelled(cycles, "Cycles"), (gpu.width, 0))
        rows.append(row)
    sheet = Image.new("RGB", (rows[0].width, sum(row.height for row in rows)))
    offset = 0
    for row in rows:
        sheet.paste(row, (0, offset))
        offset += row.height
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


main()
