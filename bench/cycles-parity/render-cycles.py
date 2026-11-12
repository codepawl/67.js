"""Render an exported 67js scene JSON in Blender Cycles OptiX with matched parity settings."""
import base64
import json
import math
import os
import re
import sys
import time

import bpy
import numpy
from mathutils import Matrix, Vector

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WATTS_PER_POINT_INTENSITY = 4.0 * math.pi
WATTS_PER_AREA_INTENSITY = math.pi
SUN_ANGULAR_DIAMETER = math.radians(1.0)
ENVIRONMENT_ROTATION_Z = -math.pi / 2.0
PART_ID_STEPS = 64
# A part may carry rayVisibility: { shadow: false, ... } for the ray kinds it is hidden from (Cook reads the same field).
RAY_VISIBILITY_ATTRIBUTES = {
    "camera": "visible_camera", "diffuse": "visible_diffuse", "glossy": "visible_glossy",
    "transmission": "visible_transmission", "volumeScatter": "visible_volume_scatter", "shadow": "visible_shadow",
}

# Set by --soft-falloff. Blender 4 and later build a point or spot light with a radius as an oriented disk while Light.use_soft_falloff
# is on (the default) and as a sphere while it is off. Cook draws the sphere unless a light carries `softFalloff: true`, so without the flag
# each light follows its own `softFalloff` field and a light without one is a sphere. `--soft-falloff default|on|off` overrides every light
# (default keeps the Blender default, represented here by None).
SOFT_FALLOFF_FROM_SCENE = "scene"
soft_falloff_setting = SOFT_FALLOFF_FROM_SCENE
Y_UP_TO_Z_UP = Matrix((
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 0.0, -1.0, 0.0),
    (0.0, 1.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
))
NUMPY_DTYPES = {
    "Float32Array": numpy.float32,
    "Uint32Array": numpy.uint32,
    "Uint16Array": numpy.uint16,
    "Uint8Array": numpy.uint8,
    "Uint8ClampedArray": numpy.uint8,
}
PEAK_MEMORY_PATTERN = re.compile(r"(?:Peak|Mem)[:\s]+([0-9.]+)\s*([KMGT]?)(?:i?B)?", re.IGNORECASE)


def read_flag_value(argument_list, flag_name, fallback_value):
    if flag_name not in argument_list:
        return fallback_value
    flag_index = argument_list.index(flag_name)
    if flag_index + 1 >= len(argument_list):
        raise ValueError(f"Flag {flag_name} requires a value.")
    return argument_list[flag_index + 1]


PIXEL_FILTER_TYPES = {"box": "BOX", "gaussian": "GAUSSIAN", "blackman-harris": "BLACKMAN_HARRIS"}
# Keep in step with GREY_DIFFUSE_MATERIAL in grey-diffuse-override.mjs: both renderers must shade the same thing.
GREY_DIFFUSE_ENTRY = {"color": [0.8, 0.8, 0.8], "metallic": 0.0, "roughness": 1.0, "specular": 0.0}
DEFAULT_DEPTH_SAMPLES = 64


SOFT_FALLOFF_VALUES = {"default": None, "on": True, "off": False}


def read_soft_falloff(argument_list):
    if "--soft-falloff" not in argument_list:
        return SOFT_FALLOFF_FROM_SCENE
    value = read_flag_value(argument_list, "--soft-falloff", "off")
    if value not in SOFT_FALLOFF_VALUES:
        raise ValueError(f"--soft-falloff must be default, on or off, got {value!r}.")
    return SOFT_FALLOFF_VALUES[value]


def parse_cli_arguments():
    if "--" not in sys.argv:
        raise ValueError("Pass script arguments after '--': <sceneJsonPath> <outputPrefix> [options].")
    argument_list = sys.argv[sys.argv.index("--") + 1:]
    if len(argument_list) < 2 or argument_list[0].startswith("--") or argument_list[1].startswith("--"):
        raise ValueError("Usage: blender -b --factory-startup --python bench/cycles-parity/render-cycles.py -- <sceneJsonPath> <outputPrefix> [--samples 256] [--bounces 8] [--transparent-bounces 8] [--seed 1] [--width 960] [--height 540] [--filter-type box|gaussian|blackman-harris] [--filter-width 1.0] [--keep-exr] [--part-ids] [--grey-diffuse] [--soft-falloff default|on|off (default: each light's softFalloff field, off when absent)] [--z-depth] [--depth-samples 64] [--denoise none|oidn-gpu|oidn-cpu] [--f-stop 2.8 [--focus-distance m] [--aperture-blades 0|3..64] [--aperture-rotation degrees] [--sensor-width 36]]")
    return {
        "scene_json_path": os.path.abspath(argument_list[0]),
        "output_prefix": os.path.abspath(argument_list[1]),
        "samples": int(read_flag_value(argument_list, "--samples", "256")),
        "bounces": int(read_flag_value(argument_list, "--bounces", "8")),
        # Transparent Max Bounces on its own; absent means the same value as --bounces.
        "transparent_bounces": (
            int(read_flag_value(argument_list, "--transparent-bounces", "-1"))
            if "--transparent-bounces" in argument_list else None
        ),
        "seed": int(read_flag_value(argument_list, "--seed", "1")),
        "width": int(read_flag_value(argument_list, "--width", "960")),
        "height": int(read_flag_value(argument_list, "--height", "540")),
        "filter_type": read_flag_value(argument_list, "--filter-type", "box"),
        "filter_width": float(read_flag_value(argument_list, "--filter-width", "1.0")),
        "keep_exr": "--keep-exr" in argument_list,
        "part_ids": "--part-ids" in argument_list,
        "grey_diffuse": "--grey-diffuse" in argument_list,
        "z_depth": "--z-depth" in argument_list,
        "depth_samples": int(read_flag_value(argument_list, "--depth-samples", str(DEFAULT_DEPTH_SAMPLES))),
        "denoise": read_flag_value(argument_list, "--denoise", "none"),
        "f_stop": float(read_flag_value(argument_list, "--f-stop", "0")) if "--f-stop" in argument_list else None,
        "focus_distance": float(read_flag_value(argument_list, "--focus-distance", "0")) if "--focus-distance" in argument_list else None,
        "aperture_blades": int(read_flag_value(argument_list, "--aperture-blades", "0")),
        "aperture_rotation": float(read_flag_value(argument_list, "--aperture-rotation", "0")),
        "sensor_width": float(read_flag_value(argument_list, "--sensor-width", "36")),
        "soft_falloff": read_soft_falloff(argument_list),
    }


