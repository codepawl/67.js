"""Turns a Blender demo scene into a GLB that Crucible can load, for the README hero render (#1043).

Source: the Classroom demo scene by Christophe Seux (CC0), from the Blender demo files, https://download.blender.org/demo/test/classroom.zip
The .blend and the exported GLB stay out of git.

Run it in Blender 5.3 on a copy of the scene, with auto-run scripts off:

  blender -b classroom.blend --disable-autoexec --python scripts/blender-demo-to-glb.py -- <outputDirectory>

Then render the GLB with a scene.json (glb, hdri, eye [2.5764, 1.0945, 4.4658], target [0.9620, 1.1662, -1.7321], frame.fov 39.6, renderer.samples 8; the Blender camera in Y up):

  node scripts/render-media.mjs --kind image --scene file --config <outputDirectory>/scene.json --width 1600 --height 900 --output hero.png

Old demo scenes shade with Cycles-only Diffuse, Glossy and Glass nodes, which the glTF exporter skips. This script puts a
Principled BSDF in their place first (base colour or the first image texture upstream of the Diffuse colour, roughness, metal for
a lone Glossy, a soft alpha for Glass), so colours and textures survive. It is an approximation, not a Cycles match.
"""
import sys

import bpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
output_directory = sys.argv[sys.argv.index("--") + 1]


def find_image_node(start_socket):
    pending = [start_socket]
    visited = set()
    while pending:
        socket = pending.pop()
        for link in socket.links:
            node = link.from_node
            if node.as_pointer() in visited:
                continue
            visited.add(node.as_pointer())
            if node.type == "TEX_IMAGE" and node.image is not None:
                return node
            for input_socket in node.inputs:
                pending.append(input_socket)
    return None


def first_node(material, node_type):
    for node in material.node_tree.nodes:
        if node.type == node_type:
            return node
    return None


replaced = 0
for material in bpy.data.materials:
    if not material.use_nodes or material.node_tree is None:
        continue
    tree = material.node_tree
    if first_node(material, "BSDF_PRINCIPLED"):
        continue
    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
    diffuse = first_node(material, "BSDF_DIFFUSE")
    glossy = first_node(material, "BSDF_GLOSSY")
    emission = first_node(material, "EMISSION")
    glass = first_node(material, "BSDF_GLASS") or first_node(material, "BSDF_TRANSPARENT")
    if output is None or not (diffuse or glossy or emission or glass):
        continue
    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Roughness"].default_value = 0.6
    source = diffuse or glossy or glass
    if source is not None:
        color_input = source.inputs["Color"]
        image_node = find_image_node(color_input)
        if image_node is not None:
            tree.links.new(image_node.outputs["Color"], principled.inputs["Base Color"])
        else:
            principled.inputs["Base Color"].default_value = color_input.default_value
        if "Roughness" in source.inputs:
            principled.inputs["Roughness"].default_value = source.inputs["Roughness"].default_value
    if glossy is not None and diffuse is None:
        principled.inputs["Metallic"].default_value = 1.0
    elif glossy is not None:
        principled.inputs["Roughness"].default_value = glossy.inputs["Roughness"].default_value
        principled.inputs["Metallic"].default_value = 0.0
    if emission is not None and diffuse is None and glossy is None:
        principled.inputs["Emission Color"].default_value = emission.inputs["Color"].default_value
        principled.inputs["Emission Strength"].default_value = emission.inputs["Strength"].default_value
    if glass is not None:
        principled.inputs["Alpha"].default_value = 0.25
        material.surface_render_method = "BLENDED"
    tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    replaced += 1
print("REPLACED", replaced, "of", len(bpy.data.materials))
bpy.ops.export_scene.gltf(
    filepath=output_directory + "/scene.glb", export_format="GLB", export_apply=True,
    export_image_format="JPEG", export_jpeg_quality=85, export_cameras=False, export_lights=True,
    export_import_convert_lighting_mode="COMPAT",
    use_renderable=True, use_visible=True, export_yup=True, export_texcoords=True, export_normals=True,
)
print("EXPORTED")
