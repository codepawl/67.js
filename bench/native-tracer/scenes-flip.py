# Mean FLIP (LDR) between the WebGPU and native image of every scene that bench/native-tracer/scenes.mjs drew.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/native-tracer/scenes-flip.py <directory>
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


directory = Path(sys.argv[1])
records = json.loads((directory / "scenes.json").read_text())["records"]
scores = {}
for scene, record in records.items():
    if "error" in record:
        print(f"{scene}: skipped ({record['error']})")
        continue
    _, mean_error, _ = flip_evaluator.evaluate(load(directory / f"{scene}-webgpu.png"), load(directory / f"{scene}-native.png"), "LDR", inputsRGB=True)
    scores[scene] = round(float(mean_error), 4)
    print(f"{scene}: FLIP {scores[scene]}  native {record['nativeTracedSeconds']:.2f} s  webgpu {record['webgpuTracedSeconds']:.2f} s")
worst = max(scores, key=scores.get)
print(f"{len(scores)} scenes, worst {worst} {scores[worst]}, mean {sum(scores.values()) / len(scores):.4f}")
