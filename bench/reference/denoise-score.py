# Scores every denoiser output of denoise-compare.mjs against the Cycles render of the same scene with FLIP, and writes denoise.json:
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/denoise-score.py <capture directory> <cycles directory> <output json>
# Each <capture directory>/<scene>/<samples>/<method>.f32 is linear RGB, 960 by 540. Like score.py, the image is tone mapped as Crucible does
# and rounded to 8 bits before FLIP, because a path traced still is written as an 8-bit PNG.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np

WIDTH = 960
HEIGHT = 540
GAMMA = 2.2
MIN_SCENES_BETTER = 4


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def quantise_to_8_bit(display):
    return np.round(np.clip(display, 0, 1) * 255).astype(np.float32) / 255


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def main():
    capture_directory = Path(sys.argv[1])
    cycles_directory = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    timings_path = capture_directory / "timings.json"
    timings = json.loads(timings_path.read_text(encoding="utf-8")) if timings_path.exists() else {}
    # With a fourth argument the reference is not Cycles but the tracer's own 512 sample capture without a filter in that
    # directory (denoise-capture.mjs --samples 512), which takes the difference between the tracer and Cycles out of the
    # score and leaves the noise and the blur the denoiser adds.
    truth_directory = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    scores = {}
    for scene_directory in sorted(path for path in capture_directory.iterdir() if path.is_dir()):
        if truth_directory is not None:
            truth_path = truth_directory / scene_directory.name / "512" / "color.f32"
            if not truth_path.exists():
                continue
            cycles = quantise_to_8_bit(tone_map_like_crucible(np.fromfile(truth_path, dtype=np.float32).reshape(HEIGHT, WIDTH, 3)))
        else:
            cycles_path = cycles_directory / f"{scene_directory.name}-cycles.npy"
            if not cycles_path.exists():
                continue
            cycles = tone_map_like_crucible(np.load(cycles_path))
        scores[scene_directory.name] = {}
        for sample_directory in sorted((path for path in scene_directory.iterdir() if path.is_dir()), key=lambda path: int(path.name)):
            entry = {}
            for method_path in sorted(sample_directory.glob("*.f32")):
                if method_path.stem in ("color", "albedo", "normal", "depth", "variance"):
                    continue
                linear = np.fromfile(method_path, dtype=np.float32).reshape(HEIGHT, WIDTH, 3)
                entry[method_path.stem] = flip_score(cycles, quantise_to_8_bit(tone_map_like_crucible(linear)))
            scores[scene_directory.name][sample_directory.name] = entry
    verdict = {}
    for scene_id, by_samples in scores.items():
        wavelet_at_64 = by_samples.get("64", {}).get("wavelet")
        for method in sorted({name for entry in by_samples.values() for name in entry}):
            if method in ("none", "wavelet"):
                continue
            beats = [samples for samples in ("8", "16") if wavelet_at_64 is not None and by_samples.get(samples, {}).get(method, 9) <= wavelet_at_64]
            verdict.setdefault(method, {})[scene_id] = beats
    report = {
        "metric": "FLIP (LDR), mean error against Cycles, lower is better; 960 by 540, tone mapped and rounded to 8 bits",
        "scores": scores,
        "timings": timings,
        "scenesWhereMethodAtOrBelow16BeatsWaveletAt64": {method: [scene for scene, beats in per_scene.items() if beats] for method, per_scene in verdict.items()},
        "samplesThatBeatWaveletAt64": verdict,
    }
    output_path.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    for scene_id, by_samples in scores.items():
        print(scene_id)
        for samples, entry in by_samples.items():
            print("  " + samples.rjust(3) + " spp  " + "  ".join(f"{name} {value:.4f}" for name, value in entry.items()))


main()
