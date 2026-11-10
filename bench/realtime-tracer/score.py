# FLIP of the resting real-time frame (bench/realtime-tracer/run.mjs, <scene>@realtime-rest.png) and of the 64 sample still
# (bench/reference/progressive-compare.mjs --still, <scene>@still-64.png) against the Cycles render.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/realtime-tracer/score.py <directory> <scene id>,... --cycles <directory with <scene>-cycles.npy>
# A real-time frame at twice the Cycles size is reduced with a 2 by 2 box filter first.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image

GAMMA = 2.2


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def tone_map_like_67js(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def reduce_to(image, height, width):
    if image.shape[0] == height * 2 and image.shape[1] == width * 2:
        return image.reshape(height, 2, width, 2, 3).mean(axis=(1, 3))
    return image


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def main():
    directory = Path(sys.argv[1])
    scene_ids = sys.argv[2].split(",")
    cycles_directory = Path(sys.argv[sys.argv.index("--cycles") + 1])
    rows = {}
    for scene_id in scene_ids:
        cycles = tone_map_like_67js(np.load(cycles_directory / f"{scene_id}-cycles.npy"))
        row = {}
        for label, name in (("realtime", f"{scene_id}@realtime-rest.png"), ("still-64", f"{scene_id}@still-64.png")):
            if (directory / name).exists():
                row[label] = flip_score(cycles, reduce_to(load_png(directory / name), cycles.shape[0], cycles.shape[1]))
        rows[scene_id] = row
        print(scene_id.ljust(18), json.dumps(row))
    (directory / "realtime-score.json").write_text(json.dumps(rows, indent=1) + "\n", encoding="utf-8")


main()
