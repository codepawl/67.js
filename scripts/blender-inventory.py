"""Dumps what Blender's own build offers, as JSON, for the parity comparison.

Run headless with factory settings (no add-ons beyond the defaults):
  blender -b --factory-startup --python scripts/blender-inventory.py -- bench/parity/blender-inventory.json
The output path is the first argument after "--". Compare with: node scripts/blender-inventory-compare.mjs
"""
import ast
import json
import os
import re
import sys

import bpy


def output_path():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return arguments[0] if arguments else "bench/parity/blender-inventory.json"


def enum_items(owner_type, property_name):
    """Enum items of a property on an RNA type, as identifier, name and description."""
    property_definition = owner_type.bl_rna.properties[property_name]
    return [
        {"identifier": item.identifier, "name": item.name, "description": item.description}
        for item in property_definition.enum_items
    ]


def property_summary(owner_type):
    """Every property of an RNA type with its kind, so settings groups can be listed."""
    summary = []
    for property_definition in owner_type.bl_rna.properties:
        if property_definition.identifier == "rna_type":
            continue
        entry = {
            "identifier": property_definition.identifier,
            "name": property_definition.name,
            "type": property_definition.type,
        }
        if property_definition.type == "ENUM":
            entry["enum_items"] = [item.identifier for item in property_definition.enum_items]
        summary.append(entry)
    return summary


def safe(function, fallback):
    """Runs one inventory step; a failing step is recorded instead of losing the whole dump."""
    try:
        return function()
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}", "fallback": fallback}


def operator_enum_items(operator_function, property_name):
    rna = operator_function.get_rna_type()
    return [
        {"identifier": item.identifier, "name": item.name}
        for item in rna.properties[property_name].enum_items
    ]


def all_subclasses(base_type):
    """Every registered subclass of a Blender UI or node type, at any depth."""
    found = []
    pending = list(base_type.__subclasses__())
    while pending:
        subclass = pending.pop()
        if subclass not in found:
            found.append(subclass)
            pending.extend(subclass.__subclasses__())
    return found


def panel_layout():
    panels = []
    for panel_class in all_subclasses(bpy.types.Panel):
        panels.append({
            "idname": getattr(panel_class, "bl_idname", None) or panel_class.bl_rna.identifier,
            "label": getattr(panel_class, "bl_label", None) or panel_class.bl_rna.name,
            "space_type": getattr(panel_class, "bl_space_type", None),
            "region_type": getattr(panel_class, "bl_region_type", None),
            "context": getattr(panel_class, "bl_context", None) or None,
            "category": getattr(panel_class, "bl_category", None) or None,
            "parent_id": getattr(panel_class, "bl_parent_id", None) or None,
        })
    panels.sort(key=lambda entry: (entry["space_type"] or "", entry["region_type"] or "", entry["context"] or "", entry["idname"]))
    return panels


def menu_list():
    menus = [
        {
            "idname": getattr(menu_class, "bl_idname", None) or menu_class.bl_rna.identifier,
            "label": getattr(menu_class, "bl_label", None) or menu_class.bl_rna.name,
        }
        for menu_class in all_subclasses(bpy.types.Menu)
    ]
    menus.sort(key=lambda entry: entry["idname"])
    return menus


def operator_inventory():
    categories = {}
    for category_name in sorted(dir(bpy.ops)):
        if category_name.startswith("_"):
            continue
        category = getattr(bpy.ops, category_name)
        operators = []
        for operator_name in sorted(dir(category)):
            if operator_name.startswith("_"):
                continue
            try:
                rna = getattr(category, operator_name).get_rna_type()
                operators.append({"name": operator_name, "label": rna.name, "description": rna.description})
            except Exception:
                operators.append({"name": operator_name, "label": "", "description": ""})
        categories[category_name] = {"count": len(operators), "operators": operators}
    return categories


def node_classes(base_type):
    entries = {}
    # Built-in nodes are C types that do not appear in __subclasses__, so scan bpy.types by name.
    prefixes = ("GeometryNode", "FunctionNode") if base_type is bpy.types.GeometryNode else (base_type.__name__,)
    for type_name in dir(bpy.types):
        node_class = getattr(bpy.types, type_name)
        is_node = isinstance(node_class, type) and issubclass(node_class, bpy.types.Node)
        if is_node and type_name.startswith(prefixes) and type_name not in ("GeometryNode", "FunctionNode") and type_name != base_type.__name__:
            entries[type_name] = node_class.bl_rna.name
    return entries


def menu_path(class_name, label):
    """Top menu and submenu, such as "Mesh > Operations", from a class like NODE_MT_gn_mesh_operations_base."""
    tokens = [token for token in class_name.replace("NODE_MT_", "").replace("_base", "").split("_")
              if token not in ("gn", "category", "compositor", "shader", "node", "cmp")]
    if not tokens:
        return label
    top_length = 2 if tokens[:2] == ["grease", "pencil"] else 1
    top = " ".join(tokens[:top_length]).title()
    return label if len(tokens) == top_length else f"{top} > {label}"


