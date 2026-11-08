# Splits a hall into light components on both sides and prints one table per hall (issue #543).
#   uv run --no-project --with openexr --with numpy --with pillow python -I bench/reference/light-components.py <passes directory>... -- <variants directory> <out.md>
# Cycles side: <id>-passes.exr from render-blender.py --passes, in linear radiance. 67js side: <variants>/<label>/<id>.png, drawn by
# artifacts/543/variants.sh, turned back into linear radiance by inverting the display fit (tone map and gamma 2.2).
# Components are mean linear luminance over the frame. 67js has no light passes, so its components are differences between renders:
# haze = vE - vE-nofog, sun = vE - vE-nosun, and what is left with sun and haze off is the sky and the bounced light.
import json
import sys
from pathlib import Path

import numpy as np
import OpenEXR
from PIL import Image

GAMMA = 2.2
LUMINANCE = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
WIDTH = 960
HEIGHT = 540
HALLS = {
    "temple-hall": "temple-hall",
    "temple-hall-a": "temple-hall-a",
    "temple-hall-b": "temple-hall-b",
    "temple-hall-c": "temple-hall-c",
    "dark-shaft": "dark-shaft",
}


def tone_map(linear):
    color = np.maximum(linear, 0)
    return np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1) ** (1 / GAMMA)


_SAMPLES = np.concatenate([[0], np.geomspace(1e-5, 60, 4000)]).astype(np.float64)
_DISPLAY = tone_map(_SAMPLES)


def to_linear(display):
    """The inverse of the display fit; a clipped pixel (1.0) maps to the largest value the fit reaches."""
    return np.interp(display, _DISPLAY, _SAMPLES).astype(np.float32)


def load_png_linear(path):
    display = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255
    return to_linear(display)


def read_passes(path):
    exr = OpenEXR.File(str(path))
    # Blender writes one EXR part for each pass, named ViewLayer.<pass name>.
    result = {}
    for part in exr.parts:
        for key, channel in part.channels.items():
            result[key.split(".", 1)[-1]] = np.asarray(channel.pixels, dtype=np.float32)[:, :, :3]
    return result


def luminance_mean(image, mask=None):
    values = image @ LUMINANCE
    return float(values.mean() if mask is None else values[mask].mean()) if (mask is None or mask.any()) else float("nan")


def cycles_components(passes):
    names = {key.lower(): key for key in passes}
    def get(*candidates):
        for candidate in candidates:
            if candidate.lower() in names:
                return passes[names[candidate.lower()]]
        return np.zeros((HEIGHT, WIDTH, 3), dtype=np.float32)
    diffuse_direct = get("DiffDir", "Diffuse Direct", "DiffuseDirect")
    diffuse_indirect = get("DiffInd", "Diffuse Indirect", "DiffuseIndirect")
    diffuse_color = get("DiffCol", "Diffuse Color", "DiffuseColor")
    glossy_direct = get("GlossDir", "Glossy Direct")
    glossy_indirect = get("GlossInd", "Glossy Indirect")
    glossy_color = get("GlossCol", "Glossy Color")
    return {
        "diffuse direct (sun on surfaces)": diffuse_direct * diffuse_color,
        "diffuse indirect (sky + bounces)": diffuse_indirect * diffuse_color,
        "glossy": (glossy_direct + glossy_indirect) * glossy_color,
        "haze direct": get("VolumeDir", "Volume Direct", "VolumeDirect"),
        "haze indirect": get("VolumeInd", "Volume Indirect", "VolumeIndirect"),
        "emission": get("Emit", "Emission"),
        "sky seen": get("Env", "Environment"),
        "combined": get("Combined", "Composite"),
    }


def regions(components):
    sun = components["diffuse direct (sun on surfaces)"] @ LUMINANCE
    sky = components["sky seen"] @ LUMINANCE
    combined = components["combined"] @ LUMINANCE
    haze = (components["haze direct"] + components["haze indirect"]) @ LUMINANCE
    surface = sky < 0.02
    return {
        "frame": np.ones_like(sun, dtype=bool),
        "surface in sun": surface & (sun > 0.1),
        "surface in shade": surface & (sun < 0.01) & (haze < 0.5 * combined),
        "haze-dominated air": haze > 0.5 * np.maximum(combined, 1e-6),
        "sky": ~surface,
    }