def resolve_lens_options(options, camera_entry):
    """Depth-of-field settings from --f-stop and its companions, or None for a pinhole (the default).

    Without --focus-distance the focus is the eye-to-target distance, as in createCamera.
    """
    if options["f_stop"] is None:
        stray_flags = [name for name in ("--focus-distance", "--aperture-blades", "--aperture-rotation", "--sensor-width") if name in sys.argv]
        if stray_flags:
            raise ValueError(f"Option {stray_flags[0]} needs --f-stop: pass the f-stop that turns on depth of field, such as --f-stop 2.8.")
        return None
    if options["f_stop"] <= 0:
        raise ValueError(f"--f-stop must be above 0, got {options['f_stop']}.")
    if options["aperture_blades"] != 0 and not 3 <= options["aperture_blades"] <= 64:
        raise ValueError(f"--aperture-blades must be 0 (a round aperture) or from 3 to 64, got {options['aperture_blades']}.")
    focus_distance = options["focus_distance"]
    if focus_distance is None:
        focus_distance = math.dist(camera_entry["eye"], camera_entry["target"])
    return {
        "f_stop": options["f_stop"],
        "focus_distance": focus_distance,
        "aperture_blades": options["aperture_blades"],
        "aperture_rotation": options["aperture_rotation"],
        "sensor_width": options["sensor_width"],
    }


def decode_typed_array(encoded_entry):
    if encoded_entry is None:
        return None
    raw_bytes = base64.b64decode(encoded_entry["base64"])
    dtype = NUMPY_DTYPES[encoded_entry["type"]]
    return numpy.frombuffer(raw_bytes, dtype=dtype)


def convert_position_to_blender(position):
    return (position[0], -position[2], position[1])


def set_linear_rgba_socket(socket, rgb_color):
    socket.default_value = (rgb_color[0], rgb_color[1], rgb_color[2], 1.0)


def build_blender_mesh(mesh_name, geometry_entry):
    positions = decode_typed_array(geometry_entry["positions"]).reshape(-1, 3)
    normals = decode_typed_array(geometry_entry["normals"]).reshape(-1, 3)
    triangles = decode_typed_array(geometry_entry["indices"]).reshape(-1, 3)
    degenerate_mask = (triangles[:, 0] == triangles[:, 1]) | (triangles[:, 1] == triangles[:, 2]) | (triangles[:, 0] == triangles[:, 2])
    valid_triangles = triangles[~degenerate_mask]
    mesh = bpy.data.meshes.new(mesh_name)
    mesh.from_pydata(positions.tolist(), [], valid_triangles.tolist())
    mesh.validate()
    mesh.normals_split_custom_set_from_vertices(normals.tolist())
    uv_values = decode_typed_array(geometry_entry.get("uvs"))
    if uv_values is not None:
        uv_pairs = uv_values.reshape(-1, 2)
        uv_layer = mesh.uv_layers.new(name="UVMap")
        corner_uvs = uv_pairs[valid_triangles.reshape(-1)].copy()
        corner_uvs[:, 1] = 1.0 - corner_uvs[:, 1]
        uv_layer.data.foreach_set("uv", corner_uvs.reshape(-1))
    vertex_colors = decode_typed_array(geometry_entry.get("colors"))
    if vertex_colors is not None:
        color_attribute = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        rgb_values = vertex_colors.reshape(-1, 3)
        alpha_column = numpy.ones((len(rgb_values), 1), dtype=numpy.float32)
        rgba_values = numpy.concatenate([rgb_values, alpha_column], axis=1)
        color_attribute.data.foreach_set("color", rgba_values.reshape(-1))
    mesh.update()
    return mesh


def unpack_shared_image(image_name, texture_descriptor, image_entries, built_images):
    image_identifier = (texture_descriptor["image"]["imageId"], texture_descriptor.get("colorSpace", "srgb"))
    if image_identifier in built_images:
        return built_images[image_identifier]
    source_entry = image_entries[image_identifier[0]]
    raw_pixels = decode_typed_array(source_entry["data"])
    width = source_entry["width"]
    height = source_entry["height"]
    blender_image = bpy.data.images.new(image_name, width, height, alpha=True)
    if image_identifier[1] == "linear":
        # Set before the pixels: changing the colour space of an image that holds pixels reloads it and drops them.
        blender_image.colorspace_settings.name = "Non-Color"
    flipped_pixels = raw_pixels.reshape(height, width, 4)[::-1].astype(numpy.float32) / 255.0
    blender_image.pixels.foreach_set(flipped_pixels.reshape(-1))
    blender_image.pack()
    built_images[image_identifier] = blender_image
    return blender_image


