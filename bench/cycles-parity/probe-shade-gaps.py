"""Probe matrix for the two small gaps left by #1040 (#1070): prints Cook and Cycles mean radiance and Cook over Cycles ratios.

Run from the repository root on a machine with Blender 5.3, Node, a GPU and the built render-native addon:
    uv run --no-project --with numpy python bench/cycles-parity/probe-shade-gaps.py <outputDirectory> [--samples 1024]

Every row renders one scene with Cook and with Cycles (grey diffuse, Soft Falloff off) at one bounce count and prints
    PROBE <label> cookMean=<r g b> cyclesMean=<r g b> ratio=<mean ratio> tiles5=<n>/<eligible> minmax=[<min>, <max>]
plus, with --grids, the 8 x 8 tile ratios. Rows can change what each renderer does with the lamp:
    cookDirect  both | nee-only | bsdf-only      (Cook --direct-lighting)
    cyclesMis   on | off                         (Cycles light multiple importance sampling)
Options: --only a|b (rows whose label contains a or b), --tag name (Cook output name), --transparent-bounces N (Cycles limit), --grids.
Cook ignores --direct-lighting nee-only and bsdf-only for point and spot lights: a lamp hit by a BSDF ray is still counted, so the
nee-only rows double count and sit about 5 percent high; compare Cycles with --light-mis off against the both rows instead.
"""
import importlib.util
import json
import os
import subprocess
import sys

import numpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

parity_spec = importlib.util.spec_from_file_location("run_sphere_light_parity", os.path.join(HERE, "run-sphere-light-parity.py"))
parity = importlib.util.module_from_spec(parity_spec)
parity_spec.loader.exec_module(parity)

# (label, scene, bounces, cookDirect, cyclesMis)
PROBE_ROWS = [
    ("bare-r0.18 b1", "bare-r0.18", 1, "both", "on"),
    ("enclosed-r0.18 b0", "enclosed-r0.18", 0, "both", "on"),
    ("enclosed-r0.18 b1", "enclosed-r0.18", 1, "both", "on"),
    ("enclosed-r0.18 b2", "enclosed-r0.18", 2, "both", "on"),
    ("enclosed-r0.18 b3", "enclosed-r0.18", 3, "both", "on"),
    ("enclosed-r0.18 b8", "enclosed-r0.18", 8, "both", "on"),
    ("enclosed-r0 b1", "enclosed-r0", 1, "both", "on"),
    ("enclosed-r0.18 b1 nee-only vs mis-off", "enclosed-r0.18", 1, "nee-only", "off"),
    ("enclosed-r0.18 b2 nee-only vs mis-off", "enclosed-r0.18", 2, "nee-only", "off"),
    ("enclosed-r0.18 b8 nee-only vs mis-off", "enclosed-r0.18", 8, "nee-only", "off"),
    ("bare-r0.18 b1 nee-only vs mis-off", "bare-r0.18", 1, "nee-only", "off"),
    ("enclosed-hidden-r0 b0", "enclosed-hidden-r0", 0, "both", "on"),
    ("enclosed-hidden-r0 b1", "enclosed-hidden-r0", 1, "both", "on"),
    ("enclosed-hidden-r0 b2", "enclosed-hidden-r0", 2, "both", "on"),
    ("enclosed-hidden-r0 b3", "enclosed-hidden-r0", 3, "both", "on"),
    ("enclosed-hidden-r0 b8", "enclosed-hidden-r0", 8, "both", "on"),
    ("enclosed-r0 b8", "enclosed-r0", 8, "both", "on"),
    ("enclosed-hidden-r0.18 b8", "enclosed-hidden-r0.18", 8, "both", "on"),
    ("poking-hidden-r0.18 b8", "poking-hidden-r0.18", 8, "both", "on"),
    ("poking-r0.18 b8", "poking-r0.18", 8, "both", "on"),
]


