# Runs each case in tests/fixtures/blender/cases.json in Blender and writes the results to golden.json beside it.
# Run it when a case changes or Blender moves to a new release:
#   blender -b --factory-startup --python scripts/blender-golden.py
import json
import os
from math import cos, radians, sqrt
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

FIXTURE_DIRECTORY = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "blender"
DEFAULT_MAX_ANGLE = 10
UNLIMITED_SIDES = 4096
ANGLE_EPSILON = 1e-9
CREASE_TO_SHARPNESS = 10


def new_bmesh(mesh_input):
    bm = bmesh.new()
    vertices = [bm.verts.new(position) for position in mesh_input["vertices"]]
    for face in mesh_input["faces"]:
        bm.faces.new([vertices[index] for index in face])
    refresh(bm)
    return bm


def refresh(bm):
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()


def new_object(name, mesh_input):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(mesh_input["vertices"], [], mesh_input["faces"])
    mesh.update()
    mesh_object = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(mesh_object)
    return mesh_object


def selected_faces(bm, rule):
    if "faces" in rule:
        return [bm.faces[index] for index in rule["faces"]]
    if "normal" in rule:
        direction = Vector(rule["normal"]).normalized()
        limit = cos(radians(rule.get("maxAngle", DEFAULT_MAX_ANGLE))) - ANGLE_EPSILON
        return [face for face in bm.faces if face.normal.dot(direction) >= limit]
    raise ValueError(f"Unsupported face rule: {rule}")


def selected_vertices(bm, rule):
    if "vertices" in rule:
        return [bm.verts[index] for index in rule["vertices"]]
    if "valence" in rule:
        return [vertex for vertex in bm.verts if len(vertex.link_edges) == rule["valence"]]
    if rule.get("all"):
        return list(bm.verts)
    raise ValueError(f"Unsupported vertex rule: {rule}")


def edge_midpoint_inside(edge, box):
    if box is None:
        return True
    middle = (edge.verts[0].co + edge.verts[1].co) / 2
    return all(box["min"][axis] - 1e-6 <= middle[axis] <= box["max"][axis] + 1e-6 for axis in range(3))


def selected_edges(bm, rule):
    if "open" in rule:
        box = None if rule["open"] is True else rule["open"]["inside"]
        return [edge for edge in bm.edges if len(edge.link_faces) == 1 and edge_midpoint_inside(edge, box)]
    if rule.get("all"):
        return [edge for edge in bm.edges if len(edge.link_faces) == 2]
    if "along" in rule:
        direction = Vector(rule["along"]).normalized()
        limit = cos(radians(rule.get("maxAngle", DEFAULT_MAX_ANGLE))) - ANGLE_EPSILON
        return [edge for edge in bm.edges if edge_is_along(edge, direction, limit)]
    if "angle" in rule:
        limit = cos(radians(rule["angle"])) + ANGLE_EPSILON
        return [edge for edge in bm.edges if len(edge.link_faces) == 2 and edge.link_faces[0].normal.dot(edge.link_faces[1].normal) <= limit]
    if "boundaryOf" in rule:
        inside = set(selected_faces(bm, rule["boundaryOf"]))
        return [edge for edge in bm.edges if edge_crosses(edge, inside)]
    if "between" in rule:
        first = set(selected_faces(bm, rule["between"][0]))
        second = set(selected_faces(bm, rule["between"][1]))
        return [edge for edge in bm.edges if edge_joins(edge, first, second)]
    raise ValueError(f"Unsupported edge rule: {rule}")


def edge_is_along(edge, direction, limit):
    vector = (edge.verts[1].co - edge.verts[0].co).normalized()
    return abs(vector.dot(direction)) >= limit


def edge_crosses(edge, inside):
    faces = edge.link_faces
    return len(faces) == 2 and (faces[0] in inside) != (faces[1] in inside)


def edge_joins(edge, first, second):
    faces = edge.link_faces
    if len(faces) != 2:
        return False
    return (faces[0] in first and faces[1] in second) or (faces[1] in first and faces[0] in second)


def area_weighted_normal(faces):
    total = Vector((0, 0, 0))
    for face in faces:
        total += face.normal * face.calc_area()
    return total.normalized()


