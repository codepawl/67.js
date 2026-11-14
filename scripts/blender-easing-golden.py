# Writes tests/fixtures/blender/easing-golden.json: every Blender keyframe easing evaluated on one channel that goes
# from 0 to 1 over one frame, at 20 sample times. Run it when an easing case changes or Blender moves to a new release:
#   blender -b --factory-startup --python scripts/blender-easing-golden.py
import json
from pathlib import Path

import bpy

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "blender" / "easing-golden.json"
SAMPLE_COUNT = 20
FAMILIES = {
    "Sine": "SINE",
    "Quad": "QUAD",
    "Cubic": "CUBIC",
    "Quart": "QUART",
    "Quint": "QUINT",
    "Expo": "EXPO",
    "Circ": "CIRC",
    "Back": "BACK",
    "Bounce": "BOUNCE",
    "Elastic": "ELASTIC",
}
# The Crucible defaults for Elastic, given to Blender explicitly: Blender stores a period in frames (4.1 by default), which
# has no meaning for a segment of unknown length, and treats 0 as a tiny period.
DEFAULT_ELASTIC_SETTINGS = {"EASE_IN": {"amplitude": 1.0, "period": 0.3}, "EASE_OUT": {"amplitude": 1.0, "period": 0.3}, "EASE_IN_OUT": {"amplitude": 1.0, "period": 0.45}}
DIRECTIONS = {"In": "EASE_IN", "Out": "EASE_OUT", "InOut": "EASE_IN_OUT"}
# Non-default Back and Elastic settings. Blender's amplitude and period are absolute values; over a one-unit change in
# one frame they equal the multiple of the change and the fraction of the segment that Crucible takes.
PARAMETER_CASES = [  # (easing as written in a keyframe, family, Blender easing, Blender settings)
    ("easeOutBack(3)", "Back", "EASE_OUT", {"back": 3.0}),
    ("easeInBack(0.5)", "Back", "EASE_IN", {"back": 0.5}),
    ("easeInOutBack(2.5)", "Back", "EASE_IN_OUT", {"back": 2.5}),
    ("easeOutElastic(1.5, 0.4)", "Elastic", "EASE_OUT", {"amplitude": 1.5, "period": 0.4}),
    ("easeInElastic(2, 0.2)", "Elastic", "EASE_IN", {"amplitude": 2.0, "period": 0.2}),
    ("easeInOutElastic(1.2, 0.3)", "Elastic", "EASE_IN_OUT", {"amplitude": 1.2, "period": 0.3}),
]


def evaluate_easing(interpolation, easing, settings):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cube = bpy.data.objects.new("cube", None)
    bpy.context.scene.collection.objects.link(cube)
    cube.location = (0.0, 0.0, 0.0)
    cube.keyframe_insert("location", index=0, frame=0)
    cube.location = (1.0, 0.0, 0.0)
    cube.keyframe_insert("location", index=0, frame=1)
    action = cube.animation_data.action
    fcurve = action.layers[0].strips[0].channelbags[0].fcurves[0]
    first_point = fcurve.keyframe_points[0]
    first_point.interpolation = interpolation
    first_point.easing = easing
    for name, value in settings.items():
        setattr(first_point, name, value)
    return [fcurve.evaluate(index / (SAMPLE_COUNT - 1)) for index in range(SAMPLE_COUNT)]


def main():
    cases = []
    for family, interpolation in FAMILIES.items():
        for direction, easing in DIRECTIONS.items():
            cases.append({
                "easing": f"ease{direction}{family}",
                "values": evaluate_easing(interpolation, easing, DEFAULT_ELASTIC_SETTINGS[easing] if family == "Elastic" else {}),
            })
    for name, family, easing, blender_settings in PARAMETER_CASES:
        cases.append({
            "easing": name,
            "values": evaluate_easing(FAMILIES[family], easing, blender_settings),
        })
    output = {"blender": bpy.app.version_string, "sampleCount": SAMPLE_COUNT, "cases": cases}
    OUTPUT_PATH.write_text(json.dumps(output, indent=1) + "\n", encoding="utf-8")


main()
