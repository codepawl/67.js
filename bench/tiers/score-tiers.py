"""Scores the tier benchmark runs against the Cycles 5.3 reference and writes the numbers as JSON.

  uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/tiers/score-tiers.py final <work directory> <scene> [--width 960]
  uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/tiers/score-tiers.py raster <work directory> <scene>,<scene> [--width 960]
  uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/tiers/score-tiers.py matrix <results json from run-all.mjs>
  uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/tiers/score-tiers.py settle <work directory> <scene> --bound 0.15,0.10

final:  Cook (cpu, gpu, webgpu), the native tracer and Cycles at each sample count: relMSE, FLIP, time, and the equal-error and equal-time reading.
raster: Glaze draft and realtime against EEVEE default and lowest, all against the Cycles reference: FLIP, display-space relMSE, frame times, memory.
settle: the experimental real-time path tracer's checkpoints against the reference: the time until FLIP is under each bound.
FLIP is the LDR mean error of NVlabs/flip (0 identical). Linear images are put into display space with the ACES fit and 2.2 gamma of src/post.js and
rounded to 8 bits (as a PNG is), the same as bench/reference/score.py does.
"""
import glob
import importlib.util
import json
import math
import os
import statistics
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

GAMMA = 2.2
COMPARE_SCRIPT = Path(__file__).resolve().parent.parent / "cycles-parity" / "compare.py"


def load_compare_module():
    specification = importlib.util.spec_from_file_location("cycles_parity_compare", COMPARE_SCRIPT)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


COMPARE = load_compare_module()


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def quantise_to_8_bit(display):
    return np.round(np.clip(display, 0, 1) * 255).astype(np.float32) / 255


def display_of_linear(linear):
    return quantise_to_8_bit(tone_map_like_crucible(linear))


def load_png(path, width, height):
    image = Image.open(path).convert("RGB")
    if image.size != (width, height):
        image = image.resize((width, height), Image.BILINEAR)
    return np.asarray(image, dtype=np.float32) / 255


