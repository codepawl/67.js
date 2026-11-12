"""Blender side of the Classroom parity bridge (#896).

Run inside Blender 5.3, on a copy of the Classroom demo scene (Christophe Seux, CC0), never with auto-run scripts:

  blender -b classroom.blend --disable-autoexec --python bench/cycles-parity/classroom_bridge.py -- export <outputDirectory> [options]
  blender -b classroom.blend --disable-autoexec --python bench/cycles-parity/classroom_bridge.py -- reference <outputPrefix> [options]

`export` writes the evaluated scene in the JSON scene format that render-cycles.py and trace-native.mjs read: one geometry per
mesh datablock (with the same modifier settings), one part per instance with its world matrix, the camera, the lights and the
world, with every material replaced by the grey diffuse one. It also writes <outputDirectory>/classroom-lens.json (the
depth-of-field flags) and <outputDirectory>/classroom-report.json (counts and everything dropped or approximated).

`reference` renders the original .blend in Cycles with the same drops and the same grey override, so the bridge itself
(lights, world, camera, geometry) can be compared with Cycles on the very scene it came from.

Both modes call prepare_scene first, so the two sides drop the same objects.
"""
import base64
import importlib.util
import json
import math
import os
import sys
import time

import bpy
import numpy
from mathutils import Euler, Matrix, Vector

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
REPOSITORY_ROOT = os.path.abspath(os.path.join(SCRIPT_DIRECTORY, "..", ".."))
BLENDER_TO_YUP = Matrix((
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
))
WATTS_PER_POINT_INTENSITY = 4.0 * math.pi
WATTS_PER_AREA_INTENSITY = math.pi
HDR_RADIANCE_LIMIT = 60000.0
HDR_WIDTH = 2048
HDR_HEIGHT = 1024
PROBE_HDR_WIDTH = 1024
PROBE_HDR_HEIGHT = 512
PROBE_VIEW_SIZE = 48
PROBE_SAMPLES = 8
BAKE_ROTATION_CANDIDATE_DEGREES = (0.0, 90.0, 180.0, 270.0)
UNSUPPORTED_OBJECT_TYPES = ("CURVES", "POINTCLOUD", "VOLUME", "GREASEPENCIL", "GPENCIL")
MESH_LIKE_OBJECT_TYPES = ("MESH", "CURVE", "SURFACE", "FONT", "META")
IGNORED_MODIFIER_PROPERTIES = {"rna_type", "persistent_uid", "name", "show_expanded", "is_active", "is_override_data", "use_pin_to_last", "execution_time"}
GREY_ALBEDO = 0.8
RAY_VISIBILITY_ATTRIBUTES = {
    "camera": "visible_camera", "diffuse": "visible_diffuse", "glossy": "visible_glossy",
    "transmission": "visible_transmission", "volumeScatter": "visible_volume_scatter", "shadow": "visible_shadow",
}


def log(message):
    print(f"BRIDGE {message}", flush=True)


