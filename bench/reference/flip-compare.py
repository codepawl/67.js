# FLIP of the GPU path tracer against the CPU path tracer (same seed) and, when the Cycles renders are at hand, of both
# against Cycles. Reads the files bench/reference/gpu-compare.mjs writes.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/flip-compare.py <directory> <scene id>,<scene id> [--cycles <directory with <scene>-cycles.npy>]
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image

GAMMA = 2.2


class score:
    """The same helpers as score.py (which runs its own main on import, so they are repeated here)."""

    @staticmethod
    def load_png(path):
        return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255

    @staticmethod
    def tone_map_like_crucible(linear):
        color = np.maximum(linear, 0)
        mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
        return mapped ** (1 / GAMMA)

    @staticmethod
    def flip_score(reference, test):
        _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
        return round(float(mean_error), 4)


def main():
    directory = Path(sys.argv[1])
    scene_ids = sys.argv[2].split(",")
    cycles_directory = Path(sys.argv[sys.argv.index("--cycles") + 1]) if "--cycles" in sys.argv else None
    timings = json.loads((directory / "timings.json").read_text(encoding="utf-8")) if (directory / "timings.json").exists() else {}
    rows = {}
    print("scene".ljust(18) + "gpu-vs-cpu".rjust(12) + "cpu-vs-cycles".rjust(15) + "gpu-vs-cycles".rjust(15) + "gpu s".rjust(9) + "cpu s".rjust(9))
    for scene_id in scene_ids:
        cpu = score.load_png(directory / f"{scene_id}-pathtracer-cpu.png")
        gpu = score.load_png(directory / f"{scene_id}-pathtracer-gpu.png")
        row = {"gpu-vs-cpu": score.flip_score(cpu, gpu)}
        if cycles_directory is not None and (cycles_directory / f"{scene_id}-cycles.npy").exists():
            cycles = score.tone_map_like_crucible(np.load(cycles_directory / f"{scene_id}-cycles.npy"))
            row["cpu-vs-cycles"] = score.flip_score(cycles, cpu)
            row["gpu-vs-cycles"] = score.flip_score(cycles, gpu)
        row["gpu-seconds"] = timings.get(f"{scene_id}:gpu", {}).get("seconds")
        row["cpu-seconds"] = timings.get(f"{scene_id}:cpu", {}).get("seconds")
        rows[scene_id] = row
        cells = [row["gpu-vs-cpu"], row.get("cpu-vs-cycles"), row.get("gpu-vs-cycles"), row["gpu-seconds"], row["cpu-seconds"]]
        print(scene_id.ljust(18) + "".join(("-" if value is None else f"{value:.4f}" if index < 3 else f"{value:.1f}").rjust(width) for index, (value, width) in enumerate(zip(cells, [12, 15, 15, 9, 9]))))
    (directory / "flip-compare.json").write_text(json.dumps(rows, indent=1) + "\n", encoding="utf-8")


main()
