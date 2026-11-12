"""One-call driver for the Classroom parity row of #896: export, both renders, comparisons and a figure.

Run from the repository root on a machine with Blender 5.3 (Cycles OptiX), Node, the built render-native addon and a GPU:

  python3 bench/cycles-parity/run-classroom-parity.py [--data-directory <folder>] [--samples 1024] [--force stage,stage] [--keep-glass]

Stages, each skipped when its outputs already exist unless named in --force: export, cook, cycles, reference, compare.
The scene is the Blender "Classroom" demo file (Christophe Seux, CC0). It is downloaded once into --data-directory (default
~/cook-data/classroom), outside the repository, and opened only with auto-run scripts disabled. Outputs go to artifacts/classroom/
(ignored by Git); the summary is artifacts/classroom/summary.json and the figure artifacts/classroom/classroom-comparison.jpg.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

CLASSROOM_URL = "https://download.blender.org/demo/test/classroom.zip"
OUTPUT_DIRECTORY = os.path.join(REPOSITORY_ROOT, "artifacts", "classroom")
SCENE_DIRECTORY = os.path.join(OUTPUT_DIRECTORY, "scene")
HOME_DIRECTORY = os.path.expanduser("~")
DEFAULT_DATA_DIRECTORY = os.path.join(HOME_DIRECTORY, "cook-data", "classroom")
BLENDER_SEARCH_PATTERNS = (
    os.path.join(HOME_DIRECTORY, "blender", "blender"),
    os.path.join(HOME_DIRECTORY, "*", "blender"),
    os.path.join(HOME_DIRECTORY, "*", "*", "blender"),
    os.path.join(os.sep + "opt", "*", "blender"),
    os.path.join(os.sep + "opt", "*", "*", "blender"),
)
WIDTH = 960
HEIGHT = 540
DEPTH_SAMPLES = 1024


def parse_arguments():
    arguments = sys.argv[1:]

    def option(name, fallback):
        return arguments[arguments.index(name) + 1] if name in arguments else fallback

    return {
        "data_directory": option("--data-directory", DEFAULT_DATA_DIRECTORY),
        "samples": int(option("--samples", "1024")),
        "force": set(filter(None, option("--force", "").split(","))),
        "keep_glass": "--keep-glass" in arguments,
    }


def log(message):
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    with open(os.path.join(OUTPUT_DIRECTORY, "driver.log"), "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def run_command(command, log_name, check=True):
    log_path = os.path.join(OUTPUT_DIRECTORY, f"{log_name}.log")
    started = time.perf_counter()
    with open(log_path, "w", encoding="utf-8") as handle:
        completed = subprocess.run(command, cwd=REPOSITORY_ROOT, stdout=handle, stderr=subprocess.STDOUT)
    seconds = time.perf_counter() - started
    log(f"{log_name}: exit {completed.returncode} in {seconds:.1f} s")
    if completed.returncode != 0:
        with open(log_path, encoding="utf-8", errors="replace") as handle:
            tail = handle.read().splitlines()[-25:]
        log(f"{log_name} tail:\n" + "\n".join(tail))
        if check:
            raise RuntimeError(f"{log_name} failed with exit code {completed.returncode}")
    return seconds


def find_blender():
    found = shutil.which("blender")
    if found:
        return found
    for pattern in BLENDER_SEARCH_PATTERNS:
        for path in sorted(glob.glob(pattern)):
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
    raise RuntimeError("Blender was not found on this machine.")


def ensure_python_packages():
    """The packages come from `uv run --with numpy --with pillow --with flip-evaluator` (run-classroom-parity.sh)."""
    for module_name in ("numpy", "PIL", "flip_evaluator"):
        __import__(module_name)


def ensure_classroom_file(data_directory):
    existing = glob.glob(os.path.join(data_directory, "**", "*.blend"), recursive=True)
    if existing:
        return existing[0]
    os.makedirs(data_directory, exist_ok=True)
    archive_path = os.path.join(data_directory, "classroom.zip")
    log(f"downloading {CLASSROOM_URL}")
    urllib.request.urlretrieve(CLASSROOM_URL, archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(data_directory)
    existing = glob.glob(os.path.join(data_directory, "**", "*.blend"), recursive=True)
    if not existing:
        raise RuntimeError("The Classroom archive holds no .blend file.")
    return existing[0]


def blender_command(blender, blend_path, mode, output, extra):
    return [blender, "-b", "--disable-autoexec", blend_path, "--python", os.path.join(HERE, "classroom_bridge.py"), "--", mode, output, "--width", str(WIDTH), "--height", str(HEIGHT)] + extra


def lens_flags_for(lens):
    if not lens.get("enabled"):
        return []
    return ["--f-stop", str(lens["fStop"]), "--focus-distance", str(lens["focusDistance"]), "--aperture-blades", str(lens["apertureBlades"]),
            "--aperture-rotation", str(lens["apertureRotation"]), "--sensor-width", str(lens["sensorWidth"])]


def stage_wanted(stage, outputs, force):
    return stage in force or not all(os.path.exists(path) for path in outputs)


def cook_command(scene_json, prefix, samples, seed, extra):
    return ["node", os.path.join(HERE, "trace-native.mjs"), scene_json, prefix, "--kernel", "cycles", "--samples", str(samples), "--bounces", "8", "--seed", str(seed),
            "--width", str(WIDTH), "--height", str(HEIGHT), "--grey-diffuse", "--instancing"] + extra


def cycles_command(blender, scene_json, prefix, samples, seed, extra):
    return [blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "render-cycles.py"), "--", scene_json, prefix, "--samples", str(samples), "--bounces", "8",
            "--seed", str(seed), "--width", str(WIDTH), "--height", str(HEIGHT), "--grey-diffuse"] + extra


def tone_mapped_image(linear_rgb):
    import numpy
    import compare
    return (numpy.clip(compare.tone_map_like_67js(linear_rgb), 0.0, 1.0) * 255.0 + 0.5).astype(numpy.uint8)


def write_side_by_side(cook_path, cycles_path, output_path):
    import numpy
    from PIL import Image
    cook = Image.fromarray(tone_mapped_image(numpy.load(cook_path))).resize((640, 360), Image.LANCZOS)
    cycles = Image.fromarray(tone_mapped_image(numpy.load(cycles_path))).resize((640, 360), Image.LANCZOS)
    canvas = Image.new("RGB", (1280, 360))
    canvas.paste(cook, (0, 0))
    canvas.paste(cycles, (640, 0))
    canvas.save(output_path, "JPEG", quality=80, optimize=True)


def write_ratio_map(reference_path, candidate_path, output_path, block=12):
    import numpy
    from PIL import Image
    reference = numpy.load(reference_path).astype(numpy.float64).mean(axis=2)
    candidate = numpy.load(candidate_path).astype(numpy.float64).mean(axis=2)
    rows = reference.shape[0] // block
    columns = reference.shape[1] // block
    reference_blocks = reference[: rows * block, : columns * block].reshape(rows, block, columns, block).mean(axis=(1, 3))
    candidate_blocks = candidate[: rows * block, : columns * block].reshape(rows, block, columns, block).mean(axis=(1, 3))
    log_ratio = numpy.log2(numpy.maximum(candidate_blocks, 1e-6) / numpy.maximum(reference_blocks, 1e-6))
    scaled = numpy.clip(log_ratio / 0.25, -1.0, 1.0)
    image = numpy.zeros((rows, columns, 3), dtype=numpy.uint8)
    image[..., 0] = numpy.clip(128 + 127 * scaled, 0, 255)
    image[..., 2] = numpy.clip(128 - 127 * scaled, 0, 255)
    image[..., 1] = numpy.clip(128 - 127 * numpy.abs(scaled), 0, 255)
    Image.fromarray(image).resize((columns * 4, rows * 4), Image.NEAREST).save(output_path, "JPEG", quality=80)
    return {"blockMeanLog2RatioMin": float(log_ratio.min()), "blockMeanLog2RatioMax": float(log_ratio.max())}


def select_image_summary(comparison):
    gates = comparison["parityGates"]
    tiles = comparison["tileGrid8x8"]
    return {
        "channelMeanRatio": gates["channelMeanRatioExact"], "channelMeanPass": gates["channelMeanPass"],
        "tilesWithin5Percent": f"{tiles['withinFivePercentCount']} of {tiles['eligibleTileCount']}", "tilePass": gates["tileGridPass"],
        "tileMinMax": [tiles["minRatio"], tiles["maxRatio"]], "darkTilesExcluded": tiles["excludedDarkTileCount"],
        "relMse": comparison["relMse"], "relMseTrimmed": comparison["relMseTrimmed"],
        "flipLdr": gates.get("flipLdrCandidateVsA"), "flipLdrSeedFloor": gates.get("flipLdrAVsB"), "flipLdrCeiling": gates.get("flipLdrCeiling"), "flipPass": gates.get("flipPass"),
        "seedFloorRelMse": comparison.get("seedAVsSeedB", {}).get("relMse"), "worstTiles": tiles["worstTiles"][:4],
    }


def compare_images(reference_path, candidate_path, seed_path):
    import compare
    reference = compare.load_linear_rgb_image(reference_path)
    candidate = compare.load_linear_rgb_image(candidate_path)
    seed_comparison = None
    if seed_path and os.path.exists(seed_path):
        seed_comparison = compare.compare_image_pair(reference, compare.load_linear_rgb_image(seed_path), include_flip=True)
    comparison = compare.compare_image_pair(reference, candidate, include_flip=True, seed_ab_comparison=seed_comparison)
    summary = select_image_summary(comparison)
    summary["meanLuminance"] = float(reference.mean())
    return summary


def compare_depths(cycles_depth_path, cook_depth_path, field_of_view):
    import numpy
    import compare_depth
    reference = numpy.load(cycles_depth_path)
    cook_z = compare_depth.ray_distance_to_z_depth(numpy.load(cook_depth_path), field_of_view)
    result = compare_depth.compare_depth_maps(reference, cook_z, 0.01)
    reference_hit = compare_depth.hit_mask_of(reference)
    candidate_hit = compare_depth.hit_mask_of(cook_z)
    agree = compare_depth.agreement_at(numpy.where(reference_hit, reference, 0.0), numpy.where(candidate_hit, cook_z, 0.0), reference_hit, candidate_hit, 0.01)
    disagree = ~agree
    grid = [[int(disagree[row * HEIGHT // 8:(row + 1) * HEIGHT // 8, column * WIDTH // 8:(column + 1) * WIDTH // 8].sum()) for column in range(8)] for row in range(8)]
    result["disagreeingPixelsPer8x8Tile"] = grid
    result["referenceMissShare"] = float((~reference_hit).mean())
    depth_error = numpy.abs(cook_z - reference) / numpy.maximum(reference, 1e-9)
    both = reference_hit & candidate_hit
    result["bothHitByRelativeError"] = {
        "above1Percent": int((both & (depth_error > 0.01)).sum()),
        "above5Percent": int((both & (depth_error > 0.05)).sum()),
        "above20Percent": int((both & (depth_error > 0.20)).sum()),
    }
    return result, disagree


def write_depth_disagreement_image(disagree, cycles_depth_path, output_path):
    import numpy
    from PIL import Image
    depth = numpy.load(cycles_depth_path)
    shade = (numpy.clip(depth / max(float(depth.max()), 1e-6), 0, 1) * 160).astype(numpy.uint8)
    image = numpy.stack([shade, shade, shade], axis=2)
    image[disagree] = (255, 0, 0)
    Image.fromarray(image).save(output_path, "JPEG", quality=80)


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main():
    options = parse_arguments()
    os.makedirs(SCENE_DIRECTORY, exist_ok=True)
    summary = {"samples": options["samples"], "errors": {}}
    force = options["force"]
    samples = options["samples"]

    def guarded(stage, action):
        try:
            action()
        except Exception as error:
            summary["errors"][stage] = repr(error)
            log(f"STAGE {stage} FAILED: {error}\n{traceback.format_exc()[-1500:]}")

    log(f"driver start, samples {samples}, force {sorted(force)}")
    ensure_python_packages()
    blender = find_blender()
    summary["blender"] = blender
    blend_path = ensure_classroom_file(options["data_directory"])
    summary["blendBytes"] = os.path.getsize(blend_path)
    scene_json = os.path.join(SCENE_DIRECTORY, "classroom.json")
    report_path = os.path.join(SCENE_DIRECTORY, "classroom-report.json")

    def stage_export():
        if stage_wanted("export", [scene_json, report_path], force):
            extra = ["--keep-glass"] if options["keep_glass"] else []
            run_command(blender_command(blender, blend_path, "export", SCENE_DIRECTORY, extra), "export")

    guarded("export", stage_export)
    if os.path.exists(report_path):
        report = read_json(report_path)
        keys = ("partCount", "geometryCount", "uniqueTriangleCount", "uniqueVertexCount", "instancedTriangleCount", "negativeDeterminantParts", "skipped", "lightCounts", "environmentSummary", "worldDescription", "worldBake", "camera", "lens", "sceneJsonBytes", "exportSeconds", "notes", "raw", "emptyMeshObjects", "renderableObjectsNotExported", "partsWithHiddenRayKinds", "shadowCatcherOrHoldoutObjects")
        summary["export"] = {key: report.get(key) for key in keys}
        summary["inspection"] = report.get("inspection")
        summary["prepare"] = report.get("prepare")
    if not os.path.exists(scene_json):
        finish(summary)
        return
    lens = read_json(os.path.join(SCENE_DIRECTORY, "classroom-lens.json"))
    lens_flags = lens_flags_for(lens)
    summary["lens"] = lens
    variants = [("pinhole", [])]
    if lens.get("enabled"):
        variants.insert(0, ("dof", lens_flags))

    def stage_cook():
        for label, flags in variants:
            prefix = os.path.join(OUTPUT_DIRECTORY, f"cook-{label}")
            extra = list(flags) + (["--write-depth"] if label == "pinhole" else [])
            if stage_wanted("cook", [prefix + ".npy", prefix + ".json"], force):
                run_command(cook_command(scene_json, prefix, samples, 1, extra), f"cook-{label}")
            trace = read_json(prefix + ".json")
            summary.setdefault("cook", {})[label] = {key: trace.get(key) for key in ("triangleCount", "instanceCount", "samplingSeconds", "setupSeconds", "adapter", "thinLens", "cameraVerticalFovDegrees")}

    def stage_cycles():
        for label, flags in variants:
            for seed in (1, 2):
                prefix = os.path.join(OUTPUT_DIRECTORY, f"cycles-{label}-seed{seed}")
                with_depth = label == "pinhole" and seed == 1
                extra = list(flags) + (["--z-depth", "--depth-samples", str(DEPTH_SAMPLES)] if with_depth else [])
                if stage_wanted("cycles", [prefix + ".npy", prefix + ".json"], force):
                    run_command(cycles_command(blender, scene_json, prefix, samples, seed, extra), f"cycles-{label}-seed{seed}")
            trace = read_json(os.path.join(OUTPUT_DIRECTORY, f"cycles-{label}-seed1.json"))
            summary.setdefault("cycles", {})[label] = {key: trace.get(key) for key in ("samplingSeconds", "setupSeconds", "devices", "blenderVersion", "thinLens", "cyclesPeakMemoryMegabytes", "depthError")}

    def stage_reference():
        prefix = os.path.join(OUTPUT_DIRECTORY, "blend-pinhole")
        if stage_wanted("reference", [prefix + ".npy"], force):
            extra = ["--pinhole", "--z-depth", "--samples", str(samples), "--seed", "1"] + (["--keep-glass"] if options["keep_glass"] else [])
            run_command(blender_command(blender, blend_path, "reference", prefix, extra), "blend-pinhole")

    guarded("cook", stage_cook)
    guarded("cycles", stage_cycles)
    guarded("reference", stage_reference)

    def stage_compare():
        comparisons = {}
        for label, flags in variants:
            cook_path = os.path.join(OUTPUT_DIRECTORY, f"cook-{label}.npy")
            cycles_path = os.path.join(OUTPUT_DIRECTORY, f"cycles-{label}-seed1.npy")
            seed_path = os.path.join(OUTPUT_DIRECTORY, f"cycles-{label}-seed2.npy")
            comparisons[f"cook-vs-cycles-{label}"] = compare_images(cycles_path, cook_path, seed_path)
            comparisons[f"cook-vs-cycles-{label}"]["ratioMap"] = write_ratio_map(cycles_path, cook_path, os.path.join(OUTPUT_DIRECTORY, f"ratio-map-{label}.jpg"))
        blend_npy = os.path.join(OUTPUT_DIRECTORY, "blend-pinhole.npy")
        if os.path.exists(blend_npy):
            seed_path = os.path.join(OUTPUT_DIRECTORY, "cycles-pinhole-seed2.npy")
            comparisons["bridge-cycles-vs-original-blend-pinhole"] = compare_images(blend_npy, os.path.join(OUTPUT_DIRECTORY, "cycles-pinhole-seed1.npy"), seed_path)
            comparisons["cook-vs-original-blend-pinhole"] = compare_images(blend_npy, os.path.join(OUTPUT_DIRECTORY, "cook-pinhole.npy"), seed_path)
        summary["images"] = comparisons
        fov = read_json(os.path.join(OUTPUT_DIRECTORY, "cook-pinhole.json"))["cameraVerticalFovDegrees"]
        cycles_depth = os.path.join(OUTPUT_DIRECTORY, "cycles-pinhole-seed1-depth.npy")
        depth_result, disagree = compare_depths(cycles_depth, os.path.join(OUTPUT_DIRECTORY, "cook-pinhole-depth.npy"), fov)
        summary["depth"] = depth_result
        blend_depth = os.path.join(OUTPUT_DIRECTORY, "blend-pinhole-depth.npy")
        if os.path.exists(blend_depth):
            import numpy
            import compare_depth
            geometry_check = compare_depth.compare_depth_maps(numpy.load(blend_depth), numpy.load(cycles_depth), 0.01)
            geometry_check["disagreeingPixelsPer8x8Tile"] = [[int((~compare_depth.agreement_at(numpy.load(blend_depth), numpy.load(cycles_depth), compare_depth.hit_mask_of(numpy.load(blend_depth)), compare_depth.hit_mask_of(numpy.load(cycles_depth)), 0.01))[row * HEIGHT // 8:(row + 1) * HEIGHT // 8, column * WIDTH // 8:(column + 1) * WIDTH // 8].sum()) for column in range(8)] for row in range(8)]
            summary["bridgeGeometryCheckDepthCyclesJsonVsOriginalBlend"] = geometry_check
        write_depth_disagreement_image(disagree, cycles_depth, os.path.join(OUTPUT_DIRECTORY, "depth-disagreement.jpg"))
        primary = variants[0][0]
        write_side_by_side(os.path.join(OUTPUT_DIRECTORY, f"cook-{primary}.npy"), os.path.join(OUTPUT_DIRECTORY, f"cycles-{primary}-seed1.npy"), os.path.join(OUTPUT_DIRECTORY, "classroom-comparison.jpg"))

    guarded("compare", stage_compare)
    guarded("diagnose", lambda: stage_diagnose(blender, blend_path, scene_json, options, summary))
    guarded("pointprobe", lambda: stage_point_probe(blender, scene_json, options, summary))
    finish(summary)


POINT_PROBE_SAMPLES = 256


def stage_point_probe(blender, scene_json, options, summary):
    """Cook against Cycles on the same exported scene, lit by one point light at a time and by all of them with radius 0.

    Both renderers read one JSON file, so a gap here is in how they treat a point light, not in the bridge."""
    scene = read_json(scene_json)
    environment = scene["environment"]
    points = environment["pointLights"]
    summary["pointLights"] = [{"index": index, "position": [round(value, 3) for value in light["position"]], "intensity": round(light["intensity"], 4), "radius": light["radius"], "color": [round(value, 3) for value in light["color"]]} for index, light in enumerate(points)]
    base = {"keyColor": [0, 0, 0], "areaLights": [], "spotLights": []}
    variants = {f"point{index}": {**base, "pointLights": [light]} for index, light in enumerate(points)}
    variants["all-radius0"] = {**base, "pointLights": [{**light, "radius": 0.0} for light in points]}
    results = {}
    for name, environment_changes in variants.items():
        variant_path = os.path.join(SCENE_DIRECTORY, f"classroom-probe-{name}.json")
        with open(variant_path, "w", encoding="utf-8") as handle:
            json.dump({**scene, "environment": {**environment, **environment_changes}}, handle)
        cook_prefix = os.path.join(OUTPUT_DIRECTORY, f"probe-cook-{name}")
        cycles_prefix = os.path.join(OUTPUT_DIRECTORY, f"probe-cycles-{name}")
        run_command(cook_command(variant_path, cook_prefix, POINT_PROBE_SAMPLES, 1, []), f"probe-cook-{name}", check=False)
        run_command(cycles_command(blender, variant_path, cycles_prefix, POINT_PROBE_SAMPLES, 1, []), f"probe-cycles-{name}", check=False)
        entry = {}
        for label, prefix in (("cook", cook_prefix), ("cycles", cycles_prefix)):
            if os.path.exists(prefix + ".npy"):
                entry[label] = channel_means(prefix + ".npy")[1]
        if len(entry) == 2:
            entry["cookOverCycles"] = round(entry["cook"] / max(entry["cycles"], 1e-12), 4)
        results[name] = entry
    summary["pointProbe"] = results


DIAGNOSTIC_SAMPLES = 256
BLEND_VARIANTS = ("sun-only", "points-only", "areas-only", "spots-only")
LIGHT_SUBSETS = {
    "sun-only": {"pointLights": [], "areaLights": [], "spotLights": []},
    "points-only": {"keyColor": [0, 0, 0], "areaLights": [], "spotLights": []},
    "areas-only": {"keyColor": [0, 0, 0], "pointLights": [], "spotLights": []},
    "spots-only": {"keyColor": [0, 0, 0], "pointLights": [], "areaLights": []},
}


def channel_means(npy_path):
    import numpy
    return [round(float(value), 5) for value in numpy.load(npy_path).reshape(-1, 3).mean(axis=0)]


def stage_diagnose(blender, blend_path, scene_json, options, summary):
    """Mean radiance per light class on three scenes: the original blend, the bridge through Cycles, and the bridge through Cook.

    A pinhole camera at 256 samples; only the means are compared, so it finds which part of the scene the gap lives in."""
    scene = read_json(scene_json)
    table = {}
    for variant in BLEND_VARIANTS:
        prefix = os.path.join(OUTPUT_DIRECTORY, f"diag-blend-{variant}")
        if stage_wanted("diagnose", [prefix + ".npy"], options["force"]):
            extra = ["--pinhole", "--samples", str(DIAGNOSTIC_SAMPLES), "--seed", "1", "--variant", variant]
            run_command(blender_command(blender, blend_path, "reference", prefix, extra), f"diag-blend-{variant}", check=False)
        if os.path.exists(prefix + ".npy"):
            table.setdefault(variant, {})["blend"] = channel_means(prefix + ".npy")
    flipped_direction = [-component for component in scene["environment"]["lightDirection"]]
    subsets = {**LIGHT_SUBSETS, "sun-flipped": {**LIGHT_SUBSETS["sun-only"], "lightDirection": flipped_direction}}
    for name, environment_changes in subsets.items():
        subset_scene = {**scene, "environment": {**scene["environment"], **environment_changes}}
        subset_path = os.path.join(SCENE_DIRECTORY, f"classroom-{name}.json")
        with open(subset_path, "w", encoding="utf-8") as handle:
            json.dump(subset_scene, handle)
        cook_prefix = os.path.join(OUTPUT_DIRECTORY, f"diag-cook-{name}")
        cycles_prefix = os.path.join(OUTPUT_DIRECTORY, f"diag-cycles-{name}")
        if stage_wanted("diagnose", [cook_prefix + ".npy"], options["force"]):
            run_command(cook_command(subset_path, cook_prefix, DIAGNOSTIC_SAMPLES, 1, []), f"diag-cook-{name}", check=False)
        if stage_wanted("diagnose", [cycles_prefix + ".npy"], options["force"]):
            run_command(cycles_command(blender, subset_path, cycles_prefix, DIAGNOSTIC_SAMPLES, 1, []), f"diag-cycles-{name}", check=False)
        for label, prefix in (("cook", cook_prefix), ("cycles", cycles_prefix)):
            if os.path.exists(prefix + ".npy"):
                table.setdefault(name, {})[label] = channel_means(prefix + ".npy")
    summary["diagnose"] = table
    from PIL import Image
    import numpy
    for label, path in (("blend", "blend-pinhole"), ("cycles", "cycles-pinhole-seed1")):
        npy_path = os.path.join(OUTPUT_DIRECTORY, path + ".npy")
        if os.path.exists(npy_path):
            image = Image.fromarray(tone_mapped_image(numpy.load(npy_path))).resize((640, 360), Image.LANCZOS)
            image.save(os.path.join(OUTPUT_DIRECTORY, f"view-{label}-pinhole.jpg"), "JPEG", quality=75)


def copy_small_outputs():
    """Copies the logs, JSON files and pictures (never the .npy dumps or the scene) into out/, the one folder a caller fetches."""
    small_directory = os.path.join(OUTPUT_DIRECTORY, "out")
    os.makedirs(small_directory, exist_ok=True)
    sources = glob.glob(os.path.join(OUTPUT_DIRECTORY, "*")) + glob.glob(os.path.join(SCENE_DIRECTORY, "classroom-*.json"))
    for source in sources:
        if os.path.isfile(source) and source.endswith((".json", ".log", ".jpg")) and os.path.getsize(source) < 3_000_000:
            shutil.copy(source, small_directory)


def finish(summary):
    with open(os.path.join(OUTPUT_DIRECTORY, "summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, default=str)
    copy_small_outputs()
    print("CLASSROOM_SUMMARY " + json.dumps(summary, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        os.makedirs(OUTPUT_DIRECTORY, exist_ok=True)
        log(f"DRIVER FAILED: {error}\n{traceback.format_exc()[-2000:]}")
        finish({"errors": {"driver": repr(error)}})
        raise
