# Writes a 960 px wide preview per scene: Cycles (top left), Crucible before (top right) and Crucible after (bottom left), with captions.
#   uv run --no-project --python 3.12 --with pillow --with numpy python -I bench/reference/before-after-sheet.py <renders directory> <output directory> <scene id> [...]
# "Before" is the Crucible panel of the committed sheet images/<scene id>.jpg; "after" is <renders directory>/<scene id>-gpu.png.
import os
import sys

from PIL import Image, ImageDraw

HEADER_HEIGHT = 22
PANEL_WIDTH = 480
PANEL_HEIGHT = 270


def sheet_panels(scene_id):
    sheet = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "images", f"{scene_id}.jpg")).convert("RGB")
    row_height = sheet.height // 2
    cycles = sheet.crop((0, HEADER_HEIGHT, PANEL_WIDTH, row_height))
    before = sheet.crop((0, row_height + HEADER_HEIGHT, PANEL_WIDTH, sheet.height))
    return cycles, before


def captioned(picture, caption):
    panel = picture.resize((PANEL_WIDTH, PANEL_HEIGHT), Image.LANCZOS)
    ImageDraw.Draw(panel).text((8, 6), caption, fill=(255, 255, 255))
    return panel


if __name__ == "__main__":
    renders, output, scene_ids = sys.argv[1], sys.argv[2], sys.argv[3:]
    os.makedirs(output, exist_ok=True)
    for scene_id in scene_ids:
        cycles, before = sheet_panels(scene_id)
        after = Image.open(os.path.join(renders, f"{scene_id}-gpu.png")).convert("RGB")
        sheet = Image.new("RGB", (PANEL_WIDTH * 2, PANEL_HEIGHT * 2), (20, 20, 20))
        sheet.paste(captioned(cycles, "Cycles"), (0, 0))
        sheet.paste(captioned(before, "Crucible before"), (PANEL_WIDTH, 0))
        sheet.paste(captioned(after, "Crucible after"), (0, PANEL_HEIGHT))
        sheet.save(os.path.join(output, f"{scene_id}.png"), optimize=True)
