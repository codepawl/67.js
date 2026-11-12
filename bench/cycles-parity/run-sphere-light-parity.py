"""Sphere light parity matrix (#1040): Cook against Blender Cycles on small scenes with one lamp that has a radius.

Run from the repository root on a machine with Blender 5.3, Node, a GPU and the built render-native addon:
    uv run --no-project --with numpy python bench/cycles-parity/run-sphere-light-parity.py <outputDirectory> [options]

It exports `lit-interior`, writes the scenes of make-sphere-light-scenes.mjs, renders each one with Cycles (grey diffuse
everywhere) and with Cook, and prints one result line per scene. Options:
    --samples 1024  --width 480  --height 270  --bounces 8
    --soft-falloff default,off     Cycles `use_soft_falloff` settings to render for the sphere scenes (default: the Blender default and off).
                                   The `-soft` scenes carry `softFalloff: true` and are compared with Cycles following the scene (Soft Falloff on).
    --scenes a,b                   only these scenes
    --label before                 name of the Cook run in the output
    --repeat-cycles-seed2          also render Cycles with seed 2 for the seed-to-seed floor
    --reference-scenes a,b         also run these scenes of bench/reference/scenes.js with their own materials
    --no-sphere-scenes             skip the sphere light scenes
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys

import numpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from compare import compare_image_pair, load_linear_rgb_image  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DIRECT_ONLY_SCENES = ("bare-r0", "bare-r0.18", "enclosed-r0", "enclosed-r0.18", "enclosed-hidden-r0", "enclosed-hidden-r0.18")
INSTANCED_CONTROL_SCENES = ("enclosed-r0.18", "poking-r0.18")
HIDDEN_PREFIXES = ("enclosed-hidden", "poking-hidden")
SPHERE_SCENE_PREFIXES = ("bare-", "enclosed-", "poking-")
SOFT_FALLOFF_SCENE_SUFFIX = "-soft"
FOLLOW_SCENE = "scene"  # render-cycles.py reads each light's own softFalloff field


def falloff_settings_for_scene(name, falloff_settings):
    return [FOLLOW_SCENE] if name.endswith(SOFT_FALLOFF_SCENE_SUFFIX) else falloff_settings


def read_flag(argument_list, flag_name, fallback):
    if flag_name not in argument_list:
        return fallback
    return argument_list[argument_list.index(flag_name) + 1]


def find_blender():
    found = shutil.which("blender")
    if found:
        return found
    patterns = (
        os.path.join(os.path.expanduser("~"), "blender", "blender"),
        os.path.join(os.sep + "opt", "*", "blender"),
        os.path.join(os.path.expanduser("~"), "*", "blender"),
    )
    for pattern in patterns:
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    raise RuntimeError("Blender was not found on this machine.")


def run(command):
    print("RUN", " ".join(command), flush=True)
    completed = subprocess.run(command, cwd=os.getcwd(), capture_output=True, text=True)
    if completed.returncode != 0:
        print(completed.stdout[-1500:], completed.stderr[-1500:], flush=True)
        raise RuntimeError(f"command failed with {completed.returncode}")


def render_cycles(blender, scene_path, prefix, options, bounces, seed, soft_falloff, grey_diffuse=True):
    if os.path.exists(f"{prefix}.npy"):
        return
    command = [blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "render-cycles.py"), "--", scene_path, prefix,
               "--samples", str(options["samples"]), "--bounces", str(bounces), "--seed", str(seed),
               "--width", str(options["width"]), "--height", str(options["height"])]
    if soft_falloff != FOLLOW_SCENE:
        command += ["--soft-falloff", soft_falloff]
    if grey_diffuse:
        command.append("--grey-diffuse")
    run(command)


def render_cook(scene_path, prefix, options, bounces, instancing, grey_diffuse=True):
    command = ["node", os.path.join(HERE, "trace-native.mjs"), scene_path, prefix, "--kernel", "cycles",
               "--samples", str(options["samples"]), "--bounces", str(bounces), "--seed", "1",
               "--width", str(options["width"]), "--height", str(options["height"]),
               "--firefly-clamp", "1000000000", "--noise-threshold", "0"]
    if grey_diffuse:
        command.append("--grey-diffuse")
    if instancing:
        command.append("--instancing")
    run(command)


def tile_ratio_rows(reference_rgb, candidate_rgb, grid=8):
    height, width = reference_rgb.shape[0], reference_rgb.shape[1]
    rows = []
    for row in range(grid):
        cells = []
        for column in range(grid):
            rows_slice = slice(row * height // grid, (row + 1) * height // grid)
            columns_slice = slice(column * width // grid, (column + 1) * width // grid)
            reference_sum = float(numpy.sum(reference_rgb[rows_slice, columns_slice]))
            cells.append(round(float(numpy.sum(candidate_rgb[rows_slice, columns_slice])) / reference_sum, 3) if reference_sum > 0 else None)
        rows.append(cells)
    return rows


def summarize(reference_path, candidate_path):
    comparison = compare_image_pair(load_linear_rgb_image(reference_path), load_linear_rgb_image(candidate_path), include_flip=False)
    tile_grid = comparison["tileGrid8x8"]
    return {
        "tileRatios": tile_ratio_rows(load_linear_rgb_image(reference_path), load_linear_rgb_image(candidate_path)),
        "meanRatio": comparison["channelMeanRatio"],
        "relMse": round(comparison["relMse"], 6),
        "tilesWithinFivePercent": tile_grid["withinFivePercentCount"],
        "tilesEligible": tile_grid["eligibleTileCount"],
        "tileMinMax": [tile_grid["minRatio"], tile_grid["maxRatio"]],
    }


def sha256_of(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run_pair(blender, scene_path, name, suffix, bounces, options, falloff_settings, label, instancing, grey_diffuse, results):
    cook_prefix = os.path.join(options["output_directory"], "renders", f"{name}{suffix}-{label}")
    render_cook(scene_path, cook_prefix, options, bounces, instancing, grey_diffuse)
    for setting in falloff_settings:
        cycles_prefix = os.path.join(options["output_directory"], "renders", f"{name}{suffix}-cycles-{setting}")
        render_cycles(blender, scene_path, cycles_prefix, options, bounces, 1, setting, grey_diffuse)
        key = f"{name}{suffix}|{setting}"
        results[key] = summarize(f"{cycles_prefix}.npy", f"{cook_prefix}.npy")
        print("PARITY", key, json.dumps(results[key]), flush=True)
    results[f"{name}{suffix}|cookSha256"] = sha256_of(f"{cook_prefix}.npy")


def run_sphere_scenes(blender, scene_names, options, falloff_settings, label, results):
    for name in scene_names:
        scene_path = os.path.join(options["output_directory"], "scenes", f"{name}.json")
        hidden = name.startswith(HIDDEN_PREFIXES)
        bounce_counts = [options["bounces"], 1] if name in DIRECT_ONLY_SCENES else [options["bounces"]]
        for bounces in bounce_counts:
            suffix = "" if bounces == options["bounces"] else f"-b{bounces}"
            run_pair(blender, scene_path, name, suffix, bounces, options, falloff_settings_for_scene(name, falloff_settings), label, hidden, True, results)
        if name in INSTANCED_CONTROL_SCENES:
            run_pair(blender, scene_path, name, "-instanced", options["bounces"], options, falloff_settings, label, True, True, results)


def run_reference_scenes(blender, scene_names, options, falloff_settings, label, results):
    for name in scene_names:
        run(["node", os.path.join(HERE, "export-scene.mjs"), options["output_directory"], "--scene", name])
        scene_path = os.path.join(options["output_directory"], "scenes", f"{name}.json")
        run_pair(blender, scene_path, name, "", options["bounces"], options, falloff_settings, label, False, False, results)


def run_seed_floor(blender, scene_names, options, falloff_settings):
    floor = {}
    for name in scene_names:
        scene_path = os.path.join(options["output_directory"], "scenes", f"{name}.json")
        for setting in falloff_settings_for_scene(name, falloff_settings):
            first = os.path.join(options["output_directory"], "renders", f"{name}-cycles-{setting}")
            second = f"{first}-seed2"
            render_cycles(blender, scene_path, second, options, options["bounces"], 2, setting)
            key = f"{name}|{setting}|seed2VsSeed1"
            floor[key] = summarize(f"{first}.npy", f"{second}.npy")
            print("FLOOR", key, json.dumps(floor[key]), flush=True)
    return floor


def main():
    argument_list = sys.argv[1:]
    options = {
        "output_directory": os.path.abspath(argument_list[0]),
        "samples": int(read_flag(argument_list, "--samples", "1024")),
        "width": int(read_flag(argument_list, "--width", "480")),
        "height": int(read_flag(argument_list, "--height", "270")),
        "bounces": int(read_flag(argument_list, "--bounces", "8")),
    }
    falloff_settings = read_flag(argument_list, "--soft-falloff", "default,off").split(",")
    for falloff_setting in falloff_settings:
        if falloff_setting not in ("default", "on", "off"):
            raise ValueError(f"--soft-falloff takes default, on or off separated by commas, got {falloff_setting!r}.")
    label = read_flag(argument_list, "--label", "cook")
    reference_names = [name for name in read_flag(argument_list, "--reference-scenes", "").split(",") if name]
    blender = find_blender()
    results = {}
    os.makedirs(os.path.join(options["output_directory"], "renders"), exist_ok=True)
    if "--no-sphere-scenes" not in argument_list:
        run(["node", os.path.join(HERE, "export-scene.mjs"), options["output_directory"], "--scene", "lit-interior"])
        base_scene = os.path.join(options["output_directory"], "scenes", "lit-interior.json")
        run(["node", os.path.join(HERE, "make-sphere-light-scenes.mjs"), base_scene, options["output_directory"]])
        scene_names = sorted(os.path.basename(path)[:-5] for path in glob.glob(os.path.join(options["output_directory"], "scenes", "*.json")) if os.path.basename(path).startswith(SPHERE_SCENE_PREFIXES))
        wanted = read_flag(argument_list, "--scenes", "")
        if wanted:
            scene_names = [name for name in scene_names if name in wanted.split(",")]
        run_sphere_scenes(blender, scene_names, options, falloff_settings, label, results)
        if "--repeat-cycles-seed2" in argument_list:
            results.update(run_seed_floor(blender, scene_names, options, falloff_settings))
    run_reference_scenes(blender, reference_names, options, falloff_settings, label, results)
    with open(os.path.join(options["output_directory"], f"sphere-light-{label}.json"), "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=1)
    print("DONE", len(results))


if __name__ == "__main__":
    main()
