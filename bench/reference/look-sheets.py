"""Collects the Crucible renders of the named looks into artifacts/look-168/<scene>/<option>.png and one contact sheet per scene.

uv run --no-project --with pillow python -I bench/reference/look-sheets.py artifacts/reference-look artifacts/look-168

Reads <scene>-<option>-gpu.png written by `node bench/reference/run.mjs --option <scene>:<option>`.
"""
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SCENES = ["mountain-valley", "temple-hall", "megacity-dusk"]
LABEL_HEIGHT = 22


def main():
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    for scene in SCENES:
        renders = sorted(source.glob(f"{scene}-*-gpu.png"))
        if not renders:
            continue
        (target / scene).mkdir(parents=True, exist_ok=True)
        images = []
        for render in renders:
            option = render.name[len(scene) + 1:-len("-gpu.png")]
            shutil.copyfile(render, target / scene / f"{option}.png")
            images.append((option, Image.open(render).convert("RGB")))
        width, height = images[0][1].size
        columns = 2
        rows = (len(images) + columns - 1) // columns
        sheet = Image.new("RGB", (width * columns, (height + LABEL_HEIGHT) * rows), (16, 16, 16))
        draw = ImageDraw.Draw(sheet)
        for index, (option, image) in enumerate(images):
            left, top = (index % columns) * width, (index // columns) * (height + LABEL_HEIGHT)
            draw.text((left + 8, top + 5), f"{scene}:{option}", fill=(235, 235, 235))
            sheet.paste(image, (left, top + LABEL_HEIGHT))
        sheet.save(target / scene / "contact-sheet.png")
        print(f"{scene}: {len(images)} options, sheet {sheet.size}")


main()
