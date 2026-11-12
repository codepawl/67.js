"""Exporter checks that need Blender. Run from the repository root:

  blender -b --factory-startup --python-exit-code 1 --python packages/blender-addon/tests/test_exporter_in_blender.py

Exits non-zero on the first failed check, and prints one line per passed check.
"""
import base64
import json
import math
import os
import sys
import tempfile

TESTS_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
ADDON_PARENT = os.path.abspath(os.path.join(TESTS_DIRECTORY, ".."))
sys.path.insert(0, ADDON_PARENT)
sys.path.insert(0, TESTS_DIRECTORY)

import bpy  # noqa: E402
import numpy  # noqa: E402

import scene_fixtures  # noqa: E402
from cook_blender.scene_export import export_scene  # noqa: E402

CHECKS_PASSED = []


def check(condition, description):
    if not condition:
        raise AssertionError(f"FAILED: {description}")
    CHECKS_PASSED.append(description)
    print(f"PASS {description}", flush=True)


def export(scene, width=480, height=270):
    work_directory = tempfile.mkdtemp(prefix="cook-test-")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return export_scene(depsgraph, width, height, work_directory) + (work_directory,)


def decode_floats(encoded):
    return numpy.frombuffer(base64.b64decode(encoded["base64"]), dtype=numpy.float32)