def move(bm, vertices, offset):
    bmesh.ops.translate(bm, verts=list(vertices), vec=offset)


def extrude_face_region(bm, edit):
    faces = selected_faces(bm, edit["select"])
    normal = area_weighted_normal(faces)
    result = bmesh.ops.extrude_face_region(bm, geom=faces)
    new_vertices = [element for element in result["geom"] if isinstance(element, bmesh.types.BMVert)]
    move(bm, new_vertices, normal * edit["offset"])
    # Blender keeps the source faces when the extrusion is not a closed region. The operator in the editor removes them.
    bmesh.ops.delete(bm, geom=faces, context="FACES")


def extrude_individual(bm, edit):
    faces = selected_faces(bm, edit["select"])
    normals = [face.normal.copy() for face in faces]
    result = bmesh.ops.extrude_discrete_faces(bm, faces=faces)
    for face, normal in zip(result["faces"], normals):
        move(bm, face.verts, normal * edit["offset"])


def inset_region(bm, edit):
    faces = selected_faces(bm, edit["select"])
    # The editor's Inset Faces turns use_boundary on, and the operator's own default is off.
    bmesh.ops.inset_region(
        bm,
        faces=faces,
        thickness=edit["thickness"],
        depth=edit.get("depth", 0),
        use_even_offset=True,
        use_boundary=True,
    )


def inset_individual(bm, edit):
    faces = selected_faces(bm, edit["select"])
    bmesh.ops.inset_individual(bm, faces=faces, thickness=edit["thickness"], depth=edit.get("depth", 0), use_even_offset=True)


def bevel(bm, edit):
    edges = selected_edges(bm, edit["edges"])
    vertices = {vertex for edge in edges for vertex in edge.verts}
    bmesh.ops.bevel(
        bm,
        geom=edges + list(vertices),
        offset=edit["width"],
        offset_type="OFFSET",
        profile_type="SUPERELLIPSE",
        segments=edit.get("segments", 1),
        profile=edit.get("profile", 0.5),
        affect="EDGES",
        clamp_overlap=edit.get("clampOverlap", True),
        loop_slide=True,
    )


def low_vertex_first(edge):
    first, second = edge.verts
    return tuple(first.co) <= tuple(second.co)


def loop_cut(bm, edit):
    edges = selected_edges(bm, edit["edges"])
    cuts = edit.get("cuts", 1)
    factor = edit.get("factor", 0.5)
    edge_percents = {}
    if cuts == 1 and factor != 0.5:
        edge_percents = {edge: factor if low_vertex_first(edge) else 1 - factor for edge in edges}
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=cuts, use_grid_fill=True, edge_percents=edge_percents)


def fill_holes(bm, edit):
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    bmesh.ops.holes_fill(bm, edges=boundary, sides=edit.get("sides", UNLIMITED_SIDES))


def dissolve_faces(bm, edit):
    bmesh.ops.dissolve_faces(bm, faces=selected_faces(bm, edit["select"]), use_verts=False)


def dissolve_edges(bm, edit):
    bmesh.ops.dissolve_edges(bm, edges=selected_edges(bm, edit["edges"]), use_verts=False, use_face_split=False)


def dissolve_verts(bm, edit):
    bmesh.ops.dissolve_verts(bm, verts=selected_vertices(bm, edit["verts"]), use_face_split=False, use_boundary_tear=False)


def dissolve_limited(bm, edit):
    bmesh.ops.dissolve_limit(
        bm,
        angle_limit=radians(edit.get("angle", 5)),
        use_dissolve_boundaries=False,
        verts=list(bm.verts),
        edges=list(bm.edges),
    )


def bisect_plane(bm, edit):
    geometry = list(bm.verts) + list(bm.edges) + list(bm.faces)
    result = bmesh.ops.bisect_plane(
        bm,
        geom=geometry,
        dist=edit.get("distance", 1e-4),
        plane_co=edit["point"],
        plane_no=edit["normal"],
        clear_inner=edit.get("clearInner", False),
        clear_outer=edit.get("clearOuter", False),
    )
    if edit.get("fill"):
        cut = [element for element in result["geom_cut"] if isinstance(element, bmesh.types.BMEdge) and element.is_boundary]
        bmesh.ops.holes_fill(bm, edges=cut, sides=UNLIMITED_SIDES)


