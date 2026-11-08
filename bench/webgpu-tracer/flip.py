# Mean FLIP (LDR) between two tone mapped PNGs: the WebGL2 reference and the WGSL trace.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/webgpu-tracer/flip.py <reference.png> <test.png>
import sys

import flip_evaluator
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


reference = load(sys.argv[1])
test = load(sys.argv[2])
_, mean_error, _ = flip_evaluator.evaluate(reference, test, "LDR", inputsRGB=True)
print(round(float(mean_error), 4))