def connect_base_color_texture(material, principled_node, material_entry, has_vertex_colors, image_entries, built_images):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    texture_node = nodes.new("ShaderNodeTexImage")
    texture_node.image = unpack_shared_image(f"{material.name}-map", material_entry["map"], image_entries, built_images)
    multiply_node = nodes.new("ShaderNodeMixRGB")
    multiply_node.blend_type = "MULTIPLY"
    multiply_node.inputs[0].default_value = 1.0
    set_linear_rgba_socket(multiply_node.inputs[2], material_entry["color"])
    links.new(texture_node.outputs["Color"], multiply_node.inputs[1])
    if has_vertex_colors:
        vertex_color_node = nodes.new("ShaderNodeVertexColor")
        vertex_color_node.layer_name = "Col"
        vertex_multiply_node = nodes.new("ShaderNodeMixRGB")
        vertex_multiply_node.blend_type = "MULTIPLY"
        vertex_multiply_node.inputs[0].default_value = 1.0
        links.new(multiply_node.outputs["Color"], vertex_multiply_node.inputs[1])
        links.new(vertex_color_node.outputs["Color"], vertex_multiply_node.inputs[2])
        links.new(vertex_multiply_node.outputs["Color"], principled_node.inputs["Base Color"])
    else:
        links.new(multiply_node.outputs["Color"], principled_node.inputs["Base Color"])
    if material_entry.get("alphaMode") == "mask":
        cutoff_node = nodes.new("ShaderNodeMath")
        cutoff_node.operation = "GREATER_THAN"
        cutoff_node.inputs[1].default_value = material_entry.get("alphaCutoff", 0.5)
        links.new(texture_node.outputs["Alpha"], cutoff_node.inputs[0])
        links.new(cutoff_node.outputs[0], principled_node.inputs["Alpha"])


def connect_vertex_colors(material, principled_node, material_entry):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    vertex_color_node = nodes.new("ShaderNodeVertexColor")
    vertex_color_node.layer_name = "Col"
    multiply_node = nodes.new("ShaderNodeMixRGB")
    multiply_node.blend_type = "MULTIPLY"
    multiply_node.inputs[0].default_value = 1.0
    set_linear_rgba_socket(multiply_node.inputs[2], material_entry["color"])
    links.new(vertex_color_node.outputs["Color"], multiply_node.inputs[1])
    links.new(multiply_node.outputs["Color"], principled_node.inputs["Base Color"])


def connect_emissive_map(material, principled_node, material_entry, emission_color, image_entries, built_images):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    texture_node = nodes.new("ShaderNodeTexImage")
    texture_node.image = unpack_shared_image(f"{material.name}-emissive", material_entry["emissiveMap"], image_entries, built_images)
    multiply_node = nodes.new("ShaderNodeMixRGB")
    multiply_node.blend_type = "MULTIPLY"
    multiply_node.inputs[0].default_value = 1.0
    set_linear_rgba_socket(multiply_node.inputs[2], emission_color)
    links.new(texture_node.outputs["Color"], multiply_node.inputs[1])
    links.new(multiply_node.outputs["Color"], principled_node.inputs["Emission Color"])


def configure_anisotropy(principled_node, material_entry):
    strength = material_entry.get("anisotropy", 0.0)
    if strength <= 0.0:
        return
    alpha = material_entry.get("roughness", 0.5) ** 2
    alpha_tangent = alpha + (1.0 - alpha) * (strength ** 2)
    principled_node.inputs["Anisotropic"].default_value = min((1.0 - alpha / alpha_tangent) / 0.9, 1.0)
    principled_node.inputs["Roughness"].default_value = (alpha * alpha_tangent) ** 0.25
    principled_node.inputs["Anisotropic Rotation"].default_value = material_entry.get("anisotropyRotation", 0.0) / (2.0 * math.pi)
    node_tree = principled_node.id_data
    tangent_node = node_tree.nodes.new("ShaderNodeTangent")
    tangent_node.direction_type = "UV_MAP"
    tangent_node.uv_map = "UVMap"
    node_tree.links.new(tangent_node.outputs["Tangent"], principled_node.inputs["Tangent"])


def configure_thin_film(principled_node, material_entry):
    if material_entry.get("iridescence", 0.0) <= 0.0:
        return
    principled_node.inputs["Thin Film Thickness"].default_value = material_entry.get("iridescenceThickness", 400.0)
    principled_node.inputs["Thin Film IOR"].default_value = material_entry.get("iridescenceIor", 1.3)


def configure_subsurface(principled_node, material_entry):
    subsurface_block = material_entry.get("subsurface")
    if not subsurface_block or subsurface_block.get("weight", 0.0) <= 0.0:
        return
    principled_node.subsurface_method = "RANDOM_WALK"
    principled_node.inputs["Subsurface Weight"].default_value = subsurface_block["weight"]
    principled_node.inputs["Subsurface Radius"].default_value = subsurface_block.get("radius", [1.0, 0.2, 0.1])
    principled_node.inputs["Subsurface Scale"].default_value = subsurface_block.get("scale", 0.05)


