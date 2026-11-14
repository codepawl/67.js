"""The Cook render engine: exports the evaluated scene, runs the native tracer and fills the render result."""
import json
import math
import os
import shutil
import tempfile

import bpy
import numpy

from . import blender_conversions as conversions
from . import native_runner
from .scene_export import export_scene

ENGINE_ID = "COOK"
PIXEL_FILTERS = (
    ("blackman-harris", "Blackman-Harris", "Smooth filter, the Cycles default"),
    ("gaussian", "Gaussian", "Gaussian filter"),
    ("box", "Box", "Sharp filter, one pixel wide at width 1"),
)


def log(message):
    print(f"COOK {message}", flush=True)


class CookSceneSettings(bpy.types.PropertyGroup):
    samples: bpy.props.IntProperty(name="Samples", description="Samples per pixel", default=128, min=1, soft_max=4096)
    max_bounces: bpy.props.IntProperty(name="Max Bounces", description="Light bounces per path", default=8, min=0, max=64)
    seed: bpy.props.IntProperty(name="Seed", description="Noise pattern seed", default=1, min=0)
    pixel_filter: bpy.props.EnumProperty(name="Pixel Filter", items=PIXEL_FILTERS, default="blackman-harris")
    environment_cap: bpy.props.FloatProperty(
        name="Environment Cap",
        description="Limit each texel of the world image to this radiance before it is used. 0 leaves the image unclamped, as Cycles does; a cap lowers noise from small very bright spots and loses their energy",
        default=0.0, min=0.0, soft_max=1000.0,
    )
    filter_width: bpy.props.FloatProperty(name="Filter Width", description="Pixel filter width in pixels", default=1.5, min=0.01, max=10.0, subtype="PIXEL")


class CookPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    native_directory: bpy.props.StringProperty(
        name="Native tracer folder",
        description=f"Root of a Crucible checkout with Cook built (npm run cook:build), unless COOK_ADDON_PATH names a built render-native.node. The {native_runner.NATIVE_DIRECTORY_VARIABLE} environment variable is used when this is empty",
        subtype="DIR_PATH",
    )
    node_executable: bpy.props.StringProperty(name="Node executable", description="Node 20.19 or later; 'node' is looked up on PATH", default="node")

    def draw(self, context):
        self.layout.prop(self, "native_directory")
        self.layout.prop(self, "node_executable")


