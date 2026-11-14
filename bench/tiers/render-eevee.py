"""Render an exported Crucible scene JSON in Blender 5.3 EEVEE and time its frames.

  blender -b --factory-startup --python bench/tiers/render-eevee.py -- <sceneJsonPath> <outputPrefix> [--preset default|lowest] [--width 960] [--height 540] [--frames 10]

The scene is built by the Cycles parity script (bench/cycles-parity/render-cycles.py) so Cycles and EEVEE see the same objects, lights, world and camera.
Timing: the first render (shader compile and scene sync) is reported on its own, then `--frames` more renders of the same scene, each a full
bpy.ops.render.render call (Blender re-syncs the scene on each call), then one render written to an EXR for the scorer.
"""
import importlib.util
import json
import os
import statistics
import sys
import time

import bpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CYCLES_SCRIPT = os.path.join(os.getcwd(), "bench", "cycles-parity", "render-cycles.py")

# The EEVEE settings per preset, applied only where Blender 5.3 has the property. "default" changes nothing from a fresh scene except what the scene needs.
PRESETS = {
    "default": {},
    "lowest": {
        "taa_render_samples": 1,
        "use_raytracing": False,
        "shadow_ray_count": 1,
        "shadow_step_count": 1,
        "use_volumetric_shadows": False,
    },
}


def load_cycles_builder():
    specification = importlib.util.spec_from_file_location("render_cycles_builder", CYCLES_SCRIPT)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def read_flag_value(argument_list, flag_name, fallback_value):
    if flag_name not in argument_list:
        return fallback_value
    return argument_list[argument_list.index(flag_name) + 1]


def apply_eevee_preset(scene, preset_name):
    scene.render.engine = "BLENDER_EEVEE"
    applied = {}
    for property_name, value in PRESETS[preset_name].items():
        if hasattr(scene.eevee, property_name):
            setattr(scene.eevee, property_name, value)
        applied[property_name] = "set" if hasattr(scene.eevee, property_name) else "missing in this Blender"
    effective = {}
    for property_name in ("taa_render_samples", "use_raytracing", "shadow_ray_count", "shadow_step_count", "use_volumetric_shadows", "use_shadows"):
        if hasattr(scene.eevee, property_name):
            effective[property_name] = getattr(scene.eevee, property_name)
    return applied, effective


class EngineRenderTimer:
    """Blender's own render time: from the render_pre handler to render_post, which leaves out the Python call, the scene build and the file write."""

    def __init__(self):
        self.started = None
        self.durations = []

    def on_render_pre(self, *_):
        self.started = time.perf_counter()

    def on_render_post(self, *_):
        if self.started is not None:
            self.durations.append(time.perf_counter() - self.started)
            self.started = None

    def install(self):
        bpy.app.handlers.render_pre.append(self.on_render_pre)
        bpy.app.handlers.render_post.append(self.on_render_post)


def main():
    argument_list = sys.argv[sys.argv.index("--") + 1:]
    scene_json_path = os.path.abspath(argument_list[0])
    output_prefix = os.path.abspath(argument_list[1])
    preset_name = read_flag_value(argument_list, "--preset", "default")
    width = int(read_flag_value(argument_list, "--width", "960"))
    height = int(read_flag_value(argument_list, "--height", "540"))
    frame_count = int(read_flag_value(argument_list, "--frames", "10"))
    builder = load_cycles_builder()
    with open(scene_json_path, encoding="utf-8") as handle:
        description = json.load(handle)
    build_started = time.perf_counter()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    builder.build_scene_objects(scene, description)
    builder.build_world_shader(scene, description["world"], os.getcwd())
    builder.build_scene_lights(scene, description["environment"])
    builder.build_camera_object(scene, description["camera"])
    builder.configure_linear_exr_output(scene, width, height)
    applied, effective = apply_eevee_preset(scene, preset_name)
    scene_build_seconds = time.perf_counter() - build_started
    engine_timer = EngineRenderTimer()
    engine_timer.install()
    first_started = time.perf_counter()
    bpy.ops.render.render()
    first_frame_seconds = time.perf_counter() - first_started
    frame_seconds = []
    for _ in range(frame_count):
        frame_started = time.perf_counter()
        bpy.ops.render.render()
        frame_seconds.append(time.perf_counter() - frame_started)
    # engine_timer.durations holds the first render, then one per frame above; the handlers may not fire in every Blender build.
    engine_frame_seconds = engine_timer.durations[1:1 + frame_count]
    exr_path = f"{output_prefix}.exr"
    scene.render.filepath = exr_path
    bpy.ops.render.render(write_still=True)
    builder.load_exr_into_npy(exr_path, f"{output_prefix}.npy", width, height, False)
    report = {
        "engine": "eevee",
        "blenderVersion": bpy.app.version_string,
        "renderEngine": scene.render.engine,
        "sceneId": description["id"],
        "preset": preset_name,
        "presetApplied": applied,
        "effectiveSettings": effective,
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "sceneBuildSeconds": round(scene_build_seconds, 4),
        "firstFrameSeconds": round(first_frame_seconds, 4),
        "frameSeconds": [round(value, 4) for value in frame_seconds],
        "medianFrameSeconds": round(statistics.median(frame_seconds), 4),
        "engineFirstFrameSeconds": round(engine_timer.durations[0], 4) if engine_timer.durations else None,
        "engineFrameSeconds": [round(value, 4) for value in engine_frame_seconds],
        "engineMedianFrameSeconds": round(statistics.median(engine_frame_seconds), 4) if engine_frame_seconds else None,
        "viewTransform": scene.view_settings.view_transform,
    }
    with open(f"{output_prefix}.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print("EEVEE_TIMING " + json.dumps({key: report[key] for key in ("preset", "firstFrameSeconds", "medianFrameSeconds", "engineMedianFrameSeconds", "effectiveSettings")}))


main()