def add_menu_categories(file_name, node_names):
    """Groups node types by the Add menu class that lists them, read from Blender's own menu source."""
    source_path = os.path.join(bpy.utils.system_resource("SCRIPTS"), "startup", "bl_ui", file_name)
    with open(source_path, encoding="utf-8") as source_file:
        source = source_file.read()
    class_pattern = re.compile(r"^class (\w+)\(.*?\):\n(.*?)(?=^class |\Z)", re.S | re.M)
    categories = {}
    listed = set()
    for match in class_pattern.finditer(source):
        class_name, body = match.group(1), match.group(2)
        if not class_name.startswith("NODE_MT_"):
            continue
        label_match = re.search(r'bl_label = "([^"]+)"', body)
        label = menu_path(class_name, label_match.group(1) if label_match else class_name)
        members = re.findall(r'"((?:Geometry|Shader|Compositor|Function)Node\w+)"', body)
        members = [name for name in dict.fromkeys(members) if name in node_names]
        for name in members:
            categories.setdefault(label, [])
            if name not in categories[label]:
                categories[label].append(name)
            listed.add(name)
    unlisted = sorted(set(node_names) - listed)
    return categories, unlisted


def node_inventory(base_type, menu_file):
    names = node_classes(base_type)
    categories, unlisted = add_menu_categories(menu_file, names)
    return {
        "count": len(names),
        "add_menu_categories": {
            label: [{"idname": name, "label": names[name]} for name in members]
            for label, members in sorted(categories.items())
        },
        "not_in_add_menu": [{"idname": name, "label": names[name]} for name in unlisted],
    }


def physics_inventory():
    scene = bpy.context.scene
    return {
        "force_field_types": enum_items(bpy.types.FieldSettings, "type"),
        "particle_system_types": enum_items(bpy.types.ParticleSettings, "type"),
        "rigid_body_types": enum_items(bpy.types.RigidBodyObject, "type"),
        "rigid_body_collision_shapes": enum_items(bpy.types.RigidBodyObject, "collision_shape"),
        "rigid_body_constraint_types": enum_items(bpy.types.RigidBodyConstraint, "type"),
        "fluid_types": enum_items(bpy.types.FluidModifier, "fluid_type"),
        "dynamic_paint_types": enum_items(bpy.types.DynamicPaintModifier, "ui_type"),
        "settings": {
            "cloth": property_summary(bpy.types.ClothSettings),
            "cloth_collision": property_summary(bpy.types.ClothCollisionSettings),
            "soft_body": property_summary(bpy.types.SoftBodySettings),
            "fluid_domain": property_summary(bpy.types.FluidDomainSettings),
            "fluid_flow": property_summary(bpy.types.FluidFlowSettings),
            "dynamic_paint_surface": property_summary(bpy.types.DynamicPaintSurface),
            "particle_settings": property_summary(bpy.types.ParticleSettings),
            "force_field": property_summary(bpy.types.FieldSettings),
            "rigid_body_world": property_summary(bpy.types.RigidBodyWorld),
            "rigid_body_object": property_summary(bpy.types.RigidBodyObject),
        },
        "scene_has_rigid_body_world": scene.rigidbody_world is not None,
    }


def render_inventory():
    scene = bpy.context.scene
    engines = [
        {"identifier": engine_class.bl_idname, "name": engine_class.bl_label}
        for engine_class in all_subclasses(bpy.types.RenderEngine)
        if getattr(engine_class, "bl_idname", "")
    ]
    known_names = {engine["identifier"] for engine in engines}
    for candidate in ("BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"):
        # EEVEE and Workbench are built in and not Python classes; the scene accepts a valid engine name only.
        try:
            scene.render.engine = candidate
        except TypeError:
            continue
        if candidate not in known_names:
            engines.append({"identifier": candidate, "name": candidate.replace("BLENDER_", "").title()})
            known_names.add(candidate)
    # Every engine's settings live on the scene (eevee, cycles) or the display (workbench); read what is registered.
    settings = {}
    if hasattr(scene, "eevee"):
        settings["scene.eevee"] = property_summary(type(scene.eevee))
    if hasattr(scene, "cycles"):
        settings["scene.cycles"] = property_summary(type(scene.cycles))
        settings["view_layer.cycles"] = property_summary(type(scene.view_layers[0].cycles))
    settings["scene.display.shading"] = property_summary(type(scene.display.shading))
    return {
        "engines": engines,
        "engine_settings": settings,
        "scene_render": property_summary(bpy.types.RenderSettings),
        "image_format": property_summary(bpy.types.ImageFormatSettings),
        "ffmpeg": property_summary(bpy.types.FFmpegSettings),
        "view_layer": property_summary(bpy.types.ViewLayer),
        "image_file_formats": enum_items(bpy.types.ImageFormatSettings, "file_format"),
        "video_containers": enum_items(bpy.types.FFmpegSettings, "format"),
        "video_codecs": enum_items(bpy.types.FFmpegSettings, "codec"),
    }


