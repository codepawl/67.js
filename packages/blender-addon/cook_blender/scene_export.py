"""Blender scene to the Cook scene description (the JSON that bench/cycles-parity/trace-native.mjs reads).

The functions up to `encode_array` are shared with bench/cycles-parity/classroom_bridge.py, so the Classroom parity bridge and the
render add-on read a Blender scene the same way. `export_scene` is the add-on entry: it reads an evaluated depsgraph.
"""
import base64
import math
import os

import bpy
import numpy
from mathutils import Matrix, Vector

from . import blender_conversions as conversions
from .material_export import MaterialExporter

UNSUPPORTED_OBJECT_TYPES = ("CURVES", "POINTCLOUD", "VOLUME", "GREASEPENCIL", "GPENCIL")
MESH_LIKE_OBJECT_TYPES = ("MESH", "CURVE", "SURFACE", "FONT", "META")
IGNORED_MODIFIER_PROPERTIES = {"rna_type", "persistent_uid", "name", "show_expanded", "is_active", "is_override_data", "use_pin_to_last", "execution_time"}
RAY_VISIBILITY_ATTRIBUTES = {
    "camera": "visible_camera", "diffuse": "visible_diffuse", "glossy": "visible_glossy",
    "transmission": "visible_transmission", "volumeScatter": "visible_volume_scatter", "shadow": "visible_shadow",
}
ROLL_NOTE_THRESHOLD_DEGREES = 0.5


# ---- Coordinates and camera ----

def to_yup(vector):
    return conversions.to_yup(vector)


def column_major_yup_matrix(blender_matrix):
    return conversions.column_major_yup_matrix([list(row) for row in blender_matrix])


def effective_horizontal_sensor_width(camera_data, width, height):
    return conversions.effective_horizontal_sensor_width(camera_data.sensor_fit, camera_data.sensor_width, camera_data.sensor_height, width, height)


def vertical_fov_degrees(camera_data, width, height):
    return conversions.vertical_fov_degrees(effective_horizontal_sensor_width(camera_data, width, height), camera_data.lens, width, height)


