# Scores how close the two engines' pictures are with FLIP, and writes one number for each scene and backend.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/runtime/score-pictures.py <work directory>
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def main():
    work_directory = Path(sys.argv[1])
    scores = {}
    for reference in sorted(work_directory.glob("*-three.png")):
        name = reference.name.removesuffix("-three.png")
        test = work_directory / f"{name}-crucible.png"
        _, mean_error, _ = flip_evaluator.evaluate(load(reference), load(test), "LDR", inputsRGB=True)
        scores[name] = round(float(mean_error), 4)
    (work_directory / "pictures.json").write_text(json.dumps(scores, indent=1), encoding="utf-8")


main()