def load_render_cycles_module():
    specification = importlib.util.spec_from_file_location("render_cycles", os.path.join(SCRIPT_DIRECTORY, "render-cycles.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def read_option(argument_list, flag_name, fallback_value):
    if flag_name not in argument_list:
        return fallback_value
    return argument_list[argument_list.index(flag_name) + 1]


def parse_arguments():
    if "--" not in sys.argv:
        raise ValueError("Pass the mode after '--': export <outputDirectory> | reference <outputPrefix>.")
    argument_list = sys.argv[sys.argv.index("--") + 1:]
    if len(argument_list) < 2 or argument_list[0] not in ("export", "reference"):
        raise ValueError("Usage: -- export <outputDirectory> [--width 960] [--height 540] [--keep-glass] | reference <outputPrefix> [--samples 1024] [--seed 1] [--pinhole] [--keep-glass]")
    return {
        "mode": argument_list[0],
        "output": os.path.abspath(argument_list[1]),
        "width": int(read_option(argument_list, "--width", "960")),
        "height": int(read_option(argument_list, "--height", "540")),
        "samples": int(read_option(argument_list, "--samples", "1024")),
        "seed": int(read_option(argument_list, "--seed", "1")),
        "keep_glass": "--keep-glass" in argument_list,
        "pinhole": "--pinhole" in argument_list,
        "bounces": int(read_option(argument_list, "--bounces", "8")),
        "variant": read_option(argument_list, "--variant", "baseline"),
        "z_depth": "--z-depth" in argument_list,
    }


# ---- Visibility, modifiers, hair and glass: the same drops on both sides ----

def collect_instanced_object_names():
    names = set()
    for scene_object in bpy.data.objects:
        if scene_object.instance_type == "COLLECTION" and scene_object.instance_collection is not None:
            for source_object in scene_object.instance_collection.all_objects:
                names.add(source_object.name)
    return names


def make_instanced_collections_visible_in_viewport(report):
    """Cycles draws a collection instance whatever the viewport flags of its source collection and objects say; the viewport
    evaluation the export reads does not, so those flags are cleared for everything that renders."""
    cleared_collections = 0
    cleared_objects = 0
    for scene_object in bpy.data.objects:
        if scene_object.instance_type != "COLLECTION" or scene_object.instance_collection is None:
            continue
        pending = [scene_object.instance_collection]
        while pending:
            collection = pending.pop()
            if collection.hide_viewport and not collection.hide_render:
                collection.hide_viewport = False
                cleared_collections += 1
            pending.extend(collection.children)
        for source_object in scene_object.instance_collection.all_objects:
            if not source_object.hide_render and source_object.hide_viewport:
                source_object.hide_viewport = False
                cleared_objects += 1
    report["instancedCollectionsMadeViewportVisible"] = cleared_collections
    report["instancedObjectsMadeViewportVisible"] = cleared_objects


def make_render_collections_visible(layer_collection, visible_names):
    if layer_collection.exclude or layer_collection.collection.hide_render:
        return
    layer_collection.hide_viewport = False
    layer_collection.collection.hide_viewport = False
    for scene_object in layer_collection.collection.objects:
        if not scene_object.hide_render:
            visible_names.add(scene_object.name)
    for child_collection in layer_collection.children:
        make_render_collections_visible(child_collection, visible_names)


def tag_material_node_trees(material):
    tags = set()
    if material is None or material.node_tree is None:
        return tags
    pending_trees = [material.node_tree]
    seen_tree_names = set()
    while pending_trees:
        node_tree = pending_trees.pop()
        if node_tree.name in seen_tree_names:
            continue
        seen_tree_names.add(node_tree.name)
        for node in node_tree.nodes:
            if node.type == "GROUP" and node.node_tree is not None:
                pending_trees.append(node.node_tree)
            elif node.type in ("BSDF_GLASS", "BSDF_REFRACTION"):
                tags.add("glass")
            elif node.type == "BSDF_TRANSPARENT":
                tags.add("transparent")
            elif node.type == "BSDF_PRINCIPLED":
                transmission_socket = node.inputs.get("Transmission Weight")
                if transmission_socket is not None and not transmission_socket.is_linked and transmission_socket.default_value >= 0.5:
                    tags.add("glass")
                alpha_socket = node.inputs.get("Alpha")
                if alpha_socket is not None and (alpha_socket.is_linked or alpha_socket.default_value < 1.0):
                    tags.add("alpha")
    return tags


def tag_object_materials(scene_object):
    tags = set()
    for material_slot in scene_object.material_slots:
        tags |= tag_material_node_trees(material_slot.material)
    return tags


def disable_particle_systems_and_sync_modifiers(report):
    for scene_object in bpy.data.objects:
        for modifier in scene_object.modifiers:
            if modifier.type == "PARTICLE_SYSTEM":
                settings = modifier.particle_system.settings
                instances_objects = settings.type == "EMITTER" and settings.render_type in ("OBJECT", "COLLECTION")
                if instances_objects:
                    modifier.show_viewport = modifier.show_render
                    report["particleInstanceSystemsKept"] += 1
                else:
                    modifier.show_viewport = False
                    modifier.show_render = False
                    report["particleSystemsDropped"] += 1
                    report["particleSystemsDroppedKinds"][f"{settings.type}/{settings.render_type}"] = report["particleSystemsDroppedKinds"].get(f"{settings.type}/{settings.render_type}", 0) + 1
                continue
            modifier.show_viewport = modifier.show_render
            if modifier.type in ("SUBSURF", "MULTIRES"):
                modifier.levels = modifier.render_levels


def hide_object_everywhere(scene_object):
    scene_object.hide_render = True
    scene_object.hide_viewport = True


def prepare_scene(scene, keep_glass):
    """Makes the viewport evaluation equal the render evaluation, then removes what the bench format cannot carry."""
    report = {
        "hiddenFromRender": 0,
        "hiddenFromRenderNames": [],
        "unsupportedObjects": {},
        "glassObjects": [],
        "cutoutObjectCount": 0,
        "particleInstanceSystemsKept": 0,
        "particleSystemsDropped": 0,
        "particleSystemsDroppedKinds": {},
        "extraSunsDropped": [],
    }
    make_instanced_collections_visible_in_viewport(report)
    instanced_names = collect_instanced_object_names()
    visible_names = set()
    make_render_collections_visible(scene.view_layers[0].layer_collection, visible_names)
    disable_particle_systems_and_sync_modifiers(report)
    for scene_object in list(scene.objects):
        if scene_object.name in instanced_names:
            continue
        if scene_object.name in visible_names:
            scene_object.hide_viewport = False
            try:
                scene_object.hide_set(False)
            except RuntimeError:
                pass
        else:
            scene_object.hide_viewport = True
            report["hiddenFromRender"] += 1
            report["hiddenFromRenderNames"].append(f"{scene_object.name} ({scene_object.type})")
    for scene_object in bpy.data.objects:
        if scene_object.type in UNSUPPORTED_OBJECT_TYPES and not scene_object.hide_render:
            report["unsupportedObjects"][scene_object.type] = report["unsupportedObjects"].get(scene_object.type, 0) + 1
            hide_object_everywhere(scene_object)
            continue
        if scene_object.type not in MESH_LIKE_OBJECT_TYPES or scene_object.hide_render:
            continue
        tags = tag_object_materials(scene_object)
        if "glass" in tags and not keep_glass:
            report["glassObjects"].append(scene_object.name)
            hide_object_everywhere(scene_object)
        elif tags & {"transparent", "alpha"}:
            report["cutoutObjectCount"] += 1
    sun_names = sorted(obj.name for obj in scene.objects if obj.type == "LIGHT" and obj.data.type == "SUN" and not obj.hide_render and obj.name in visible_names)
    for extra_sun_name in sun_names[1:]:
        report["extraSunsDropped"].append(extra_sun_name)
        hide_object_everywhere(bpy.data.objects[extra_sun_name])
    report["glassObjectCount"] = len(report["glassObjects"])
    report["glassObjectNamesSample"] = report["glassObjects"][:40]
    return report


# ---- Coordinates, camera, lights ----

def to_yup(vector):
    return [float(vector[0]), float(vector[2]), float(-vector[1])]


def column_major_yup_matrix(blender_matrix):
    matrix = BLENDER_TO_YUP @ blender_matrix
    return [float(matrix[row][column]) for column in range(4) for row in range(4)]


def effective_horizontal_sensor_width(camera_data, width, height):
    fit = camera_data.sensor_fit
    if fit == "AUTO":
        fit = "HORIZONTAL" if width >= height else "VERTICAL"
    if fit == "HORIZONTAL":
        return camera_data.sensor_width
    return camera_data.sensor_height * width / height


def vertical_fov_degrees(camera_data, width, height):
    horizontal_sensor_width = effective_horizontal_sensor_width(camera_data, width, height)
    half_tangent_x = horizontal_sensor_width / (2.0 * camera_data.lens)
    half_tangent_y = half_tangent_x * height / width
    return math.degrees(2.0 * math.atan(half_tangent_y))


def build_camera_entries(scene, width, height, report):
    camera_object = scene.camera
    camera_data = camera_object.data
    if camera_data.type != "PERSP":
        raise ValueError(f"Camera type {camera_data.type} is not supported: the bench draws perspective cameras only.")
    world_matrix = camera_object.matrix_world
    eye = world_matrix.translation.copy()
    forward = (world_matrix.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
    camera_up = (world_matrix.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized()
    level_up = (Vector((0.0, 0.0, 1.0)) - forward * forward.z).normalized()
    roll_degrees = math.degrees(math.acos(max(-1.0, min(1.0, camera_up.dot(level_up)))))
    report["camera"] = {
        "name": camera_object.name,
        "lensMillimetres": camera_data.lens,
        "sensorWidth": camera_data.sensor_width,
        "sensorHeight": camera_data.sensor_height,
        "sensorFit": camera_data.sensor_fit,
        "shiftX": camera_data.shift_x,
        "shiftY": camera_data.shift_y,
        "rollDegrees": roll_degrees,
        "clipStart": camera_data.clip_start,
        "clipEnd": camera_data.clip_end,
        "dofEnabled": camera_data.dof.use_dof,
        "pixelAspect": scene.render.pixel_aspect_x / scene.render.pixel_aspect_y,
        "frame": scene.frame_current,
    }
    camera_entry = {
        "eye": to_yup(eye),
        "target": to_yup(eye + forward),
        "up": to_yup(level_up),
        "fov": vertical_fov_degrees(camera_data, width, height),
        "near": camera_data.clip_start,
        "far": max(camera_data.clip_end, 1000.0),
    }
    lens_entry = {"enabled": False}
    if camera_data.dof.use_dof:
        dof = camera_data.dof
        focus_distance = dof.focus_distance
        if dof.focus_object is not None:
            focus_distance = abs((dof.focus_object.matrix_world.translation - eye).dot(forward))
        lens_entry = {
            "enabled": True,
            "fStop": dof.aperture_fstop,
            "focusDistance": focus_distance,
            "apertureBlades": dof.aperture_blades,
            "apertureRotation": math.degrees(dof.aperture_rotation),
            "apertureRatio": dof.aperture_ratio,
            "sensorWidth": effective_horizontal_sensor_width(camera_data, width, height),
        }
    report["lens"] = lens_entry
    return camera_entry, lens_entry


def light_color_with_exposure(light_data):
    exposure_scale = 2.0 ** getattr(light_data, "exposure", 0.0)
    return [float(channel) for channel in light_data.color], light_data.energy * exposure_scale


def add_light_entry(environment, light_object, light_matrix, report):
    light_data = light_object.data
    color, energy = light_color_with_exposure(light_data)
    if energy <= 0.0:
        return
    position = to_yup(light_matrix.translation)
    emission_direction = to_yup((light_matrix.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized())
    if light_data.type == "SUN":
        toward_light = [-component for component in emission_direction]
        environment["keyColor"] = [channel * energy for channel in color]
        environment["lightDirection"] = toward_light
        environment["sunAngularRadius"] = light_data.angle / 2.0
    elif light_data.type == "POINT":
        environment["pointLights"].append({"position": position, "color": color, "intensity": energy / WATTS_PER_POINT_INTENSITY, "radius": light_data.shadow_soft_size})
    elif light_data.type == "SPOT":
        environment["spotLights"].append({
            "position": position,
            "color": color,
            "intensity": energy / WATTS_PER_POINT_INTENSITY,
            "radius": light_data.shadow_soft_size,
            "direction": emission_direction,
            "angle": light_data.spot_size / 2.0,
            "penumbra": light_data.spot_blend,
        })
    elif light_data.type == "AREA":
        scale = light_matrix.to_scale()
        local_up = to_yup((light_matrix.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized())
        shape = {"SQUARE": "rectangle", "RECTANGLE": "rectangle", "DISK": "disk", "ELLIPSE": "ellipse"}[light_data.shape]
        width_value = light_data.size * abs(scale.x)
        height_value = width_value if light_data.shape in ("SQUARE", "DISK") else light_data.size_y * abs(scale.y)
        entry = {
            "position": position,
            "color": color,
            "intensity": energy / WATTS_PER_AREA_INTENSITY,
            "width": width_value,
            "height": height_value,
            "direction": emission_direction,
            "up": [-component for component in local_up],
            "shape": shape,
            "spread": max(0.0001, min(math.pi, light_data.spread)),
        }
        environment["areaLights"].append(entry)
        if getattr(light_data, "normalize", True) is False:
            report["notes"].append(f"area light {light_object.name} has Normalize off, which the bench format cannot carry")
    report["lightCounts"][light_data.type] = report["lightCounts"].get(light_data.type, 0) + 1


# ---- World ----

def describe_world(world):
    if world is None:
        return {"kind": "constant", "value": 0.0, "note": "no world"}
    if not world.use_nodes or world.node_tree is None:
        color = list(world.color)
        return {"kind": "constant", "value": color[0], "color": color, "grey": max(color) - min(color) < 1e-6}
    output_node = next((node for node in world.node_tree.nodes if node.type == "OUTPUT_WORLD" and node.is_active_output), None)
    if output_node is None or not output_node.inputs["Surface"].is_linked:
        return {"kind": "baked", "reason": "no linked world output"}
    background_node = output_node.inputs["Surface"].links[0].from_node
    if background_node.type != "BACKGROUND":
        return {"kind": "baked", "reason": f"output reads a {background_node.type} node"}
    color_socket = background_node.inputs["Color"]
    strength_socket = background_node.inputs["Strength"]
    if color_socket.is_linked or strength_socket.is_linked:
        linked_types = [socket.links[0].from_node.type for socket in (color_socket, strength_socket) if socket.is_linked]
        return {"kind": "baked", "reason": f"background inputs linked to {linked_types}"}
    color = [float(channel) * strength_socket.default_value for channel in color_socket.default_value[:3]]
    return {"kind": "constant", "value": color[0], "color": color, "grey": max(color) - min(color) < 1e-6}


def create_probe_scene(name, world, width, height, samples, render_cycles):
    probe_scene = bpy.data.scenes.new(name)
    probe_scene.render.engine = "CYCLES"
    probe_scene.cycles.device = "CPU"
    probe_scene.cycles.samples = samples
    probe_scene.cycles.use_denoising = False
    probe_scene.cycles.use_adaptive_sampling = False
    probe_scene.render.film_transparent = False
    render_cycles.configure_linear_exr_output(probe_scene, width, height)
    probe_scene.world = world
    return probe_scene


def add_probe_camera(probe_scene, camera_data, location, rotation_euler):
    camera_object = bpy.data.objects.new("probe-camera", camera_data)
    camera_object.location = location
    camera_object.rotation_mode = "XYZ"
    camera_object.rotation_euler = rotation_euler
    probe_scene.collection.objects.link(camera_object)
    probe_scene.camera = camera_object
    return camera_object


def render_probe_scene_to_array(probe_scene, file_stem, render_cycles):
    exr_path = f"{file_stem}.exr"
    probe_scene.render.filepath = exr_path
    bpy.ops.render.render(write_still=True, scene=probe_scene.name)
    width = probe_scene.render.resolution_x
    height = probe_scene.render.resolution_y
    render_cycles.load_exr_into_npy(exr_path, f"{file_stem}.npy", width, height, False)
    return numpy.load(f"{file_stem}.npy")


def render_world_to_hdr(world, hdr_path, width, height, rotation_euler, work_directory, render_cycles):
    probe_scene = create_probe_scene("hdr-bake", world, width, height, 4, render_cycles)
    camera_data = bpy.data.cameras.new("hdr-bake-camera")
    camera_data.type = "PANO"
    if hasattr(camera_data, "panorama_type"):
        camera_data.panorama_type = "EQUIRECTANGULAR"
    else:
        camera_data.cycles.panorama_type = "EQUIRECTANGULAR"
    for attribute_name, attribute_value in (("latitude_min", -math.pi / 2), ("latitude_max", math.pi / 2), ("longitude_min", -math.pi), ("longitude_max", math.pi)):
        if hasattr(camera_data, attribute_name):
            setattr(camera_data, attribute_name, attribute_value)
    add_probe_camera(probe_scene, camera_data, (0.0, 0.0, 0.0), rotation_euler)
    probe_scene.render.image_settings.file_format = "HDR"
    probe_scene.render.image_settings.color_mode = "RGB"
    probe_scene.render.filepath = hdr_path
    bpy.ops.render.render(write_still=True, scene=probe_scene.name)


def probe_view_directions():
    directions = []
    for sign_x in (-1.0, 1.0):
        for sign_y in (-1.0, 1.0):
            for sign_z in (-1.0, 1.0):
                directions.append(Vector((sign_x, sign_y, sign_z * 0.6)).normalized())
    return directions


def render_world_probe_views(world, label, work_directory, render_cycles):
    probe_scene = create_probe_scene(f"probe-{label}", world, PROBE_VIEW_SIZE, PROBE_VIEW_SIZE, PROBE_SAMPLES, render_cycles)
    camera_data = bpy.data.cameras.new(f"probe-camera-{label}")
    camera_data.angle = math.radians(60.0)
    views = []
    for view_index, direction in enumerate(probe_view_directions()):
        rotation = direction.to_track_quat("-Z", "Y").to_euler()
        camera_object = add_probe_camera(probe_scene, camera_data, (0.0, 0.0, 0.0), rotation)
        views.append(render_probe_scene_to_array(probe_scene, os.path.join(work_directory, f"probe-{label}-{view_index}"), render_cycles))
        probe_scene.collection.objects.unlink(camera_object)
    return views


def probe_difference(reference_views, candidate_views):
    errors = [float(numpy.mean(numpy.abs(numpy.log1p(numpy.maximum(a, 0)) - numpy.log1p(numpy.maximum(b, 0))))) for a, b in zip(reference_views, candidate_views)]
    mean_ratio = float(numpy.mean([numpy.mean(b) for b in candidate_views]) / max(float(numpy.mean([numpy.mean(a) for a in reference_views])), 1e-12))
    return float(numpy.mean(errors)), mean_ratio


def bake_world(world, work_directory, final_hdr_path, render_cycles, report):
    """Renders the world to an equirectangular .hdr, choosing the rotation about Z by probing the world from eight directions.

    The bench reads an .hdr through render-cycles.py's world nodes (an Environment Texture turned by -90 degrees about Z). Each
    candidate is rendered, put through those same nodes in a probe scene, and compared with the original world seen from the
    same directions, so the orientation is measured and not assumed."""
    original_views = render_world_probe_views(world, "original", work_directory, render_cycles)
    candidate_results = []
    for rotation_degrees in BAKE_ROTATION_CANDIDATE_DEGREES:
        candidate_path = os.path.join(work_directory, f"world-candidate-{int(rotation_degrees)}.hdr")
        euler = Euler((math.radians(90.0), 0.0, math.radians(rotation_degrees)), "XYZ")
        render_world_to_hdr(world, candidate_path, PROBE_HDR_WIDTH, PROBE_HDR_HEIGHT, euler, work_directory, render_cycles)
        hdr_scene = bpy.data.scenes.new(f"probe-hdr-{int(rotation_degrees)}")
        render_cycles.build_world_shader(hdr_scene, {"type": "hdri", "file": candidate_path, "intensity": 1.0, "radianceLimit": HDR_RADIANCE_LIMIT}, REPOSITORY_ROOT)
        candidate_views = render_world_probe_views(hdr_scene.world, f"hdr{int(rotation_degrees)}", work_directory, render_cycles)
        error, mean_ratio = probe_difference(original_views, candidate_views)
        candidate_results.append({"rotationDegrees": rotation_degrees, "meanLogError": error, "meanRatio": mean_ratio})
        log(f"world candidate {rotation_degrees} degrees: log error {error:.5f}, mean ratio {mean_ratio:.4f}")
    best = min(candidate_results, key=lambda entry: entry["meanLogError"])
    best_euler = Euler((math.radians(90.0), 0.0, math.radians(best["rotationDegrees"])), "XYZ")
    render_world_to_hdr(world, final_hdr_path, HDR_WIDTH, HDR_HEIGHT, best_euler, work_directory, render_cycles)
    report["worldBake"] = {"candidates": candidate_results, "chosenRotationDegrees": best["rotationDegrees"], "hdrWidth": HDR_WIDTH, "hdrHeight": HDR_HEIGHT, "radianceLimit": HDR_RADIANCE_LIMIT}
    return best


# ---- Geometry ----

def modifier_signature(original_object):
    """A text key for the modifier stack; None when a modifier reads another object, so two copies could evaluate differently."""
    entries = []
    for modifier in original_object.modifiers:
        if not modifier.show_viewport:
            continue
        properties = []
        for property_description in modifier.bl_rna.properties:
            identifier = property_description.identifier
            if identifier in IGNORED_MODIFIER_PROPERTIES or property_description.type == "COLLECTION":
                continue
            value = getattr(modifier, identifier)
            if property_description.type == "POINTER":
                if isinstance(value, bpy.types.Object):
                    return None
                properties.append((identifier, getattr(value, "name", None)))
                continue
            if hasattr(value, "__len__") and not isinstance(value, str):
                value = tuple(value)
            properties.append((identifier, value))
        entries.append((modifier.type, tuple(properties)))
    return repr(entries)


def geometry_key(original_object):
    if original_object.type == "MESH":
        signature = modifier_signature(original_object)
        if signature is not None:
            return ("data", original_object.data.name, signature)
    return ("object", original_object.name)


def mesh_to_arrays(evaluated_object):
    mesh = evaluated_object.to_mesh()
    try:
        mesh.calc_loop_triangles()
        triangle_count = len(mesh.loop_triangles)
        if triangle_count == 0:
            return None
        coordinates = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float32)
        mesh.vertices.foreach_get("co", coordinates)
        triangle_vertices = numpy.empty(triangle_count * 3, dtype=numpy.int32)
        mesh.loop_triangles.foreach_get("vertices", triangle_vertices)
        triangle_loops = numpy.empty(triangle_count * 3, dtype=numpy.int32)
        mesh.loop_triangles.foreach_get("loops", triangle_loops)
        corner_normals = numpy.empty(len(mesh.loops) * 3, dtype=numpy.float32)
        mesh.corner_normals.foreach_get("vector", corner_normals)
        positions = coordinates.reshape(-1, 3)[triangle_vertices]
        normals = corner_normals.reshape(-1, 3)[triangle_loops]
        stacked = numpy.concatenate([positions, normals], axis=1)
        unique_rows, inverse = numpy.unique(stacked, axis=0, return_inverse=True)
        return {
            "positions": numpy.ascontiguousarray(unique_rows[:, :3], dtype=numpy.float32),
            "normals": numpy.ascontiguousarray(unique_rows[:, 3:], dtype=numpy.float32),
            "indices": numpy.ascontiguousarray(inverse.reshape(-1), dtype=numpy.uint32),
        }
    finally:
        evaluated_object.to_mesh_clear()


def encode_array(array):
    return {"type": {"float32": "Float32Array", "uint32": "Uint32Array"}[array.dtype.name], "base64": base64.b64encode(array.tobytes()).decode("ascii")}


def collect_scene_content(scene, width, height, report, glass_names):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    environment = {
        "world": True, "fillIntensity": 0, "ambientIntensity": 1, "fogDensity": 0,
        "lightDirection": [0.0, 1.0, 0.0], "keyColor": [0.0, 0.0, 0.0],
        "pointLights": [], "spotLights": [], "areaLights": [],
    }
    geometry_indices = {}
    geometries = []
    parts = []
    skipped = {"hiddenOriginal": 0, "showSelfFalse": 0, "emptyMesh": 0, "otherType": {}, "glassInstance": 0}
    triangle_total = 0
    negative_parts = 0
    ray_visibility_counts = {}
    empty_mesh_names = []
    for instance in depsgraph.object_instances:
        evaluated_object = instance.object
        original_object = evaluated_object.original
        if original_object.hide_render:
            skipped["hiddenOriginal"] += 1
            continue
        if hasattr(instance, "show_self") and not instance.show_self:
            skipped["showSelfFalse"] += 1
            continue
        if original_object.type == "LIGHT":
            add_light_entry(environment, evaluated_object, instance.matrix_world, report)
            continue
        if original_object.type not in MESH_LIKE_OBJECT_TYPES:
            skipped["otherType"][original_object.type] = skipped["otherType"].get(original_object.type, 0) + 1
            continue
        if original_object.name in glass_names:
            skipped["glassInstance"] += 1
            continue
        key = geometry_key(original_object)
        if key not in geometry_indices:
            arrays = mesh_to_arrays(evaluated_object)
            if arrays is None:
                geometry_indices[key] = None
            else:
                geometry_indices[key] = len(geometries)
                geometries.append(arrays)
        geometry_index = geometry_indices[key]
        if geometry_index is None:
            skipped["emptyMesh"] += 1
            empty_mesh_names.append(f"{original_object.name} ({original_object.type})")
            continue
        if instance.matrix_world.determinant() < 0.0:
            negative_parts += 1
        triangle_total += len(geometries[geometry_index]["indices"]) // 3
        name = original_object.name if instance.parent is None else f"{instance.parent.original.name}/{original_object.name}"
        part = {"name": name, "geometry": geometry_index, "matrix": column_major_yup_matrix(instance.matrix_world), "material": 0}
        hidden_rays = {kind: False for kind, attribute in RAY_VISIBILITY_ATTRIBUTES.items() if not getattr(original_object, attribute, True)}
        if hidden_rays:
            part["rayVisibility"] = hidden_rays
            for kind in hidden_rays:
                ray_visibility_counts[kind] = ray_visibility_counts.get(kind, 0) + 1
        parts.append(part)
    report["skipped"] = skipped
    report["partCount"] = len(parts)
    report["geometryCount"] = len(geometries)
    report["uniqueTriangleCount"] = sum(len(entry["indices"]) // 3 for entry in geometries)
    report["uniqueVertexCount"] = sum(len(entry["positions"]) for entry in geometries)
    report["instancedTriangleCount"] = triangle_total
    report["negativeDeterminantParts"] = negative_parts
    exported_names = {part["name"].split("/")[-1] for part in parts}
    report["emptyMeshObjects"] = empty_mesh_names[:40]
    report["renderableObjectsNotExported"] = [f"{obj.name} ({obj.type}, collections {[c.name for c in obj.users_collection][:2]})" for obj in bpy.data.objects if obj.type in MESH_LIKE_OBJECT_TYPES and not obj.hide_render and obj.name not in exported_names and obj.name not in glass_names][:60]
    report["partsWithHiddenRayKinds"] = ray_visibility_counts
    report["shadowCatcherOrHoldoutObjects"] = sum(1 for obj in bpy.data.objects if getattr(obj, "is_shadow_catcher", False) or getattr(obj, "is_holdout", False))
    return environment, geometries, parts


def collect_inspection(scene):
    object_types = {}
    modifier_types = {}
    shared_data = {}
    for scene_object in bpy.data.objects:
        object_types[scene_object.type] = object_types.get(scene_object.type, 0) + 1
        for modifier in scene_object.modifiers:
            modifier_types[modifier.type] = modifier_types.get(modifier.type, 0) + 1
        if scene_object.type == "MESH":
            shared_data[scene_object.data.name] = shared_data.get(scene_object.data.name, 0) + 1
    node_types = {}
    for material in bpy.data.materials:
        for tag in tag_material_node_trees(material):
            node_types[tag] = node_types.get(tag, 0) + 1
    return {
        "blenderVersion": bpy.app.version_string,
        "objectTypes": object_types,
        "modifierTypes": modifier_types,
        "meshDatablocks": len(shared_data),
        "meshDatablocksUsedByMoreThanOneObject": sum(1 for count in shared_data.values() if count > 1),
        "materialCount": len(bpy.data.materials),
        "materialTags": node_types,
        "collectionInstanceEmpties": sum(1 for obj in bpy.data.objects if obj.instance_type == "COLLECTION"),
        "unitScale": scene.unit_settings.scale_length,
        "engine": scene.render.engine,
        "frame": scene.frame_current,
        "motionBlur": scene.render.use_motion_blur,
        "worldNodeTypes": sorted({node.type for node in scene.world.node_tree.nodes}) if scene.world and scene.world.use_nodes else None,
    }


def grey_material_entry():
    return {"tag": "surface", "color": [GREY_ALBEDO] * 3, "metallic": 0, "roughness": 1, "specular": 0, "emission": 0}


def run_export(options):
    started = time.perf_counter()
    scene = bpy.context.scene
    output_directory = options["output"]
    os.makedirs(output_directory, exist_ok=True)
    render_cycles = load_render_cycles_module()
    report = {"inspection": collect_inspection(scene), "lightCounts": {}, "notes": []}
    log("inspection " + json.dumps(report["inspection"]))
    report["raw"] = describe_lights_and_film(scene)
    report["prepare"] = prepare_scene(scene, options["keep_glass"])
    glass_names = set(report["prepare"].pop("glassObjects"))
    log("prepare " + json.dumps(report["prepare"]))
    camera_entry, lens_entry = build_camera_entries(scene, options["width"], options["height"], report)
    environment, geometries, parts = collect_scene_content(scene, options["width"], options["height"], report, glass_names)
    log("content " + json.dumps({key: report[key] for key in ("partCount", "geometryCount", "uniqueTriangleCount", "instancedTriangleCount", "negativeDeterminantParts", "skipped", "lightCounts")}))
    world_description = describe_world(scene.world)
    report["worldDescription"] = world_description
    if world_description["kind"] == "constant" and world_description.get("grey", True):
        world_entry = {"type": "constant", "value": world_description["value"]}
    else:
        relative_hdr_path = "artifacts/classroom/world.hdr"
        absolute_hdr_path = os.path.join(REPOSITORY_ROOT, relative_hdr_path)
        os.makedirs(os.path.dirname(absolute_hdr_path), exist_ok=True)
        work_directory = os.path.join(output_directory, "world-probes")
        os.makedirs(work_directory, exist_ok=True)
        bake_world(scene.world, work_directory, absolute_hdr_path, render_cycles, report)
        world_entry = {"type": "hdri", "file": relative_hdr_path, "intensity": 1.0, "radianceLimit": HDR_RADIANCE_LIMIT}
    description = {
        "id": "classroom",
        "camera": camera_entry,
        "environment": environment,
        "world": world_entry,
        "materials": [grey_material_entry()],
        "images": [],
        "parts": parts,
        "geometries": [{"positions": encode_array(entry["positions"]), "normals": encode_array(entry["normals"]), "indices": encode_array(entry["indices"])} for entry in geometries],
    }
    scene_path = os.path.join(output_directory, "classroom.json")
    with open(scene_path, "w", encoding="utf-8") as handle:
        json.dump(description, handle)
    with open(os.path.join(output_directory, "classroom-lens.json"), "w", encoding="utf-8") as handle:
        json.dump(lens_entry, handle, indent=2)
    report["sceneJsonBytes"] = os.path.getsize(scene_path)
    report["exportSeconds"] = round(time.perf_counter() - started, 2)
    report["environmentSummary"] = {key: (len(value) if isinstance(value, list) and key.endswith("Lights") else value) for key, value in environment.items() if key in ("keyColor", "lightDirection", "sunAngularRadius", "pointLights", "spotLights", "areaLights")}
    with open(os.path.join(output_directory, "classroom-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    log("done " + json.dumps({"sceneJsonBytes": report["sceneJsonBytes"], "exportSeconds": report["exportSeconds"], "environment": report["environmentSummary"], "world": world_entry["type"]}))


def describe_lights_and_film(scene):
    """Raw light, world and film settings, so a brightness gap between the bridge and the original can be traced."""
    lights = []
    for light_object in bpy.data.objects:
        if light_object.type != "LIGHT":
            continue
        light_data = light_object.data
        lights.append({
            "name": light_object.name, "type": light_data.type, "energy": light_data.energy, "exposure": getattr(light_data, "exposure", None),
            "color": list(light_data.color), "radius": getattr(light_data, "shadow_soft_size", None), "hideRender": light_object.hide_render,
            "shape": getattr(light_data, "shape", None), "size": getattr(light_data, "size", None), "sizeY": getattr(light_data, "size_y", None),
            "scale": list(light_object.matrix_world.to_scale()), "library": light_data.library.filepath if light_data.library else None,
            "useShadow": getattr(light_data, "use_shadow", None), "normalize": getattr(light_data, "normalize", None),
            "cyclesSettings": {name: getattr(light_data.cycles, name, None) for name in ("is_portal", "max_bounces", "cast_shadow")} if hasattr(light_data, "cycles") else None,
        })
    world = scene.world
    world_raw = None
    if world is not None and world.use_nodes and world.node_tree is not None:
        world_raw = [{"type": node.type, "inputs": {socket.name: (list(socket.default_value) if hasattr(socket.default_value, "__len__") else socket.default_value) for socket in node.inputs if hasattr(socket, "default_value")}} for node in world.node_tree.nodes]
    return {
        "lights": lights, "worldNodes": world_raw,
        "filmExposure": scene.cycles.film_exposure, "viewExposure": scene.view_settings.exposure, "viewGamma": scene.view_settings.gamma,
        "viewTransform": scene.view_settings.view_transform, "lightTree": getattr(scene.cycles, "use_light_tree", None),
        "samplingThreshold": getattr(scene.cycles, "light_sampling_threshold", None), "maxBounces": scene.cycles.max_bounces,
    }


def apply_reference_variant(scene, variant):
    """Experiments on the original scene: each removes one thing the bridge converts, to see which one the brightness depends on."""
    if variant == "film-reset":
        scene.cycles.film_exposure = 1.0
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
    elif variant == "no-world":
        scene.world = None
    elif variant in ("sun-only", "points-only", "areas-only", "spots-only"):
        keep = {"sun-only": "SUN", "points-only": "POINT", "areas-only": "AREA", "spots-only": "SPOT"}[variant]
        for light_object in bpy.data.objects:
            if light_object.type == "LIGHT" and light_object.data.type != keep:
                hide_object_everywhere(light_object)
        scene.world = None


def run_reference(options):
    scene = bpy.context.scene
    render_cycles = load_render_cycles_module()
    prepare_report = prepare_scene(scene, options["keep_glass"])
    prepare_report.pop("glassObjects")
    log("prepare " + json.dumps(prepare_report))
    log("lights and film " + json.dumps(describe_lights_and_film(scene), default=str))
    apply_reference_variant(scene, options["variant"])
    render_options = {
        "samples": options["samples"], "seed": options["seed"], "bounces": options["bounces"], "transparent_bounces": None,
        "filter_type": "box", "filter_width": 1.0, "denoise": "none",
    }
    used_devices = render_cycles.configure_cycles_parity(scene, render_options)
    render_cycles.configure_linear_exr_output(scene, options["width"], options["height"])
    scene.render.use_motion_blur = False
    scene.render.film_transparent = False
    if options["pinhole"]:
        scene.camera.data.dof.use_dof = False
    render_cycles.apply_grey_diffuse_override(scene)
    exr_path = f"{options['output']}.exr"
    timing = render_cycles.execute_timed_cycles_render(scene, exr_path)
    render_cycles.load_exr_into_npy(exr_path, f"{options['output']}.npy", options["width"], options["height"], False)
    if options["z_depth"]:
        render_cycles.render_camera_z_depth(scene, options["output"], options["width"], options["height"], options["samples"])
    report = {"engine": "cycles-optix", "mode": "original-blend", "devices": used_devices, "samples": options["samples"], "seed": options["seed"], "pinhole": options["pinhole"], "renderCallSeconds": round(timing["render_call_seconds"], 3), "prepare": prepare_report}
    with open(f"{options['output']}.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    log("reference done " + json.dumps({"renderCallSeconds": report["renderCallSeconds"]}))


def main():
    options = parse_arguments()
    if options["mode"] == "export":
        run_export(options)
    else:
        run_reference(options)


main()
