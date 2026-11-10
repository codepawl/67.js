# FLIP of path tracer images against the Cycles renders: the images of progressive-compare.mjs (<scene>@<label>.png) and of
# gpu-compare.mjs (<scene>-pathtracer-gpu.png).
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/progressive-score.py <directory> --cycles <directory with <scene>-cycles.npy>
# Prints one line per image and writes progressive-score.json beside the images.
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


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def split_name(stem):
    if "@" in stem:
        scene_id, label = stem.split("@", 1)
        return scene_id, label
    if stem.endswith("-pathtracer-webgpu"):
        return stem.removesuffix("-pathtracer-webgpu"), "webgpu"
    return stem.removesuffix("-pathtracer-gpu"), "gpu"


def main():
    directory = Path(sys.argv[1])
    cycles_directory = Path(sys.argv[sys.argv.index("--cycles") + 1])
    cycles_cache = {}
    scores = {}
    for path in sorted(directory.glob("*.png")):
        scene_id, label = split_name(path.stem)
        cycles_path = cycles_directory / f"{scene_id}-cycles.npy"
        if not cycles_path.exists():
            continue
        if scene_id not in cycles_cache:
            cycles_cache[scene_id] = tone_map_like_67js(np.load(cycles_path))
        score = flip_score(cycles_cache[scene_id], load_png(path))
        scores[f"{scene_id}:{label}"] = score
        print(f"{scene_id:<20}{label:<16}{score:.4f}")
    (directory / "progressive-score.json").write_text(json.dumps(scores, indent=1) + "\n", encoding="utf-8")


main()
