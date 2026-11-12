"""Floor-only variants of the metal scene that split the floor's direct light into sun, flat sky and the real sky (#1104).

  uv run --no-project python bench/cycles-parity/make-floor-scenes.py <dataDirectory>

Reads <dataDirectory>/scenes/metal.json and writes floor-<variant>.json beside it, plus two flat skies as Radiance files in
<dataDirectory>/hdri. Run it from the repository root: the world file paths are relative to it.

Variants (all keep only the floor part; the suite renders them with --grey-diffuse, so the floor is a Lambert surface of albedo 0.8):
  td-*  camera straight down at the floor, so every pixel sees the same light and no horizon, edge or shadow is in the picture
  ob-*  the metal scene's own camera, to bring the horizon and the grazing floor back
  sun    sun only, black constant sky
  flat-a / flat-b   no sun, a flat sky Radiance file whose texels are RGBE (128,128,128,128) and (255,255,255,128)
  const  no sun, constant world 0.5 (no environment table)
  sky    no sun, the Kloofendal 1k sky
  both   sun and the Kloofendal sky
  sk-*   no sun, the Kloofendal sky seen from 1.5 m: level (sk-h), 45 degrees up (sk-45), straight up (sk-up); the background pixels of these
         pictures give the sky lookup itself, without any lighting
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FLAT_WIDTH = 1024
FLAT_HEIGHT = 512
MAXIMUM_RUN_LENGTH = 127
SUN_COLOR = [3.0, 2.8, 2.5]
KLOOFENDAL = {"type": "hdri", "file": "public/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr", "intensity": 1, "radianceLimit": 16}
TOP_DOWN_CAMERA = {"eye": [0, 3, 0], "target": [0, 0, 0], "up": [0, 0, -1], "fov": 35, "near": 0.1, "far": 200}


def encode_run_length_channel(value, width):
    encoded = bytearray()
    remaining = width
    while remaining > 0:
        run = min(MAXIMUM_RUN_LENGTH, remaining)
        encoded += bytes([128 + run, value])
        remaining -= run
    return bytes(encoded)


def write_flat_radiance(path, mantissa, exponent):
    header = f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {FLAT_HEIGHT} +X {FLAT_WIDTH}\n".encode("ascii")
    scanline = bytes([2, 2, FLAT_WIDTH >> 8, FLAT_WIDTH & 255])
    for channel_value in (mantissa, mantissa, mantissa, exponent):
        scanline += encode_run_length_channel(channel_value, FLAT_WIDTH)
    with open(path, "wb") as handle:
        handle.write(header + scanline * FLAT_HEIGHT)


def looking_at(target, up):
    return {"eye": [0, 1.5, 0], "target": target, "up": up, "fov": 60, "near": 0.1, "far": 200}


def floor_only(description):
    floor_index = next(index for index, part in enumerate(description["parts"]) if part["name"] == "floor")
    floor_part = dict(description["parts"][floor_index])
    floor_geometry = description["geometries"][floor_part["geometry"]]
    floor_part["geometry"] = 0
    reduced = dict(description)
    reduced["parts"] = [floor_part]
    reduced["geometries"] = [floor_geometry]
    return reduced


def variant(description, name, camera, key_color, world):
    scene = dict(description)
    scene["id"] = f"floor-{name}"
    scene["camera"] = camera
    scene["environment"] = dict(description["environment"], keyColor=key_color)
    scene["world"] = world
    return scene


def main():
    data_directory = sys.argv[1]
    repository_root = os.getcwd()
    with open(os.path.join(data_directory, "scenes", "metal.json"), encoding="utf-8") as handle:
        metal = json.load(handle)
    floor = floor_only(metal)
    hdri_directory = os.path.join(data_directory, "hdri")
    os.makedirs(hdri_directory, exist_ok=True)
    flat_worlds = {}
    for name, mantissa in (("flat-a", 128), ("flat-b", 255)):
        path = os.path.join(hdri_directory, f"{name}.hdr")
        write_flat_radiance(path, mantissa, 128)
        relative = os.path.relpath(path, repository_root).replace(os.sep, "/")
        flat_worlds[name] = {"type": "hdri", "file": relative, "intensity": 1, "radianceLimit": 16}
    black = {"type": "constant", "value": 0}
    no_sun = [0, 0, 0]
    oblique = metal["camera"]
    scenes = {
        "td-sun": (TOP_DOWN_CAMERA, SUN_COLOR, black),
        "td-flat-a": (TOP_DOWN_CAMERA, no_sun, flat_worlds["flat-a"]),
        "td-flat-b": (TOP_DOWN_CAMERA, no_sun, flat_worlds["flat-b"]),
        "td-const": (TOP_DOWN_CAMERA, no_sun, {"type": "constant", "value": 0.5}),
        "td-sky": (TOP_DOWN_CAMERA, no_sun, KLOOFENDAL),
        "td-both": (TOP_DOWN_CAMERA, SUN_COLOR, KLOOFENDAL),
        "ob-sun": (oblique, SUN_COLOR, black),
        "ob-sky": (oblique, no_sun, KLOOFENDAL),
        "ob-both": (oblique, SUN_COLOR, KLOOFENDAL),
        "sk-h": (looking_at([0, 1.5, -10], [0, 1, 0]), no_sun, KLOOFENDAL),
        "sk-45": (looking_at([0, 2.5, -1], [0, 1, 0]), no_sun, KLOOFENDAL),
        "sk-up": (looking_at([0, 5, 0], [0, 0, -1]), no_sun, KLOOFENDAL),
    }
    for name, (camera, key_color, world) in scenes.items():
        with open(os.path.join(data_directory, "scenes", f"floor-{name}.json"), "w", encoding="utf-8") as handle:
            json.dump(variant(floor, name, camera, key_color, world), handle)
    print(f"wrote {len(scenes)} floor scenes and {len(flat_worlds)} flat skies; sun direction {metal['environment']['lightDirection']}")


main()
