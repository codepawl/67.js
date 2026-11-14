# Builds bench/reference/line-art-scene.json in Blender 5.2 and renders it twice, without and with Freestyle lines.
#   blender --background --factory-startup -t 6 --python bench/reference/line-art-blender.py -- <scene json> <output directory> <width> <height> <line width in pixels>
# Files are <output directory>/blender-off.png and blender-on.png. Blender's Line Art modifier needs its bake operator, which
# is missing in background mode, so the outlines come from Freestyle (silhouette, border and crease edges, crease angle 35).
import json
import math
import sys

import bpy
from mathutils import Vector

sceneFile, outputDirectory, width, height, lineWidth = sys.argv[sys.argv.index("--") + 1:]
width = int(width)
height = int(height)
lineWidth = float(lineWidth)
recipe = json.load(open(sceneFile))


def toBlender(vector):
    # Crucible is Y up, Blender is Z up.
    return Vector((vector[0], -vector[2], vector[1]))


def scaleToBlender(vector):
    return Vector((vector[0], vector[2], vector[1]))


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x = width
scene.render.resolution_y = height
scene.render.resolution_percentage = 100
# Cycles on the CPU with few samples: the lines come from Freestyle, and this keeps the GPU free for other sessions.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.cycles.use_denoising = False
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
skyColor = recipe["environment"]["skyTop"]
world.node_tree.nodes["Background"].inputs["Color"].default_value = (*skyColor, 1.0)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8

materials = {}
for material in recipe["materials"]:
    blenderMaterial = bpy.data.materials.new(material["id"])
    blenderMaterial.use_nodes = True
    principled = blenderMaterial.node_tree.nodes["Principled BSDF"]
    principled.inputs["Base Color"].default_value = (*material["color"], 1.0)
    principled.inputs["Roughness"].default_value = material.get("roughness", 0.5)
    materials[material["id"]] = blenderMaterial

geometryTypes = {geometry["id"]: geometry["type"] for geometry in recipe["geometries"]}
for node in recipe["nodes"]:
    kind = geometryTypes[node["geometry"]]
    if kind == "box":
        bpy.ops.mesh.primitive_cube_add(size=1.0)
    else:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, radius=1.0)
        bpy.ops.object.shade_smooth()
    blenderObject = bpy.context.active_object
    blenderObject.name = node["id"]
    blenderObject.location = toBlender(node["translation"])
    blenderObject.scale = scaleToBlender(node["scale"])
    blenderObject.data.materials.append(materials[node["material"]])

sunData = bpy.data.lights.new("Sun", "SUN")
sunData.energy = 1.2
sun = bpy.data.objects.new("Sun", sunData)
scene.collection.objects.link(sun)
towardLight = toBlender(recipe["environment"]["lightDirection"])
sun.rotation_euler = (-towardLight).to_track_quat("-Z", "Y").to_euler()

cameraSpec = recipe["camera"]
cameraData = bpy.data.cameras.new("Camera")
cameraData.sensor_fit = "VERTICAL"
cameraData.angle = math.radians(cameraSpec["fov"])
cameraData.clip_start = cameraSpec["near"]
cameraData.clip_end = cameraSpec["far"]
camera = bpy.data.objects.new("Camera", cameraData)
scene.collection.objects.link(camera)
camera.location = toBlender(cameraSpec["eye"])
direction = toBlender(cameraSpec["target"]) - camera.location
camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
scene.camera = camera

scene.render.use_freestyle = False
scene.render.filepath = f"{outputDirectory}/blender-off.png"
bpy.ops.render.render(write_still=True)

scene.render.use_freestyle = True
scene.render.line_thickness_mode = "ABSOLUTE"
scene.render.line_thickness = lineWidth
viewLayer = scene.view_layers[0]
viewLayer.use_freestyle = True
settings = viewLayer.freestyle_settings
settings.crease_angle = math.radians(35)
lineSet = settings.linesets.new("Outlines") if len(settings.linesets) == 0 else settings.linesets[0]
lineSet.select_silhouette = True
lineSet.select_border = True
lineSet.select_crease = True
lineSet.select_contour = True
lineSet.select_external_contour = False
lineSet.select_edge_mark = False
lineSet.visibility = "VISIBLE"
if lineSet.linestyle is None:
    lineSet.linestyle = bpy.data.linestyles.new("OutlineStyle")
lineSet.linestyle.color = (0.02, 0.02, 0.02)
lineSet.linestyle.thickness = 1.0
scene.render.filepath = f"{outputDirectory}/blender-on.png"
bpy.ops.render.render(write_still=True)
print("LINE_ART_DONE", bpy.app.version_string, "freestyle strokes via", lineSet.name)