def configure_principled_layers(material, principled_node, material_entry):
    principled_node.inputs["Coat Weight"].default_value = material_entry.get("clearcoat", 0.0)
    principled_node.inputs["Coat Roughness"].default_value = material_entry.get("clearcoatRoughness", 0.0)
    default_transmission = principled_node.inputs["Transmission Weight"].default_value
    principled_node.inputs["Transmission Weight"].default_value = material_entry.get("transmission", default_transmission)
    default_ior = principled_node.inputs["IOR"].default_value
    principled_node.inputs["IOR"].default_value = material_entry.get("ior", default_ior)
    sheen_color = material_entry.get("sheenColor", [0.0, 0.0, 0.0])
    if any(sheen_color):
        principled_node.inputs["Sheen Weight"].default_value = 1.0
        set_linear_rgba_socket(principled_node.inputs["Sheen Tint"], sheen_color)
        principled_node.inputs["Sheen Roughness"].default_value = material_entry.get("sheenRoughness", 0.0)
    principled_node.inputs["Specular IOR Level"].default_value = 0.5 * material_entry.get("specular", 1.0)
    set_linear_rgba_socket(principled_node.inputs["Specular Tint"], material_entry.get("specularColor", [1.0, 1.0, 1.0]))
    configure_anisotropy(principled_node, material_entry)
    configure_thin_film(principled_node, material_entry)
    configure_subsurface(principled_node, material_entry)
    attenuation_distance = material_entry.get("attenuationDistance")
    if attenuation_distance:
        absorption_node = material.node_tree.nodes.new("ShaderNodeVolumeAbsorption")
        attenuation_color = material_entry.get("attenuationColor", [1.0, 1.0, 1.0])
        set_linear_rgba_socket(absorption_node.inputs["Color"], attenuation_color)
        mean_log_color = sum(math.log(max(channel, 0.001)) for channel in attenuation_color) / 3.0
        absorption_node.inputs["Density"].default_value = -mean_log_color / attenuation_distance
        output_node = material.node_tree.nodes["Material Output"]
        material.node_tree.links.new(absorption_node.outputs["Volume"], output_node.inputs["Volume"])


def build_blender_material(material_name, material_entry, has_vertex_colors, image_entries, built_images):
    material = bpy.data.materials.new(material_name)
    principled_node = material.node_tree.nodes["Principled BSDF"]
    set_linear_rgba_socket(principled_node.inputs["Base Color"], material_entry["color"])
    principled_node.inputs["Metallic"].default_value = material_entry.get("metallic", 0.0)
    principled_node.inputs["Roughness"].default_value = material_entry.get("roughness", 0.5)
    if material_entry.get("tag") == "liquid":
        principled_node.inputs["Transmission Weight"].default_value = 1.0
        principled_node.inputs["IOR"].default_value = material_entry["liquid"]["ior"]
    configure_principled_layers(material, principled_node, material_entry)
    if material_entry.get("alphaMode") == "blend" and 0.0 <= material_entry.get("opacity", 1.0) < 1.0:
        principled_node.inputs["Alpha"].default_value = material_entry["opacity"]
    if material_entry.get("emission", 0.0) > 0.0:
        emission_color = material_entry.get("emissiveColor", material_entry["color"])
        set_linear_rgba_socket(principled_node.inputs["Emission Color"], emission_color)
        principled_node.inputs["Emission Strength"].default_value = material_entry["emission"]
        if "emissiveMap" in material_entry:
            connect_emissive_map(material, principled_node, material_entry, emission_color, image_entries, built_images)
    if "map" in material_entry:
        connect_base_color_texture(material, principled_node, material_entry, has_vertex_colors, image_entries, built_images)
    elif has_vertex_colors:
        connect_vertex_colors(material, principled_node, material_entry)
    return material


def build_scene_objects(scene, description):
    built_meshes = {}
    built_materials = {}
    built_images = {}
    image_entries = description.get("images", [])
    for part_entry in description["parts"]:
        geometry_index = part_entry["geometry"]
        geometry_entry = description["geometries"][geometry_index]
        has_vertex_colors = geometry_entry.get("colors") is not None
        if geometry_index not in built_meshes:
            mesh = build_blender_mesh(f"geometry-{geometry_index}", geometry_entry)
            mesh.materials.append(None)
            built_meshes[geometry_index] = mesh
        material_key = (part_entry["material"], has_vertex_colors)
        if material_key not in built_materials:
            material_entry = description["materials"][part_entry["material"]]
            material_name = f"material-{part_entry['material']}"
            built_materials[material_key] = build_blender_material(material_name, material_entry, has_vertex_colors, image_entries, built_images)
        mesh_object = bpy.data.objects.new(part_entry["name"], built_meshes[geometry_index])
        mesh_object.material_slots[0].link = "OBJECT"
        mesh_object.material_slots[0].material = built_materials[material_key]
        column_major = part_entry["matrix"]
        local_matrix = Matrix([[column_major[column * 4 + row] for column in range(4)] for row in range(4)])
        mesh_object.matrix_world = Y_UP_TO_Z_UP @ local_matrix
        for ray_kind, is_visible in part_entry.get("rayVisibility", {}).items():
            setattr(mesh_object, RAY_VISIBILITY_ATTRIBUTES[ray_kind], is_visible)
        scene.collection.objects.link(mesh_object)


