# Renders each described scene in Cycles and EEVEE, and saves linear pixels as .npy for the scorer.
#   blender -b --factory-startup --python bench/reference/render-blender.py -- <work directory> [scene ids]
#   ... -- <work directory> --world-strength <scale> [scene ids]  renders Cycles only, with the world's light multiplied by <scale>
#   (0 leaves the sun and the point lights), into <id>-cycles-world<scale>.npy. The EEVEE render and the timings are left alone.
#   ... -- <work directory> --sun-strength <scale> [scene ids]  the same for the sun: Cycles only, the sun times <scale> (0 leaves the world and
#   the point lights), into <id>-cycles-sun<scale>.npy. Both switches together write <id>-cycles-world<a>-sun<b>.npy.
#   ... -- <work directory> --no-fog [scene ids]  Cycles only, without the fog volume (combines with the switches above), into <id>-cycles-nofog....npy (issue #543).
#   ... -- <work directory> --view-transform <AgX|Khronos PBR Neutral|...> [scene ids]  Cycles only, with that Blender view transform, into <id>-cycles-<name>.png (16-bit sRGB).
#   ... -- <work directory> --max-bounces <n> [--floor-color <v>] [scene ids]  Cycles only, with at most n light bounces (0 is direct light only)
#   and/or the part named "floor" painted a grey of v (0 is black), into <id>-cycles-bounces<n>-floor<v>.npy. They show how much light the ground bounces.
#   ... -- <work directory> --no-glossy [scene ids]  Cycles only, with every material's metallic, specular and coat at 0 (metals draw as diffuse
#   in their base colour, no reflections), into <id>-cycles-noglossy.npy. It shows how much of a Cycles picture is reflection (issue #506).
#   ... -- <work directory> --material-ids [scene ids]  Workbench, flat colours: <id>-materials.npy holds the material index under each pixel (0 is the sky,
#   n is the nth name in <id>-materials.json), so a difference between two renders can be split by material.
#   ... -- <work directory> --print-materials [scene ids]  prints each material's Principled values as built, one JSON line per scene.
# REFERENCE_WIDTH, REFERENCE_HEIGHT and REFERENCE_CYCLES_SAMPLES in the environment replace 960, 540 and 256 (the default look bench draws small).
# Light units were measured on a white plane: sun strength equals irradiance, a point or spot light has 4 pi watts for each
# unit of 67js intensity, and an area light has pi watts for each unit.
import base64
import json
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

WIDTH = int(os.environ.get("REFERENCE_WIDTH", 960))
HEIGHT = int(os.environ.get("REFERENCE_HEIGHT", 540))
CYCLES_SAMPLES = int(os.environ.get("REFERENCE_CYCLES_SAMPLES", 256))
EEVEE_SAMPLES = 64
WATTS_PER_INTENSITY = 4 * math.pi
WATTS_PER_AREA_INTENSITY = math.pi
SUN_ANGLE = math.radians(1)
# 67js is Y up, and Blender is Z up.
Y_UP_TO_Z_UP = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
# The centre of an environment image looks toward -Z in 67js, which is +Y here. In Blender it looks toward -X.
ENVIRONMENT_ROTATION_Z = -math.pi / 2
NUMPY_TYPES = {
    "Float32Array": np.float32,
    "Uint32Array": np.uint32,
    "Uint16Array": np.uint16,
    "Uint8Array": np.uint8,
    "Uint8ClampedArray": np.uint8,
}
# Set for each scene: the pixels its materials share, and the images already built from them.
scene_images = []
built_images = {}


def decode(entry):
    if entry is None:
        return None
    return np.frombuffer(base64.b64decode(entry["base64"]), dtype=NUMPY_TYPES[entry["type"]])


def to_blender(position):
    return (position[0], -position[2], position[1])


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def build_mesh(name, geometry):
    positions = decode(geometry["positions"]).reshape(-1, 3)
    normals = decode(geometry["normals"]).reshape(-1, 3)
    triangles = decode(geometry["indices"]).reshape(-1, 3)
    # A triangle that repeats a vertex has no area and is invisible, but Blender builds an invalid face from it
    # and crashes in mesh_set_custom_normals (the skinned character has three).
    repeats_vertex = (triangles[:, 0] == triangles[:, 1]) | (triangles[:, 1] == triangles[:, 2]) | (triangles[:, 0] == triangles[:, 2])
    triangles = triangles[~repeats_vertex]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(positions.tolist(), [], triangles.tolist())
    mesh.validate()
    mesh.normals_split_custom_set_from_vertices(normals.tolist())
    uvs = decode(geometry.get("uvs"))
    if uvs is not None:
        uv_pairs = uvs.reshape(-1, 2)
        layer = mesh.uv_layers.new(name="UVMap")
        corner_uvs = uv_pairs[triangles.reshape(-1)].copy()
        corner_uvs[:, 1] = 1 - corner_uvs[:, 1]
        layer.data.foreach_set("uv", corner_uvs.reshape(-1))
    colors = decode(geometry.get("colors"))
    if colors is not None:
        attribute = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        rgb = colors.reshape(-1, 3)
        rgba = np.concatenate([rgb, np.ones((len(rgb), 1), dtype=np.float32)], axis=1)
        attribute.data.foreach_set("color", rgba.reshape(-1))
    mesh.update()
    return mesh


def build_image(name, descriptor):
    # The scene's pixels sit once in its image table; a material only names the entry.
    image_id = descriptor["image"]["imageId"]
    if image_id in built_images:
        return built_images[image_id]
    source = scene_images[image_id]
    data = decode(source["data"])
    width = source["width"]
    height = source["height"]
    image = bpy.data.images.new(name, width, height, alpha=True)
    pixels = data.reshape(height, width, 4)[::-1].astype(np.float32) / 255
    image.pixels.foreach_set(pixels.reshape(-1))
    image.pack()
    built_images[image_id] = image
    return image


def set_linear_color(socket, color):
    socket.default_value = (color[0], color[1], color[2], 1)


def add_texture(material, principled, description, has_vertex_colors):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = build_image(f"{material.name}-map", description["map"])
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    set_linear_color(multiply.inputs[2], description["color"])
    links.new(texture.outputs["Color"], multiply.inputs[1])
    if has_vertex_colors:
        attribute = nodes.new("ShaderNodeVertexColor")
        attribute.layer_name = "Col"
        with_colors = nodes.new("ShaderNodeMixRGB")
        with_colors.blend_type = "MULTIPLY"
        with_colors.inputs[0].default_value = 1
        links.new(multiply.outputs["Color"], with_colors.inputs[1])
        links.new(attribute.outputs["Color"], with_colors.inputs[2])
        links.new(with_colors.outputs["Color"], principled.inputs["Base Color"])
    else:
        links.new(multiply.outputs["Color"], principled.inputs["Base Color"])
    if description.get("alphaMode") == "mask":
        cutoff = nodes.new("ShaderNodeMath")
        cutoff.operation = "GREATER_THAN"
        cutoff.inputs[1].default_value = description.get("alphaCutoff", 0.5)
        links.new(texture.outputs["Alpha"], cutoff.inputs[0])
        links.new(cutoff.outputs[0], principled.inputs["Alpha"])


