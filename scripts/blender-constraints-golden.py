"""Record Blender's result for each constraint case in tests/fixtures/blender/constraints.json.

Run from Bash:
  PATH="/c/Program Files/Blender Foundation/Blender 5.2:$PATH" blender -b --factory-startup --python scripts/blender-constraints-golden.py

Each case lists nodes (empties with a parent, location, Euler XYZ degrees and scale), one constraint written in Crucible's
recipe form, and optionally a `pose` that moves a node after the constraint is set up (child_of binds at the rest pose
and then follows the target). The script builds the same scene in Blender, reads the owner's evaluated world matrix and
writes it column-major, the layout Crucible uses. The numbers come from Blender's own evaluation; nothing is copied from it.
"""
import json
import math
import os

import bpy
from mathutils import Euler

OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "blender", "constraints.json")

CASES = [
    {
        "name": "copy_rotation_xz",
        "nodes": [
            {"id": "source", "translation": [1, 2, 3], "rotation": [20, 30, 40]},
            {"id": "owner", "translation": [0, 0, 0], "rotation": [10, 5, -15]},
        ],
        "constraint": {"type": "copy_rotation", "node": "owner", "target": "source", "axes": ["x", "z"]},
    },
    {
        "name": "copy_rotation_all_with_parent",
        "nodes": [
            {"id": "holder", "translation": [4, 0, 1], "rotation": [0, 0, 25]},
            {"id": "source", "translation": [1, 2, 3], "rotation": [-35, 20, 50]},
            {"id": "owner", "parent": "holder", "translation": [1, 1, 0], "rotation": [10, 5, -15]},
        ],
        "constraint": {"type": "copy_rotation", "node": "owner", "target": "source"},
    },
    {
        "name": "limit_rotation_xy",
        "nodes": [{"id": "owner", "translation": [0, 0, 0], "rotation": [80, 70, 10]}],
        "constraint": {"type": "limit_rotation", "node": "owner", "x": [-45, 45], "y": [-30, 30]},
    },
    {
        "name": "track_to_negative_z_up_y",
        "nodes": [
            {"id": "owner", "translation": [-1, 1, 0]},
            {"id": "target", "translation": [0.3, 1.5, 0.3]},
        ],
        "constraint": {"type": "track_to", "node": "owner", "target": "target", "trackAxis": "-z", "upAxis": "y", "worldUp": [0, 0, 1]},
    },
    {
        "name": "track_to_positive_x_up_z",
        "nodes": [
            {"id": "owner", "translation": [2, -1, 0.5], "rotation": [0, 0, 15]},
            {"id": "target", "translation": [-1, 3, 2]},
        ],
        "constraint": {"type": "track_to", "node": "owner", "target": "target", "trackAxis": "+x", "upAxis": "z", "worldUp": [0, 0, 1]},
    },
    {
        "name": "child_of_follows_target_from_rest",
        "nodes": [
            {"id": "target", "translation": [1, 2, 0], "rotation": [0, 0, 30]},
            {"id": "owner", "translation": [0, 1, 0]},
        ],
        "constraint": {"type": "child_of", "node": "owner", "target": "target", "inverse": "rest"},
        "pose": {"id": "target", "translation": [3, 1, 2], "rotation": [10, 20, 70]},
    },
    {
        "name": "child_of_half_influence",
        "nodes": [
            {"id": "target", "translation": [1, 2, 0], "rotation": [0, 0, 30]},
            {"id": "owner", "translation": [0, 1, 0]},
        ],
        "constraint": {"type": "child_of", "node": "owner", "target": "target", "inverse": "rest", "influence": 0.5},
        "pose": {"id": "target", "translation": [3, 1, 2], "rotation": [10, 20, 70]},
    },
    {
        "name": "floor_z_with_offset",
        "nodes": [
            {"id": "ground", "translation": [0, 0, 0.5]},
            {"id": "owner", "translation": [0.3, 0.2, -1]},
        ],
        "constraint": {"type": "floor", "node": "owner", "target": "ground", "axis": "+z", "offset": 0.1},
    },
]