def main():
    separator = sys.argv.index("--")
    pass_directories = [Path(item) for item in sys.argv[1:separator]]
    variants = Path(sys.argv[separator + 1])
    output = Path(sys.argv[separator + 2])
    lines = ["# Light components, Cycles vs 67js (issue #543)", "", "Cycles components from render-blender.py (--passes, --no-fog, --sun-strength 0); 67js from the renders of artifacts/543/variants.sh.", ""]
    for hall, passes_name in HALLS.items():
        path = next((directory / f"{passes_name}-passes.exr" for directory in pass_directories if (directory / f"{passes_name}-passes.exr").exists()), None)
        if path is None:
            continue
        passes = read_passes(path)
        cycles = cycles_components(passes)
        label = {}
        for variant in ("main", "vE", "vE-nofog", "vE-nosun", "vE-nosun-nofog", "main-nofog", "main-nosun", "main-nosun-nofog"):
            variant_path = variants / variant / f"{hall}.png"
            if variant_path.exists():
                label[variant] = load_png_linear(variant_path)
        cycles_directory = next(directory for directory in pass_directories if (directory / f"{passes_name}-passes.exr").exists())
        cycles_variant = {
            "total": cycles["combined"],
            "nofog": np.load(cycles_directory / f"{hall}-cycles-nofog.npy"),
            "nosun": np.load(cycles_directory / f"{hall}-cycles-sun0.npy"),
            "base": np.load(cycles_directory / f"{hall}-cycles-nofog-sun0.npy"),
        }
        js_variant = {
            "vE": {"total": label.get("vE"), "nofog": label.get("vE-nofog"), "nosun": label.get("vE-nosun"), "base": label.get("vE-nosun-nofog")},
            "main": {"total": label.get("main"), "nofog": label.get("main-nofog"), "nosun": label.get("main-nosun"), "base": label.get("main-nosun-nofog")},
        }
        def split(variant):
            if any(variant.get(key) is None for key in ("total", "nofog", "nosun", "base")):
                return None
            total, nofog, nosun, base = (variant[key] for key in ("total", "nofog", "nosun", "base"))
            return {
                "total": total,
                "sky + bounces + emission (no sun, no haze)": base,
                "sun on surfaces (haze off)": nofog - base,
                "haze with the sun off (net of its extinction)": nosun - base,
                "sun x haze (the rest)": total - nofog - nosun + base,
            }
        cycles_split = split(cycles_variant)
        vE_split = split(js_variant["vE"])
        main_split = split(js_variant["main"])
        lines += [f"## {hall}", "", "Mean linear luminance. Each row is a difference between renders, on both sides.", "", "| component | Cycles | 67js main | 67js vE | main / Cycles | vE / Cycles |", "|---|---|---|---|---|---|"]
        for name in cycles_split:
            cycles_value = luminance_mean(cycles_split[name])
            main_value = luminance_mean(main_split[name]) if main_split else float("nan")
            fog_value = luminance_mean(vE_split[name]) if vE_split else float("nan")
            lines.append(f"| {name} | {cycles_value:.4f} | {main_value:.4f} | {fog_value:.4f} | {main_value / cycles_value:.2f} | {fog_value / cycles_value:.2f} |")
        lines += ["", "Cycles light passes (frame mean; haze passes count in-scatter only):", "", "| pass | mean |", "|---|---|"]
        for name, image in cycles.items():
            lines.append(f"| {name} | {luminance_mean(image):.4f} |")
        masks = regions(cycles)
        lines += ["", "Regions (masks from Cycles; the same pixels on both sides), mean linear luminance:", "", "| region | pixels | Cycles | 67js main | 67js vE | vE / Cycles | main / Cycles |", "|---|---|---|---|---|---|---|"]
        for name, mask in masks.items():
            cycles_value = luminance_mean(cycles["combined"], mask)
            main_value = luminance_mean(label["main"], mask) if "main" in label else float("nan")
            fog_value = luminance_mean(label["vE"], mask) if "vE" in label else float("nan")
            lines.append(f"| {name} | {mask.mean():.1%} | {cycles_value:.4f} | {main_value:.4f} | {fog_value:.4f} | {fog_value / cycles_value:.2f} | {main_value / cycles_value:.2f} |")
        lines.append("")
    output.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