def build_world_shader(scene, world_description, repository_root):
    world = bpy.data.worlds.new("World")
    scene.world = world
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background_node = nodes["Background"]
    if world_description["type"] == "constant":
        constant_value = world_description["value"]
        background_node.inputs[0].default_value = (constant_value, constant_value, constant_value, 1.0)
        background_node.inputs[1].default_value = 1.0
        return
    if world_description["type"] == "hdri":
        coordinate_node = nodes.new("ShaderNodeTexCoord")
        mapping_node = nodes.new("ShaderNodeMapping")
        mapping_node.inputs["Rotation"].default_value = (0.0, 0.0, ENVIRONMENT_ROTATION_Z)
        environment_node = nodes.new("ShaderNodeTexEnvironment")
        environment_node.image = bpy.data.images.load(os.path.join(repository_root, world_description["file"]))
        links.new(coordinate_node.outputs["Generated"], mapping_node.inputs["Vector"])
        links.new(mapping_node.outputs["Vector"], environment_node.inputs["Vector"])
        cap_node = nodes.new("ShaderNodeVectorMath")
        cap_node.operation = "MINIMUM"
        radiance_limit = world_description["radianceLimit"]
        cap_node.inputs[1].default_value = (radiance_limit, radiance_limit, radiance_limit)
        links.new(environment_node.outputs["Color"], cap_node.inputs[0])
        links.new(cap_node.outputs["Vector"], background_node.inputs[0])
        background_node.inputs[1].default_value = world_description["intensity"]
        return
    raise ValueError(f"Unsupported world description type '{world_description['type']}'.")


def attach_light_receivers(light_object, receiver_names):
    if receiver_names is None:
        return
    receiver_collection = bpy.data.collections.new(f"{light_object.name}-receivers")
    for object_name in receiver_names:
        receiver_collection.objects.link(bpy.data.objects[object_name])
    light_object.light_linking.receiver_collection = receiver_collection


def apply_soft_falloff_setting(light_data, light_entry):
    if soft_falloff_setting == SOFT_FALLOFF_FROM_SCENE:
        light_data.use_soft_falloff = light_entry.get("softFalloff") is True
    elif soft_falloff_setting is not None:
        light_data.use_soft_falloff = soft_falloff_setting


def add_spot_light(scene, light_index, spot_entry):
    light_data = bpy.data.lights.new(f"Spot-{light_index}", "SPOT")
    light_data.energy = spot_entry["intensity"] * WATTS_PER_POINT_INTENSITY
    light_data.color = spot_entry["color"]
    light_data.shadow_soft_size = spot_entry["radius"]
    apply_soft_falloff_setting(light_data, spot_entry)
    light_data.spot_size = 2.0 * spot_entry["angle"]
    light_data.spot_blend = spot_entry["penumbra"]
    spot_object = bpy.data.objects.new(f"Spot-{light_index}", light_data)
    spot_object.location = convert_position_to_blender(spot_entry["position"])
    spot_object.rotation_mode = "QUATERNION"
    aim_direction = Vector(convert_position_to_blender(spot_entry["direction"])).normalized()
    spot_object.rotation_quaternion = aim_direction.to_track_quat("-Z", "Y")
    scene.collection.objects.link(spot_object)
    attach_light_receivers(spot_object, spot_entry.get("affects"))


def add_area_light(scene, light_index, area_entry):
    light_data = bpy.data.lights.new(f"Area-{light_index}", "AREA")
    light_data.energy = area_entry["intensity"] * WATTS_PER_AREA_INTENSITY
    light_data.color = area_entry["color"]
    shape_name = area_entry.get("shape", "rectangle")
    light_data.shape = {"rectangle": "RECTANGLE", "disk": "DISK", "ellipse": "ELLIPSE"}[shape_name]
    light_data.size = area_entry["width"]
    if shape_name != "disk":
        light_data.size_y = area_entry["height"]
    if "spread" in area_entry:
        light_data.spread = area_entry["spread"]
    area_object = bpy.data.objects.new(f"Area-{light_index}", light_data)
    area_object.location = convert_position_to_blender(area_entry["position"])
    normal_vector = Vector(convert_position_to_blender(area_entry["direction"])).normalized()
    up_vector = Vector(convert_position_to_blender(area_entry.get("up", [0.0, 1.0, 0.0]))).normalized()
    width_axis = up_vector.cross(normal_vector)
    if width_axis.length < 1e-3:
        width_axis = Vector((1.0, 0.0, 0.0))
    width_axis.normalize()
    height_axis = width_axis.cross(normal_vector)
    rotation_matrix = Matrix((width_axis, height_axis, -normal_vector)).transposed()
    area_object.rotation_mode = "QUATERNION"
    area_object.rotation_quaternion = rotation_matrix.to_quaternion()
    scene.collection.objects.link(area_object)
    attach_light_receivers(area_object, area_entry.get("affects"))


def build_scene_lights(scene, environment_entry):
    key_color = environment_entry["keyColor"]
    if max(key_color) > 0.0:
        sun_strength = max(key_color)
        sun_data = bpy.data.lights.new("Sun", "SUN")
        sun_data.energy = sun_strength
        sun_data.color = [channel / sun_strength for channel in key_color]
        # A scene that sets sunAngularRadius (radians, as Cook reads it) gets that disc; the others keep the 1 degree default.
        sun_radius = environment_entry.get("sunAngularRadius")
        sun_data.angle = SUN_ANGULAR_DIAMETER if sun_radius is None else 2.0 * sun_radius
        sun_object = bpy.data.objects.new("Sun", sun_data)
        toward_light = Vector(convert_position_to_blender(environment_entry["lightDirection"])).normalized()
        sun_object.rotation_mode = "QUATERNION"
        sun_object.rotation_quaternion = toward_light.to_track_quat("Z", "Y")
        scene.collection.objects.link(sun_object)
        attach_light_receivers(sun_object, environment_entry.get("keyAffects"))
    for light_index, point_entry in enumerate(environment_entry.get("pointLights", [])):
        point_data = bpy.data.lights.new(f"Point-{light_index}", "POINT")
        point_data.energy = point_entry["intensity"] * WATTS_PER_POINT_INTENSITY
        point_data.color = point_entry["color"]
        point_data.shadow_soft_size = point_entry["radius"]
        apply_soft_falloff_setting(point_data, point_entry)
        point_object = bpy.data.objects.new(f"Point-{light_index}", point_data)
        point_object.location = convert_position_to_blender(point_entry["position"])
        scene.collection.objects.link(point_object)
        attach_light_receivers(point_object, point_entry.get("affects"))
    for light_index, spot_entry in enumerate(environment_entry.get("spotLights", [])):
        add_spot_light(scene, light_index, spot_entry)
    for light_index, area_entry in enumerate(environment_entry.get("areaLights", [])):
        add_area_light(scene, light_index, area_entry)


