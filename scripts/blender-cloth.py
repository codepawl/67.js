"""Bake the two cloth cases of tests/cloth-blender.test.js with Blender's cloth solver and write the final positions.

Run from the repo root:
  PATH="/c/Program Files/Blender Foundation/Blender 5.2:$PATH" blender -b --factory-startup --python scripts/blender-cloth.py

Positions are written in Crucible axes (Y up): Blender (x, y, z) becomes (x, z, -y). Vertex order matches the grid
geometry of Crucible: rows from the top down, columns left to right.
"""
import json
import math
import pathlib

import bpy
import bmesh

SEGMENTS = 12
SECONDS = 2
FRAMES_PER_SECOND = 60
OUTPUT = pathlib.Path("tests/fixtures/blender/cloth-golden.json")


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FRAMES_PER_SECOND
    scene.frame_start = 1
    scene.frame_end = 4 * SECONDS * FRAMES_PER_SECOND + 1
    scene.gravity = (0.0, 0.0, -9.81)
    return scene


def grid_object(name, center, width, height, plane):
    """A (SEGMENTS + 1)^2 vertex sheet. plane 'vertical' lies in XZ (Crucible XY), 'horizontal' in XY (Crucible XZ)."""
    mesh = bpy.data.meshes.new(name)
    builder = bmesh.new()
    vertices = []
    for row in range(SEGMENTS + 1):
        for column in range(SEGMENTS + 1):
            across = (column / SEGMENTS - 0.5) * width
            down = (0.5 - row / SEGMENTS) * height
            if plane == "vertical":
                vertices.append(builder.verts.new((center[0] + across, 0.0, center[1] + down)))
            else:
                # Row 0 is the far edge (negative z in Crucible axes), as in the Crucible grid turned flat.
                vertices.append(builder.verts.new((center[0] + across, -(center[2] - down), center[1])))
    for row in range(SEGMENTS):
        for column in range(SEGMENTS):
            first = row * (SEGMENTS + 1) + column
            below = first + SEGMENTS + 1
            builder.faces.new((vertices[first], vertices[first + 1], vertices[below + 1], vertices[below]))
    builder.to_mesh(mesh)
    builder.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


# Blender's default air damping of 1 is a drag of about 54 per second on a sheet this light (terminal speed 0.18 m/s,
# measured in free fall), against 0.3 per second in Crucible. 0.1 gives 5.4 per second on both sides.
AIR_DAMPING = 0.1
EQUIVALENT_CRUCIBLE_DAMPING = 5.4


def add_cloth(obj, pinned_indices, vertex_mass):
    if pinned_indices:
        group = obj.vertex_groups.new(name="pin")
        group.add(pinned_indices, 1.0, "REPLACE")
    modifier = obj.modifiers.new("Cloth", "CLOTH")
    settings = modifier.settings
    settings.quality = 8
    settings.mass = vertex_mass
    settings.air_damping = AIR_DAMPING
    if pinned_indices:
        settings.vertex_group_mass = "pin"
    modifier.collision_settings.use_self_collision = False
    modifier.collision_settings.distance_min = 0.01
    modifier.point_cache.frame_start = 1
    modifier.point_cache.frame_end = 4 * SECONDS * FRAMES_PER_SECOND + 1
    return modifier


HISTORY_FRAMES = (16, 31, 61, 91, 121, 181, 241, 361, 481)


def vertex_positions(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return [[round(v.co.x, 5), round(v.co.z, 5), round(-v.co.y, 5)] for v in evaluated.data.vertices]


def simulate(obj):
    """Step every frame in order (the cloth cache needs that) and keep the positions at a few frames.

    The comparison frame is the one at SECONDS; the later frames show whether the bake has settled."""
    scene = bpy.context.scene
    history = {}
    for frame in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(frame)
        if frame in HISTORY_FRAMES:
            history[str(frame)] = vertex_positions(obj)
    return {
        "positions": history[str(SECONDS * FRAMES_PER_SECOND + 1)],
        "history": history,
        "framesSimulated": scene.frame_end - scene.frame_start + 1,
    }


def hanging_flag():
    reset_scene()
    width, height, center_y = 2.0, 1.5, 2.0
    flag = grid_object("flag", (0.0, center_y, 0.0), width, height, "vertical")
    top_row = list(range(SEGMENTS + 1))
    area = width * height
    vertex_mass = 0.2 * area / ((SEGMENTS + 1) ** 2)
    add_cloth(flag, top_row, vertex_mass)
    return {**simulate(flag), "vertexMass": vertex_mass}


def drape_over_ball():
    reset_scene()
    size = 1.6
    sheet = grid_object("sheet", (0.0, 1.0, 0.0), size, size, "horizontal")
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.4, location=(0.0, 0.0, 0.0), segments=48, ring_count=24)
    ball = bpy.context.active_object
    ball.modifiers.new("Collision", "COLLISION")
    ball.collision.thickness_outer = 0.01
    vertex_mass = 0.2 * size * size / ((SEGMENTS + 1) ** 2)
    add_cloth(sheet, [], vertex_mass)
    return {**simulate(sheet), "vertexMass": vertex_mass}


cases = {"hanging-flag": hanging_flag(), "drape-over-ball": drape_over_ball()}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps({"blender": bpy.app.version_string, "seconds": SECONDS, "segments": SEGMENTS, "cases": cases}, indent=1))
print("wrote", OUTPUT, "blender", bpy.app.version_string)
