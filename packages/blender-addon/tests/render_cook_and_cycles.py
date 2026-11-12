"""Renders one fixture scene with Cycles and with the Cook engine at the same settings. Runs inside Blender on a GPU machine:

  COOK_NATIVE_DIR=<repo> blender -b --factory-startup --python-exit-code 1 \
    --python packages/blender-addon/tests/render_cook_and_cycles.py -- <small|maps|hdri|hdri-patch|blend:<file.blend>> <outputDirectory> [samples] [width height]

A `blend:` variant opens that file as it is (add --disable-autoexec before --python) instead of building a fixture scene.
Writes cycles.npy and cook.npy (linear RGB, first row at the top) and timing.json to the output directory.
"""
import importlib.util
import json
import os
import sys
import time

TESTS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
ADDON_PARENT = os.path.abspath(os.path.join(TESTS_DIRECTORY, ".."))
REPOSITORY_ROOT = os.path.abspath(os.path.join(ADDON_PARENT, "..", ".."))
sys.path.insert(0, ADDON_PARENT)
sys.path.insert(0, TESTS_DIRECTORY)

import bpy  # noqa: E402

import cook_blender  # noqa: E402
import scene_fixtures  # noqa: E402

DEFAULT_WIDTH = 480
DEFAULT_HEIGHT = 270
BOUNCES = 8


def load_cycles_parity_module():
    path = os.path.join(REPOSITORY_ROOT, "bench", "cycles-parity", "render-cycles.py")
    specification = importlib.util.spec_from_file_location("render_cycles", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def render_to_npy(scene, render_cycles, output_prefix, width, height):
    render_cycles.configure_linear_exr_output(scene, width, height)
    scene.render.film_transparent = False
    exr_path = f"{output_prefix}.exr"
    scene.render.filepath = exr_path
    started = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    seconds = time.perf_counter() - started
    if not os.path.isfile(exr_path):
        raise RuntimeError(f"The render wrote no file at {exr_path}; read the lines starting with COOK above for the reason.")
    render_cycles.load_exr_into_npy(exr_path, f"{output_prefix}.npy", width, height, False)
    return seconds


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    variant = arguments[0]
    output_directory = os.path.abspath(arguments[1])
    samples = int(arguments[2]) if len(arguments) > 2 else 256
    width = int(arguments[3]) if len(arguments) > 4 else DEFAULT_WIDTH
    height = int(arguments[4]) if len(arguments) > 4 else DEFAULT_HEIGHT
    os.makedirs(output_directory, exist_ok=True)
    render_cycles = load_cycles_parity_module()
    if variant.startswith("blend:"):
        bpy.ops.wm.open_mainfile(filepath=variant[len("blend:"):], load_ui=False)
        scene = bpy.context.scene
    else:
        scene = scene_fixtures.build_small_scene(variant, width, height)
    timing = {"variant": variant if not variant.startswith("blend:") else "blend", "samples": samples, "width": width, "height": height}
    render_options = {
        "samples": samples, "seed": 1, "bounces": BOUNCES, "transparent_bounces": None,
        "filter_type": "box", "filter_width": 1.0, "denoise": "none",
    }
    timing["cyclesDevices"] = render_cycles.configure_cycles_parity(scene, render_options)
    timing["cyclesRenderCallSeconds"] = round(render_to_npy(scene, render_cycles, os.path.join(output_directory, "cycles"), width, height), 3)
    cook_blender.register()
    scene.render.engine = "COOK"
    scene.cook.samples = samples
    scene.cook.max_bounces = BOUNCES
    scene.cook.seed = 1
    scene.cook.pixel_filter = "box"
    scene.cook.filter_width = 1.0
    timing["cookRenderCallSeconds"] = round(render_to_npy(scene, render_cycles, os.path.join(output_directory, "cook"), width, height), 3)
    with open(os.path.join(output_directory, "timing.json"), "w", encoding="utf-8") as handle:
        json.dump(timing, handle, indent=2)
    print("RENDER_DONE " + json.dumps(timing), flush=True)


main()