def flip_score(reference_display, test_display):
    _, mean_error, _ = flip_evaluator.evaluate(reference_display.astype(np.float32), test_display.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def display_relative_mse(reference_display, test_display):
    return COMPARE.compute_relative_mse(reference_display.astype(np.float64), test_display.astype(np.float64))["relMse"]


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def spread(values):
    return {"median": round(statistics.median(values), 4), "min": round(min(values), 4), "max": round(max(values), 4), "runs": [round(value, 4) for value in values]}


def flag_value(arguments, flag, fallback):
    return arguments[arguments.index(flag) + 1] if flag in arguments else fallback


def reference_paths(work_directory, scene, width):
    suffix = "" if width == 960 else f"-{width}"
    return Path(work_directory) / "reference" / f"{scene}-cycles-4096-seed1{suffix}.npy"


def log_interpolate(x_value, points):
    """y at x on the log-log line through the two neighbouring (x, y) points, or None outside the measured range."""
    ordered = sorted(points)
    for (x_low, y_low), (x_high, y_high) in zip(ordered, ordered[1:]):
        if min(x_low, x_high) <= x_value <= max(x_low, x_high) and x_low != x_high and y_low > 0 and y_high > 0:
            fraction = (math.log(x_value) - math.log(x_low)) / (math.log(x_high) - math.log(x_low))
            return math.exp(math.log(y_low) + fraction * (math.log(y_high) - math.log(y_low)))
    return None


def run_times(engine, report, metrics):
    """(sampling seconds, total seconds) of one run, by what each engine reports."""
    if engine.startswith("cook-"):
        compile_seconds = report["report"].get("gpuCompileSeconds", 0.0)
        return report["report"]["tracedSeconds"] - compile_seconds, report["report"]["tracedSeconds"]
    return report["samplingSeconds"], report["totalTraceSeconds"]


def score_final(work_directory, scene, width):
    directory = Path(work_directory) / f"final-{scene}"
    reference = COMPARE.load_linear_rgb_image(str(reference_paths(work_directory, scene, width)))
    reference_display = display_of_linear(reference)
    groups = {}
    for npy_path in sorted(glob.glob(str(directory / f"{scene}-*-s*-r*.npy"))):
        stem = os.path.basename(npy_path)[: -len(".npy")]
        _, engine_part = stem.split(f"{scene}-", 1)
        engine, sample_part, repetition_part = engine_part.rsplit("-", 2)
        groups.setdefault((engine, int(sample_part[1:])), []).append((int(repetition_part[1:]), npy_path))
    rows = []
    for (engine, samples), runs in sorted(groups.items()):
        relative = []
        sampling = []
        total = []
        wall = []
        ram = []
        vram = []
        shared = []
        flips = []
        mean_ratios = None
        for repetition, npy_path in sorted(runs):
            prefix = npy_path[: -len(".npy")]
            report = read_json(f"{prefix}.json")
            image = COMPARE.load_linear_rgb_image(npy_path)
            comparison = COMPARE.compare_image_pair(reference, image)
            relative.append(comparison["relMse"])
            if mean_ratios is None:
                mean_ratios = comparison["channelMeanRatio"]
                flips.append(flip_score(reference_display, display_of_linear(image.astype(np.float32))))
            sampling_seconds, total_seconds = run_times(engine, report, None)
            sampling.append(sampling_seconds)
            total.append(total_seconds)
            metrics_path = f"{prefix}.metrics.json"
            if os.path.exists(metrics_path):
                metrics = read_json(metrics_path)
                wall.append(metrics["wallSeconds"])
                ram.append(metrics["peakRamMegabytes"])
                vram.append(metrics["peakVramDeltaMegabytes"])
                shared.append(not metrics.get("gpuExclusive", False))
            elif "card" in report:
                vram.append(report["card"]["deltaMebibytes"])
                shared.append(report["card"]["utilizationBeforePercent"] >= 20)
        rows.append({
            "engine": engine, "samples": samples, "runs": len(runs),
            "relMse": spread(relative), "flip": flips[0], "channelMeanRatio": mean_ratios,
            "samplingSeconds": spread(sampling), "totalSeconds": spread(total),
            "processWallSeconds": spread(wall) if wall else None,
            "peakRamMegabytes": spread(ram) if ram else None,
            "peakCardVramDeltaMegabytes": spread(vram) if vram else None,
            "cardWasShared": any(shared) if shared else None,
        })
    rows.extend(score_seed_stacks(directory, scene, reference, reference_display))
    return {"scene": scene, "width": width, "rows": rows, "equalError": equal_error_and_time(rows)}


def score_seed_stacks(directory, scene, reference, reference_display):
    """Cook traces of 256 samples with seeds 1..n averaged into 256 * n samples, for the counts one trace cannot reach.

    Seed 1 is the repetition-1 trace of the ladder. The time of a stack is the sum of its traces; the kernel compile is counted once.
    """
    rows = []
    for backend in ("gpu", "webgpu"):
        seed_paths = {1: str(directory / f"{scene}-cook-{backend}-s256-r1")}
        for seed_path in glob.glob(str(directory / f"{scene}-cook-{backend}-s256-seed*.npy")):
            seed_number = int(seed_path.rsplit("seed", 1)[1][: -len(".npy")])
            seed_paths[seed_number] = seed_path[: -len(".npy")]
        ordered = [seed_paths[number] for number in sorted(seed_paths)]
        for count in (2, 4, 8, 16):
            if len(ordered) < count:
                continue
            chosen = ordered[:count]
            average = np.mean([COMPARE.load_linear_rgb_image(f"{prefix}.npy") for prefix in chosen], axis=0)
            reports = [read_json(f"{prefix}.json") for prefix in chosen]
            compile_seconds = reports[0]["report"].get("gpuCompileSeconds", 0.0)
            sampling_seconds = sum(report["report"]["tracedSeconds"] - report["report"].get("gpuCompileSeconds", 0.0) for report in reports)
            comparison = COMPARE.compare_image_pair(reference, average)
            single = {"median": 0, "min": 0, "max": 0, "runs": []}
            rows.append({
                "engine": f"cook-{backend}", "samples": 256 * count, "runs": 1, "stackOf": count,
                "relMse": {**single, "median": round(comparison["relMse"], 6)}, "flip": flip_score(reference_display, display_of_linear(average.astype(np.float32))),
                "channelMeanRatio": comparison["channelMeanRatio"],
                "samplingSeconds": {**single, "median": round(sampling_seconds, 4)}, "totalSeconds": {**single, "median": round(sampling_seconds + compile_seconds, 4)},
                "processWallSeconds": None, "peakRamMegabytes": None, "peakCardVramDeltaMegabytes": None, "cardWasShared": None,
            })
    return rows


def equal_error_and_time(rows):
    cycles_256 = next((row for row in rows if row["engine"] == "cycles" and row["samples"] == 256), None)
    if cycles_256 is None:
        return None
    target_error = cycles_256["relMse"]["median"]
    result = {"target": {"cyclesSamples": 256, "relMse": target_error, "samplingSeconds": cycles_256["samplingSeconds"]["median"], "totalSeconds": cycles_256["totalSeconds"]["median"]}, "engines": {}}
    for engine in sorted({row["engine"] for row in rows if row["engine"] != "cycles"}):
        engine_rows = [row for row in rows if row["engine"] == engine]
        entry = {}
        for time_key in ("samplingSeconds", "totalSeconds"):
            error_points = [(row[time_key]["median"], row["relMse"]["median"]) for row in engine_rows]
            sample_points = [(row["relMse"]["median"], row["samples"]) for row in engine_rows]
            time_points = [(row["relMse"]["median"], row[time_key]["median"]) for row in engine_rows]
            # relMSE falls as time rises, so interpolate time and samples as functions of the error.
            seconds_at_equal_error = log_interpolate(target_error, time_points)
            samples_at_equal_error = log_interpolate(target_error, sample_points)
            error_at_equal_time = log_interpolate(result["target"][time_key], error_points)
            entry[time_key] = {
                "secondsAtEqualError": None if seconds_at_equal_error is None else round(seconds_at_equal_error, 3),
                "samplesAtEqualError": None if samples_at_equal_error is None else round(samples_at_equal_error),
                "relMseAtEqualTime": None if error_at_equal_time is None else round(error_at_equal_time, 6),
                "measuredRange": {"minSamples": min(row["samples"] for row in engine_rows), "maxSamples": max(row["samples"] for row in engine_rows), "bestRelMse": min(row["relMse"]["median"] for row in engine_rows)},
            }
        result["engines"][engine] = entry
    return result


def score_raster(work_directory, scenes, width):
    height = width * 9 // 16
    glaze = read_json(Path(work_directory) / "glaze" / f"glaze-{width}.json")
    rows = []
    for scene in scenes:
        reference = COMPARE.load_linear_rgb_image(str(reference_paths(work_directory, scene, width)))
        reference_display = display_of_linear(reference)
        for tier in ("draft", "realtime"):
            runs = [run for run in glaze["runs"] if run["sceneId"] == scene and run["tierName"] == tier]
            flips = []
            relatives = []
            for run in runs:
                image = load_png(Path(work_directory) / "glaze" / f"{scene}-{tier}-{width}-r{run['repetition']}.png", width, height)
                flips.append(flip_score(reference_display, image))
                relatives.append(display_relative_mse(reference_display, image))
            rows.append({
                "scene": scene, "engine": "glaze", "tier": tier, "width": width,
                "canvas": f"{runs[0]['canvasWidth']}x{runs[0]['canvasHeight']}",
                "firstFrameMilliseconds": spread([run["firstFrameMilliseconds"] for run in runs]),
                "setupMilliseconds": spread([run["setupMilliseconds"] for run in runs]),
                "frameMilliseconds": spread([run["medianFrameMilliseconds"] for run in runs]),
                "flip": spread(flips), "displayRelMse": spread(relatives),
                "renderTargetMegabytes": runs[0]["memoryReport"]["totalMegabytes"],
                "peakCardDeltaMebibytes": spread([run["card"]["deltaMebibytes"] for run in runs]),
                "cardUtilizationPeakPercent": spread([run["card"]["utilizationPeakPercent"] for run in runs]),
                "samples": runs[0]["capabilities"]["samples"],
            })
        for preset in ("lowest", "default"):
            prefixes = sorted(glob.glob(str(Path(work_directory) / "eevee" / f"{scene}-{preset}-{width}-r*.npy")))
            if not prefixes:
                continue
            flips = []
            relatives = []
            linear_relatives = []
            first_frames = []
            frames = []
            vram = []
            ram = []
            for npy_path in prefixes:
                prefix = npy_path[: -len(".npy")]
                report = read_json(f"{prefix}.json")
                linear = np.load(npy_path)
                display = display_of_linear(linear)
                flips.append(flip_score(reference_display, display))
                relatives.append(display_relative_mse(reference_display, display))
                linear_relatives.append(COMPARE.compute_relative_mse(reference, linear.astype(np.float64))["relMse"])
                first_frames.append(report["firstFrameSeconds"] * 1000)
                frames.append(report["medianFrameSeconds"] * 1000)
                if os.path.exists(f"{prefix}.metrics.json"):
                    metrics = read_json(f"{prefix}.metrics.json")
                    vram.append(metrics["peakVramDeltaMegabytes"])
                    ram.append(metrics["peakRamMegabytes"])
            rows.append({
                "scene": scene, "engine": "eevee", "tier": preset, "width": width,
                "firstFrameMilliseconds": spread(first_frames), "frameMilliseconds": spread(frames),
                "flip": spread(flips), "displayRelMse": spread(relatives), "linearRelMse": spread(linear_relatives),
                "peakCardDeltaMebibytes": spread(vram) if vram else None, "peakRamMegabytes": spread(ram) if ram else None,
                "effectiveSettings": read_json(f"{prefixes[0][:-4]}.json")["effectiveSettings"],
            })
    return {"width": width, "rows": rows}


def score_settle(work_directory, scene, bounds, width):
    height = width * 9 // 16
    reference = COMPARE.load_linear_rgb_image(str(reference_paths(work_directory, scene, width)))
    reference_display = display_of_linear(reference)
    result = {"scene": scene, "width": width, "bounds": bounds, "backends": {}}
    for summary_path in sorted(glob.glob(str(Path(work_directory) / "settle" / f"{scene}-*-{width}.json"))):
        summary = read_json(summary_path)
        checkpoints = []
        for checkpoint in summary["checkpoints"]:
            image = load_png(Path(summary_path).with_name(f"{Path(summary_path).stem}-f{checkpoint['frame']}.png"), width, height)
            checkpoints.append({"frame": checkpoint["frame"], "elapsedSeconds": round(checkpoint["elapsedSeconds"], 3), "flip": flip_score(reference_display, image)})
        reached = {}
        for bound in bounds:
            hit = next((entry for entry in checkpoints if entry["flip"] <= bound), None)
            reached[str(bound)] = None if hit is None else {"frame": hit["frame"], "elapsedSeconds": hit["elapsedSeconds"]}
        result["backends"][summary["requestedBackend"]] = {
            "drawnBackend": summary["backend"], "fallbackReason": summary["fallbackReason"], "gpu": summary["gpu"], "compileSeconds": summary["compileSeconds"],
            "medianFrameMilliseconds": summary["medianFrameMilliseconds"], "checkpoints": checkpoints, "timeToBound": reached,
            "card": summary.get("card"),
        }
    return result


def downscale_display(display, width, height):
    image = Image.fromarray(np.round(display * 255).astype(np.uint8))
    return np.asarray(image.resize((width, height), Image.BOX), dtype=np.float32) / 255


def score_backend_agreement(results):
    """Compares each Cook webgpu image with the Cook native image of the same scene, sample count and repetition, and stores the result as
    score.versusNative. Both run the same kernel, so at equal samples the two images should agree to within sampling noise; this is the
    evidence the tables use instead of an equal-error figure for webgpu."""
    native_cells = {
        (cell["scene"], cell["samples"], cell["repetition"]): cell
        for cell in results["cells"]
        if cell["status"] == "ok" and cell["engine"] == "cook-native"
    }
    compared = 0
    for cell in results["cells"]:
        if cell["status"] != "ok" or cell["engine"] != "cook-webgpu" or "score" not in cell or "versusNative" in cell["score"]:
            continue
        native = native_cells.get((cell["scene"], cell["samples"], cell["repetition"]))
        if native is None:
            continue
        native_linear = COMPARE.load_linear_rgb_image(native["image"]["path"])
        webgpu_linear = COMPARE.load_linear_rgb_image(cell["image"]["path"])
        comparison = COMPARE.compare_image_pair(native_linear, webgpu_linear)
        native_display = display_of_linear(native_linear.astype(np.float32))
        webgpu_display = display_of_linear(webgpu_linear.astype(np.float32))
        cell["score"]["versusNative"] = {
            "relMse": comparison["relMse"],
            "flip": flip_score(native_display, webgpu_display),
            "displayRelMse": display_relative_mse(native_display, webgpu_display),
        }
        compared += 1
    return compared


def score_matrix(results_path):
    """Scores every ok cell of run-all.mjs's results file that has no `score` yet, against that scene's Cycles reference, and writes the file back.

    A Glaze cell is a display-space PNG at the tier's own canvas size. flip is its score after a bilinear enlargement to the full size (what a
    viewer sees); flipNative is its score against the reference reduced to the canvas size, which leaves the enlargement out.
    """
    results = read_json(results_path)
    references = {}
    scored = 0
    for cell in results["cells"]:
        if cell["status"] != "ok" or "score" in cell:
            continue
        scene = cell["scene"]
        if scene not in references:
            linear = COMPARE.load_linear_rgb_image(results["references"][scene]["path"])
            references[scene] = (linear, display_of_linear(linear))
        reference_linear, reference_display = references[scene]
        width, height = cell["width"], cell["height"]
        image = cell["image"]
        if image["kind"] == "png-display":
            native = (image["nativeWidth"], image["nativeHeight"])
            test_display = load_png(image["path"], width, height)
            score = {"flip": flip_score(reference_display, test_display), "displayRelMse": display_relative_mse(reference_display, test_display)}
            if native != (width, height):
                raw = load_png(image["path"], native[0], native[1])
                score["flipNative"] = flip_score(downscale_display(reference_display, native[0], native[1]), raw)
                score["nativeSize"] = f"{native[0]}x{native[1]}"
        else:
            linear = COMPARE.load_linear_rgb_image(image["path"])
            display = display_of_linear(linear.astype(np.float32))
            comparison = COMPARE.compare_image_pair(reference_linear, linear)
            score = {"flip": flip_score(reference_display, display), "displayRelMse": display_relative_mse(reference_display, display), "relMse": comparison["relMse"], "channelMeanRatio": comparison["channelMeanRatio"]}
        cell["score"] = score
        scored += 1
    agreement = score_backend_agreement(results)
    Path(results_path).write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")
    print(f"scored {scored} cells and {agreement} backend pairs in {results_path}")


def main():
    arguments = sys.argv[1:]
    if arguments[0] == "matrix":
        score_matrix(arguments[1])
        return
    command, work_directory, scene_text = arguments[0], arguments[1], arguments[2]
    width = int(flag_value(arguments, "--width", "960"))
    if command == "final":
        output = score_final(work_directory, scene_text, width)
    elif command == "raster":
        output = score_raster(work_directory, scene_text.split(","), width)
    elif command == "settle":
        output = score_settle(work_directory, scene_text, [float(bound) for bound in flag_value(arguments, "--bound", "0.15,0.10").split(",")], width)
    else:
        raise SystemExit(f"Unknown command {command}.")
    destination = Path(work_directory) / f"scores-{command}-{scene_text.replace(',', '+')}-{width}.json"
    destination.write_text(json.dumps(output, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {destination}")


main()
