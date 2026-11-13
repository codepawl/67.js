# Scores the default look renders (issue #988) against the Cycles render of each scene with FLIP, and writes the committed reference images and a contact sheet per scene.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/default-look-score.py <work directory> <output directory> <scene ids> <variant names>
# The work directory holds <scene>-<variant>.png from default-look.mjs and, after a Blender run, <scene>-cycles.npy and <scene>-eevee.npy.
# A new <scene>-cycles.npy is tone mapped like 67js (the ACES fit and gamma 2.2 of score.py), rounded to 8 bits and saved as <output directory>/<scene>-cycles.png,
# which is what gets committed. Without a .npy the committed PNG is the reference, so a score run needs no Blender.
# It prints one JSON object, {scene: {variant: FLIP}}. FLIP is 0 for identical images and larger for a larger visible difference.
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2
PANEL_WIDTH = 320
PANEL_HEIGHT = 180
LABEL_HEIGHT = 18
SHEET_COLUMNS = 4


def tone_map_like_67js(linear):
    """The same curve and gamma as score.py, so every image meets in one display space."""
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def to_eight_bit(display):
    return np.round(np.clip(display, 0, 1) * 255).astype(np.uint8)


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def reference_path(output_directory, scene_id):
    return output_directory / f"{scene_id}-cycles.png"


def write_reference(work_directory, output_directory, scene_id):
    cycles_path = work_directory / f"{scene_id}-cycles.npy"
    if cycles_path.exists():
        image = Image.fromarray(to_eight_bit(tone_map_like_67js(np.load(cycles_path))))
        image.save(reference_path(output_directory, scene_id), optimize=True)


def write_sheet(output_directory, scene_id, panels):
    rows = (len(panels) + SHEET_COLUMNS - 1) // SHEET_COLUMNS
    sheet = Image.new("RGB", (PANEL_WIDTH * SHEET_COLUMNS, (PANEL_HEIGHT + LABEL_HEIGHT) * rows), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    for index, (label, image) in enumerate(panels):
        left = (index % SHEET_COLUMNS) * PANEL_WIDTH
        top = (index // SHEET_COLUMNS) * (PANEL_HEIGHT + LABEL_HEIGHT)
        draw.text((left + 4, top + 3), label, fill=(235, 235, 235))
        sheet.paste(image.resize((PANEL_WIDTH, PANEL_HEIGHT), Image.LANCZOS), (left, top + LABEL_HEIGHT))
    sheet.save(output_directory / f"{scene_id}-sheet.jpg", quality=80, optimize=True)


def main():
    work_directory = Path(sys.argv[1])
    output_directory = Path(sys.argv[2])
    scene_ids = sys.argv[3].split(",")
    variant_names = sys.argv[4].split(",")
    output_directory.mkdir(parents=True, exist_ok=True)
    scores = {}
    for scene_id in scene_ids:
        write_reference(work_directory, output_directory, scene_id)
        reference = load_png(reference_path(output_directory, scene_id))
        scene_scores = {}
        panels = [("Cycles (reference)", Image.open(reference_path(output_directory, scene_id)).convert("RGB"))]
        eevee_path = work_directory / f"{scene_id}-eevee.npy"
        if eevee_path.exists():
            eevee = to_eight_bit(tone_map_like_67js(np.load(eevee_path)))
            scene_scores["eevee"] = flip_score(reference, eevee.astype(np.float32) / 255)
        for variant_name in variant_names:
            rendered = Image.open(work_directory / f"{scene_id}-{variant_name}.png").convert("RGB")
            scene_scores[variant_name] = flip_score(reference, np.asarray(rendered, dtype=np.float32) / 255)
            panels.append((f"{variant_name} {scene_scores[variant_name]:.4f}", rendered))
        scores[scene_id] = scene_scores
        write_sheet(output_directory, scene_id, panels)
    print(json.dumps(scores))


main()