def live_enum_identifiers(owner, property_name):
    """OpenColorIO enums are not in the RNA items; Blender lists them in the error for a bad value."""
    try:
        setattr(owner, property_name, "__not_a_value__")
    except TypeError as error:
        listed = re.search(r"in (\(.*\))\s*$", str(error))
        if listed:
            return list(ast.literal_eval(listed.group(1)))
    return []


def color_management_inventory():
    view_settings = bpy.context.scene.view_settings
    display_settings = bpy.context.scene.display_settings
    view_transforms = live_enum_identifiers(view_settings, "view_transform")
    looks_by_view_transform = {}
    for view_transform in view_transforms:
        view_settings.view_transform = view_transform
        looks_by_view_transform[view_transform] = live_enum_identifiers(view_settings, "look")
    return {
        "view_transforms": view_transforms,
        "looks_by_view_transform": looks_by_view_transform,
        "display_devices": live_enum_identifiers(display_settings, "display_device"),
        "view_settings": property_summary(bpy.types.ColorManagedViewSettings),
    }


def light_camera_world_inventory():
    return {
        "light_types": enum_items(bpy.types.Light, "type"),
        "light_settings": {
            "Light": property_summary(bpy.types.Light),
            "PointLight": property_summary(bpy.types.PointLight),
            "SunLight": property_summary(bpy.types.SunLight),
            "SpotLight": property_summary(bpy.types.SpotLight),
            "AreaLight": property_summary(bpy.types.AreaLight),
        },
        "light_probe_types": enum_items(bpy.types.LightProbe, "type"),
        "camera_types": enum_items(bpy.types.Camera, "type"),
        "camera_settings": property_summary(bpy.types.Camera),
        "camera_dof": property_summary(bpy.types.CameraDOFSettings),
        "world_settings": property_summary(bpy.types.World),
        "world_mist": property_summary(bpy.types.WorldMistSettings),
        "object_types": enum_items(bpy.types.Object, "type"),
        "mesh_primitive_operators": sorted(name for name in dir(bpy.ops.mesh) if name.startswith("primitive_")),
    }


def import_export_inventory():
    matches = []
    for category_name in sorted(dir(bpy.ops)):
        if category_name.startswith("_"):
            continue
        category = getattr(bpy.ops, category_name)
        for operator_name in sorted(dir(category)):
            lowered = operator_name.lower()
            if operator_name.startswith("_"):
                continue
            is_transfer = category_name.startswith(("import_", "export_")) or (
                lowered.endswith("_import") or lowered.endswith("_export")
                or lowered.startswith("import_") or lowered.startswith("export_")
            )
            if not is_transfer:
                continue
            try:
                rna = getattr(category, operator_name).get_rna_type()
                matches.append({"operator": f"{category_name}.{operator_name}", "label": rna.name, "description": rna.description})
            except Exception:
                matches.append({"operator": f"{category_name}.{operator_name}", "label": "", "description": ""})
    return matches


def modifier_constraint_inventory():
    return {
        "modifier_types": enum_items(bpy.types.Modifier, "type"),
        "constraint_types": enum_items(bpy.types.Constraint, "type"),
        "bone_constraint_types": operator_enum_items(bpy.ops.pose.constraint_add, "type"),
    }


def build_inventory():
    operators = operator_inventory()
    return {
        "blender_version": bpy.app.version_string,
        "blender_version_tuple": list(bpy.app.version),
        "factory_startup": True,
        "enabled_add_ons": sorted(bpy.context.preferences.addons.keys()),
        "ui": {"panels": safe(panel_layout, []), "menus": safe(menu_list, [])},
        "operators": operators,
        "operator_totals": {
            "categories": len(operators),
            "operators": sum(entry["count"] for entry in operators.values()),
        },
        "modifiers_and_constraints": safe(modifier_constraint_inventory, {}),
        "geometry_nodes": safe(lambda: node_inventory(bpy.types.GeometryNode, "node_add_menu_geometry.py"), {}),
        "shader_nodes": safe(lambda: node_inventory(bpy.types.ShaderNode, "node_add_menu_shader.py"), {}),
        "compositor_nodes": safe(lambda: node_inventory(bpy.types.CompositorNode, "node_add_menu_compositor.py"), {}),
        "physics": safe(physics_inventory, {}),
        "render": safe(render_inventory, {}),
        "color_management": safe(color_management_inventory, {}),
        "lights_cameras_world": safe(light_camera_world_inventory, {}),
        "import_export_operators": safe(import_export_inventory, []),
    }


def scrub(value):
    """Removes local paths and the user name from every string in the result."""
    home = os.path.expanduser("~")
    user = os.path.basename(home)
    if isinstance(value, str):
        text = value.replace(home, "~").replace(home.replace("\\", "/"), "~")
        return re.sub(re.escape(user), "user", text, flags=re.I) if user else text
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {scrub(key): scrub(item) for key, item in value.items()}
    return value


def main():
    inventory = scrub(build_inventory())
    path = output_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as output_file:
        json.dump(inventory, output_file, indent=1, ensure_ascii=False)
        output_file.write("\n")
    print("inventory written", inventory["operator_totals"])


main()