def build_camera_entries(scene, width, height, report, camera_object=None, honor_roll=False):
    """Returns (camera entry, lens entry). `honor_roll` keeps the camera's own up vector; the Classroom bridge levels it."""
    camera_object = camera_object or scene.camera
    camera_data = camera_object.data
    if camera_data.type != "PERSP":
        raise ValueError(f"Camera type {camera_data.type} is not supported: Cook draws perspective cameras only. Set the camera Type to Perspective.")
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
    up_vector = camera_up if honor_roll else level_up
    camera_entry = {
        "eye": to_yup(eye),
        "target": to_yup(eye + forward),
        "up": to_yup(up_vector),
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


# ---- Lights ----

def light_color_with_exposure(light_data):
    exposure_scale = 2.0 ** getattr(light_data, "exposure", 0.0)
    return [float(channel) for channel in light_data.color], light_data.energy * exposure_scale


def add_light_entry(environment, light_object, light_matrix, report):
    light_data = light_object.data
    color, energy = light_color_with_exposure(light_data)
    if energy <= 0.0:
        return
    for note in conversions.light_feature_notes(
        light_object.name, light_data.type, getattr(light_data, "use_temperature", False), getattr(light_data, "use_shadow", True),
        getattr(light_data, "diffuse_factor", 1.0), getattr(light_data, "specular_factor", 1.0), bool(getattr(light_data, "node_tree", None)),
    ):
        if note not in report["notes"]:
            report["notes"].append(note)
    position = to_yup(light_matrix.translation)
    emission_direction = to_yup((light_matrix.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized())
    if light_data.type == "SUN":
        if report["lightCounts"].get("SUN", 0) > 0:
            report["notes"].append(f"sun {light_object.name} is ignored: Cook takes one sun per scene")
            return
        environment.update(conversions.sun_environment_fields(color, energy, emission_direction, light_data.angle))
    elif light_data.type == "POINT":
        environment["pointLights"].append(conversions.point_light_entry(position, color, energy, light_data.shadow_soft_size))
    elif light_data.type == "SPOT":
        environment["spotLights"].append(conversions.spot_light_entry(position, color, energy, light_data.shadow_soft_size, emission_direction, light_data.spot_size, light_data.spot_blend))
    elif light_data.type == "AREA":
        scale = light_matrix.to_scale()
        local_up = to_yup((light_matrix.to_3x3() @ Vector((0.0, 1.0, 0.0))).normalized())
        environment["areaLights"].append(conversions.area_light_entry(
            position, color, energy, emission_direction, local_up, light_data.shape, light_data.size, light_data.size_y, scale.x, scale.y, light_data.spread,
        ))
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


def environment_image_rows(image):
    """The image as linear (height, width, 3) floats, first row at the bottom, the order Blender stores it."""
    width, height = image.size[0], image.size[1]
    flat = numpy.empty(width * height * 4, dtype=numpy.float32)
    image.pixels.foreach_get(flat)
    rgb = flat.reshape(height, width, 4)[..., :3]
    if not image.is_float and image.colorspace_settings.name.lower().startswith("srgb"):
        rgb = numpy.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return rgb


def export_world(world, work_directory, report):
    """Returns the `world` entry: a constant colour, or an HDRI written to work_directory/world.hdr."""
    description = describe_world(world)
    report["worldDescription"] = description
    if description["kind"] == "constant":
        entry = {"type": "constant", "value": description["value"]}
        if "color" in description:
            entry["color"] = description["color"]
        return entry
    hdri_entry = export_environment_texture(world, work_directory, report)
    if hdri_entry is not None:
        return hdri_entry
    background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
    fallback = [0.05, 0.05, 0.05] if background is None else [float(channel) * background.inputs["Strength"].default_value for channel in background.inputs["Color"].default_value[:3]]
    report["notes"].append(f"world is not a constant colour or an environment image ({description.get('reason')}); its constant colour {[round(channel, 3) for channel in fallback]} is used")
    return {"type": "constant", "value": fallback[0], "color": fallback}


def export_environment_texture(world, work_directory, report):
    output_node = next((node for node in world.node_tree.nodes if node.type == "OUTPUT_WORLD" and node.is_active_output), None)
    if output_node is None or not output_node.inputs["Surface"].is_linked:
        return None
    background_node = output_node.inputs["Surface"].links[0].from_node
    if background_node.type != "BACKGROUND":
        return None
    strength_socket = background_node.inputs["Strength"]
    color_socket = background_node.inputs["Color"]
    if strength_socket.is_linked or not color_socket.is_linked:
        return None
    environment_node = color_socket.links[0].from_node
    if environment_node.type != "TEX_ENVIRONMENT" or environment_node.image is None or environment_node.projection != "EQUIRECTANGULAR":
        return None
    image = environment_node.image
    if image.size[0] == 0:
        report["notes"].append(f"world image {image.name} has no pixels (missing file?)")
        return None
    if environment_node.inputs["Vector"].is_linked:
        report["notes"].append("the world's environment texture has a Vector input (a rotation, for example); Cook reads it unrotated")
    rows = environment_image_rows(image) * float(strength_socket.default_value)
    rows = numpy.minimum(rows, conversions.HDR_RADIANCE_LIMIT)
    os.makedirs(work_directory, exist_ok=True)
    hdr_path = os.path.join(work_directory, "world.hdr")
    conversions.write_radiance_hdr(hdr_path, conversions.blender_environment_to_cook_rows(rows))
    report["worldImage"] = {"name": image.name, "width": image.size[0], "height": image.size[1]}
    return {"type": "hdri", "file": hdr_path, "intensity": 1.0, "radianceLimit": conversions.HDR_RADIANCE_LIMIT}


# ---- Geometry ----

def geometry_nodes_input_values(modifier):
    """The custom properties of a modifier (Geometry Nodes inputs), as a tuple; None when one names another object or collection."""
    values = []
    for key in modifier.keys():
        value = modifier[key]
        if isinstance(value, (bpy.types.Object, bpy.types.Collection)):
            return None
        if hasattr(value, "to_list"):
            value = tuple(value.to_list())
        elif hasattr(value, "to_dict"):
            value = repr(value.to_dict())
        values.append((key, value))
    return tuple(values)


def modifier_signature(original_object, use_render_flags=False):
    """A text key for the modifier stack; None when a modifier reads another object, so two copies could evaluate differently."""
    entries = []
    for modifier in original_object.modifiers:
        if not (modifier.show_render if use_render_flags else modifier.show_viewport):
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
        input_values = geometry_nodes_input_values(modifier)
        if input_values is None:
            return None
        entries.append((modifier.type, tuple(properties), input_values))
    return repr(entries)


def geometry_key(original_object, use_render_flags=False):
    if original_object.type == "MESH":
        signature = modifier_signature(original_object, use_render_flags)
        if signature is not None:
            return ("data", original_object.data.name, signature)
    return ("object", original_object.name)


def corner_uv_values(mesh):
    """(corner count, 2) UVs of the active UV map with V flipped to start at the top, or None without a UV map."""
    uv_layer = mesh.uv_layers.active_render or mesh.uv_layers.active
    if uv_layer is None:
        return None
    corner_uvs = numpy.empty(len(mesh.loops) * 2, dtype=numpy.float32)
    mesh.attributes[uv_layer.name].data.foreach_get("vector", corner_uvs)
    corner_uvs = corner_uvs.reshape(-1, 2)
    corner_uvs[:, 1] = 1.0 - corner_uvs[:, 1]
    return corner_uvs


def unique_vertex_arrays(stacked_rows, include_uvs):
    unique_rows, inverse = numpy.unique(stacked_rows, axis=0, return_inverse=True)
    arrays = {
        "positions": numpy.ascontiguousarray(unique_rows[:, :3], dtype=numpy.float32),
        "normals": numpy.ascontiguousarray(unique_rows[:, 3:6], dtype=numpy.float32),
        "indices": numpy.ascontiguousarray(inverse.reshape(-1), dtype=numpy.uint32),
    }
    if include_uvs:
        arrays["uvs"] = numpy.ascontiguousarray(unique_rows[:, 6:8], dtype=numpy.float32)
    return arrays


def mesh_to_triangle_groups(evaluated_object, include_uvs=False, split_by_material=False):
    """Welded vertex arrays of an evaluated object, as {material slot: arrays}; slot 0 holds everything unless split_by_material."""
    mesh = evaluated_object.to_mesh()
    if mesh is None:
        # Only the basis metaball of a family converts; the others give nothing.
        return {}
    try:
        mesh.calc_loop_triangles()
        triangle_count = len(mesh.loop_triangles)
        if triangle_count == 0:
            return {}
        coordinates = numpy.empty(len(mesh.vertices) * 3, dtype=numpy.float32)
        mesh.vertices.foreach_get("co", coordinates)
        triangle_vertices = numpy.empty(triangle_count * 3, dtype=numpy.int32)
        mesh.loop_triangles.foreach_get("vertices", triangle_vertices)
        triangle_loops = numpy.empty(triangle_count * 3, dtype=numpy.int32)
        mesh.loop_triangles.foreach_get("loops", triangle_loops)
        corner_normals = numpy.empty(len(mesh.loops) * 3, dtype=numpy.float32)
        mesh.corner_normals.foreach_get("vector", corner_normals)
        columns = [coordinates.reshape(-1, 3)[triangle_vertices], corner_normals.reshape(-1, 3)[triangle_loops]]
        corner_uvs = corner_uv_values(mesh) if include_uvs else None
        has_uvs = corner_uvs is not None
        if has_uvs:
            columns.append(corner_uvs[triangle_loops])
        stacked = numpy.concatenate(columns, axis=1)
        if not split_by_material:
            return {0: unique_vertex_arrays(stacked, has_uvs)}
        material_indices = numpy.empty(triangle_count, dtype=numpy.int32)
        mesh.loop_triangles.foreach_get("material_index", material_indices)
        per_triangle = stacked.reshape(triangle_count, 3, -1)
        return {
            int(slot): unique_vertex_arrays(per_triangle[material_indices == slot].reshape(-1, stacked.shape[1]), has_uvs)
            for slot in numpy.unique(material_indices)
        }
    finally:
        evaluated_object.to_mesh_clear()


def mesh_to_arrays(evaluated_object):
    return mesh_to_triangle_groups(evaluated_object).get(0)


def encode_array(array):
    return {"type": {"float32": "Float32Array", "uint32": "Uint32Array"}[array.dtype.name], "base64": base64.b64encode(array.tobytes()).decode("ascii")}


def encode_geometry(arrays):
    encoded = {name: encode_array(arrays[name]) for name in ("positions", "normals", "indices")}
    if "uvs" in arrays:
        encoded["uvs"] = encode_array(arrays["uvs"])
    return encoded


# ---- The add-on entry ----

def new_environment():
    return {
        "world": True, "fillIntensity": 0, "ambientIntensity": 1, "fogDensity": 0,
        "lightDirection": [0.0, 1.0, 0.0], "keyColor": [0.0, 0.0, 0.0],
        "pointLights": [], "spotLights": [], "areaLights": [],
    }


def slot_material(evaluated_object, slot):
    """The material of a face slot; a slot past the last one uses the last slot, as Blender does."""
    slot_count = len(evaluated_object.material_slots)
    if slot_count == 0:
        return None
    return evaluated_object.material_slots[max(0, min(slot, slot_count - 1))].material


def collect_parts(depsgraph, materials, report):
    geometries = []
    geometry_indices = {}
    parts = []
    environment = new_environment()
    for instance in depsgraph.object_instances:
        evaluated_object = instance.object
        original_object = evaluated_object.original
        if original_object.hide_render or not instance.show_self:
            continue
        if original_object.type == "LIGHT":
            add_light_entry(environment, evaluated_object, instance.matrix_world, report)
            continue
        if getattr(original_object, "is_holdout", False) or getattr(original_object, "is_shadow_catcher", False):
            report["notes"].append(f"object {original_object.name} is a holdout or shadow catcher; Cook renders it as an ordinary object")
        if original_object.type in UNSUPPORTED_OBJECT_TYPES:
            report["unsupportedObjects"][original_object.type] = report["unsupportedObjects"].get(original_object.type, 0) + 1
            continue
        if original_object.type not in MESH_LIKE_OBJECT_TYPES:
            continue
        key = geometry_key(original_object, use_render_flags=True)
        if instance.is_instance and evaluated_object.type == "MESH":
            # Geometry Nodes instances share one original (their host); the instanced mesh itself tells them apart.
            evaluated_data = evaluated_object.data
            key = key + ("instance", evaluated_data.name, len(evaluated_data.vertices), len(evaluated_data.polygons))
        if key not in geometry_indices:
            groups = mesh_to_triangle_groups(evaluated_object, include_uvs=True, split_by_material=True)
            geometry_indices[key] = {}
            for slot, arrays in groups.items():
                geometry_indices[key][slot] = len(geometries)
                geometries.append(arrays)
        for slot, geometry_index in geometry_indices[key].items():
            part = {
                "name": original_object.name if instance.parent is None else f"{instance.parent.original.name}/{original_object.name}",
                "geometry": geometry_index,
                "matrix": column_major_yup_matrix(instance.matrix_world),
                "material": materials.index_for(slot_material(evaluated_object, slot)),
            }
            hidden_rays = {kind: False for kind, attribute in RAY_VISIBILITY_ATTRIBUTES.items() if not getattr(original_object, attribute, True)}
            if hidden_rays:
                part["rayVisibility"] = hidden_rays
            parts.append(part)
    return environment, geometries, parts


def export_scene(depsgraph, width, height, work_directory):
    """Reads the evaluated scene. Returns (description, lens entry, report); `report` lists everything approximated or left out."""
    scene = depsgraph.scene
    report = {"lightCounts": {}, "notes": [], "unsupportedObjects": {}}
    if scene.camera is None:
        raise ValueError("The scene has no active camera. Set one in Scene properties > Camera.")
    camera_object = scene.camera.evaluated_get(depsgraph)
    camera_entry, lens_entry = build_camera_entries(scene, width, height, report, camera_object=camera_object, honor_roll=True)
    if camera_object.data.shift_x or camera_object.data.shift_y:
        report["notes"].append("camera lens shift is ignored")
    if scene.render.film_transparent:
        report["notes"].append("Film > Transparent is on; Cook renders an opaque background and writes alpha 1")
    if scene.render.pixel_aspect_x != scene.render.pixel_aspect_y:
        report["notes"].append("the pixel aspect is not 1:1; Cook renders square pixels")
    materials = MaterialExporter()
    environment, geometries, parts = collect_parts(depsgraph, materials, report)
    if not parts:
        raise ValueError("The scene has no visible mesh to render. Check that objects are enabled for rendering (the camera icon in the Outliner).")
    world_entry = export_world(scene.world, work_directory, report)
    for object_type, count in report["unsupportedObjects"].items():
        report["notes"].append(f"{count} {object_type} object(s) are not rendered: Cook draws triangle meshes only in this release")
    report["partCount"] = len(parts)
    report["geometryCount"] = len(geometries)
    report["uniqueTriangleCount"] = sum(len(arrays["indices"]) // 3 for arrays in geometries)
    report["materialCount"] = len(materials.entries)
    report["materialNotes"] = materials.notes
    description = {
        "id": scene.name,
        "camera": camera_entry,
        "environment": environment,
        "world": world_entry,
        "materials": materials.entries,
        "images": materials.images,
        "parts": parts,
        "geometries": [encode_geometry(arrays) for arrays in geometries],
    }
    return description, lens_entry, report