def render_cook(scene_path, prefix, options, bounces, instancing, direct_lighting):
    command = ["node", os.path.join(HERE, "trace-native.mjs"), scene_path, prefix, "--kernel", "cycles",
               "--samples", str(options["samples"]), "--bounces", str(bounces), "--seed", "1",
               "--width", str(options["width"]), "--height", str(options["height"]),
               "--firefly-clamp", "1000000000", "--noise-threshold", "0", "--grey-diffuse", "--direct-lighting", direct_lighting]
    if instancing:
        command.append("--instancing")
    parity.run(command)


def render_cycles(blender, scene_path, prefix, options, bounces, cycles_mis, transparent_bounces):
    if os.path.exists(f"{prefix}.npy"):
        return
    command = [blender, "-b", "--factory-startup", "--python", os.path.join(HERE, "render-cycles.py"), "--", scene_path, prefix,
               "--samples", str(options["samples"]), "--bounces", str(bounces), "--seed", "1",
               "--width", str(options["width"]), "--height", str(options["height"]),
               "--soft-falloff", "off", "--grey-diffuse", "--light-mis", cycles_mis]
    if transparent_bounces is not None:
        command += ["--transparent-bounces", transparent_bounces]
    parity.run(command)


def mean_rgb(path):
    image = parity.load_linear_rgb_image(path)
    return [round(float(value), 5) for value in image.reshape(-1, 3).mean(axis=0)]


def main():
    argument_list = sys.argv[1:]
    options = {
        "output_directory": os.path.abspath(argument_list[0]),
        "samples": int(parity.read_flag(argument_list, "--samples", "1024")),
        "width": 480,
        "height": 270,
    }
    show_grids = "--grids" in argument_list
    only = parity.read_flag(argument_list, "--only", "")
    tag = parity.read_flag(argument_list, "--tag", "")
    # Cycles transparent bounce limit; without it the limit equals the bounce count, and a lamp hit counts as one transparent bounce.
    transparent_bounces = parity.read_flag(argument_list, "--transparent-bounces", None)
    output_directory = options["output_directory"]
    os.makedirs(os.path.join(output_directory, "renders"), exist_ok=True)
    parity.run(["node", os.path.join(HERE, "export-scene.mjs"), output_directory, "--scene", "lit-interior"])
    parity.run(["node", os.path.join(HERE, "make-sphere-light-scenes.mjs"),
                os.path.join(output_directory, "scenes", "lit-interior.json"), output_directory])
    blender = parity.find_blender()
    report = []
    for label, scene, bounces, cook_direct, cycles_mis in PROBE_ROWS:
        if only and not any(part in label for part in only.split("|")):
            continue
        scene_path = os.path.join(output_directory, "scenes", f"{scene}.json")
        hidden = scene.startswith(parity.HIDDEN_PREFIXES)
        slug = f"{scene}-b{bounces}-{cook_direct}-mis{cycles_mis}"
        cycles_slug = slug if transparent_bounces is None else f"{slug}-transparent{transparent_bounces}"
        cook_prefix = os.path.join(output_directory, "renders", f"probe-cook{tag}-{slug}")
        cycles_prefix = os.path.join(output_directory, "renders", f"probe-cycles-{cycles_slug}")
        render_cook(scene_path, cook_prefix, options, bounces, hidden, cook_direct)
        render_cycles(blender, scene_path, cycles_prefix, options, bounces, cycles_mis, transparent_bounces)
        summary = parity.summarize(f"{cycles_prefix}.npy", f"{cook_prefix}.npy")
        line = (f"PROBE {label} cookMean={mean_rgb(cook_prefix + '.npy')} cyclesMean={mean_rgb(cycles_prefix + '.npy')} "
                f"ratio={summary['meanRatio']} tiles5={summary['tilesWithinFivePercent']}/{summary['tilesEligible']} minmax={summary['tileMinMax']}")
        print(line, flush=True)
        if show_grids:
            for row in summary["tileRatios"]:
                print("   ", row, flush=True)
        report.append({"label": label, "summary": summary})
    with open(os.path.join(output_directory, "probe-shade-gaps.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1)


if __name__ == "__main__":
    main()
