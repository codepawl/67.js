"""Blender materials to Cook material entries.

Reads the Principled BSDF that feeds the active material output (also a lone Diffuse or Emission shader). A socket is a constant
or an Image Texture node linked directly to it; anything else is replaced by the socket's constant value and recorded once in
`notes` under the material name, so the render log can say what was approximated.
"""
import base64
import os

import numpy

from . import blender_conversions as conversions

GREY_ALBEDO = 0.8
ALPHA_CUTOFF = 0.5
FALLBACK_ROUGHNESS = 0.5
SRGB = "srgb"
LINEAR = "linear"


def grey_entry():
    return {"tag": "surface", "color": [GREY_ALBEDO] * 3, "metallic": 0, "roughness": 0.5, "specular": 1.0, "emission": 0}


def linked_source(socket):
    """The node and output socket feeding `socket`, looking through Reroute nodes; (None, None) when nothing valid is linked."""
    while socket.is_linked:
        link = socket.links[0]
        if link.is_muted or not link.is_valid:
            return None, None
        node = link.from_node
        if node.type == "REROUTE":
            socket = node.inputs[0]
            continue
        return node, link.from_socket
    return None, None


def srgb_encode(linear_values):
    clipped = numpy.clip(linear_values, 0.0, 1.0)
    return numpy.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * numpy.power(clipped, 1.0 / 2.4) - 0.055)


def rgb_of(socket_value):
    return [float(socket_value[0]), float(socket_value[1]), float(socket_value[2])]