def add_emissive_map(material, principled, description, emission_color):
    """67js multiplies the emissive colour and strength by the emissive map (sRGB), so the map drives the Emission Color socket."""
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = build_image(f"{material.name}-emissive", description["emissiveMap"])
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    set_linear_color(multiply.inputs[2], emission_color)
    links.new(texture.outputs["Color"], multiply.inputs[1])
    links.new(multiply.outputs["Color"], principled.inputs["Emission Color"])


def add_vertex_colors(material, principled, description):
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "Col"
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    set_linear_color(multiply.inputs[2], description["color"])
    links.new(attribute.outputs["Color"], multiply.inputs[1])
    links.new(multiply.outputs["Color"], principled.inputs["Base Color"])


def add_anisotropy(principled, description):
    """Maps the glTF anisotropy model (rougher along the tangent) onto Blender's aspect-ratio model."""
    strength = description.get("anisotropy", 0)
    if strength <= 0:
        return
    alpha = description.get("roughness", 0.5) ** 2
    alpha_tangent = alpha + (1 - alpha) * strength ** 2
    # Blender stretches alpha by 1 / aspect along the tangent and by aspect across it, aspect = sqrt(1 - 0.9 * Anisotropic).
    principled.inputs["Anisotropic"].default_value = min((1 - alpha / alpha_tangent) / 0.9, 1)
    principled.inputs["Roughness"].default_value = (alpha * alpha_tangent) ** 0.25
    principled.inputs["Anisotropic Rotation"].default_value = description.get("anisotropyRotation", 0) / (2 * math.pi)
    # 67js takes the grain along the U direction of the UV map; Blender's default tangent is a different field.
    tree = principled.id_data
    tangent = tree.nodes.new("ShaderNodeTangent")
    tangent.direction_type = "UV_MAP"
    tangent.uv_map = "UVMap"
    tree.links.new(tangent.outputs["Tangent"], principled.inputs["Tangent"])


def add_thin_film(principled, description):
    if description.get("iridescence", 0) <= 0:
        return
    principled.inputs["Thin Film Thickness"].default_value = description.get("iridescenceThickness", 400)
    principled.inputs["Thin Film IOR"].default_value = description.get("iridescenceIor", 1.3)


def add_subsurface(principled, description):
    """Maps the 67js subsurface block onto the Principled BSDF subsurface inputs (random walk). Blender 4 and later takes the base color as the scatter color."""
    block = description.get("subsurface")
    if not block or block.get("weight", 0) <= 0:
        return
    principled.subsurface_method = "RANDOM_WALK"
    principled.inputs["Subsurface Weight"].default_value = block["weight"]
    principled.inputs["Subsurface Radius"].default_value = block.get("radius", [1, 0.2, 0.1])
    principled.inputs["Subsurface Scale"].default_value = block.get("scale", 0.05)


def add_material_layers(material, principled, description):
    """Maps the 67js material layers onto the Principled BSDF inputs of the same meaning."""
    principled.inputs["Coat Weight"].default_value = description.get("clearcoat", 0)
    principled.inputs["Coat Roughness"].default_value = description.get("clearcoatRoughness", 0)
    principled.inputs["Transmission Weight"].default_value = description.get("transmission", principled.inputs["Transmission Weight"].default_value)
    principled.inputs["IOR"].default_value = description.get("ior", principled.inputs["IOR"].default_value)
    sheen_color = description.get("sheenColor", [0, 0, 0])
    if any(sheen_color):
        principled.inputs["Sheen Weight"].default_value = 1
        set_linear_color(principled.inputs["Sheen Tint"], sheen_color)
        principled.inputs["Sheen Roughness"].default_value = description.get("sheenRoughness", 0)
    # Blender's specular level 0.5 is the 4 percent reflectance that 67js calls specular 1.
    principled.inputs["Specular IOR Level"].default_value = 0.5 * description.get("specular", 1)
    set_linear_color(principled.inputs["Specular Tint"], description.get("specularColor", [1, 1, 1]))
    add_anisotropy(principled, description)
    add_thin_film(principled, description)
    add_subsurface(principled, description)
    attenuation_distance = description.get("attenuationDistance")
    if attenuation_distance:
        absorption = material.node_tree.nodes.new("ShaderNodeVolumeAbsorption")
        attenuation_color = description.get("attenuationColor", [1, 1, 1])
        set_linear_color(absorption.inputs["Color"], attenuation_color)
        # Beer-Lambert: the colour is what attenuationDistance metres let through.
        mean_log = sum(math.log(max(channel, 0.001)) for channel in attenuation_color) / 3
        absorption.inputs["Density"].default_value = -mean_log / attenuation_distance
        material.node_tree.links.new(absorption.outputs["Volume"], material.node_tree.nodes["Material Output"].inputs["Volume"])


GRAPH_MATH_OPERATIONS = {
    "add": "ADD", "sub": "SUBTRACT", "mul": "MULTIPLY", "div": "DIVIDE", "min": "MINIMUM", "max": "MAXIMUM",
    "pow": "POWER", "abs": "ABSOLUTE", "floor": "FLOOR", "fract": "FRACT", "sqrt": "SQRT",
}
# The graph noise node of 67js is Blender's Noise Texture (2D, fBm, Roughness 0.5, Lacunarity 2, Normalize), value for
# value (bench/reference/README.md, 2026-11-04) when it says "tile": false. A tiling noise (the default) wraps its lattice.
GRAPH_BUMP_DISTANCE = 0.15


