"""Scenes the add-on checks build by script. Runs inside Blender (it imports bpy)."""
import math

import bpy
import numpy

CHECKER_SIZE = 128
CHECKER_CELLS = 8
ENVIRONMENT_WIDTH = 128
ENVIRONMENT_HEIGHT = 64


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def make_principled_material(name, base_color, roughness, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = material.node_tree.nodes["Principled BSDF"]
    principled.inputs["Base Color"].default_value = (*base_color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    return material


def make_checker_image(name):
    image = bpy.data.images.new(name, CHECKER_SIZE, CHECKER_SIZE, alpha=True)
    cell = CHECKER_SIZE // CHECKER_CELLS
    rows, columns = numpy.mgrid[0:CHECKER_SIZE, 0:CHECKER_SIZE]
    is_light = ((rows // cell) + (columns // cell)) % 2 == 0
    pixels = numpy.ones((CHECKER_SIZE, CHECKER_SIZE, 4), dtype=numpy.float32)
    pixels[is_light, :3] = (0.85, 0.8, 0.7)
    pixels[~is_light, :3] = (0.12, 0.25, 0.4)
    # A gradient across the columns so a flipped or rotated lookup shows in the picture.
    pixels[..., 0] *= numpy.linspace(0.6, 1.0, CHECKER_SIZE)[None, :]
    image.pixels.foreach_set(pixels.reshape(-1))
    image.pack()
    return image


def make_textured_material(name, roughness):
    material = make_principled_material(name, (0.8, 0.8, 0.8), roughness)
    nodes = material.node_tree.nodes
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = make_checker_image(f"{name}-checker")
    material.node_tree.links.new(texture.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    return material


def make_emissive_material(name, color, strength):
    material = make_principled_material(name, (0.0, 0.0, 0.0), 1.0)
    principled = material.node_tree.nodes["Principled BSDF"]
    principled.inputs["Emission Color"].default_value = (*color, 1.0)
    principled.inputs["Emission Strength"].default_value = strength
    return material


def add_object(scene, name, mesh_data, location, material=None):
    scene_object = bpy.data.objects.new(name, mesh_data)
    scene_object.location = location
    scene.collection.objects.link(scene_object)
    if material is not None:
        if not scene_object.data.materials:
            scene_object.data.materials.append(material)
    return scene_object


def make_mesh(kind, name):
    bpy.ops.object.select_all(action="DESELECT")
    if kind == "plane":
        bpy.ops.mesh.primitive_plane_add(size=10.0)
    elif kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=48, ring_count=24)
        bpy.ops.object.shade_smooth()
    else:
        bpy.ops.mesh.primitive_cube_add(size=0.4)
    template = bpy.context.active_object
    mesh_data = template.data
    mesh_data.name = name
    bpy.data.objects.remove(template)
    return mesh_data


def add_light(scene, name, light_type, location, energy, rotation=(0.0, 0.0, 0.0)):
    light_data = bpy.data.lights.new(name, light_type)
    light_data.energy = energy
    light_object = bpy.data.objects.new(name, light_data)
    light_object.location = location
    light_object.rotation_euler = rotation
    scene.collection.objects.link(light_object)
    return light_object


def sky_gradient(rows):
    pixels = numpy.ones((ENVIRONMENT_HEIGHT, ENVIRONMENT_WIDTH, 4), dtype=numpy.float32)
    pixels[..., 0] = 0.15 + 0.35 * rows
    pixels[..., 1] = 0.22 + 0.4 * rows
    pixels[..., 2] = 0.4 + 0.5 * rows
    return pixels


def add_broad_glow(pixels):
    """A warm lobe 30 degrees above the horizon toward Blender's +Y, about 18 degrees wide: orientation shows, and no pixel is a point source."""
    columns = (numpy.arange(ENVIRONMENT_WIDTH) + 0.5) / ENVIRONMENT_WIDTH
    rows = (numpy.arange(ENVIRONMENT_HEIGHT) + 0.5) / ENVIRONMENT_HEIGHT
    azimuth = (0.5 - columns[None, :]) * 2.0 * math.pi
    elevation = (rows[:, None] - 0.5) * math.pi
    directions = numpy.stack([
        numpy.cos(elevation) * numpy.cos(azimuth),
        numpy.cos(elevation) * numpy.sin(azimuth),
        numpy.sin(elevation) * numpy.ones_like(azimuth),
    ], axis=-1)
    center = numpy.array([0.0, math.cos(math.radians(30.0)), math.sin(math.radians(30.0))])
    angle = numpy.arccos(numpy.clip(directions @ center, -1.0, 1.0))
    lobe = 12.0 * numpy.exp(-0.5 * (angle / math.radians(18.0)) ** 2)
    pixels[..., :3] += lobe[..., None] * numpy.array([1.0, 0.85, 0.6])


def add_small_patch(pixels):
    """The same direction as a patch of a few pixels: a small bright source, the hard case for environment sampling."""
    # Blender maps +Y to U = 0.25 (0.5 is +X); the patch sits there, at 30 degrees above the horizon.
    patch_column = int(0.25 * ENVIRONMENT_WIDTH)
    patch_row = int((0.5 + 30.0 / 180.0) * ENVIRONMENT_HEIGHT)
    pixels[patch_row - 3:patch_row + 3, patch_column - 4:patch_column + 4, :3] = (30.0, 26.0, 20.0)


def make_environment_image(kind):
    image = bpy.data.images.new("sky", ENVIRONMENT_WIDTH, ENVIRONMENT_HEIGHT, alpha=True, float_buffer=True)
    pixels = sky_gradient(numpy.linspace(0.0, 1.0, ENVIRONMENT_HEIGHT)[:, None])
    if kind == "hdri":
        add_broad_glow(pixels)
    else:
        add_small_patch(pixels)
    image.pixels.foreach_set(pixels.reshape(-1))
    return image


def set_hdri_world(scene, kind):
    world = bpy.data.worlds.new("Sky")
    world.use_nodes = True
    scene.world = world
    nodes = world.node_tree.nodes
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = make_environment_image(kind)
    world.node_tree.links.new(environment.outputs["Color"], nodes["Background"].inputs["Color"])
    nodes["Background"].inputs["Strength"].default_value = 1.0


def set_constant_world(scene, color, strength):
    world = bpy.data.worlds.new("Dusk")
    world.use_nodes = True
    scene.world = world
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (*color, 1.0)
    background.inputs["Strength"].default_value = strength


def make_data_image(name, pixels):
    """A packed image read as data (Non-Color); the colour space is set before the pixels, which changing it afterwards would drop."""
    height, width, _ = pixels.shape
    image = bpy.data.images.new(name, width, height, alpha=True)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels.astype(numpy.float32).reshape(-1))
    image.pack()
    return image


def link_image(material, image, output_name, input_name):
    nodes = material.node_tree.nodes
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    material.node_tree.links.new(texture.outputs[output_name], nodes["Principled BSDF"].inputs[input_name])
    return texture


def bump_normal_pixels(size=64, tiles=6, slope=1.5):
    coordinates = (numpy.arange(size) + 0.5) / size
    u_values, v_values = numpy.meshgrid(coordinates, coordinates)
    slope_u = slope * numpy.cos(2.0 * math.pi * tiles * u_values) * numpy.sin(2.0 * math.pi * tiles * v_values)
    slope_v = slope * numpy.sin(2.0 * math.pi * tiles * u_values) * numpy.cos(2.0 * math.pi * tiles * v_values)
    normals = numpy.stack([-slope_u, -slope_v, numpy.ones_like(slope_u)], axis=-1)
    normals /= numpy.linalg.norm(normals, axis=-1, keepdims=True)
    pixels = numpy.ones((size, size, 4), dtype=numpy.float32)
    pixels[..., :3] = normals * 0.5 + 0.5
    return pixels


def add_map_materials(scene):
    """Images on Roughness (floor), Normal (the balls) and Alpha (a screen with square holes)."""
    columns = numpy.linspace(0.08, 0.9, 128)[None, :, None] * numpy.ones((128, 1, 4))
    link_image(bpy.data.materials["Floor"], make_data_image("roughness-ramp", columns), "Color", "Roughness")
    clay = bpy.data.materials["Clay"]
    normal_node = clay.node_tree.nodes.new("ShaderNodeNormalMap")
    texture = clay.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = make_data_image("bumps", bump_normal_pixels())
    clay.node_tree.links.new(texture.outputs["Color"], normal_node.inputs["Color"])
    clay.node_tree.links.new(normal_node.outputs["Normal"], clay.node_tree.nodes["Principled BSDF"].inputs["Normal"])
    cell = 16
    rows, columns_grid = numpy.mgrid[0:128, 0:128]
    solid = ((rows // cell) + (columns_grid // cell)) % 2 == 0
    cutout = numpy.ones((128, 128, 4), dtype=numpy.float32)
    cutout[..., :3] = (0.95, 0.55, 0.1)
    cutout[~solid, 3] = 0.0
    screen_material = make_principled_material("Screen", (0.8, 0.8, 0.8), 0.5)
    cutout_image = bpy.data.images.new("screen-cutout", 128, 128, alpha=True)
    cutout_image.pixels.foreach_set(cutout.reshape(-1))
    cutout_image.pack()
    texture = link_image(screen_material, cutout_image, "Color", "Base Color")
    screen_material.node_tree.links.new(texture.outputs["Alpha"], screen_material.node_tree.nodes["Principled BSDF"].inputs["Alpha"])
    screen = add_object(scene, "Screen", make_mesh("plane", "ScreenMesh"), (-2.4, 1.5, 1.0), screen_material)
    screen.scale = (0.12, 0.12, 0.12)
    screen.rotation_euler = (math.radians(90.0), 0.0, math.radians(-20.0))


def build_small_scene(variant="small", width=480, height=270):
    """A floor with a checker image on its base colour, three objects sharing one sphere mesh, an emissive cube, lights and a camera.

    `variant` "hdri" lights it with an environment image alone (a broad warm lobe); "hdri-patch" uses a small bright patch instead; "maps" adds
    images on Roughness, Normal and Alpha to the small scene."""
    scene = clear_scene()
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    clay = make_principled_material("Clay", (0.8, 0.3, 0.2), 0.4)
    floor_mesh = make_mesh("plane", "FloorMesh")
    ball_mesh = make_mesh("sphere", "BallMesh")
    cube_mesh = make_mesh("cube", "GlowMesh")
    add_object(scene, "Floor", floor_mesh, (0.0, 0.0, 0.0), make_textured_material("Floor", 0.6))
    for index, x_position in enumerate((-1.5, 0.0, 1.5)):
        add_object(scene, f"Ball{index}", ball_mesh, (x_position, 0.5 * index, 0.5), clay)
    add_object(scene, "Glow", cube_mesh, (0.0, -1.2, 0.2), make_emissive_material("Glow", (1.0, 0.6, 0.2), 15.0))
    camera_data = bpy.data.cameras.new("Camera")
    camera_data.lens = 35.0
    camera_object = bpy.data.objects.new("Camera", camera_data)
    camera_object.location = (0.0, -6.0, 2.5)
    camera_object.rotation_euler = (math.radians(75.0), 0.0, 0.0)
    scene.collection.objects.link(camera_object)
    scene.camera = camera_object
    if variant in ("hdri", "hdri-patch"):
        set_hdri_world(scene, variant)
        return scene
    if variant == "maps":
        add_map_materials(scene)
    sun = add_light(scene, "Sun", "SUN", (0.0, 0.0, 5.0), 3.0, (math.radians(50.0), 0.0, math.radians(30.0)))
    sun.data.angle = 0.05
    add_light(scene, "Lamp", "POINT", (2.0, -2.0, 3.0), 400.0).data.shadow_soft_size = 0.1
    set_constant_world(scene, (0.05, 0.07, 0.1), 1.0)
    return scene