class MaterialExporter:
    def __init__(self):
        self.entries = []
        self.images = []
        self.notes = {}
        self._index_by_material = {}
        self._index_by_image = {}

    # ---- Table access ----

    def index_for(self, material):
        key = "" if material is None else material.name_full
        if key not in self._index_by_material:
            self._index_by_material[key] = len(self.entries)
            self.entries.append(grey_entry() if material is None else self.convert_material(material))
        return self._index_by_material[key]

    def note(self, material_name, text):
        conversions.note_once(self.notes, material_name, text)

    # ---- Images ----

    def _register_image(self, key, pixels_top_first_uint8):
        if key not in self._index_by_image:
            height, width, _ = pixels_top_first_uint8.shape
            self._index_by_image[key] = len(self.images)
            self.images.append({
                "width": width,
                "height": height,
                "data": {"type": "Uint8ClampedArray", "base64": base64.b64encode(pixels_top_first_uint8.tobytes()).decode("ascii")},
            })
        return self._index_by_image[key]

    @staticmethod
    def _texture_descriptor(image_index, color_space):
        return {"image": {"imageId": image_index}, "colorSpace": color_space}

    @staticmethod
    def read_image_floats(image):
        """Returns (height, width, 4) floats, first row at the top, in the values the file stores (before any colour transform)."""
        width, height = image.size[0], image.size[1]
        flat = numpy.empty(width * height * 4, dtype=numpy.float32)
        image.pixels.foreach_get(flat)
        return flat.reshape(height, width, 4)[::-1]

    def texture_from_image(self, material_name, image, color_space):
        if image.size[0] == 0 or image.size[1] == 0:
            self.note(material_name, f"image {image.name} has no pixels (missing file?); the constant value is used")
            return None
        key = (image.name_full, color_space)
        if key not in self._index_by_image:
            values = self.read_image_floats(image)
            if color_space == SRGB and image.is_float:
                encoded = values.copy()
                encoded[..., :3] = srgb_encode(values[..., :3])
                values = encoded
            quantized = numpy.rint(numpy.clip(values, 0.0, 1.0) * 255.0).astype(numpy.uint8)
            self._register_image(key, quantized)
        return self._texture_descriptor(self._index_by_image[key], color_space)

    def scalar_texture_pixels(self, image):
        """Luminance of an image read as data (Blender converts a colour to a number this way), (height, width) floats."""
        values = self.read_image_floats(image)[..., :3]
        return values[..., 0] * conversions.LUMINANCE_WEIGHTS[0] + values[..., 1] * conversions.LUMINANCE_WEIGHTS[1] + values[..., 2] * conversions.LUMINANCE_WEIGHTS[2]

    # ---- Sockets ----

    def check_image_node(self, material_name, node):
        if node.projection != "FLAT":
            self.note(material_name, f"image node {node.name} uses {node.projection} projection; read as a flat UV lookup")
        if node.interpolation == "Closest":
            self.note(material_name, f"image node {node.name} uses Closest interpolation; Cook filters linearly")
        if node.extension != "REPEAT":
            self.note(material_name, f"image node {node.name} uses extension {node.extension}; Cook repeats the image")
        if node.inputs["Vector"].is_linked:
            self.note(material_name, f"image node {node.name} has a Vector input; the first UV map without a mapping is used")

    def read_color(self, material_name, socket, label):
        """Returns (constant colour, image node or None). A linked source other than an Image Texture colour becomes the constant."""
        constant = rgb_of(socket.default_value)
        source_node, source_socket = linked_source(socket)
        if source_node is None:
            if socket.is_linked:
                self.note(material_name, f"{label} has a muted or invalid link; the constant {constant} is used")
            return constant, None
        if source_node.type == "TEX_IMAGE" and source_socket.name == "Color" and source_node.image is not None:
            self.check_image_node(material_name, source_node)
            return constant, source_node
        self.note(material_name, f"{label} is driven by a {source_node.type} node, which Cook does not read; the constant {[round(value, 3) for value in constant]} is used")
        return constant, None

    def read_scalar(self, material_name, socket, label):
        """Returns (constant, image node or None); an image node gives the number through its colour or alpha output."""
        constant = float(socket.default_value)
        source_node, source_socket = linked_source(socket)
        if source_node is None:
            if socket.is_linked:
                self.note(material_name, f"{label} has a muted or invalid link; the constant {constant:g} is used")
            return constant, None, None
        if source_node.type == "TEX_IMAGE" and source_socket.name in ("Color", "Alpha") and source_node.image is not None:
            self.check_image_node(material_name, source_node)
            return constant, source_node, source_socket.name
        self.note(material_name, f"{label} is driven by a {source_node.type} node, which Cook does not read; the constant {constant:g} is used")
        return constant, None, None

    def read_constant(self, material_name, node, input_name, label):
        socket = node.inputs.get(input_name)
        if socket is None:
            return 0.0
        if socket.is_linked:
            self.note(material_name, f"{label} is linked; Cook reads only its constant value {float(socket.default_value):g}")
        return float(socket.default_value)

    def color_space_of(self, image_node):
        return LINEAR if image_node.image.colorspace_settings.name == "Non-Color" else SRGB

    # ---- Materials ----

    def convert_material(self, material):
        name = material.name_full
        surface_node = self.find_surface_node(material)
        if surface_node is None:
            self.note(name, "no node tree or no shader linked to the Material Output; the viewport colour is used as a diffuse material")
            return self.fallback_entry(material)
        self.report_unread_outputs(material, name)
        if surface_node.type == "BSDF_PRINCIPLED":
            return self.convert_principled(name, surface_node)
        if surface_node.type == "EMISSION":
            return self.convert_emission(name, surface_node)
        if surface_node.type == "BSDF_DIFFUSE":
            return self.convert_diffuse(name, surface_node)
        self.note(name, f"surface is a {surface_node.type} node, which Cook does not read; the viewport colour is used as a diffuse material")
        return self.fallback_entry(material)

    @staticmethod
    def find_surface_node(material):
        node_tree = material.node_tree
        if node_tree is None:
            return None
        output_node = node_tree.get_output_node("CYCLES") or node_tree.get_output_node("ALL")
        if output_node is None:
            return None
        node, _ = linked_source(output_node.inputs["Surface"])
        return node

    def report_unread_outputs(self, material, name):
        output_node = material.node_tree.get_output_node("CYCLES") or material.node_tree.get_output_node("ALL")
        if output_node.inputs["Volume"].is_linked:
            self.note(name, "a volume shader is linked to the output; Cook ignores volumes in this release")
        if output_node.inputs["Displacement"].is_linked:
            self.note(name, "displacement is linked to the output; Cook does not displace geometry in this release")

    @staticmethod
    def fallback_entry(material):
        entry = grey_entry()
        entry["color"] = rgb_of(material.diffuse_color)
        entry["roughness"] = FALLBACK_ROUGHNESS
        return entry

    def convert_diffuse(self, name, node):
        entry = {"tag": "surface", "metallic": 0, "roughness": 1, "specular": 0, "emission": 0}
        self.apply_base_color(name, node, entry)
        return entry

    def convert_emission(self, name, node):
        color, color_node = self.read_color(name, node.inputs["Color"], "Emission Color")
        strength = self.read_constant(name, node, "Strength", "Emission Strength")
        entry = {"tag": "surface", "color": [0.0, 0.0, 0.0], "metallic": 0, "roughness": 1, "specular": 0, "emission": strength, "emissiveColor": color}
        if color_node is not None:
            texture = self.texture_from_image(name, color_node.image, self.color_space_of(color_node))
            if texture is not None:
                entry["emissiveMap"] = texture
                entry["emissiveColor"] = [1.0, 1.0, 1.0]
        return entry

    def apply_base_color(self, name, node, entry):
        """Sets the colour (and map) of the entry; returns the image node that feeds it, or None."""
        color, color_node = self.read_color(name, node.inputs["Color" if node.type == "BSDF_DIFFUSE" else "Base Color"], "Base Color")
        entry["color"] = color
        if color_node is None:
            return None
        texture = self.texture_from_image(name, color_node.image, self.color_space_of(color_node))
        if texture is None:
            return None
        entry["map"] = texture
        entry["color"] = [1.0, 1.0, 1.0]
        return color_node

    def convert_principled(self, name, node):
        entry = {"tag": "surface"}
        base_image_node = self.apply_base_color(name, node, entry)
        self.apply_metallic_roughness(name, node, entry)
        self.apply_alpha(name, node, entry, base_image_node)
        self.apply_normal(name, node, entry)
        self.apply_emission(name, node, entry)
        entry["ior"] = self.read_constant(name, node, "IOR", "IOR")
        entry["specular"] = 2.0 * self.read_constant(name, node, "Specular IOR Level", "Specular IOR Level")
        transmission = self.read_constant(name, node, "Transmission Weight", "Transmission Weight")
        if transmission > 0.0:
            entry["transmission"] = transmission
        coat = self.read_constant(name, node, "Coat Weight", "Coat Weight")
        if coat > 0.0:
            entry["clearcoat"] = coat
            entry["clearcoatRoughness"] = self.read_constant(name, node, "Coat Roughness", "Coat Roughness")
        self.report_ignored_layers(name, node)
        return entry

    def report_ignored_layers(self, name, node):
        for input_name in ("Sheen Weight", "Subsurface Weight", "Anisotropic", "Thin Film Thickness"):
            socket = node.inputs.get(input_name)
            if socket is not None and (socket.is_linked or socket.default_value > 0.0):
                self.note(name, f"{input_name} is set, which Cook does not read in this release; it is left out")
        specular_tint = node.inputs.get("Specular Tint")
        if specular_tint is not None and any(abs(channel - 1.0) > 1e-3 for channel in specular_tint.default_value[:3]):
            self.note(name, "Specular Tint is not white, which Cook does not read in this release; it is left out")

    def apply_metallic_roughness(self, name, node, entry):
        metallic, metallic_node, metallic_output = self.read_scalar(name, node.inputs["Metallic"], "Metallic")
        roughness, roughness_node, roughness_output = self.read_scalar(name, node.inputs["Roughness"], "Roughness")
        entry["metallic"] = metallic
        entry["roughness"] = roughness
        if metallic_node is None and roughness_node is None:
            return
        if "Alpha" in (metallic_output, roughness_output):
            self.note(name, "Metallic or Roughness reads an image alpha output; the alpha is not used and the constant is kept")
            return
        pixel_grids = {}
        for label, image_node in (("roughness", roughness_node), ("metallic", metallic_node)):
            if image_node is not None:
                pixel_grids[label] = self.scalar_texture_pixels(image_node.image)
        shapes = {grid.shape for grid in pixel_grids.values()}
        if len(shapes) > 1:
            self.note(name, "Metallic and Roughness images differ in size; the Metallic image is left out and its constant is used")
            pixel_grids.pop("metallic")
        height, width = next(iter(pixel_grids.values())).shape
        packed = numpy.ones((height, width, 4), dtype=numpy.float32)
        packed[..., 1] = pixel_grids.get("roughness", numpy.full((height, width), roughness, dtype=numpy.float32))
        packed[..., 2] = pixel_grids.get("metallic", numpy.full((height, width), metallic, dtype=numpy.float32))
        quantized = numpy.rint(numpy.clip(packed, 0.0, 1.0) * 255.0).astype(numpy.uint8)
        key = ("metallic-roughness", tuple(sorted((label, ("" if image_node is None else image_node.image.name_full)) for label, image_node in (("roughness", roughness_node), ("metallic", metallic_node)))), roughness, metallic)
        image_index = self._register_image(key, quantized)
        entry["metallicRoughnessMap"] = self._texture_descriptor(image_index, LINEAR)
        entry["metallic"] = 1.0
        entry["roughness"] = 1.0

    def apply_alpha(self, name, node, entry, base_image_node):
        alpha, alpha_node, alpha_output = self.read_scalar(name, node.inputs["Alpha"], "Alpha")
        if alpha_node is None:
            if alpha < 1.0:
                entry["alphaMode"] = "blend"
                entry["opacity"] = alpha
            return
        entry["alphaMode"] = "mask"
        entry["alphaCutoff"] = ALPHA_CUTOFF
        self.note(name, f"Alpha comes from image {alpha_node.image.name}; Cook cuts it out at {ALPHA_CUTOFF} instead of blending")
        if alpha_node is base_image_node and alpha_output == "Alpha":
            return
        key = (alpha_node.image.name_full, "alpha-" + (alpha_output or ""))
        grid = self.scalar_texture_pixels(alpha_node.image) if alpha_output == "Color" else self.read_image_floats(alpha_node.image)[..., 3]
        quantized = numpy.rint(numpy.clip(numpy.stack([grid, grid, grid, numpy.ones_like(grid)], axis=-1), 0.0, 1.0) * 255.0).astype(numpy.uint8)
        entry["alphaMap"] = self._texture_descriptor(self._register_image(key, quantized), LINEAR)

    def apply_normal(self, name, node, entry):
        normal_socket = node.inputs["Normal"]
        if not normal_socket.is_linked:
            return
        source_node, _ = linked_source(normal_socket)
        if source_node is None or source_node.type != "NORMAL_MAP" or source_node.space != "TANGENT":
            kind = "nothing valid" if source_node is None else source_node.type
            self.note(name, f"Normal is driven by {kind}; only a tangent-space Normal Map fed by an image is read, so the surface normal is left unperturbed")
            return
        image_node, _ = linked_source(source_node.inputs["Color"])
        if image_node is None or image_node.type != "TEX_IMAGE" or image_node.image is None:
            self.note(name, "the Normal Map node is not fed directly by an Image Texture; the surface normal is left unperturbed")
            return
        self.check_image_node(name, image_node)
        texture = self.texture_from_image(name, image_node.image, LINEAR)
        if texture is None:
            return
        strength = float(source_node.inputs["Strength"].default_value)
        if os.environ.get("COOK_EXPERIMENT_FLIP_GREEN") == "1":
            self.invert_green_of_last_image()
        entry["normalMap"] = texture
        entry["normalScale"] = [strength, strength]
        if source_node.inputs["Strength"].is_linked:
            self.note(name, f"Normal Map strength is linked; the constant {strength:g} is used")

    def invert_green_of_last_image(self):
        raw = base64.b64decode(self.images[-1]["data"]["base64"])
        pixels = numpy.frombuffer(raw, dtype=numpy.uint8).copy().reshape(-1, 4)
        pixels[:, 1] = 255 - pixels[:, 1]
        self.images[-1]["data"]["base64"] = base64.b64encode(pixels.tobytes()).decode("ascii")

    def apply_emission(self, name, node, entry):
        strength = self.read_constant(name, node, "Emission Strength", "Emission Strength")
        color, color_node = self.read_color(name, node.inputs["Emission Color"], "Emission Color")
        if strength <= 0.0 or (color_node is None and not any(color)):
            entry["emission"] = 0
            return
        entry["emission"] = strength
        entry["emissiveColor"] = color
        if color_node is not None:
            texture = self.texture_from_image(name, color_node.image, self.color_space_of(color_node))
            if texture is not None:
                entry["emissiveMap"] = texture
                entry["emissiveColor"] = [1.0, 1.0, 1.0]
