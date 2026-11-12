"""Blender 5.3 Cycles directional albedo of a white metallic Principled BSDF in a white furnace.
Usage: blender -b --factory-startup --python bench/cycles-parity/furnace-albedo.py -- <out.json> <samples> <device>
"""
import sys, os, json, math, tempfile, bpy, numpy as np
from mathutils import Vector

out_path, samples, device = sys.argv[sys.argv.index("--") + 1:][:3]
samples = int(samples)
WO = (0.5, 0.3, 0.8124)
CASES = [
    ("isotropic", 0.0, 0.0, WO),
    ("anisotropic-unrotated", 0.7, 0.0, WO),
    ("anisotropic-rotated", 0.7, 0.2, WO),
    ("anisotropic-unrotated-swapped-azimuth", 0.7, 0.0, (0.3, 0.5, 0.8124)),
]

def build(anisotropy, rotation, wo):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cycles = scene.cycles
    cycles.samples = samples
    cycles.use_denoising = False
    cycles.max_bounces = 12
    cycles.glossy_bounces = 12
    cycles.sample_clamp_direct = 0
    cycles.sample_clamp_indirect = 0
    if device == "gpu":
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for entry in prefs.devices:
            entry.use = entry.type == "OPTIX"
        cycles.device = "GPU"
    scene.render.resolution_x = 64
    scene.render.resolution_y = 64
    scene.render.resolution_percentage = 100
    scene.render.filter_size = 0.01
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (1, 1, 1, 1)
    background.inputs["Strength"].default_value = 1.0
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=200)
    plane = bpy.context.object
    material = bpy.data.materials.new("m")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = nodes["Principled BSDF"]
    principled.distribution = "MULTI_GGX"
    principled.inputs["Base Color"].default_value = (1, 1, 1, 1)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 0.35
    principled.inputs["Anisotropic"].default_value = anisotropy
    principled.inputs["Anisotropic Rotation"].default_value = rotation
    geometry_vector = nodes.new("ShaderNodeCombineXYZ")
    geometry_vector.inputs["X"].default_value = 1.0
    geometry_vector.inputs["Y"].default_value = 0.0
    geometry_vector.inputs["Z"].default_value = 0.0
    material.node_tree.links.new(geometry_vector.outputs["Vector"], principled.inputs["Tangent"])
    plane.data.materials.append(material)
    camera_data = bpy.data.cameras.new("c")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 1.0
    camera = bpy.data.objects.new("c", camera_data)
    scene.collection.objects.link(camera)
    direction = Vector(wo).normalized()
    camera.location = direction * 10.0
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    return scene

results = {}
for name, anisotropy, rotation, wo in CASES:
    scene = build(anisotropy, rotation, wo)
    path = os.path.join(tempfile.gettempdir(), "furnace-%s.exr" % name)
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(path)
    pixels = np.array(list(image.pixels), dtype=np.float64).reshape(-1, 4)[:, :3]
    # Orthographic camera on an infinite plane: every pixel sees the same point, so pixel variance is sample noise.
    mean = pixels.mean(axis=0)
    stderr = pixels.std(axis=0, ddof=1) / math.sqrt(len(pixels))
    results[name] = {"wo": list(wo), "anisotropy": anisotropy, "rotation": rotation, "samples": samples,
                     "pixelCount": len(pixels), "meanRgb": mean.tolist(), "stderrRgb": stderr.tolist()}
    print("CASE", name, results[name])
with open(out_path, "w") as handle:
    json.dump({"blender": bpy.app.version_string, "cases": results}, handle, indent=2)