class CookRenderEngine(bpy.types.RenderEngine):
    bl_idname = ENGINE_ID
    bl_label = "Cook"
    bl_use_preview = False
    bl_use_eevee_viewport = True
    bl_use_postprocess = True

    def update_render_passes(self, scene=None, renderlayer=None):
        if renderlayer is not None and renderlayer.use_pass_z:
            self.register_pass(scene, renderlayer, "Depth", 1, "Z", "VALUE")

    def render(self, depsgraph):
        try:
            self._render(depsgraph)
        except Exception as error:
            # Any failure ends the render with a message; an exception left to Blender would end it with a crash report.
            self.report({"ERROR"}, f"Cook: {error}")
            log(f"error: {type(error).__name__}: {error}")
            self.error_set(str(error))

    def _render(self, depsgraph):
        scene = depsgraph.scene
        settings = scene.cook
        scale = scene.render.resolution_percentage / 100.0
        width = max(1, int(scene.render.resolution_x * scale))
        height = max(1, int(scene.render.resolution_y * scale))
        enabled_addon = bpy.context.preferences.addons.get(__package__)
        preferences = enabled_addon.preferences if enabled_addon is not None else None
        native_directory = native_runner.resolve_native_directory(preferences.native_directory if preferences else "")
        node_executable = native_runner.resolve_node_executable(preferences.node_executable if preferences else "node")
        work_directory = tempfile.mkdtemp(prefix="cook-render-")
        try:
            self.update_stats("Cook", "Exporting the scene")
            description, lens_entry, report = export_scene(depsgraph, width, height, work_directory)
            self.report_export(scene, report)
            scene_path = os.path.join(work_directory, "scene.json")
            with open(scene_path, "w", encoding="utf-8") as handle:
                json.dump(description, handle)
            options = {
                "width": width, "height": height, "samples": settings.samples, "bounces": settings.max_bounces, "seed": settings.seed,
                "filter_type": settings.pixel_filter, "filter_width": settings.filter_width, "lens": lens_entry,
                "environment_cap": settings.environment_cap,
            }
            output_prefix = os.path.join(work_directory, "trace")
            command = native_runner.build_trace_command(node_executable, native_directory, scene_path, output_prefix, options)
            self.update_stats("Cook", f"Tracing {settings.samples} samples")
            log_path = os.path.join(work_directory, "trace.log")
            exit_code, seconds = native_runner.run_with_cancel(command, native_directory, log_path, self.test_break)
            if self.test_break():
                return
            if exit_code != 0:
                raise RuntimeError(f"the native tracer exited with code {exit_code}. Last output:\n{native_runner.read_log_tail(log_path)}")
            trace_report = native_runner.read_trace_report(output_prefix)
            log(f"traced {width}x{height} at {settings.samples} samples in {seconds:.2f} s on {trace_report.get('adapter')}")
            self.write_result(scene, width, height, output_prefix, description["camera"]["fov"])
        finally:
            if os.environ.get("COOK_KEEP_FILES") != "1":
                shutil.rmtree(work_directory, ignore_errors=True)

    def report_export(self, scene, report):
        log(f"exported {report['partCount']} parts over {report['geometryCount']} geometries ({report['uniqueTriangleCount']} unique triangles), {report['materialCount']} materials")
        if scene.render.use_border:
            report["notes"].append("the render border is ignored; the whole frame is rendered")
        if any(view_layer.use_pass_z for view_layer in scene.view_layers):
            report["notes"].append(conversions.DEPTH_COVERAGE_NOTE)
        for note in report["notes"]:
            self.report({"WARNING"}, f"Cook: {note}")
            log(f"note: {note}")
        for material_name, notes in report["materialNotes"].items():
            for note in notes:
                self.report({"WARNING"}, f"Cook material '{material_name}': {note}")
                log(f"material '{material_name}': {note}")

    def write_result(self, scene, width, height, output_prefix, vertical_fov_degrees):
        top_first = numpy.load(f"{output_prefix}.npy")
        rgba = numpy.ones((height, width, 4), dtype=numpy.float32)
        rgba[..., :3] = top_first
        result = self.begin_result(0, 0, width, height)
        render_layer = result.layers[0]
        render_layer.passes["Combined"].rect.foreach_set(numpy.ascontiguousarray(rgba[::-1]).reshape(-1))
        if "Depth" in render_layer.passes.keys():
            tangent_y = math.tan(math.radians(vertical_fov_degrees) / 2.0)
            ray_distance = numpy.load(f"{output_prefix}-depth.npy")
            depth = conversions.z_depth_from_ray_distance(ray_distance, tangent_y * width / height, tangent_y)
            render_layer.passes["Depth"].rect.foreach_set(numpy.ascontiguousarray(depth[::-1]).reshape(-1))
        self.end_result(result)


class COOK_PT_sampling(bpy.types.Panel):
    bl_label = "Sampling"
    bl_space_type = "PROPERTIES"
    bl_region_type = "WINDOW"
    bl_context = "render"
    COMPAT_ENGINES = {ENGINE_ID}

    @classmethod
    def poll(cls, context):
        return context.engine in cls.COMPAT_ENGINES

    def draw(self, context):
        settings = context.scene.cook
        layout = self.layout
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.prop(settings, "samples")
        layout.prop(settings, "max_bounces")
        layout.prop(settings, "seed")
        layout.prop(settings, "pixel_filter")
        layout.prop(settings, "filter_width")
        layout.prop(settings, "environment_cap")


EDITABLE_ENGINE_IDS = ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES")


def panels_to_share():
    """Built-in panels (material, light, world, camera, output) that list Eevee or Cycles; Cook joins their engine sets."""
    shared = []
    for panel in bpy.types.Panel.__subclasses__():
        engines = getattr(panel, "COMPAT_ENGINES", None)
        if isinstance(engines, set) and any(engine in engines for engine in EDITABLE_ENGINE_IDS) and panel is not COOK_PT_sampling:
            shared.append(panel)
    return shared


_shared_panels = []


def share_builtin_panels():
    for panel in panels_to_share():
        panel.COMPAT_ENGINES.add(ENGINE_ID)
        _shared_panels.append(panel)


def unshare_builtin_panels():
    for panel in _shared_panels:
        panel.COMPAT_ENGINES.discard(ENGINE_ID)
    _shared_panels.clear()


CLASSES = (CookSceneSettings, CookPreferences, CookRenderEngine, COOK_PT_sampling)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.cook = bpy.props.PointerProperty(type=CookSceneSettings)
    share_builtin_panels()


def unregister():
    unshare_builtin_panels()
    del bpy.types.Scene.cook
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