BLENDER_TYPES = {
    "copy_rotation": "COPY_ROTATION",
    "limit_rotation": "LIMIT_ROTATION",
    "track_to": "TRACK_TO",
    "child_of": "CHILD_OF",
    "floor": "FLOOR",
}
TRACK_AXES = {"+x": "TRACK_X", "-x": "TRACK_NEGATIVE_X", "+y": "TRACK_Y", "-y": "TRACK_NEGATIVE_Y", "+z": "TRACK_Z", "-z": "TRACK_NEGATIVE_Z"}


def set_transform(blender_object, node):
    blender_object.location = node.get("translation", [0, 0, 0])
    blender_object.rotation_mode = "XYZ"
    blender_object.rotation_euler = Euler([math.radians(angle) for angle in node.get("rotation", [0, 0, 0])], "XYZ")
    blender_object.scale = node.get("scale", [1, 1, 1])


def evaluated_world(blender_object):
    bpy.context.view_layer.update()
    evaluated = blender_object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    matrix = evaluated.matrix_world
    return [matrix[row][column] for column in range(4) for row in range(4)]


def add_constraint(owner, objects, spec):
    kind = spec["type"]
    constraint = owner.constraints.new(BLENDER_TYPES[kind])
    if "target" in spec:
        constraint.target = objects[spec["target"]]
    constraint.influence = spec.get("influence", 1)
    if kind == "copy_rotation":
        axes = spec.get("axes", ["x", "y", "z"])
        constraint.use_x = "x" in axes
        constraint.use_y = "y" in axes
        constraint.use_z = "z" in axes
        constraint.mix_mode = "REPLACE"
        constraint.target_space = "WORLD"
        constraint.owner_space = "WORLD"
    elif kind == "limit_rotation":
        for axis in ("x", "y", "z"):
            if axis in spec:
                setattr(constraint, "use_limit_" + axis, True)
                setattr(constraint, "min_" + axis, math.radians(spec[axis][0]))
                setattr(constraint, "max_" + axis, math.radians(spec[axis][1]))
        constraint.owner_space = "WORLD"
    elif kind == "track_to":
        constraint.track_axis = TRACK_AXES[spec.get("trackAxis", "-z")]
        constraint.up_axis = "UP_" + spec.get("upAxis", "y").upper()
        constraint.use_target_z = False
    elif kind == "floor":
        constraint.floor_location = "FLOOR_" + spec.get("axis", "+y").replace("+", "").replace("-", "NEGATIVE_").upper()
        constraint.offset = spec.get("offset", 0)
        constraint.use_rotation = False
    return constraint


def run_case(case):
    objects = {}
    for node in case["nodes"]:
        blender_object = bpy.data.objects.new(node["id"], None)
        bpy.context.scene.collection.objects.link(blender_object)
        set_transform(blender_object, node)
        objects[node["id"]] = blender_object
    for node in case["nodes"]:
        if "parent" in node:
            objects[node["id"]].parent = objects[node["parent"]]
    owner = objects[case["constraint"]["node"]]
    constraint = add_constraint(owner, objects, case["constraint"])
    if case["constraint"]["type"] == "child_of":
        bpy.context.view_layer.update()
        constraint.inverse_matrix = objects[case["constraint"]["target"]].matrix_world.inverted()
    if "pose" in case:
        set_transform(objects[case["pose"]["id"]], case["pose"])
    result = dict(case)
    result["expectedOwnerWorld"] = evaluated_world(owner)
    for blender_object in objects.values():
        bpy.data.objects.remove(blender_object)
    return result


def main():
    cases = [run_case(case) for case in CASES]
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump({"blender": bpy.app.version_string, "cases": cases}, handle, indent=1)
        handle.write("\n")
    print("wrote", len(cases), "cases for Blender", bpy.app.version_string)


main()