def bridge_edge_loops(bm, edit):
    result = bmesh.ops.bridge_loops(
        bm,
        edges=selected_edges(bm, edit["edges"]),
        use_pairs=False,
        use_cyclic=False,
        use_merge=False,
        merge_factor=0.5,
        twist_offset=edit.get("twistOffset", 0),
    )
    segments = edit.get("segments", 1)
    if segments > 1:
        bmesh.ops.subdivide_edges(bm, edges=result["edges"], cuts=segments - 1, use_grid_fill=True)


def subdivide_edges(bm, edit):
    bmesh.ops.subdivide_edges(bm, edges=selected_edges(bm, edit["edges"]), cuts=edit["cuts"], use_grid_fill=True)


# Blender's knife project needs a viewport, so a straight cut is compared with the plane through the line that holds
# the projection direction. It agrees where the line spans the whole mesh.
def knife_project(bm, edit):
    start = Vector(edit["path"][0])
    end = Vector(edit["path"][1])
    normal = (end - start).cross(Vector(edit["direction"])).normalized()
    bisect_plane(bm, {"point": list(start), "normal": list(normal)})


# Blender has no modifier for sculpt brushes that runs without a viewport, so the reference runs the same brush formula
# on Blender's own mesh: displacement along the angle-weighted vertex normal (inflate) or a fixed direction (displace),
# or a step toward the mean of the edge neighbours (smooth), scaled by a quintic falloff that has zero first and second
# derivatives at the rim and the centre value one.
def brush_falloff(relative):
    return 1 - relative**3 * (10 + relative * (-15 + 6 * relative))


def sculpt(bm, edit):
    bm.verts.index_update()
    points = [vertex.co.copy() for vertex in bm.verts]
    normals = [vertex.normal.copy() for vertex in bm.verts]
    neighbours = [[edge.other_vert(vertex).index for edge in vertex.link_edges] for vertex in bm.verts]
    for stroke in edit["strokes"]:
        centre = Vector(stroke["center"])
        smoothing = stroke["type"] == "smooth"
        moved = [point.copy() for point in points] if smoothing else points
        for index, point in enumerate(points):
            distance = (point - centre).length
            if distance >= stroke["radius"] or stroke["strength"] == 0:
                continue
            weight = stroke["strength"] * brush_falloff(distance / stroke["radius"])
            if smoothing:
                if not neighbours[index]:
                    continue
                mean = sum((points[other] for other in neighbours[index]), Vector((0, 0, 0))) / len(neighbours[index])
                moved[index] = point + (mean - point) * weight
            else:
                direction = normals[index] if stroke["type"] == "inflate" else Vector(stroke["direction"]).normalized()
                points[index] = point + direction * weight
        points = moved
    for vertex, point in zip(bm.verts, points):
        vertex.co = point


def poke(bm, edit):
    bmesh.ops.poke(bm, faces=selected_faces(bm, edit["select"]), offset=edit.get("offset", 0), center_mode="MEAN", use_relative_offset=edit.get("relative", False))


# 67js joins by the angle between face normals only, so the shape limit is opened fully.
def tris_to_quads(bm, edit):
    bmesh.ops.join_triangles(bm, faces=selected_faces(bm, edit["select"]), angle_face_threshold=radians(edit.get("angle", 40)), angle_shape_threshold=radians(180))


# Blender's direction "-X" copies the negative half over the positive one, so keeping the positive half is "X".
def symmetrize(bm, edit):
    axis = edit.get("axis", "x").upper()
    direction = axis if edit.get("keep", "positive") == "positive" else "-" + axis
    geometry = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.symmetrize(bm, input=geometry, direction=direction, dist=edit.get("distance", 1e-4))


BMESH_OPERATIONS = {
    "poke": poke,
    "tris_to_quads": tris_to_quads,
    "symmetrize": symmetrize,
    "sculpt": sculpt,
    "extrude_face_region": extrude_face_region,
    "extrude_individual": extrude_individual,
    "inset_region": inset_region,
    "inset_individual": inset_individual,
    "bevel": bevel,
    "loop_cut": loop_cut,
    "fill_holes": fill_holes,
    "dissolve_faces": dissolve_faces,
    "dissolve_edges": dissolve_edges,
    "dissolve_verts": dissolve_verts,
    "dissolve_limited": dissolve_limited,
    "bisect_plane": bisect_plane,
    "bridge_edge_loops": bridge_edge_loops,
    "subdivide_edges": subdivide_edges,
    "knife_project": knife_project,
}


