# How much of a Cycles frame is reflection, and how far 67js is from the frame with and without it (issue #506).
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/reflection-share.py \
#     <cycles directory> <frames directory> <output directory> <scene id>,<scene id> [--labels a,b]
# The Cycles directory holds <id>-cycles.npy, and optionally <id>-cycles-noglossy.npy (render-blender.py --no-glossy) and <id>-materials.npy and
# <id>-materials.json (--material-ids). The frames directory holds the 67js frames as <id>-<label>.png for each label (default before,after; a label may also be a subdirectory holding <id>.png).
# Writes <output>/metrics.json and one sheet per scene: each 67js frame, Cycles without glossy, Cycles full.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2
PANEL_WIDTH = 480
PANEL_HEIGHT = 270
LABEL_HEIGHT = 22
LUMINANCE_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def tone_map_like_67js(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return float(mean_error)


def frame_statistics(display):
    luminance = display @ LUMINANCE_WEIGHTS
    linear = display ** GAMMA
    return {
        "mean": round(float(luminance.mean()), 4),
        "p20": round(float(np.percentile(luminance, 20)), 4),
        "rb": round(float(linear[:, :, 0].sum() / max(linear[:, :, 2].sum(), 1e-9)), 3),
    }


def reflection_by_material(full, without, cycles_directory, scene_id):
    """Signed and absolute linear luminance the reflections add, per material, as a share of the whole frame's luminance."""
    difference = (full - without) @ LUMINANCE_WEIGHTS
    total = float((full @ LUMINANCE_WEIGHTS).sum())
    result = {
        "reflectionShareSigned": round(float(difference.sum()) / total, 4),
        "reflectionShareAbsolute": round(float(np.abs(difference).sum()) / total, 4),
    }
    ids_path = cycles_directory / f"{scene_id}-materials.npy"
    if not ids_path.exists():
        return result
    identifiers = np.load(ids_path)
    names = ["sky"] + json.loads((cycles_directory / f"{scene_id}-materials.json").read_text())
    per_material = {}
    for index, name in enumerate(names):
        mask = identifiers == index
        if not mask.any():
            continue
        per_material[name] = {
            "pixels": round(float(mask.mean()), 4),
            "frameLuminance": round(float((full @ LUMINANCE_WEIGHTS)[mask].sum()) / total, 4),
            "reflectionSigned": round(float(difference[mask].sum()) / total, 4),
            "reflectionAbsolute": round(float(np.abs(difference[mask]).sum()) / total, 4),
        }
    result["byMaterial"] = per_material
    return result


def panel(display, label):
    image = Image.fromarray(np.round(np.clip(display, 0, 1) * 255).astype(np.uint8)).resize((PANEL_WIDTH, PANEL_HEIGHT), Image.LANCZOS)
    canvas = Image.new("RGB", (PANEL_WIDTH, PANEL_HEIGHT + LABEL_HEIGHT), (20, 20, 20))
    canvas.paste(image, (0, LABEL_HEIGHT))
    ImageDraw.Draw(canvas).text((6, 5), label, fill=(235, 235, 235))
    return canvas


def sheet(panels):
    canvas = Image.new("RGB", (PANEL_WIDTH * len(panels), PANEL_HEIGHT + LABEL_HEIGHT))
    for index, item in enumerate(panels):
        canvas.paste(item, (index * PANEL_WIDTH, 0))
    return canvas


def main():
    arguments = sys.argv[1:]
    labels = ["before", "after"]
    if "--labels" in arguments:
        flag_index = arguments.index("--labels")
        labels = arguments[flag_index + 1].split(",")
        del arguments[flag_index:flag_index + 2]
    cycles_directory, frames_directory, output_directory = (Path(item) for item in arguments[:3])
    scene_ids = arguments[3].split(",")
    output_directory.mkdir(parents=True, exist_ok=True)
    metrics = {}
    sheets = []
    for scene_id in scene_ids:
        full_linear = np.load(cycles_directory / f"{scene_id}-cycles.npy")
        full = tone_map_like_67js(full_linear)
        without_path = cycles_directory / f"{scene_id}-cycles-noglossy.npy"
        without_linear = np.load(without_path) if without_path.exists() else None
        without = tone_map_like_67js(without_linear) if without_linear is not None else None
        entry = {"cycles-full": frame_statistics(full)}
        if without is not None:
            entry["cycles-noglossy"] = frame_statistics(without)
            entry["flip-full-vs-noglossy"] = round(flip_score(full, without), 4)
            entry.update(reflection_by_material(full_linear, without_linear, cycles_directory, scene_id))
        panels = []
        for label in labels:
            frame = load_png(frames_directory / f"{scene_id}-{label}.png") if (frames_directory / f"{scene_id}-{label}.png").exists() else load_png(frames_directory / label / f"{scene_id}.png")
            entry[label] = {"flip-vs-full": round(flip_score(full, frame), 4), **frame_statistics(frame)}
            title = f"{scene_id} {label}  FLIP to Cycles full {entry[label]['flip-vs-full']:.4f}"
            if without is not None:
                entry[label]["flip-vs-noglossy"] = round(flip_score(without, frame), 4)
                title += f", no-glossy {entry[label]['flip-vs-noglossy']:.4f}"
            panels.append(panel(frame, title))
        if without is not None:
            panels.append(panel(without, f"Cycles no glossy  FLIP to full {entry['flip-full-vs-noglossy']:.4f}"))
        panels.append(panel(full, "Cycles full"))
        metrics[scene_id] = entry
        scene_sheet = sheet(panels)
        scene_sheet.save(output_directory / f"sheet-{scene_id}.png")
        sheets.append(scene_sheet)
        print(scene_id, json.dumps({key: value for key, value in entry.items() if key != "byMaterial"}))
    combined = Image.new("RGB", (max(item.width for item in sheets), sheets[0].height * len(sheets)))
    for index, item in enumerate(sheets):
        combined.paste(item, (0, index * item.height))
    combined.save(output_directory / "sheet.png")
    (output_directory / "metrics.json").write_text(json.dumps(metrics, indent=1))


main()