def configure_depth_of_field(camera_data, lens_options, aspect):
    """Thin-lens depth of field, matching createCamera in src/path-tracer.js (the same flags go to trace-native.mjs).

    The sensor is sensor-width / aspect tall, so the focal length Cycles derives from the vertical field of view is the one
    the native side computes; the aperture radius is then focal length / (2 * f-stop) in metres.
    """
    camera_data.sensor_height = lens_options["sensor_width"] / aspect
    camera_data.dof.use_dof = True
    camera_data.dof.aperture_fstop = lens_options["f_stop"]
    camera_data.dof.focus_distance = lens_options["focus_distance"]
    if lens_options["aperture_blades"] > 0:
        camera_data.dof.aperture_blades = lens_options["aperture_blades"]
        camera_data.dof.aperture_rotation = math.radians(lens_options["aperture_rotation"])


def build_camera_object(scene, camera_entry, lens_options=None, aspect=16.0 / 9.0):
    camera_data = bpy.data.cameras.new("Camera")
    camera_data.sensor_fit = "VERTICAL"
    if lens_options is not None:
        configure_depth_of_field(camera_data, lens_options, aspect)
    camera_data.angle_y = math.radians(camera_entry["fov"])
    camera_data.clip_start = camera_entry["near"]
    camera_data.clip_end = camera_entry["far"]
    camera_object = bpy.data.objects.new("Camera", camera_data)
    eye_vector = Vector(convert_position_to_blender(camera_entry["eye"]))
    target_vector = Vector(convert_position_to_blender(camera_entry["target"]))
    camera_object.location = eye_vector
    camera_object.rotation_mode = "QUATERNION"
    camera_object.rotation_quaternion = (target_vector - eye_vector).to_track_quat("-Z", "Y")
    scene.collection.objects.link(camera_object)
    scene.camera = camera_object


def configure_linear_exr_output(scene, width, height):
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.exr_codec = "ZIP"
    scene.view_settings.view_transform = "Raw"
    scene.view_settings.look = "None"


def configure_cycles_denoising(scene, mode):
    """Off by default. "oidn-gpu" and "oidn-cpu" run Cycles' own Open Image Denoise with albedo and normal passes.

    Blender's default denoiser for final renders is Open Image Denoise (the other choice is OptiX), with the
    albedo and normal passes, the accurate prefilter and, when a GPU renders, GPU denoising. This sets those
    values explicitly so the comparison does not depend on a default.
    """
    if mode == "none":
        scene.cycles.use_denoising = False
        return
    if mode not in ("oidn-gpu", "oidn-cpu"):
        raise ValueError(f"--denoise must be none, oidn-gpu or oidn-cpu, got {mode!r}.")
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    scene.cycles.denoising_prefilter = "ACCURATE"
    scene.cycles.denoising_use_gpu = mode == "oidn-gpu"


def configure_cycles_parity(scene, options):
    scene.render.engine = "CYCLES"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    preferences.compute_device_type = "OPTIX"
    preferences.get_devices()
    used_devices = []
    for device in preferences.devices:
        device.use = device.type == "OPTIX"
        if device.use:
            used_devices.append(device.name)
    if not used_devices:
        raise RuntimeError("No OptiX GPU device was found in Blender Cycles preferences.")
    scene.cycles.device = "GPU"
    scene.cycles.samples = options["samples"]
    scene.cycles.seed = options["seed"]
    configure_cycles_denoising(scene, options["denoise"])
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.pixel_filter_type = PIXEL_FILTER_TYPES[options["filter_type"]]
    scene.cycles.filter_width = options["filter_width"]
    scene.cycles.sample_clamp_direct = 0.0
    scene.cycles.sample_clamp_indirect = 0.0
    scene.cycles.caustics_reflective = True
    scene.cycles.caustics_refractive = True
    bounces = options["bounces"]
    scene.cycles.max_bounces = bounces
    scene.cycles.diffuse_bounces = bounces
    scene.cycles.glossy_bounces = bounces
    scene.cycles.transmission_bounces = bounces
    scene.cycles.volume_bounces = bounces
    transparent_bounces = options["transparent_bounces"]
    scene.cycles.transparent_max_bounces = bounces if transparent_bounces is None else transparent_bounces
    return used_devices


def parse_megabytes_from_stats(stats_text):
    matches = PEAK_MEMORY_PATTERN.findall(stats_text)
    if not matches:
        return None
    scale_by_unit = {"K": 1.0 / 1024.0, "M": 1.0, "": 1.0, "G": 1024.0, "T": 1024.0 * 1024.0}
    values = [float(number_text) * scale_by_unit.get(unit_text.upper(), 1.0) for number_text, unit_text in matches]
    return max(values)