def add_mirror(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Mirror", "MIRROR")
    axis = "xyz".index(edit.get("axis", "x"))
    modifier.use_axis = [index == axis for index in range(3)]
    modifier.use_mirror_merge = True
    modifier.merge_threshold = edit.get("merge", 0.001)


def add_array(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Array", "ARRAY")
    modifier.fit_type = "FIXED_COUNT"
    modifier.count = edit.get("count", 2)
    modifier.use_relative_offset = True
    modifier.relative_offset_displace = edit.get("relativeOffset", [1, 0, 0])
    modifier.use_constant_offset = True
    modifier.constant_offset_displace = edit.get("offset", [0, 0, 0])
    merge = edit.get("merge", 0)
    modifier.use_merge_vertices = merge > 0
    modifier.merge_threshold = merge


def add_solidify(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Solidify", "SOLIDIFY")
    modifier.solidify_mode = "EXTRUDE"
    modifier.thickness = edit["thickness"]
    modifier.offset = edit.get("offset", -1)
    modifier.use_even_offset = edit.get("evenThickness", True)
    modifier.use_rim = True


def add_boolean(mesh_object, edit, inputs):
    cutter = new_object("Cutter", inputs[edit["cutter"]["type"]])
    cutter.location = edit.get("translation", [0, 0, 0])
    cutter.scale = edit.get("scale", [1, 1, 1])
    cutter.hide_render = True
    modifier = mesh_object.modifiers.new("Boolean", "BOOLEAN")
    modifier.operation = edit["operation"].upper()
    modifier.solver = "MANIFOLD"
    modifier.object = cutter


# Blender's Shrinkwrap modifier. Its projection runs along one axis, so the cases project along -Z.
def add_shrinkwrap(mesh_object, edit, inputs):
    target = new_object("Target", inputs[edit["target"]["type"]])
    target.location = edit.get("translation", [0, 0, 0])
    target.scale = edit.get("scale", [1, 1, 1])
    target.hide_render = True
    modifier = mesh_object.modifiers.new("Shrinkwrap", "SHRINKWRAP")
    modifier.target = target
    modifier.wrap_mode = "ON_SURFACE"
    modifier.offset = edit.get("offset", 0)
    if edit.get("mode", "nearest") == "project":
        if edit["direction"] != [0, 0, -1]:
            raise ValueError("The Blender golden projects along -Z only.")
        modifier.wrap_method = "PROJECT"
        modifier.use_project_z = True
        modifier.use_negative_direction = True
        modifier.use_positive_direction = False
    else:
        modifier.wrap_method = "NEAREST_SURFACEPOINT"


# Blender stores a crease from 0 to 1. Measured against 67js sharpness, crease squared times 10 is the sharpness.
def add_subdivision(mesh_object, edit, _inputs):
    levels = edit.get("levels", 1)
    if "crease" in edit:
        bm = bmesh.new()
        bm.from_mesh(mesh_object.data)
        refresh(bm)
        creased = {edge.index for edge in selected_edges(bm, edit["crease"])}
        bm.free()
        crease = mesh_object.data.attributes.new("crease_edge", "FLOAT", "EDGE")
        value = sqrt(min(edit.get("sharpness", 10), CREASE_TO_SHARPNESS) / CREASE_TO_SHARPNESS)
        crease.data.foreach_set("value", [value if index in creased else 0.0 for index in range(len(mesh_object.data.edges))])
    modifier = mesh_object.modifiers.new("Subdivision", "SUBSURF")
    modifier.subdivision_type = "CATMULL_CLARK"
    modifier.levels = levels
    modifier.render_levels = levels
    modifier.quality = 3
    modifier.use_creases = True
    # The limit surface moves the points onto the final surface, where plain Catmull-Clark leaves them at the level.
    modifier.use_limit_surface = False
    modifier.boundary_smooth = "PRESERVE_CORNERS"


# Set Position through a Geometry Nodes modifier. Only the part of the field language the cases use is translated:
# numbers, "vec", position components, add, sub and mul. Anything else raises, so a case can never silently differ.
def field_socket(tree, expression, position_xyz):
    if isinstance(expression, (int, float)):
        node = tree.nodes.new("ShaderNodeValue")
        node.outputs[0].default_value = float(expression)
        return node.outputs[0]
    if "attr" in expression and expression["attr"] == "position" and "component" in expression:
        return position_xyz.outputs["xyz".index(expression["component"])]
    operations = {"add": "ADD", "sub": "SUBTRACT", "mul": "MULTIPLY"}
    for name, operation in operations.items():
        if name in expression:
            left, right = expression[name]
            node = tree.nodes.new("ShaderNodeMath")
            node.operation = operation
            tree.links.new(field_socket(tree, left, position_xyz), node.inputs[0])
            tree.links.new(field_socket(tree, right, position_xyz), node.inputs[1])
            return node.outputs[0]
    raise ValueError(f"Unsupported field expression for the Blender golden: {expression}")


def add_set_position(mesh_object, edit, _inputs):
    tree = bpy.data.node_groups.new("SetPosition", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = tree.nodes.new("NodeGroupInput")
    group_output = tree.nodes.new("NodeGroupOutput")
    set_position = tree.nodes.new("GeometryNodeSetPosition")
    position = tree.nodes.new("GeometryNodeInputPosition")
    position_xyz = tree.nodes.new("ShaderNodeSeparateXYZ")
    tree.links.new(position.outputs["Position"], position_xyz.inputs["Vector"])
    combine = tree.nodes.new("ShaderNodeCombineXYZ")
    for axis, component in enumerate(edit["offset"]["vec"]):
        tree.links.new(field_socket(tree, component, position_xyz), combine.inputs[axis])
    tree.links.new(group_input.outputs[0], set_position.inputs["Geometry"])
    tree.links.new(combine.outputs["Vector"], set_position.inputs["Offset"])
    tree.links.new(set_position.outputs["Geometry"], group_output.inputs[0])
    modifier = mesh_object.modifiers.new("SetPosition", "NODES")
    modifier.node_group = tree


# Displace with a field as the texture. A constant field means no texture. The one varying field the cases use, a
# linear gradient along local x, is Blender's Blend texture, whose value is (x + 1) / 2.
LINEAR_GRADIENT_X = {"mul": [{"add": [{"attr": "position", "component": "x"}, 1]}, 0.5]}


def add_displace(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Displace", "DISPLACE")
    modifier.strength = edit.get("strength", 1)
    modifier.mid_level = edit.get("midlevel", 0.5)
    modifier.direction = edit.get("direction", "normal").upper()
    if edit["field"] != 1:
        if edit["field"] != LINEAR_GRADIENT_X:
            raise ValueError(f"Unsupported field for the Blender golden: {edit['field']}")
        texture = bpy.data.textures.new("Gradient", "BLEND")
        texture.progression = "LINEAR"
        modifier.texture = texture
        modifier.texture_coords = "LOCAL"


def add_decimate(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Decimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = edit["ratio"]
    modifier.use_collapse_triangulate = True


def add_remesh(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Remesh", "REMESH")
    modifier.mode = "VOXEL"
    modifier.voxel_size = edit["voxelSize"]
    modifier.adaptivity = 0
    modifier.use_smooth_shade = False


def add_weld(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Weld", "WELD")
    modifier.mode = "ALL"
    modifier.merge_threshold = edit.get("distance", 0.001)


def add_triangulate(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Triangulate", "TRIANGULATE")
    modifier.min_vertices = edit.get("minVertices", 4)
    modifier.quad_method = "BEAUTY"
    modifier.ngon_method = "BEAUTY"


def add_edge_split(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("EdgeSplit", "EDGE_SPLIT")
    modifier.use_edge_angle = True
    modifier.use_edge_sharp = False
    modifier.split_angle = radians(edit.get("angle", 30))


def add_smooth(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Smooth", "SMOOTH")
    modifier.factor = edit.get("factor", 0.5)
    modifier.iterations = edit.get("iterations", 1)


def add_simple_deform(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("SimpleDeform", "SIMPLE_DEFORM")
    modifier.deform_method = edit["mode"].upper()
    modifier.deform_axis = edit.get("axis", "z").upper()
    # Blender stores angle and factor in one field, so set only the one this mode uses.
    if edit["mode"] in ("twist", "bend"):
        modifier.angle = radians(edit.get("angle", 45))
    else:
        modifier.factor = edit.get("factor", 0.5)


def add_cast(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Cast", "CAST")
    modifier.cast_type = "SPHERE"
    modifier.factor = edit.get("factor", 0.5)
    modifier.radius = 0
    modifier.size = edit.get("size", 0)
    modifier.use_radius_as_size = False


def add_screw(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Screw", "SCREW")
    modifier.axis = edit.get("axis", "z").upper()
    modifier.angle = radians(edit.get("angle", 360))
    modifier.steps = edit.get("steps", 16)
    modifier.render_steps = modifier.steps
    modifier.iterations = edit.get("iterations", 1)
    modifier.screw_offset = edit.get("lift", 0)
    modifier.use_merge_vertices = False


def add_wireframe(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Wireframe", "WIREFRAME")
    modifier.thickness = edit.get("thickness", 0.02)
    modifier.offset = edit.get("offset", 0)
    modifier.use_even_offset = edit.get("evenOffset", True)
    modifier.use_replace = edit.get("replace", True)
    modifier.use_boundary = False


# Blender reads the frame number as the time of the wave.
def add_wave(mesh_object, edit, _inputs):
    modifier = mesh_object.modifiers.new("Wave", "WAVE")
    modifier.height = edit.get("height", 0.5)
    modifier.width = edit.get("width", 1.5)
    modifier.narrowness = edit.get("narrowness", 1.5)
    modifier.speed = edit.get("speed", 0.25)
    modifier.time_offset = edit.get("timeOffset", 0)
    start = edit.get("start", [0, 0])
    modifier.start_position_x = start[0]
    modifier.start_position_y = start[1]
    modifier.use_cyclic = edit.get("cyclic", True)
    modifier.use_normal = edit.get("normal", False)
    modifier.use_x = edit.get("axes", "xy") in ("xy", "x")
    modifier.use_y = edit.get("axes", "xy") in ("xy", "y")
    bpy.context.scene.frame_set(int(edit.get("time", 0)))


def add_dual(mesh_object, _edit, _inputs):
    tree = bpy.data.node_groups.new("DualMesh", "GeometryNodeTree")
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = tree.nodes.new("NodeGroupInput")
    group_output = tree.nodes.new("NodeGroupOutput")
    dual = tree.nodes.new("GeometryNodeDualMesh")
    tree.links.new(group_input.outputs[0], dual.inputs["Mesh"])
    tree.links.new(dual.outputs["Dual Mesh"], group_output.inputs[0])
    modifier = mesh_object.modifiers.new("DualMesh", "NODES")
    modifier.node_group = tree


MODIFIERS = {
    "dual": add_dual,
    "wave": add_wave,
    "screw": add_screw,
    "wireframe": add_wireframe,
    "weld": add_weld,
    "triangulate": add_triangulate,
    "edge_split": add_edge_split,
    "smooth": add_smooth,
    "simple_deform": add_simple_deform,
    "cast": add_cast,
    "decimate": add_decimate,
    "remesh": add_remesh,
    "set_position": add_set_position,
    "displace": add_displace,
    "mirror": add_mirror,
    "array": add_array,
    "solidify": add_solidify,
    "boolean": add_boolean,
    "subdivide": add_subdivision,
    "shrinkwrap": add_shrinkwrap,
}


def run_bmesh_case(case, inputs):
    bm = new_bmesh(inputs[case["input"]])
    BMESH_OPERATIONS[case["edit"]["op"]](bm, case["edit"])
    refresh(bm)
    return bm


# bmesh.ops.grid_fill returns nothing in background mode, so the Fill > Grid Fill operator runs in edit mode instead.
def run_operator_case(case, inputs):
    mesh_object = new_object("Input", inputs[case["input"]])
    bpy.context.view_layer.objects.active = mesh_object
    mesh_object.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    edit_bm = bmesh.from_edit_mesh(mesh_object.data)
    refresh(edit_bm)
    loop_edges = selected_edges(edit_bm, case["edit"]["edges"])
    for edge in loop_edges:
        edge.select_set(True)
    edit_bm.select_flush_mode()
    bmesh.update_edit_mesh(mesh_object.data)
    bpy.ops.mesh.fill_grid(span=len(loop_edges) // 4, offset=0, use_interp_simple=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    refresh(bm)
    return bm


def run_modifier_case(case, inputs):
    mesh_object = new_object("Input", inputs[case["input"]])
    MODIFIERS[case["edit"]["op"]](mesh_object, case["edit"], inputs)
    bpy.context.view_layer.update()
    evaluated = mesh_object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    bm = bmesh.new()
    bm.from_mesh(evaluated.to_mesh())
    refresh(bm)
    evaluated.to_mesh_clear()
    return bm


def fan_triangles(face):
    corners = [vertex.co for vertex in face.verts]
    for index in range(1, len(corners) - 1):
        yield corners[0], corners[index], corners[index + 1]


def measure(bm):
    volume = 0.0
    area = 0.0
    for face in bm.faces:
        # Summing signed triangles keeps both measures right on a concave face.
        vector_area = Vector((0, 0, 0))
        for first, second, third in fan_triangles(face):
            volume += first.dot(second.cross(third)) / 6
            vector_area += (second - first).cross(third - first) / 2
        area += vector_area.length
    positions = [list(vertex.co) for vertex in bm.verts]
    face_sizes = {}
    for face in bm.faces:
        size = str(len(face.verts))
        face_sizes[size] = face_sizes.get(size, 0) + 1
    return {
        "vertexCount": len(bm.verts),
        "edgeCount": len(bm.edges),
        "faceCount": len(bm.faces),
        "faceSizes": dict(sorted(face_sizes.items(), key=lambda entry: int(entry[0]))),
        "volume": round(abs(volume), 6),
        "area": round(area, 6),
        "positions": sorted([round(value, 5) for value in position] for position in positions),
    }


def surface_tree(bm):
    triangulated = bm.copy()
    bmesh.ops.triangulate(triangulated, faces=list(triangulated.faces))
    triangulated.verts.ensure_lookup_table()
    tree = BVHTree.FromBMesh(triangulated)
    return tree, triangulated


def farthest_vertex(bm, tree):
    farthest = 0.0
    for vertex in bm.verts:
        location = tree.find_nearest(vertex.co)[0]
        if location is not None:
            farthest = max(farthest, (location - vertex.co).length)
    return farthest


# Approximating operations change the face count, so they are compared by what the surface does: its volume and area
# and its Hausdorff distance to the input, measured at vertices in both directions (the same way the JS test does).
def measure_surface(bm, reference):
    measured = measure(bm)
    output_tree, output_copy = surface_tree(bm)
    reference_tree, reference_copy = surface_tree(reference)
    hausdorff = max(farthest_vertex(bm, reference_tree), farthest_vertex(reference, output_tree))
    output_copy.free()
    reference_copy.free()
    return {
        "faceCount": measured["faceCount"],
        "volume": measured["volume"],
        "area": measured["area"],
        "hausdorff": round(hausdorff, 6),
    }


def evaluated_measure(curve_object):
    bpy.context.view_layer.update()
    evaluated = curve_object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    bm = bmesh.new()
    bm.from_mesh(evaluated.to_mesh())
    evaluated.to_mesh_clear()
    refresh(bm)
    triangulated = bm.copy()
    bmesh.ops.triangulate(triangulated, faces=list(triangulated.faces))
    measured = measure(triangulated)
    positions = [vertex.co for vertex in bm.verts]
    result = {
        "vertexCount": len(bm.verts),
        "volume": measured["volume"],
        "area": measured["area"],
        "boundsMin": [round(min(position[axis] for position in positions), 5) for axis in range(3)],
        "boundsMax": [round(max(position[axis] for position in positions), 5) for axis in range(3)],
    }
    triangulated.free()
    bm.free()
    return result


# A Bezier curve with a round bevel: the 67js radialSegments 4 + 2n sides is Blender's bevel resolution n, and the
# caps are filled. Handles are absolute positions in both.
def run_curve_case(case):
    spec = case["curve"]
    curve_data = bpy.data.curves.new(case["id"], "CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = spec["resolution"]
    curve_data.bevel_depth = spec["radius"]
    curve_data.bevel_resolution = (spec["radialSegments"] - 4) // 2
    curve_data.fill_mode = "FULL"
    curve_data.use_fill_caps = True
    spline = curve_data.splines.new("BEZIER")
    spline.bezier_points.add(len(spec["points"]) - 1)
    spline.use_cyclic_u = spec.get("closed", False)
    spline.resolution_u = spec["resolution"]
    for bezier_point, knot in zip(spline.bezier_points, spec["points"]):
        bezier_point.co = knot["position"]
        bezier_point.handle_left_type = "FREE"
        bezier_point.handle_right_type = "FREE"
        bezier_point.handle_left = knot["handleIn"]
        bezier_point.handle_right = knot["handleOut"]
    curve_object = bpy.data.objects.new(case["id"], curve_data)
    bpy.context.scene.collection.objects.link(curve_object)
    return evaluated_measure(curve_object)


# Blender's own default font is not DejaVu Sans, so the text cases load the font 67js bundles. Get DejaVuSans.ttf with
# "npm pack dejavu-fonts-ttf" (ttf/DejaVuSans.ttf in the package) and point DEJAVU_SANS_TTF at it.
def bundled_font():
    path = os.environ.get("DEJAVU_SANS_TTF")
    if not path:
        raise SystemExit("Set DEJAVU_SANS_TTF to the path of DejaVuSans.ttf (version 2.37) to run the text cases.")
    return bpy.data.fonts.load(path)


# Blender's text object extrudes both ways from the baseline plane, so its extrude is half the 67js depth.
def text_measure(name, body, size, extrude, curve_segments):
    font_data = bpy.data.curves.new(name, "FONT")
    font_data.font = bundled_font()
    font_data.body = body
    font_data.size = size
    font_data.extrude = extrude
    font_data.resolution_u = curve_segments
    text_object = bpy.data.objects.new(name, font_data)
    bpy.context.scene.collection.objects.link(text_object)
    return evaluated_measure(text_object)


# Blender 5.2 draws text smaller than the font's em for the same size. The unit is calibrated on the capital I, whose
# height in DejaVu Sans is 1493 of 2048 units, so every other measure is compared at the same scale.
DEJAVU_CAP_HEIGHT_EMS = 1493 / 2048


def blender_size_for(size):
    calibration = text_measure("Calibration", "I", 1.0, 0.1, 4)
    return size * DEJAVU_CAP_HEIGHT_EMS / calibration["boundsMax"][1]


def run_text_case(case):
    spec = case["text"]
    return text_measure(case["id"], spec["text"], blender_size_for(spec["size"]), spec["depth"] / 2, spec["curveSegments"])


def remove_all_objects():
    for mesh_object in list(bpy.data.objects):
        bpy.data.objects.remove(mesh_object)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)


def main():
    fixture = json.loads((FIXTURE_DIRECTORY / "cases.json").read_text(encoding="utf-8"))
    results = {}
    for case in fixture["cases"]:
        remove_all_objects()
        operation = case["edit"]["op"]
        runner = run_bmesh_case if operation in BMESH_OPERATIONS else run_modifier_case
        if operation == "grid_fill":
            runner = run_operator_case
        bm = runner(case, fixture["inputs"])
        if case.get("compare") == "surface":
            reference = new_bmesh(fixture["inputs"][case["input"]])
            results[case["id"]] = measure_surface(bm, reference)
            reference.free()
        else:
            results[case["id"]] = measure(bm)
        bm.free()
    curves = {}
    for case in fixture["curves"]:
        remove_all_objects()
        curves[case["id"]] = run_curve_case(case)
    texts = {}
    for case in fixture["texts"]:
        remove_all_objects()
        texts[case["id"]] = run_text_case(case)
    output = {"blenderVersion": bpy.app.version_string, "results": results, "curves": curves, "texts": texts}
    (FIXTURE_DIRECTORY / "golden.json").write_text(json.dumps(output, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(results)} results from Blender {bpy.app.version_string}.")


main()