class GraphTranslator:
    """Builds the Blender nodes for a 67js material graph (src/material-graph.js). Values are a number, a socket,
    {"color": socket or three numbers} or {"vector": three numbers or sockets}. Only the nodes the reference scenes use exist."""

    def __init__(self, material):
        self.nodes = material.node_tree.nodes
        self.links = material.node_tree.links
        self.coordinates = None

    def connect(self, socket, value):
        if isinstance(value, (int, float)):
            socket.default_value = value
        else:
            self.links.new(value, socket)

    def math(self, operation, *inputs):
        node = self.nodes.new("ShaderNodeMath")
        node.operation = operation
        for index, value in enumerate(inputs):
            self.connect(node.inputs[index], value)
        return node.outputs[0]

    def uv_parts(self):
        if self.coordinates is None:
            attribute = self.nodes.new("ShaderNodeUVMap")
            separate = self.nodes.new("ShaderNodeSeparateXYZ")
            self.links.new(attribute.outputs["UV"], separate.inputs[0])
            # The mesh stores 1 - v, because Blender's image rows run the other way (see build_mesh).
            self.coordinates = (separate.outputs["X"], self.math("SUBTRACT", 1.0, separate.outputs["Y"]))
        return self.coordinates

    def position(self, settings):
        if "at" in settings:
            at = self.compile(settings["at"])
            return at["vector"][0], at["vector"][1]
        return self.uv_parts()

    def scalar(self, node):
        value = self.compile(node)
        if isinstance(value, dict):
            raise NotImplementedError("This graph node needs a number.")
        return value

    def compile(self, node):
        if isinstance(node, (int, float)):
            return float(node)
        if isinstance(node, list):
            return {"color": node}
        name, settings = next(iter(node.items()))
        if name == "uv":
            u, v = self.uv_parts()
            return {"u": u, "v": v}.get(settings) or {"vector": [u, v, 0.0]}
        if name == "vec":
            return {"vector": [self.scalar(part) for part in settings]}
        if name == "noise":
            return self.noise(settings)
        if name == "wave":
            return self.wave(settings)
        if name == "smoothstep":
            low, high, value = (self.scalar(part) for part in settings)
            return self.smooth_step(value, low, high)
        if name == "ramp":
            return self.ramp(settings)
        if name == "mix":
            return self.mix(settings)
        if name in GRAPH_MATH_OPERATIONS:
            operands = settings if isinstance(settings, list) else [settings]
            return self.math(GRAPH_MATH_OPERATIONS[name], *(self.scalar(operand) for operand in operands))
        raise NotImplementedError(f"The Blender translation has no node for {name}.")

    def smooth_step(self, value, low, high):
        node = self.nodes.new("ShaderNodeMapRange")
        node.data_type = "FLOAT"
        node.interpolation_type = "SMOOTHSTEP"
        node.clamp = True
        self.connect(node.inputs["Value"], value)
        self.connect(node.inputs["From Min"], low)
        self.connect(node.inputs["From Max"], high)
        return node.outputs["Result"]

    def noise(self, settings):
        if settings.get("tile", True):
            raise NotImplementedError("Blender's noise lattice does not wrap: a reference noise needs \"tile\": false.")
        node = self.nodes.new("ShaderNodeTexNoise")
        node.noise_dimensions = "2D"
        node.inputs["Scale"].default_value = settings.get("scale", 4)
        node.inputs["Detail"].default_value = settings.get("octaves", 4) - 1
        node.inputs["Roughness"].default_value = 0.5
        seed = settings.get("seed", 0)
        scale = settings.get("scale", 4)
        # 67js moves the lattice by whole cells per seed (NOISE seed shifts in src/material-graph.js), in scaled units.
        shifts = ((seed * 7919) % 1024 / scale, (seed * 104729) % 1024 / scale)
        combine = self.nodes.new("ShaderNodeCombineXYZ")
        for index, part in enumerate(self.position(settings)):
            self.connect(combine.inputs[index], self.math("ADD", part, shifts[index]) if index < 2 and shifts[index] else part)
        self.links.new(combine.outputs[0], node.inputs["Vector"])
        return node.outputs["Fac"]

    def wave(self, settings):
        u, v = self.position(settings)
        direction = settings.get("direction", "u")
        along = u if direction == "u" else v
        if direction == "diagonal":
            along = self.math("ADD", u, v)
        phase = self.math("MULTIPLY", along, float(settings.get("frequency", 4)))
        shape = settings.get("shape", "sine")
        if shape == "sine":
            return self.math("MULTIPLY_ADD", self.math("SINE", self.math("MULTIPLY", phase, 2 * math.pi)), 0.5, 0.5)
        fraction = self.math("FRACT", phase)
        if shape == "saw":
            return fraction
        return self.math("SUBTRACT", 1.0, self.math("ABSOLUTE", self.math("SUBTRACT", self.math("MULTIPLY", fraction, 2.0), 1.0)))

    def ramp(self, settings):
        node = self.nodes.new("ShaderNodeValToRGB")
        node.color_ramp.interpolation = "LINEAR"
        stops = settings["stops"]
        elements = node.color_ramp.elements
        while len(elements) < len(stops):
            elements.new(0.5)
        for element, (position, color) in zip(elements, stops):
            element.position = position
            element.color = (color[0], color[1], color[2], 1)
        self.connect(node.inputs["Fac"], self.scalar(settings["value"]))
        return {"color": node.outputs["Color"]}

    def color_socket(self, value, node, index):
        if isinstance(value, dict) and isinstance(value["color"], list):
            node.inputs[index].default_value = (value["color"][0], value["color"][1], value["color"][2], 1)
        else:
            self.links.new(value["color"], node.inputs[index])

    def mix(self, settings):
        first, second, factor = (self.compile(part) for part in settings)
        if not isinstance(first, dict):
            return self.math("ADD", first, self.math("MULTIPLY", self.math("SUBTRACT", second, first), factor))
        node = self.nodes.new("ShaderNodeMixRGB")
        node.blend_type = "MIX"
        self.connect(node.inputs[0], factor)
        self.color_socket(first, node, 1)
        self.color_socket(second, node, 2)
        return {"color": node.outputs["Color"]}


def add_graph(material, principled, description):
    """Builds the material from its graph, so Blender evaluates the same nodes 67js baked into textures."""
    translator = GraphTranslator(material)
    graph = description["graph"]
    links = material.node_tree.links
    if "color" in graph:
        links.new(translator.compile(graph["color"])["color"], principled.inputs["Base Color"])
    for output, socket_name in (("roughness", "Roughness"), ("metallic", "Metallic")):
        if output in graph:
            translator.connect(principled.inputs[socket_name], translator.scalar(graph[output]))
    if "height" in graph:
        bump = material.node_tree.nodes.new("ShaderNodeBump")
        bump.inputs["Distance"].default_value = GRAPH_BUMP_DISTANCE * description.get("graphBump", 1)
        translator.connect(bump.inputs["Height"], translator.scalar(graph["height"]))
        links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    if "emission" in graph:
        links.new(translator.compile(graph["emission"])["color"], principled.inputs["Emission Color"])
        principled.inputs["Emission Strength"].default_value = description.get("emission", 1)


