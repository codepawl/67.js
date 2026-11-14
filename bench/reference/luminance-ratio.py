# Mean and 20th percentile of linear luminance of the Crucible panel divided by the Cycles panel, read from reference sheets.
#   uv run --no-project --python 3.12 --with pillow --with numpy python -I bench/reference/luminance-ratio.py <sheet.jpg> [<sheet.jpg> ...]
#   uv run --no-project --python 3.12 --with pillow --with numpy python -I bench/reference/luminance-ratio.py --renders <directory> <scene id> [...]
# The second form takes the Cycles panel from images/<scene id>.jpg and the Crucible picture from <directory>/<scene id>-gpu.png
# (what render-gpu.mjs writes), scaled to the panel's size.
# A sheet is two columns by two rows of panels under 22 px headers: Cycles top left, the Crucible panel bottom left.
import os
import sys

import numpy as np
from PIL import Image

HEADER_HEIGHT = 22
LUMINANCE_WEIGHTS = np.array([0.2126, 0.7152, 0.0722])


def linear_luminance(pixels):
    normalized = pixels.astype(np.float64) / 255.0
    linear = np.where(normalized <= 0.04045, normalized / 12.92, ((normalized + 0.055) / 1.055) ** 2.4)
    return linear @ LUMINANCE_WEIGHTS


def panels(path):
    sheet = np.asarray(Image.open(path).convert("RGB"))
    height, width = sheet.shape[:2]
    column_width = width // 2
    row_height = height // 2
    cycles = sheet[HEADER_HEIGHT:row_height, :column_width]
    gpu = sheet[row_height + HEADER_HEIGHT:, :column_width]
    return cycles, gpu


def ratios(cycles, gpu):
    cycles_luminance = linear_luminance(cycles)
    gpu_luminance = linear_luminance(gpu)
    return (
        gpu_luminance.mean() / cycles_luminance.mean(),
        np.percentile(gpu_luminance, 20) / np.percentile(cycles_luminance, 20),
    )


def rendered_pair(directory, scene_id):
    cycles, _ = panels(os.path.join(os.path.dirname(os.path.abspath(__file__)), "images", f"{scene_id}.jpg"))
    picture = Image.open(os.path.join(directory, f"{scene_id}-gpu.png")).convert("RGB")
    gpu = np.asarray(picture.resize((cycles.shape[1], cycles.shape[0]), Image.LANCZOS))
    return cycles, gpu


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if arguments and arguments[0] == "--renders":
        directory, scene_ids = arguments[1], arguments[2:]
        pairs = [(scene_id, rendered_pair(directory, scene_id)) for scene_id in scene_ids]
    else:
        pairs = [(os.path.basename(path), panels(path)) for path in arguments]
    for name, (cycles, gpu) in pairs:
        mean_ratio, p20_ratio = ratios(cycles, gpu)
        print(f"{name}\tmean {mean_ratio:.2f}\tp20 {p20_ratio:.2f}")
