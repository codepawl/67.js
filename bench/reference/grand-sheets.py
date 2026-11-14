"""Comparison sheets for the grand scene options (issue #168): one sheet per scene, one row per option.

Each row has the Cycles render and the Crucible render side by side, labelled with the option letter, the FLIP score of Crucible
against Cycles and the Cycles time. Run after `npm run reference -- --grand`:

    uv run --no-project --python 3.12 --with pillow --with numpy --with flip-evaluator python -I bench/reference/grand-sheets.py <output directory>
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

WORK_DIRECTORY = Path("artifacts/reference-grand")
REPORT = Path("bench/reference/grand.json")
SCENES = ["mountain-valley", "temple-hall", "megacity-dusk"]
PANEL_SIZE = (800, 450)
LABEL_HEIGHT = 44


def load_tone_map():
    # score.py runs main() when it is imported, so take its functions without the last call.
    source = Path("bench/reference/score.py").read_text(encoding="utf-8").rstrip()
    assert source.endswith("main()")
    namespace = {"__name__": "score_functions"}
    exec(compile(source[: -len("main()")], "score.py", "exec"), namespace)
    return namespace["tone_map_like_crucible"]


def to_image(display_array):
    return Image.fromarray(np.clip(np.asarray(display_array) * 255 + 0.5, 0, 255).astype(np.uint8)).resize(PANEL_SIZE, Image.LANCZOS)


def font(size):
    for name in ("arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    output_directory = Path(sys.argv[1])
    output_directory.mkdir(parents=True, exist_ok=True)
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    tone_map = load_tone_map()
    for scene_id in SCENES:
        sheet = Image.new("RGB", (PANEL_SIZE[0] * 2 + 12, (PANEL_SIZE[1] + LABEL_HEIGHT) * 3), (18, 18, 20))
        draw = ImageDraw.Draw(sheet)
        for row, letter in enumerate("abc"):
            option_id = f"{scene_id}-{letter}"
            top = row * (PANEL_SIZE[1] + LABEL_HEIGHT)
            cycles = to_image(tone_map(np.load(WORK_DIRECTORY / f"{option_id}-cycles.npy")))
            gpu = Image.open(WORK_DIRECTORY / f"{option_id}-gpu.png").convert("RGB").resize(PANEL_SIZE, Image.LANCZOS)
            sheet.paste(cycles, (0, top + LABEL_HEIGHT))
            sheet.paste(gpu, (PANEL_SIZE[0] + 12, top + LABEL_HEIGHT))
            flip = report["scores"][option_id]["gpu-vs-cycles"]
            seconds = report["seconds"][option_id]["cycles"]
            draw.text((12, top + 6), letter.upper(), font=font(30), fill=(255, 214, 90))
            draw.text((60, top + 12), f"Cycles ({seconds:.0f} s)", font=font(22), fill=(230, 230, 230))
            draw.text((PANEL_SIZE[0] + 24, top + 12), f"Crucible   FLIP {flip:.4f}", font=font(22), fill=(230, 230, 230))
        path = output_directory / f"{scene_id}.png"
        sheet.save(path)
        print(path)


main()
