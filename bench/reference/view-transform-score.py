# Scores Crucible drawn with environment.viewTransform against Cycles rendered with the matching Blender view transform (issue #282).
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/view-transform-score.py <work directory> <output directory> <agx|neutral> [scene ids]
# Blender writes its picture in the sRGB transfer curve, and Crucible encodes with a power of 1 / 2.2 (src/post.js). The Blender picture is decoded
# to display-linear and encoded with the 2.2 power, so both sides meet in one display space as score.py does for the plain suite; the
# difference left is the tone curve and the lighting. Writes view-transform.json in the output directory.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image

GAMMA = 2.2


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def srgb_to_display(encoded):
    linear = np.where(encoded <= 0.04045, encoded / 12.92, ((encoded + 0.055) / 1.055) ** 2.4)
    return np.round(np.clip(linear, 0, 1) ** (1 / GAMMA) * 255).astype(np.float32) / 255


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def main():
    work_directory = Path(sys.argv[1])
    output_directory = Path(sys.argv[2])
    name = sys.argv[3]
    blender_suffix = {"agx": "agx", "neutral": "khronos-pbr-neutral"}[name]
    scene_ids = sys.argv[4:] or sorted(path.name.removesuffix(f"-cycles-{blender_suffix}.png") for path in work_directory.glob(f"*-cycles-{blender_suffix}.png"))
    scores = {}
    for scene_id in scene_ids:
        cycles = srgb_to_display(load_png(work_directory / f"{scene_id}-cycles-{blender_suffix}.png"))
        mine = load_png(work_directory / f"{scene_id}-gpu.png")
        scores[scene_id] = flip_score(cycles, mine)
        print(f"{scene_id}: Crucible {name} against Cycles {name}: {scores[scene_id]}")
    result = {"metric": "FLIP (LDR), mean error, lower is better", "viewTransform": name, "scores": scores}
    (output_directory / "view-transform.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")


main()
