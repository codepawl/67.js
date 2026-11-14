# Scores the Crucible water shadow pool against the Cycles reference: FLIP of the two pictures, and the bed shadow contrast
# (lit minus shadowed, against the same pool dry) of each, next to exp(-absorption * depth).
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/water-shadows-score.py <work directory>
import json
import math
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image

GAMMA = 2.2
LIT_X = -1.4
SHADOW_X = 0.9
FOV = 40


def aces(linear):
    color = np.maximum(linear, 0)
    return np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)


def inverse_aces(value):
    low = np.zeros_like(value)
    high = np.full_like(value, 40.0)
    for _ in range(40):
        middle = (low + high) / 2
        below = aces(middle) < value
        low = np.where(below, middle, low)
        high = np.where(below, high, middle)
    return (low + high) / 2


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def bed_patch(linear, x, depth):
    height, width = linear.shape[:2]
    half_height = (12 + depth) * math.tan(math.radians(FOV / 2))
    column = round(width / 2 + x / half_height * height / 2)
    return linear[height // 2 - 3:height // 2 + 4, column - 3:column + 4].reshape(-1, 3).mean(axis=0)


def contrast(wet, dry, depth):
    wet_gap = bed_patch(wet, LIT_X, depth) - bed_patch(wet, SHADOW_X, depth)
    dry_gap = bed_patch(dry, LIT_X, depth) - bed_patch(dry, SHADOW_X, depth)
    return [round(float(value), 3) for value in wet_gap / dry_gap]


def flip(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def main():
    work = Path(sys.argv[1])
    plan = json.loads((work / "cases.json").read_text(encoding="utf-8"))
    rows = []
    for case in plan["cases"]:
        if case["absorption"] is None:
            continue
        depth = case["depth"]
        dry_name = f"dry-{depth}"
        js_picture = load_png(work / f"js-{case['name']}.png")
        js_dry_picture = load_png(work / f"js-{dry_name}.png")
        cycles = np.load(work / f"{case['name']}.npy")
        cycles_dry = np.load(work / f"{dry_name}.npy")
        rows.append({
            "case": case["name"],
            "flip": flip(aces(cycles) ** (1 / GAMMA), js_picture),
            "flipDry": flip(aces(cycles_dry) ** (1 / GAMMA), js_dry_picture),
            "contrastcrucible": contrast(inverse_aces(js_picture ** GAMMA), inverse_aces(js_dry_picture ** GAMMA), depth),
            "contrastCycles": contrast(cycles, cycles_dry, depth),
            "beer": [round(math.exp(-sigma * depth), 3) for sigma in case["absorption"]],
        })
        print(rows[-1])
    (work / "scores.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")


main()
