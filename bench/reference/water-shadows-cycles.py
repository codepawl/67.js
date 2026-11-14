# Cycles reference of the water shadow pool (scripts/water-shadow-scene.js, issue #349): a post in a 12 m pool seen from above,
# the water a box of volume absorption and scatter. Reads cases.json from scripts/score-water-shadows.mjs and writes <name>.npy
# (linear RGB, rows from the top) for each case.
#   blender -b --factory-startup -t 6 --python bench/reference/water-shadows-cycles.py -- <cases.json> <output directory>
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ALBEDO = 0.3
POST_ALBEDO = (0.6, 0.4, 0.3)
POOL_SIZE = 12.0
POST_TOP = 1.5
POST_WIDTH = 0.5
SUN_DIRECTION_CRUCIBLE = (-0.6, 1.0, 0.0)
CAMERA_HEIGHT = 12.0


def to_blender(point):
    """Crucible is y up; Blender is z up: (x, y, z) becomes (x, -z, y)."""
    return Vector((point[0], -point[2], point[1]))


def diffuse_material(name, color):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    shader.inputs["Specular IOR Level"].default_value = 0.0
    return material


def volume_material(absorption, scatter_density):
    material = bpy.data.materials.new("water")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.remove(nodes["Principled BSDF"])
    output = nodes["Material Output"]
    density = max(max(absorption), 1.0)
    absorb = nodes.new("ShaderNodeVolumeAbsorption")
    absorb.inputs["Color"].default_value = (*[1.0 - channel / density for channel in absorption], 1.0)
    absorb.inputs["Density"].default_value = density
    scatter = nodes.new("ShaderNodeVolumeScatter")
    scatter.inputs["Color"].default_value = (0.8, 0.85, 0.85, 1.0)
    scatter.inputs["Density"].default_value = scatter_density
    add = nodes.new("ShaderNodeAddShader")
    links.new(absorb.outputs[0], add.inputs[0])
    links.new(scatter.outputs[0], add.inputs[1])
    links.new(add.outputs[0], output.inputs["Volume"])
    return material


def add_box(name, center, size, material):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=to_blender(center))
    box = bpy.context.active_object
    box.name = name
    box.scale = (size[0], size[2], size[1])
    box.data.materials.append(material)
    return box


def build_scene(case, calibration, width, height):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.volume_bounces = 8
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    depth = case["depth"]
    # The sky and sun are set from the dry bed Crucible measured: the shadowed bed is albedo times the sky, the lit bed adds the sun.
    sky = float(np.mean(calibration["shadowed"])) / ALBEDO
    cosine = SUN_DIRECTION_CRUCIBLE[1] / math.hypot(SUN_DIRECTION_CRUCIBLE[0], SUN_DIRECTION_CRUCIBLE[1])
    sun_strength = (float(np.mean(calibration["lit"])) - float(np.mean(calibration["shadowed"]))) * math.pi / (ALBEDO * cosine)
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (sky, sky, sky, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = sun_strength
    sun_object = bpy.data.objects.new("sun", sun)
    scene.collection.objects.link(sun_object)
    sun_object.rotation_euler = to_blender(SUN_DIRECTION_CRUCIBLE).to_track_quat("Z", "Y").to_euler()

    add_box("bed", (0, -depth - 0.5, 0), (POOL_SIZE, 1.0, POOL_SIZE), diffuse_material("bed", (ALBEDO,) * 3))
    add_box("post", (0, (POST_TOP - depth) / 2, 0), (POST_WIDTH, POST_TOP + depth, POST_WIDTH), diffuse_material("post", POST_ALBEDO))
    if case["absorption"] is not None:
        # The volume stops 1 mm above the bed so the two surfaces never share a face.
        thickness = depth - 0.001
        add_box("water", (0, -thickness / 2, 0), (POOL_SIZE, thickness, POOL_SIZE), volume_material(case["absorption"], case["turbidity"]))

    camera_data = bpy.data.cameras.new("camera")
    camera_data.sensor_fit = "VERTICAL"
    camera_data.lens_unit = "FOV"
    camera_data.angle_y = math.radians(40)
    camera = bpy.data.objects.new("camera", camera_data)
    camera.location = to_blender((0, CAMERA_HEIGHT, 0))
    scene.collection.objects.link(camera)
    scene.camera = camera


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    plan = json.loads(Path(arguments[0]).read_text(encoding="utf-8"))
    output = Path(arguments[1])
    output.mkdir(parents=True, exist_ok=True)
    for case in plan["cases"]:
        build_scene(case, plan["calibration"], plan["width"], plan["height"])
        exr_path = output / f"{case['name']}.exr"
        bpy.context.scene.render.filepath = str(exr_path)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(exr_path))
        image.colorspace_settings.name = "Non-Color"
        pixels = np.array(image.pixels[:], dtype=np.float32).reshape(plan["height"], plan["width"], 4)[:, :, :3]
        np.save(output / f"{case['name']}.npy", pixels[::-1])
        print("rendered", case["name"], flush=True)


main()