def test_small_scene():
    scene = scene_fixtures.build_small_scene("small")
    description, lens, report, _ = export(scene)
    ball_parts = [part for part in description["parts"] if part["name"].startswith("Ball")]
    check(len(ball_parts) == 3, "three objects sharing one mesh give three parts")
    check(len({part["geometry"] for part in ball_parts}) == 1, "the three parts share one geometry, not three copies of the triangles")
    check(report["geometryCount"] == 3, "floor, ball and glow cube are the three geometries")
    check(len(description["environment"]["pointLights"]) == 1 and description["environment"]["keyColor"] != [0.0, 0.0, 0.0], "the point light and the sun are exported")
    check(description["world"]["type"] == "constant" and len(description["world"]["color"]) == 3, "a constant world keeps its colour")
    floor_part = next(part for part in description["parts"] if part["name"] == "Floor")
    floor_material = description["materials"][floor_part["material"]]
    check("map" in floor_material and floor_material["map"]["colorSpace"] == "srgb", "the floor's image on Base Color becomes an sRGB map")
    floor_geometry = description["geometries"][floor_part["geometry"]]
    check("uvs" in floor_geometry and len(decode_floats(floor_geometry["uvs"])) == 2 * len(decode_floats(floor_geometry["positions"])) // 3, "meshes carry one UV pair per vertex")
    glow_part = next(part for part in description["parts"] if part["name"] == "Glow")
    glow_material = description["materials"][glow_part["material"]]
    check(glow_material["emission"] == 15.0 and glow_material["emissiveColor"] == [1.0, 0.6000000238418579, 0.20000000298023224], "an emissive material keeps its strength and colour")
    check(len(description["images"]) == 1 and description["images"][0]["width"] == scene_fixtures.CHECKER_SIZE, "the image table holds the one checker image")
    check(abs(description["camera"]["fov"] - math.degrees(2 * math.atan(18.0 / 35.0 * 270 / 480))) < 1e-3, "the camera field of view is exported")
    check(not report["materialNotes"], "a fully supported scene reports no material notes")
    check(lens == {"enabled": False}, "a camera without depth of field has no lens entry")
    check(len(json.dumps(description)) > 1000, "the whole description is plain JSON")


def test_collection_instances():
    scene = scene_fixtures.build_small_scene("small")
    collection = bpy.data.collections.new("Props")
    bpy.context.scene.collection.children.link(collection)
    prop = bpy.data.objects.new("Prop", scene_fixtures.make_mesh("cube", "PropMesh"))
    collection.objects.link(prop)
    for index in range(4):
        empty = bpy.data.objects.new(f"Copy{index}", None)
        empty.instance_type = "COLLECTION"
        empty.instance_collection = collection
        empty.location = (index, 3.0, 0.0)
        scene.collection.objects.link(empty)
    collection.hide_render = False
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    prop_parts = [part for part in description["parts"] if part["name"].endswith("Prop")]
    check(len(prop_parts) >= 4, f"four collection instances give four parts (got {len(prop_parts)})")
    check(len({part["geometry"] for part in prop_parts}) == 1, "collection instances share one geometry")


def test_material_slots_and_notes():
    scene = scene_fixtures.build_small_scene("small")
    ball_mesh = bpy.data.meshes["BallMesh"]
    metal = scene_fixtures.make_principled_material("Metal", (0.9, 0.9, 0.9), 0.2, metallic=1.0)
    ball_mesh.materials.append(metal)
    for polygon in ball_mesh.polygons[: len(ball_mesh.polygons) // 2]:
        polygon.material_index = 1
    clay = bpy.data.materials["Clay"]
    nodes = clay.node_tree.nodes
    noise = nodes.new("ShaderNodeTexNoise")
    clay.node_tree.links.new(noise.outputs["Fac"], nodes["Principled BSDF"].inputs["Roughness"])
    clay.node_tree.links.new(noise.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    principled = nodes["Principled BSDF"]
    principled.inputs["Sheen Weight"].default_value = 0.5
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    check(report["geometryCount"] == 4, "a mesh with two material slots splits into two geometries")
    notes = report["materialNotes"]["Clay"]
    check(any("Roughness" in note and "TEX_NOISE" in note for note in notes), "a procedural texture on Roughness is reported with its fallback")
    check(any("Base Color" in note for note in notes), "a procedural texture on Base Color is reported")
    check(any("Sheen" in note for note in notes), "an unread layer such as Sheen is reported")
    check(len(notes) == len(set(notes)), "each note is reported once per material")
    check(all(len(set(notes_for)) == len(notes_for) for notes_for in report["materialNotes"].values()), "no material repeats a note")


def test_other_surface_shaders():
    scene = scene_fixtures.build_small_scene("small")
    ball_mesh = bpy.data.meshes["BallMesh"]
    for name, node_type in (("DiffuseOnly", "ShaderNodeBsdfDiffuse"), ("EmissionOnly", "ShaderNodeEmission"), ("GlassOnly", "ShaderNodeBsdfGlass")):
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        tree = material.node_tree
        shader = tree.nodes.new(node_type)
        tree.links.new(shader.outputs[0], tree.get_output_node("ALL").inputs["Surface"])
        ball_mesh.materials.append(material)
        if name == "DiffuseOnly":
            texture = tree.nodes.new("ShaderNodeTexImage")
            texture.image = scene_fixtures.make_checker_image("diffuse-checker")
            tree.links.new(texture.outputs["Color"], shader.inputs["Color"])
    for index, polygon in enumerate(ball_mesh.polygons):
        polygon.material_index = 1 + index % 3
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    json.dumps(description)
    check(any(material.get("map") for material in description["materials"]), "a Diffuse shader with an image gives a mapped material")
    check(any(material.get("emission", 0) > 0 and material["color"] == [0.0, 0.0, 0.0] for material in description["materials"]), "an Emission shader gives an emissive material")
    check(any("BSDF_GLASS" in note for note in report["materialNotes"]["GlassOnly"]), "a Glass shader is reported with its fallback")


def test_lights_and_camera():
    scene = scene_fixtures.build_small_scene("small")
    scene_fixtures.add_light(scene, "Spot", "SPOT", (0.0, 0.0, 4.0), 500.0)
    area = scene_fixtures.add_light(scene, "Panel", "AREA", (1.0, 0.0, 4.0), 200.0)
    area.data.size = 2.0
    scene_fixtures.add_light(scene, "Sun2", "SUN", (0.0, 0.0, 6.0), 1.0)
    scene.camera.data.dof.use_dof = True
    scene.camera.data.dof.focus_distance = 5.0
    scene.camera.data.dof.aperture_fstop = 2.8
    bpy.context.view_layer.update()
    description, lens, report, _ = export(scene)
    environment = description["environment"]
    check(len(environment["spotLights"]) == 1 and len(environment["areaLights"]) == 1, "spot and area lights are exported")
    check(any("Sun2" in note for note in report["notes"]), "a second sun is reported and ignored")
    check(lens["enabled"] and abs(lens["fStop"] - 2.8) < 1e-5 and abs(lens["focusDistance"] - 5.0) < 1e-5, "depth of field becomes a lens entry")
    scene.camera.data.type = "ORTHO"
    try:
        export(scene)
    except ValueError as error:
        check("Perspective" in str(error), "an orthographic camera is refused with the fix in the message")
    else:
        raise AssertionError("FAILED: an orthographic camera was accepted")


def test_hdri_world():
    scene = scene_fixtures.build_small_scene("hdri")
    description, _, report, work_directory = export(scene)
    check(description["world"]["type"] == "hdri", "an environment image becomes an HDRI world")
    hdr_path = description["world"]["file"]
    with open(hdr_path, "rb") as handle:
        magic = handle.read(10)
    check(magic == b"#?RADIANCE", "the HDRI is written as a Radiance file")


def test_world_without_a_background_uses_the_fallback():
    scene = scene_fixtures.build_small_scene("small")
    tree = scene.world.node_tree
    for node in list(tree.nodes):
        if node.type == "BACKGROUND":
            tree.nodes.remove(node)
    description, _, report, _ = export(scene)
    check(description["world"]["type"] == "constant", "a world with no Background node falls back to a constant colour")
    mix = tree.nodes.new("ShaderNodeMixShader")
    tree.links.new(mix.outputs[0], tree.get_output_node("ALL").inputs["Surface"])
    description, _, report, _ = export(scene)
    check(description["world"]["type"] == "constant" and any("world is not a constant" in note for note in report["notes"]), "a Mix Shader on the world output is reported and falls back")


def test_geometry_edge_cases():
    scene = scene_fixtures.build_small_scene("small")
    ball_mesh = bpy.data.meshes["BallMesh"]
    ball_mesh.materials.append(scene_fixtures.make_principled_material("Second", (0.1, 0.9, 0.1), 0.5))
    for polygon in ball_mesh.polygons:
        polygon.material_index = 7
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    ball_part = next(part for part in description["parts"] if part["name"] == "Ball0")
    second_index = next(index for index, material in enumerate(description["materials"]) if material["color"][1] > 0.8 and material["color"][0] < 0.2)
    check(ball_part["material"] == second_index, "a face index past the last slot uses the last slot's material")
    # Two metaballs in one family: only the basis converts, and the other must not abort the export.
    for object_name, location in (("Blob", (0.0, 4.0, 0.5)), ("Blob.001", (0.4, 4.0, 0.5))):
        metaball_data = bpy.data.metaballs.new(object_name)
        metaball_data.elements.new()
        metaball_object = bpy.data.objects.new(object_name, metaball_data)
        metaball_object.location = location
        scene.collection.objects.link(metaball_object)
    bpy.context.view_layer.update()
    export(scene)
    check(True, "two metaballs in one family do not abort the export")
    # A UV map made render-active is the one exported.
    floor_mesh = bpy.data.meshes["FloorMesh"]
    second_map = floor_mesh.uv_layers.new(name="Other")
    for loop in second_map.uv:
        loop.vector = (0.0, 0.0)
    floor_mesh.uv_layers.active_index = 1
    floor_mesh.uv_layers[0].active_render = True
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    floor_part = next(part for part in description["parts"] if part["name"] == "Floor")
    uvs = decode_floats(description["geometries"][floor_part["geometry"]]["uvs"])
    check(float(uvs.max()) > 0.5, "the render-active UV map is exported, not the one selected for editing")


def test_scene_notes_and_color_spaces():
    scene = scene_fixtures.build_small_scene("small")
    scene.render.film_transparent = True
    scene.render.pixel_aspect_x = 2.0
    lamp = bpy.data.lights["Lamp"]
    lamp.use_temperature = True
    lamp.use_shadow = False
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    joined = " ".join(report["notes"])
    for fragment in ("Transparent", "pixel aspect", "blackbody", "shadows off"):
        check(fragment in joined, f"the notes mention {fragment}")
    floor_material = bpy.data.materials["Floor"]
    image = floor_material.node_tree.nodes["Image Texture"].image
    image.colorspace_settings.name = "Linear Rec.709"
    description, _, _, _ = export(scene)
    floor_part = next(part for part in description["parts"] if part["name"] == "Floor")
    check(description["materials"][floor_part["material"]]["map"]["colorSpace"] == "linear", "an image tagged Linear Rec.709 is declared linear, not sRGB")


def test_geometry_nodes_instances():
    scene = scene_fixtures.build_small_scene("small")
    cube = bpy.data.objects.new("InstCube", scene_fixtures.make_mesh("cube", "InstCubeMesh"))
    sphere = bpy.data.objects.new("InstSphere", scene_fixtures.make_mesh("sphere", "InstSphereMesh"))
    for source in (cube, sphere):
        scene.collection.objects.link(source)
        source.hide_render = True
        source.location = (0.0, 0.0, -20.0)
    host = bpy.data.objects.new("Host", scene_fixtures.make_mesh("cube", "HostMesh"))
    scene.collection.objects.link(host)
    group = bpy.data.node_groups.new("Pair", "GeometryNodeTree")
    group.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nodes = group.nodes
    group_output = nodes.new("NodeGroupOutput")
    join = nodes.new("GeometryNodeJoinGeometry")
    for source in (cube, sphere):
        info = nodes.new("GeometryNodeObjectInfo")
        info.transform_space = "RELATIVE"
        info.inputs["Object"].default_value = source
        info.inputs["As Instance"].default_value = True
        group.links.new(info.outputs["Geometry"], join.inputs["Geometry"])
    group.links.new(join.outputs["Geometry"], group_output.inputs["Geometry"])
    modifier = host.modifiers.new("Pair", "NODES")
    modifier.node_group = group
    bpy.context.view_layer.update()
    description, _, report, _ = export(scene)
    host_geometries = {part["geometry"] for part in description["parts"] if part["name"].endswith("Host") or part["name"].startswith("Host")}
    triangle_counts = {len(decode_floats(description["geometries"][index]["positions"])) for index in host_geometries}
    check(len(host_geometries) >= 2 and len(triangle_counts) >= 2, f"two different Geometry Nodes instances keep their own geometry (geometries {len(host_geometries)}, sizes {sorted(triangle_counts)})")


def main():
    for test in (test_small_scene, test_collection_instances, test_material_slots_and_notes, test_other_surface_shaders, test_lights_and_camera, test_hdri_world, test_world_without_a_background_uses_the_fallback, test_geometry_edge_cases, test_scene_notes_and_color_spaces, test_geometry_nodes_instances):
        test()
    print(f"{len(CHECKS_PASSED)} checks passed", flush=True)


main()