def load_exr_into_npy(exr_path, npy_path, width, height, keep_exr):
    loaded_image = bpy.data.images.load(exr_path)
    rgba_pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
    loaded_image.pixels.foreach_get(rgba_pixels)
    linear_rgb = rgba_pixels.reshape(height, width, 4)[::-1, :, :3].copy()
    numpy.save(npy_path, linear_rgb)
    bpy.data.images.remove(loaded_image)
    if not keep_exr:
        os.remove(exr_path)


def render_part_identifier_map(scene, output_prefix, width, height):
    mesh_objects = sorted([item for item in scene.objects if item.type == "MESH"], key=lambda item: item.name)
    part_names = [item.name for item in mesh_objects]
    for part_index, mesh_object in enumerate(mesh_objects, start=1):
        part_material = bpy.data.materials.new(f"part-id-{part_index}")
        part_material.diffuse_color = (part_index / PART_ID_STEPS, 0.0, 0.0, 1.0)
        mesh_object.material_slots[0].material = part_material
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.render_aa = "OFF"
    scene.view_settings.view_transform = "Raw"
    scene.world.color = (0.0, 0.0, 0.0)
    temporary_exr = f"{output_prefix}-part-levels.exr"
    temporary_npy = f"{output_prefix}-part-levels.npy"
    scene.render.filepath = temporary_exr
    bpy.ops.render.render(write_still=True)
    load_exr_into_npy(temporary_exr, temporary_npy, width, height, False)
    red_levels = numpy.load(temporary_npy)[:, :, 0]
    os.remove(temporary_npy)
    part_indices = numpy.rint(red_levels * PART_ID_STEPS).astype(numpy.int16)
    numpy.save(f"{output_prefix}-parts.npy", part_indices)
    with open(f"{output_prefix}-parts.json", "w", encoding="utf-8") as handle:
        json.dump(part_names, handle, indent=2)
    print("PART_IDS " + json.dumps({"parts": part_names, "outputPrefix": output_prefix}))


def apply_grey_diffuse_override(scene):
    """Shades every object with one grey diffuse material, as the view layer's material override does."""
    grey_material = build_blender_material("grey-diffuse-override", GREY_DIFFUSE_ENTRY, False, [], {})
    scene.view_layers[0].material_override = grey_material


def build_camera_z_depth_material():
    """An emission material whose colour is the camera Z depth: the distance along the view axis, not along the ray."""
    material = bpy.data.materials.new("camera-z-depth")
    node_tree = material.node_tree
    node_tree.nodes.clear()
    camera_data_node = node_tree.nodes.new("ShaderNodeCameraData")
    emission_node = node_tree.nodes.new("ShaderNodeEmission")
    emission_node.inputs["Strength"].default_value = 1.0
    output_node = node_tree.nodes.new("ShaderNodeOutputMaterial")
    node_tree.links.new(camera_data_node.outputs["View Z Depth"], emission_node.inputs["Color"])
    node_tree.links.new(emission_node.outputs["Emission"], output_node.inputs["Surface"])
    return material


def render_camera_z_depth(scene, output_prefix, width, height, depth_samples):
    """Renders the camera Z depth through Cycles into <prefix>-depth.npy (rows from the top, 0 where nothing is hit).

    A real Z pass needs a multilayer EXR or compositor nodes; the Camera Data node's View Z Depth is the same
    quantity (Cycles' pass is camera_z_depth too) and goes through the single-layer path used for the colour image.
    The world is switched off so a miss reads 0, which is also what Cook writes.
    """
    scene.view_layers[0].material_override = build_camera_z_depth_material()
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.0
    scene.cycles.samples = depth_samples
    depth_exr_path = f"{output_prefix}-depth.exr"
    depth_npy_path = f"{output_prefix}-depth.npy"
    scene.render.filepath = depth_exr_path
    bpy.ops.render.render(write_still=True)
    load_exr_into_npy(depth_exr_path, depth_npy_path, width, height, False)
    z_depth = numpy.load(depth_npy_path)[:, :, 0].copy()
    numpy.save(depth_npy_path, z_depth)
    return depth_npy_path


def execute_timed_cycles_render(scene, exr_path):
    scene.render.filepath = exr_path
    stats_events = []
    render_started = time.perf_counter()

    def record_stats(*callback_arguments):
        elapsed = time.perf_counter() - render_started
        joined_text = " ".join(str(item) for item in callback_arguments if item is not None)
        stats_events.append((elapsed, joined_text))

    bpy.app.handlers.render_stats.append(record_stats)
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        bpy.app.handlers.render_stats.remove(record_stats)
    render_call_seconds = time.perf_counter() - render_started
    first_sample_seconds = None
    last_sample_seconds = None
    peak_stats_megabytes = 0.0
    for event_seconds, stats_text in stats_events:
        parsed_peak = parse_megabytes_from_stats(stats_text)
        if parsed_peak is not None:
            peak_stats_megabytes = max(peak_stats_megabytes, parsed_peak)
        if "Rendering " in stats_text or "Sample " in stats_text:
            if first_sample_seconds is None:
                first_sample_seconds = event_seconds
            last_sample_seconds = event_seconds
    if first_sample_seconds is None:
        cycles_sync_seconds = render_call_seconds
        sampling_seconds = 0.0
    else:
        cycles_sync_seconds = first_sample_seconds
        end_seconds = last_sample_seconds if last_sample_seconds is not None and last_sample_seconds > first_sample_seconds else render_call_seconds
        sampling_seconds = max(0.0, end_seconds - first_sample_seconds)
    return {
        "render_call_seconds": render_call_seconds,
        "cycles_sync_seconds": cycles_sync_seconds,
        "sampling_seconds": sampling_seconds,
        "after_last_sample_seconds": max(0.0, render_call_seconds - (last_sample_seconds or render_call_seconds)),
        "peak_stats_megabytes": peak_stats_megabytes,
        "stats_event_count": len(stats_events),
        "last_stats_text": stats_events[-1][1] if stats_events else "",
    }


