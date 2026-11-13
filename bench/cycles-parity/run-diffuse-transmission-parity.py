"""Diffuse transmission parity (#1058): Cook against Blender Cycles on a thin sheet lit from behind and from the front.

Run from the repository root on a machine with Blender 5.3, Node, a GPU and the built render-native addon:
    uv run --no-project --with numpy python bench/cycles-parity/run-diffuse-transmission-parity.py <outputDirectory> [options]

It writes the scenes of make-diffuse-transmission-scenes.mjs, renders each with Cycles and with Cook and prints one result line
per scene: the channel mean ratios and the 8x8 tile ratios of Cook over Cycles. Options:
    --samples 1024  --width 480  --height 270  --bounces 8
    --scenes a,b            only these scenes
    --label cook            name of the Cook run in the output
    --repeat-cycles-seed2   also render Cycles with seed 2 for the seed-to-seed floor
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# The sphere light runner holds the render and comparison helpers, and its file name is not importable as a module.
_sphere_specification = importlib.util.spec_from_file_location("sphere_light_parity", os.path.join(HERE, "run-sphere-light-parity.py"))
sphere_light_parity = importlib.util.module_from_spec(_sphere_specification)
_sphere_specification.loader.exec_module(sphere_light_parity)

SCENE_NAMES = ("sheet-backlit", "sheet-front", "sheet-backlit-weight-0")
# The scene the weight 0 control belongs to: it must read as the backlit sheet with no light through it.
WEIGHT_ZERO_SCENE = "sheet-backlit-weight-0"
read_flag = sphere_light_parity.read_flag


def main():
    argument_list = sys.argv[1:]
    options = {
        "output_directory": os.path.abspath(argument_list[0]),
        "samples": int(read_flag(argument_list, "--samples", "1024")),
        "width": int(read_flag(argument_list, "--width", "480")),
        "height": int(read_flag(argument_list, "--height", "270")),
        "bounces": int(read_flag(argument_list, "--bounces", "8")),
    }
    label = read_flag(argument_list, "--label", "cook")
    wanted = [name for name in read_flag(argument_list, "--scenes", ",".join(SCENE_NAMES)).split(",") if name]
    blender = sphere_light_parity.find_blender()
    renders_directory = os.path.join(options["output_directory"], "renders")
    os.makedirs(renders_directory, exist_ok=True)
    sphere_light_parity.run(["node", os.path.join(HERE, "make-diffuse-transmission-scenes.mjs"), options["output_directory"]])
    results = {}
    for name in wanted:
        scene_path = os.path.join(options["output_directory"], "scenes", f"{name}.json")
        cook_prefix = os.path.join(renders_directory, f"{name}-{label}")
        cycles_prefix = os.path.join(renders_directory, f"{name}-cycles")
        sphere_light_parity.render_cook(scene_path, cook_prefix, options, options["bounces"], False, False)
        sphere_light_parity.render_cycles(blender, scene_path, cycles_prefix, options, options["bounces"], 1, "default", False)
        results[name] = sphere_light_parity.summarize(f"{cycles_prefix}.npy", f"{cook_prefix}.npy")
        results[f"{name}|cookSha256"] = sphere_light_parity.sha256_of(f"{cook_prefix}.npy")
        print("PARITY", name, json.dumps(results[name]), flush=True)
        if "--repeat-cycles-seed2" in argument_list:
            second_prefix = f"{cycles_prefix}-seed2"
            sphere_light_parity.render_cycles(blender, scene_path, second_prefix, options, options["bounces"], 2, "default", False)
            results[f"{name}|seed2VsSeed1"] = sphere_light_parity.summarize(f"{cycles_prefix}.npy", f"{second_prefix}.npy")
            print("FLOOR", name, json.dumps(results[f"{name}|seed2VsSeed1"]), flush=True)
    output_path = os.path.join(options["output_directory"], f"diffuse-transmission-{label}.json")
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=1)
    print("DONE", len(results))


if __name__ == "__main__":
    main()