# The 67js foliage shader (CANOPY_TAG in src/shaders.js) is not a plain Principled leaf. Each term is rebuilt below with the
# same constants, so both sides evaluate the same material:
#   - the shading normal of a double-sided card keeps its direction on the back face (Blender flips it);
#   - the colour is scaled by 0.78 + 0.16 * sin(13 x + sin(9 y)) * sin(11 z - 5 y) of the world position;
#   - the normal is moved by 0.06 * (sin(12 z), sin(9 x), cos(11 y)) of the world position, then normalised;
#   - environment reflection is 0.3 of a dielectric's, which halves-and-more the Principled specular level (0.5 is F0 0.04);
#   - light from behind adds colour * max(dot(-N, L), 0) * 0.3 * keyColor / resolve, times the sun shadow (a Translucent BSDF is shadowed too).
# resolve is the daylight divisor of the shader in world mode. A Translucent BSDF returns albedo * E / pi * cos, so the weight
# that gives the same radiance is 0.3 * pi / resolve for each channel.
CANOPY_NORMAL_JITTER = 0.06
CANOPY_COLOR_BASE = 0.78
CANOPY_COLOR_SWING = 0.16
CANOPY_SKY_REFLECTION = 0.3
CANOPY_BACK_LIGHT = 0.3
WORLD_KEY_RESOLVE = (3.7, 3.4, 2.9)
PRINCIPLED_SPECULAR_LEVEL_AT_DIELECTRIC = 0.5