def lower_process_priority():
    if os.name != "nt":
        return
    import ctypes
    below_normal_priority_class = 0x00004000
    process_handle = ctypes.windll.kernel32.GetCurrentProcess()
    ctypes.windll.kernel32.SetPriorityClass(process_handle, below_normal_priority_class)


def main():
    lower_process_priority()
    options = parse_cli_arguments()
    os.makedirs(os.path.dirname(options["output_prefix"]), exist_ok=True)
    with open(options["scene_json_path"], encoding="utf-8") as handle:
        description = json.load(handle)
    repository_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    build_started = time.perf_counter()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    global soft_falloff_setting
    soft_falloff_setting = options["soft_falloff"]
    build_scene_objects(scene, description)
    build_world_shader(scene, description["world"], repository_root)
    build_scene_lights(scene, description["environment"])
    lens_options = resolve_lens_options(options, description["camera"])
    build_camera_object(scene, description["camera"], lens_options, options["width"] / options["height"])
    configure_linear_exr_output(scene, options["width"], options["height"])
    if options["part_ids"]:
        render_part_identifier_map(scene, options["output_prefix"], options["width"], options["height"])
        return
    used_devices = configure_cycles_parity(scene, options)
    if options["grey_diffuse"]:
        apply_grey_diffuse_override(scene)
    scene_build_seconds = time.perf_counter() - build_started
    exr_path = f"{options['output_prefix']}.exr"
    npy_path = f"{options['output_prefix']}.npy"
    timing = execute_timed_cycles_render(scene, exr_path)
    load_exr_into_npy(exr_path, npy_path, options["width"], options["height"], options["keep_exr"])
    setup_seconds = scene_build_seconds + timing["cycles_sync_seconds"]
    total_trace_seconds = scene_build_seconds + timing["render_call_seconds"]
    report_samples = scene.cycles.samples
    depth_npy_path = None
    depth_error = None
    if options["z_depth"]:
        try:
            depth_npy_path = render_camera_z_depth(scene, options["output_prefix"], options["width"], options["height"], options["depth_samples"])
        except Exception as error:  # the colour image is already on disk; keep its report even when the depth pass fails
            depth_error = repr(error)
            print("DEPTH_PASS_FAILED " + depth_error)
    report = {
        "greyDiffuse": options["grey_diffuse"],
        "thinLens": None if lens_options is None else {
            **lens_options,
            "blenderLensMillimetres": scene.camera.data.lens,
            "blenderApertureRadius": scene.camera.data.lens / 1000.0 / (2.0 * lens_options["f_stop"]),
        },
        "depthNpyPath": depth_npy_path,
        "depthError": depth_error,
        "depthSamples": options["depth_samples"] if options["z_depth"] else None,
        "engine": "cycles-optix",
        "blenderVersion": bpy.app.version_string,
        "devices": used_devices,
        "sceneId": description["id"],
        "npyPath": npy_path,
        "exrPath": exr_path if options["keep_exr"] else None,
        "width": options["width"],
        "height": options["height"],
        "samples": report_samples,
        "seed": scene.cycles.seed,
        "bounces": scene.cycles.max_bounces,
        "diffuseBounces": scene.cycles.diffuse_bounces,
        "glossyBounces": scene.cycles.glossy_bounces,
        "transmissionBounces": scene.cycles.transmission_bounces,
        "volumeBounces": scene.cycles.volume_bounces,
        "transparentMaxBounces": scene.cycles.transparent_max_bounces,
        "useDenoising": scene.cycles.use_denoising,
        "useAdaptiveSampling": scene.cycles.use_adaptive_sampling,
        "pixelFilterType": scene.cycles.pixel_filter_type,
        "filterWidth": scene.cycles.filter_width,
        "sampleClampDirect": scene.cycles.sample_clamp_direct,
        "sampleClampIndirect": scene.cycles.sample_clamp_indirect,
        "causticsReflective": scene.cycles.caustics_reflective,
        "causticsRefractive": scene.cycles.caustics_refractive,
        "useLightTree": getattr(scene.cycles, "use_light_tree", None),
        "viewTransform": scene.view_settings.view_transform,
        "look": scene.view_settings.look,
        "sceneBuildSeconds": round(scene_build_seconds, 6),
        "cyclesSyncSeconds": round(timing["cycles_sync_seconds"], 6),
        "setupSeconds": round(setup_seconds, 6),
        "samplingSeconds": round(timing["sampling_seconds"], 6),
        "secondsAfterLastSample": round(timing["after_last_sample_seconds"], 6),
        "denoiseMode": options["denoise"],
        "denoiser": scene.cycles.denoiser if scene.cycles.use_denoising else None,
        "renderCallSeconds": round(timing["render_call_seconds"], 6),
        "totalTraceSeconds": round(total_trace_seconds, 6),
        "cyclesPeakMemoryMegabytes": round(timing["peak_stats_megabytes"], 2),
        "statsEventCount": timing["stats_event_count"],
        "lastStatsText": timing["last_stats_text"],
    }
    with open(f"{options['output_prefix']}.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print("CYCLES_TRACE " + json.dumps(report))


if __name__ == "__main__":
    main()