def add_canopy_leaf_model(material, principled):
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    def vector_math(operation, first, second=None, scale=None):
        node = nodes.new("ShaderNodeVectorMath")
        node.operation = operation
        links.new(first, node.inputs[0])
        if second is not None:
            links.new(second, node.inputs[1])
        if isinstance(scale, (int, float)):
            node.inputs[3].default_value = scale
        elif scale is not None:
            links.new(scale, node.inputs[3])
        return node.outputs[0]

    def scalar_math(operation, first, second=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = operation
        for index, value in enumerate((first, second)):
            if value is None:
                continue
            if isinstance(value, (int, float)):
                node.inputs[index].default_value = value
            else:
                links.new(value, node.inputs[index])
        return node.outputs[0]

    geometry = nodes.new("ShaderNodeNewGeometry")
    position = nodes.new("ShaderNodeSeparateXYZ")
    links.new(geometry.outputs["Position"], position.inputs[0])
    # 67js (x, y, z) is Blender (X, Z, -Y).
    world_x = position.outputs["X"]
    world_y = position.outputs["Z"]
    world_z = scalar_math("MULTIPLY", position.outputs["Y"], -1.0)

    inner = scalar_math("SINE", scalar_math("MULTIPLY", world_y, 9.0))
    first_wave = scalar_math("SINE", scalar_math("ADD", scalar_math("MULTIPLY", world_x, 13.0), inner))
    second_wave = scalar_math("SINE", scalar_math("SUBTRACT", scalar_math("MULTIPLY", world_z, 11.0), scalar_math("MULTIPLY", world_y, 5.0)))
    swing = scalar_math("MULTIPLY", scalar_math("MULTIPLY", first_wave, second_wave), CANOPY_COLOR_SWING)
    modulation = scalar_math("ADD", swing, CANOPY_COLOR_BASE)

    base_input = principled.inputs["Base Color"]
    if base_input.is_linked:
        base_color = base_input.links[0].from_socket
    else:
        constant = nodes.new("ShaderNodeRGB")
        constant.outputs[0].default_value = base_input.default_value
        base_color = constant.outputs[0]
    modulated = nodes.new("ShaderNodeMixRGB")
    modulated.blend_type = "MULTIPLY"
    modulated.inputs[0].default_value = 1
    links.new(base_color, modulated.inputs[1])
    links.new(modulation, modulated.inputs[2])
    links.new(modulated.outputs["Color"], base_input)

    # Back face keeps the stored normal: undo Blender's flip, then add the jitter.
    unflip = scalar_math("SUBTRACT", 1.0, scalar_math("MULTIPLY", geometry.outputs["Backfacing"], 2.0))
    stored_normal = vector_math("SCALE", geometry.outputs["Normal"], scale=unflip)
    jitter = nodes.new("ShaderNodeCombineXYZ")
    # 67js (sin(12 z), sin(9 x), cos(11 y)) is Blender (X, Y, Z) = (sin(12 z), -cos(11 y), sin(9 x)).
    links.new(scalar_math("SINE", scalar_math("MULTIPLY", world_z, 12.0)), jitter.inputs["X"])
    links.new(scalar_math("MULTIPLY", scalar_math("COSINE", scalar_math("MULTIPLY", world_y, 11.0)), -1.0), jitter.inputs["Y"])
    links.new(scalar_math("SINE", scalar_math("MULTIPLY", world_x, 9.0)), jitter.inputs["Z"])
    jitter_scaled = vector_math("SCALE", jitter.outputs[0], scale=CANOPY_NORMAL_JITTER)
    shading_normal = vector_math("NORMALIZE", vector_math("ADD", stored_normal, jitter_scaled))
    links.new(shading_normal, principled.inputs["Normal"])

    principled.inputs["Specular IOR Level"].default_value = PRINCIPLED_SPECULAR_LEVEL_AT_DIELECTRIC * CANOPY_SKY_REFLECTION

    translucent = nodes.new("ShaderNodeBsdfTranslucent")
    weight = nodes.new("ShaderNodeRGB")
    weight.outputs[0].default_value = tuple(CANOPY_BACK_LIGHT * math.pi / resolve for resolve in WORLD_KEY_RESOLVE) + (1,)
    weighted = nodes.new("ShaderNodeMixRGB")
    weighted.blend_type = "MULTIPLY"
    weighted.inputs[0].default_value = 1
    links.new(modulated.outputs["Color"], weighted.inputs[1])
    links.new(weight.outputs[0], weighted.inputs[2])
    links.new(weighted.outputs["Color"], translucent.inputs["Color"])
    links.new(shading_normal, translucent.inputs["Normal"])

    total = nodes.new("ShaderNodeAddShader")
    links.new(principled.outputs["BSDF"], total.inputs[0])
    links.new(translucent.outputs["BSDF"], total.inputs[1])
    final = total.outputs[0]
    alpha_input = principled.inputs["Alpha"]
    if alpha_input.is_linked:
        mask = alpha_input.links[0].from_socket
        links.remove(alpha_input.links[0])
        cutout = nodes.new("ShaderNodeMixShader")
        links.new(mask, cutout.inputs[0])
        links.new(nodes.new("ShaderNodeBsdfTransparent").outputs[0], cutout.inputs[1])
        links.new(total.outputs[0], cutout.inputs[2])
        final = cutout.outputs[0]
    output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
    links.new(final, output.inputs["Surface"])


def build_material(name, description, has_vertex_colors):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = material.node_tree.nodes["Principled BSDF"]
    set_linear_color(principled.inputs["Base Color"], description["color"])
    principled.inputs["Metallic"].default_value = description.get("metallic", 0)
    principled.inputs["Roughness"].default_value = description.get("roughness", 0.5)
    if description.get("tag") == "liquid":
        principled.inputs["Transmission Weight"].default_value = 1
        principled.inputs["IOR"].default_value = description["liquid"]["ior"]
    add_material_layers(material, principled, description)
    if description.get("emission", 0) > 0 and "graph" not in description:
        # 67js adds emissiveColor (the base colour when none is given) times emission to the pixel.
        emission_color = description.get("emissiveColor", description["color"])
        set_linear_color(principled.inputs["Emission Color"], emission_color)
        # NO_EMISSION=1 draws the scene without its emission, to measure how much of a Cycles picture is light from emissive parts (issue #392).
        principled.inputs["Emission Strength"].default_value = 0.0 if os.environ.get("NO_EMISSION") else description["emission"]
        if "emissiveMap" in description:
            add_emissive_map(material, principled, description, emission_color)
    if "graph" in description:
        add_graph(material, principled, description)
    elif "map" in description:
        add_texture(material, principled, description, has_vertex_colors)
    elif has_vertex_colors:
        add_vertex_colors(material, principled, description)
    if description.get("tag") == "foliage":
        add_canopy_leaf_model(material, principled)
    return material


def build_parts(scene, description):
    # Parts that share a geometry share one mesh, and each object carries its own material, so thousands of trees or towers
    # cost one copy of their vertices. A material is built once for every part that names it.
    meshes = {}
    materials = {}
    cloth_part_name = (description.get("blenderCloth") or {}).get("part")
    for index, part in enumerate(description["parts"]):
        # The sheet is drawn from Blender's own cloth bake (build_cloth), not from the 67js frame.
        if part["name"] == cloth_part_name:
            continue
        geometry_index = part["geometry"]
        geometry = description["geometries"][geometry_index]
        has_vertex_colors = geometry.get("colors") is not None
        if geometry_index not in meshes:
            meshes[geometry_index] = build_mesh(f"geometry-{geometry_index}", geometry)
            meshes[geometry_index].materials.append(None)
        material_key = (part["material"], has_vertex_colors)
        if material_key not in materials:
            materials[material_key] = build_material(f"material-{part['material']}", description["materials"][part["material"]], has_vertex_colors)
        mesh_object = bpy.data.objects.new(part["name"], meshes[geometry_index])
        mesh_object.material_slots[0].link = "OBJECT"
        mesh_object.material_slots[0].material = materials[material_key]
        column_major = part["matrix"]
        local = Matrix([[column_major[column * 4 + row] for column in range(4)] for row in range(4)])
        mesh_object.matrix_world = Y_UP_TO_Z_UP @ local
        scene.collection.objects.link(mesh_object)


def cloth_grid_object(settings):
    """The 67js grid (rows from the top down, columns left to right) at the sheet's rest placement, in world space."""
    segments = settings["segments"]
    column_major = settings["restMatrix"]
    placement = Y_UP_TO_Z_UP @ Matrix([[column_major[column * 4 + row] for column in range(4)] for row in range(4)])
    builder = bmesh.new()
    vertices = []
    for row in range(segments + 1):
        for column in range(segments + 1):
            local = Vector((column / segments - 0.5, 0.5 - row / segments, 0.0))
            vertices.append(builder.verts.new(placement @ local))
    for row in range(segments):
        for column in range(segments):
            first = row * (segments + 1) + column
            below = first + segments + 1
            builder.faces.new((vertices[first], vertices[below], vertices[below + 1], vertices[first + 1]))
    mesh = bpy.data.meshes.new("cloth-sim")
    builder.to_mesh(mesh)
    builder.free()
    return bpy.data.objects.new("cloth-sim", mesh)


def add_cloth_physics(scene, cloth_object, settings):
    modifier = cloth_object.modifiers.new("Cloth", "CLOTH")
    cloth = modifier.settings
    cloth.quality = 8
    cloth.mass = settings["vertexMass"]
    cloth.air_damping = settings["airDamping"]
    modifier.collision_settings.use_self_collision = False
    modifier.collision_settings.distance_min = 0.01
    modifier.point_cache.frame_start = 1
    modifier.point_cache.frame_end = scene.frame_end
    if settings["pinTopRow"]:
        group = cloth_object.vertex_groups.new(name="pin")
        group.add(list(range(settings["segments"] + 1)), 1.0, "REPLACE")
        cloth.vertex_group_mass = "pin"


def add_cloth_wind(settings):
    direction = Vector(to_blender(settings["windDirection"]))
    bpy.ops.object.effector_add(type="WIND", location=(0, 0, 0))
    wind = bpy.context.active_object
    wind.rotation_euler = direction.normalized().to_track_quat("Z", "X").to_euler()
    wind.field.strength = settings["windStrength"]


def build_cloth(scene, description):
    """Bake the sheet with Blender's cloth solver from rest to the scene's time, then keep that frame as a plain mesh.

    Each frame is stepped in order because the cloth cache needs that."""
    settings = description["blenderCloth"]
    part = next(entry for entry in description["parts"] if entry["name"] == settings["part"])
    scene.render.fps = settings["framesPerSecond"]
    scene.gravity = (0.0, 0.0, -9.81)
    target_frame = 1 + round(settings["seconds"] * settings["framesPerSecond"])
    scene.frame_start = 1
    scene.frame_end = target_frame
    for name in settings["colliders"]:
        collider = bpy.data.objects[name]
        collider.modifiers.new("Collision", "COLLISION")
        collider.collision.thickness_outer = 0.01
    cloth_object = cloth_grid_object(settings)
    scene.collection.objects.link(cloth_object)
    add_cloth_physics(scene, cloth_object, settings)
    if settings["windStrength"] > 0:
        add_cloth_wind(settings)
    for frame in range(1, target_frame + 1):
        scene.frame_set(frame)
    evaluated = cloth_object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    baked_mesh = bpy.data.meshes.new_from_object(evaluated)
    baked_mesh.shade_smooth()
    baked_mesh.materials.append(build_material("cloth", description["materials"][part["material"]], False))
    bpy.data.objects.remove(cloth_object)
    scene.collection.objects.link(bpy.data.objects.new("cloth", baked_mesh))


def gradient_sky_image(sky):
    """Sky colour by elevation: horizon to zenith above the horizon (raised to `power`), horizon to ground below it.

    grand-scenes.js (skyGradient) uses the same formula; its first row is the zenith, and Blender images start at the bottom."""
    import numpy
    width, height = 256, 128
    elevation = (numpy.arange(height) + 0.5) / height * math.pi - math.pi / 2
    sine = numpy.sin(elevation)
    above = numpy.clip(sine, 0, 1) ** sky["power"]
    below = numpy.clip(-sine * 4, 0, 1)
    horizon, zenith, ground = (numpy.array(sky[name]) for name in ("horizon", "zenith", "ground"))
    colors = horizon + (zenith - horizon) * above[:, None]
    colors = colors + (ground - colors) * below[:, None]
    pixels = numpy.ones((height, width, 4), dtype=numpy.float32)
    pixels[:, :, :3] = colors[:, None, :]
    image = bpy.data.images.new("gradient-sky", width, height, float_buffer=True)
    image.colorspace_settings.name = "Linear Rec.709"
    image.pixels.foreach_set(pixels.ravel())
    return image


def build_world(scene, world_description, root):
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    scene.world = world
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = nodes["Background"]
    if world_description["type"] == "constant":
        value = world_description["value"]
        background.inputs[0].default_value = (value, value, value, 1)
        background.inputs[1].default_value = 1
        return
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (0, 0, ENVIRONMENT_ROTATION_Z)
    texture = nodes.new("ShaderNodeTexEnvironment")
    if world_description["type"] == "gradient":
        # The same equirectangular gradient that grand-scenes.js hands to 67js, written as an image.
        texture.image = gradient_sky_image(world_description)
        links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        links.new(texture.outputs["Color"], background.inputs[0])
        background.inputs[1].default_value = 1
        return
    texture.image = bpy.data.images.load(os.path.join(root, world_description["file"]))
    links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    radiance_cap = nodes.new("ShaderNodeVectorMath")
    radiance_cap.operation = "MINIMUM"
    limit = world_description["radianceLimit"]
    radiance_cap.inputs[1].default_value = (limit, limit, limit)
    links.new(texture.outputs["Color"], radiance_cap.inputs[0])
    links.new(radiance_cap.outputs["Vector"], background.inputs[0])
    background.inputs[1].default_value = world_description["intensity"]


def link_receivers(light_object, names):
    # Light linking: a light with an affects list lights only those parts, as a receiver collection does. Shadows still
    # come from every part, which is also what 67js does.
    if names is None:
        return
    receivers = bpy.data.collections.new(f"{light_object.name}-receivers")
    for name in names:
        receivers.objects.link(bpy.data.objects[name])
    light_object.light_linking.receiver_collection = receivers


def build_lights(scene, environment):
    key = environment["keyColor"]
    if max(key) > 0:
        strength = max(key)
        light = bpy.data.lights.new("Sun", "SUN")
        light.energy = strength
        light.color = [channel / strength for channel in key]
        light.angle = SUN_ANGLE
        sun = bpy.data.objects.new("Sun", light)
        toward_light = Vector(to_blender(environment["lightDirection"])).normalized()
        sun.rotation_mode = "QUATERNION"
        sun.rotation_quaternion = toward_light.to_track_quat("Z", "Y")
        scene.collection.objects.link(sun)
        link_receivers(sun, environment.get("keyAffects"))
    for index, point in enumerate(environment["pointLights"]):
        light = bpy.data.lights.new(f"Point-{index}", "POINT")
        light.energy = point["intensity"] * WATTS_PER_INTENSITY
        light.color = point["color"]
        light.shadow_soft_size = point["radius"]
        point_object = bpy.data.objects.new(f"Point-{index}", light)
        point_object.location = to_blender(point["position"])
        scene.collection.objects.link(point_object)
        link_receivers(point_object, point.get("affects"))
    for index, spot in enumerate(environment.get("spotLights", [])):
        build_spot_light(scene, index, spot)
    for index, area in enumerate(environment.get("areaLights", [])):
        build_area_light(scene, index, area)


def build_spot_light(scene, index, spot):
    # A Blender spot light has the watts of a point light of the same strength, and its cone only masks that light.
    # Both use one cone mask: a smoothstep from the outer cosine to a penumbra fraction of the way to cosine 1.
    light = bpy.data.lights.new(f"Spot-{index}", "SPOT")
    light.energy = spot["intensity"] * WATTS_PER_INTENSITY
    light.color = spot["color"]
    light.shadow_soft_size = spot["radius"]
    light.spot_size = 2 * spot["angle"]
    light.spot_blend = spot["penumbra"]
    spot_object = bpy.data.objects.new(f"Spot-{index}", light)
    spot_object.location = to_blender(spot["position"])
    spot_object.rotation_mode = "QUATERNION"
    direction = Vector(to_blender(spot["direction"])).normalized()
    spot_object.rotation_quaternion = direction.to_track_quat("-Z", "Y")
    scene.collection.objects.link(spot_object)
    link_receivers(spot_object, spot.get("affects"))


def build_area_light(scene, index, area):
    # Measured on a white plane: a Blender area light of W watts matches a 67js area light of W / pi candela, and the
    # 67js formula stays within about 1.2 percent on the axis from 0.2 m to 2 m for 1 m and 2 m squares.
    light = bpy.data.lights.new(f"Area-{index}", "AREA")
    light.energy = area["intensity"] * WATTS_PER_AREA_INTENSITY
    light.color = area["color"]
    light.shape = "RECTANGLE"
    light.size = area["width"]
    light.size_y = area["height"]
    area_object = bpy.data.objects.new(f"Area-{index}", light)
    area_object.location = to_blender(area["position"])
    normal = Vector(to_blender(area["direction"])).normalized()
    up = Vector(to_blender(area.get("up", [0, 1, 0]))).normalized()
    width_axis = up.cross(normal)
    if width_axis.length < 1e-3:
        width_axis = Vector((1, 0, 0))
    width_axis.normalize()
    height_axis = width_axis.cross(normal)
    # The light shines toward its local -Z, and the 67js rectangle faces along its direction.
    rotation = Matrix((width_axis, height_axis, -normal)).transposed()
    area_object.rotation_mode = "QUATERNION"
    area_object.rotation_quaternion = rotation.to_quaternion()
    scene.collection.objects.link(area_object)


def build_fog(scene, fog):
    minimum = Vector(to_blender(fog["minimum"]))
    maximum = Vector(to_blender(fog["maximum"]))
    low = Vector(min(first, second) for first, second in zip(minimum, maximum))
    high = Vector(max(first, second) for first, second in zip(minimum, maximum))
    vertices = [(x, y, z) for x in (low.x, high.x) for y in (low.y, high.y) for z in (low.z, high.z)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new("Fog")
    mesh.from_pydata(vertices, [], faces)
    material = bpy.data.materials.new("Fog")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.remove(nodes["Principled BSDF"])
    scatter = nodes.new("ShaderNodeVolumeScatter")
    scatter.inputs["Color"].default_value = (*fog["color"], 1)
    scatter.inputs["Density"].default_value = fog["density"]
    scatter.inputs["Anisotropy"].default_value = fog["anisotropy"]
    material.node_tree.links.new(scatter.outputs[0], nodes["Material Output"].inputs["Volume"])
    mesh.materials.append(material)
    scene.collection.objects.link(bpy.data.objects.new("Fog", mesh))


def build_camera(scene, camera):
    data = bpy.data.cameras.new("Camera")
    data.sensor_fit = "VERTICAL"
    data.angle_y = math.radians(camera["fov"])
    data.clip_start = camera["near"]
    data.clip_end = camera["far"]
    camera_object = bpy.data.objects.new("Camera", data)
    eye = Vector(to_blender(camera["eye"]))
    target = Vector(to_blender(camera["target"]))
    camera_object.location = eye
    camera_object.rotation_mode = "QUATERNION"
    camera_object.rotation_quaternion = (target - eye).to_track_quat("-Z", "Y")
    scene.collection.objects.link(camera_object)
    scene.camera = camera_object


def configure_output(scene):
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.view_settings.view_transform = "Raw"
    scene.view_settings.look = "None"


def configure_cycles(scene):
    scene.render.engine = "CYCLES"
    if os.environ.get("CYCLES_DEVICE") == "CPU":
        # --no-gpu in run.mjs: the same renderer on the CPU, for when another job holds the GPU.
        scene.cycles.device = "CPU"
    else:
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "OPTIX"
        preferences.get_devices()
        for device in preferences.devices:
            device.use = device.type == "OPTIX"
        scene.cycles.device = "GPU"
    scene.cycles.samples = CYCLES_SAMPLES
    scene.cycles.use_denoising = True
    scene.cycles.volume_step_rate = 1
    # The default of 0 bounces drops multiple scattering, which makes dense fog much too dark.
    scene.cycles.volume_bounces = 8


def configure_eevee(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = EEVEE_SAMPLES
    scene.eevee.use_raytracing = True
    scene.eevee.volumetric_tile_size = "2"
    scene.eevee.volumetric_samples = 128


def render_to_numpy(scene, work_directory, name):
    path = os.path.join(work_directory, f"{name}.exr")
    scene.render.filepath = path
    started = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    seconds = time.perf_counter() - started
    image = bpy.data.images.load(path)
    pixels = np.empty(WIDTH * HEIGHT * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    linear = pixels.reshape(HEIGHT, WIDTH, 4)[::-1, :, :3]
    np.save(os.path.join(work_directory, f"{name}.npy"), linear)
    bpy.data.images.remove(image)
    os.remove(path)
    return seconds


def render_with_view_transform(scene, work_directory, name, view_transform):
    """Cycles with a Blender view transform (for example AgX) applied, saved as an 8-bit sRGB PNG, like the 67js picture: the picture a Blender user gets."""
    scene.view_settings.view_transform = view_transform
    scene.display_settings.display_device = "sRGB"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = os.path.join(work_directory, f"{name}.png")
    started = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    return time.perf_counter() - started


def render_passes(scene, work_directory, name):
    """A measurement switch: one undenoised Cycles render whose light components are kept apart in a multilayer EXR (issue #543)."""
    scene.cycles.use_denoising = False
    layer = scene.view_layers[0]
    layer.use_pass_diffuse_direct = True
    layer.use_pass_diffuse_indirect = True
    layer.use_pass_diffuse_color = True
    layer.use_pass_glossy_direct = True
    layer.use_pass_glossy_indirect = True
    layer.use_pass_glossy_color = True
    layer.use_pass_emit = True
    layer.use_pass_environment = True
    layer.cycles.use_pass_volume_direct = True
    layer.cycles.use_pass_volume_indirect = True
    scene.render.image_settings.media_type = "MULTI_LAYER_IMAGE"
    scene.render.image_settings.file_format = "OPEN_EXR_MULTILAYER"
    scene.render.filepath = os.path.join(work_directory, f"{name}.exr")
    started = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    return time.perf_counter() - started


def import_glb(root, glb_file):
    """A Khronos sample asset goes through Blender's own glTF importer, so Cycles shades the file as its authors meant."""
    bpy.ops.import_scene.gltf(filepath=os.path.join(root, glb_file))


def scale_world_light(scene, scale):
    """A measurement switch: the world's light times scale, like --ambient on the 67js side. The sky seen by the camera scales too."""
    background = scene.world.node_tree.nodes["Background"]
    background.inputs[1].default_value *= scale


def scale_sun_light(scene, scale):
    """A measurement switch: the sun's strength times scale, like --key on the 67js side."""
    for light in scene.collection.all_objects:
        if light.type == "LIGHT" and light.data.type == "SUN":
            light.data.energy *= scale


def limit_bounces(scene, bounces):
    """A measurement switch: every Cycles ray type stops after this many bounces (0 leaves direct light and the sky)."""
    scene.cycles.max_bounces = bounces
    scene.cycles.diffuse_bounces = bounces
    scene.cycles.glossy_bounces = bounces
    scene.cycles.transmission_bounces = bounces


def remove_glossy(scene):
    """A measurement switch: no reflections. Metallic, specular level and coat go to 0 and lose their links, so a metal draws as a diffuse surface of its base colour."""
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            for input_name in ("Metallic", "Specular IOR Level", "Coat Weight"):
                socket = node.inputs[input_name]
                for link in list(socket.links):
                    material.node_tree.links.remove(link)
                socket.default_value = 0


MATERIAL_ID_STEPS = 64


def render_material_ids(scene, work_directory, name):
    """Flat Workbench render with one red level per material, saved as an index map and the list of names in index order (1 first)."""
    names = sorted({slot.material.name for item in scene.objects if item.type == "MESH" for slot in item.material_slots if slot.material})
    for index, material_name in enumerate(names, start=1):
        bpy.data.materials[material_name].diffuse_color = (index / MATERIAL_ID_STEPS, 0, 0, 1)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.render_aa = "OFF"
    scene.view_settings.view_transform = "Raw"
    scene.world.color = (0, 0, 0)
    render_to_numpy(scene, work_directory, f"{name}-levels")
    levels = np.load(os.path.join(work_directory, f"{name}-levels.npy"))[:, :, 0]
    os.remove(os.path.join(work_directory, f"{name}-levels.npy"))
    np.save(os.path.join(work_directory, f"{name}.npy"), np.rint(levels * MATERIAL_ID_STEPS).astype(np.int16))
    with open(os.path.join(work_directory, f"{name}.json"), "w", encoding="utf-8") as file:
        json.dump(names, file)


def material_values():
    """The Principled values of every material as built: what a material import check compares with the 67js description."""
    values = {}
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                values[material.name] = {
                    "color": [round(channel, 4) for channel in node.inputs["Base Color"].default_value[:3]],
                    "roughness": round(node.inputs["Roughness"].default_value, 4),
                    "metallic": round(node.inputs["Metallic"].default_value, 4),
                    "specularLevel": round(node.inputs["Specular IOR Level"].default_value, 4),
                    "coat": round(node.inputs["Coat Weight"].default_value, 4),
                    "linked": [socket.name for socket in node.inputs if socket.links and socket.name in ("Base Color", "Roughness", "Metallic", "Specular IOR Level")],
                }
    return values


def paint_floor(scene, grey):
    """A measurement switch: the part named floor becomes a plain grey, so the light it bounces is known."""
    floor = scene.objects["floor"]
    for slot in floor.material_slots:
        principled = slot.material.node_tree.nodes["Principled BSDF"]
        for link in list(principled.inputs["Base Color"].links):
            slot.material.node_tree.links.remove(link)
        principled.inputs["Base Color"].default_value = (grey, grey, grey, 1)


def build_scene(description, root):
    clear_scene()
    scene_images[:] = description.get("images", [])
    built_images.clear()
    scene = bpy.context.scene
    if "glb" in description:
        import_glb(root, description["glb"])
    else:
        build_parts(scene, description)
        if description.get("blenderCloth"):
            build_cloth(scene, description)
    build_world(scene, description["world"], root)
    build_lights(scene, description["environment"])
    if "volumeFog" in description["environment"]:
        build_fog(scene, description["environment"]["volumeFog"])
    build_camera(scene, description["camera"])
    configure_output(scene)
    return scene


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    work_directory = os.path.abspath(arguments[0])
    world_scale = None
    if "--world-strength" in arguments:
        flag_index = arguments.index("--world-strength")
        world_scale = float(arguments[flag_index + 1])
        del arguments[flag_index:flag_index + 2]
    sun_scale = None
    if "--sun-strength" in arguments:
        flag_index = arguments.index("--sun-strength")
        sun_scale = float(arguments[flag_index + 1])
        del arguments[flag_index:flag_index + 2]
    bounces = None
    if "--max-bounces" in arguments:
        flag_index = arguments.index("--max-bounces")
        bounces = int(arguments[flag_index + 1])
        del arguments[flag_index:flag_index + 2]
    floor_grey = None
    if "--floor-color" in arguments:
        flag_index = arguments.index("--floor-color")
        floor_grey = float(arguments[flag_index + 1])
        del arguments[flag_index:flag_index + 2]
    no_glossy = "--no-glossy" in arguments
    if no_glossy:
        arguments.remove("--no-glossy")
    material_ids = "--material-ids" in arguments
    if material_ids:
        arguments.remove("--material-ids")
    print_materials = "--print-materials" in arguments
    if print_materials:
        arguments.remove("--print-materials")
    no_fog = "--no-fog" in arguments
    if no_fog:
        arguments.remove("--no-fog")
    passes = "--passes" in arguments
    if passes:
        arguments.remove("--passes")
    view_transform = None
    if "--view-transform" in arguments:
        flag_index = arguments.index("--view-transform")
        view_transform = arguments[flag_index + 1]
        del arguments[flag_index:flag_index + 2]
    only = set(arguments[1:])
    root = os.getcwd()
    timings = {}
    scene_directory = os.path.join(work_directory, "scenes")
    for file_name in sorted(os.listdir(scene_directory)):
        scene_id = file_name.removesuffix(".json")
        if only and scene_id not in only:
            continue
        with open(os.path.join(scene_directory, file_name), encoding="utf-8") as file:
            description = json.load(file)
        scene = build_scene(description, root)
        if print_materials:
            print("MATERIALS " + json.dumps({scene_id: material_values()}))
            continue
        if material_ids:
            render_material_ids(scene, work_directory, f"{scene_id}-materials")
            print(f"RENDERED {scene_id} material ids")
            continue
        if passes:
            configure_cycles(scene)
            seconds = render_passes(scene, work_directory, f"{scene_id}-passes")
            print(f"RENDERED {scene_id} as cycles passes: {seconds:.1f} s")
            continue
        if no_glossy:
            remove_glossy(scene)
            configure_cycles(scene)
            seconds = render_to_numpy(scene, work_directory, f"{scene_id}-cycles-noglossy")
            print(f"RENDERED {scene_id} as cycles without glossy: {seconds:.1f} s")
            continue
        if view_transform is not None:
            configure_cycles(scene)
            seconds = render_with_view_transform(scene, work_directory, f"{scene_id}-cycles-{view_transform.lower().replace(' ', '-')}", view_transform)
            print(f"RENDERED {scene_id} as cycles with {view_transform}: {seconds:.1f} s")
            continue
        if world_scale is not None or sun_scale is not None or bounces is not None or floor_grey is not None or no_fog:
            suffix = ""
            if no_fog and "Fog" in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects["Fog"])
                suffix += "-nofog"
            if bounces is not None:
                suffix += f"-bounces{bounces}"
            if floor_grey is not None:
                paint_floor(scene, floor_grey)
                suffix += f"-floor{floor_grey:g}"
            if world_scale is not None:
                scale_world_light(scene, world_scale)
                suffix += f"-world{world_scale:g}"
            if sun_scale is not None:
                scale_sun_light(scene, sun_scale)
                suffix += f"-sun{sun_scale:g}"
            configure_cycles(scene)
            if bounces is not None:
                limit_bounces(scene, bounces)
            seconds = render_to_numpy(scene, work_directory, f"{scene_id}-cycles{suffix}")
            print(f"RENDERED {scene_id} as cycles{suffix}: {seconds:.1f} s")
            continue
        configure_cycles(scene)
        cycles_seconds = render_to_numpy(scene, work_directory, f"{scene_id}-cycles")
        scene = build_scene(description, root)
        configure_eevee(scene)
        eevee_seconds = render_to_numpy(scene, work_directory, f"{scene_id}-eevee")
        timings[scene_id] = {"cycles": round(cycles_seconds, 1), "eevee": round(eevee_seconds, 1)}
        print(f"RENDERED {scene_id} {timings[scene_id]}")
    timings_path = os.path.join(work_directory, "blender-timings.json")
    if only and os.path.exists(timings_path):
        # A run of some scenes keeps the times of the others, so the scores of the whole directory still have them.
        with open(timings_path, encoding="utf-8") as file:
            timings = {**json.load(file)["seconds"], **timings}
    with open(timings_path, "w", encoding="utf-8") as file:
        json.dump({"blenderVersion": bpy.app.version_string, "seconds": timings}, file, indent=1)


main()
