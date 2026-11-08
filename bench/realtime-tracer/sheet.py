# One contact sheet of a camera move (bench/realtime-tracer/run.mjs --mode move, <scene>@move-<n>.png): two columns, frames
# in order from left to right and top to bottom, each reduced to 480 by 270.
#   uv run --no-project --python 3.12 --with pillow python -I bench/realtime-tracer/sheet.py <directory> <scene id>
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CELL_WIDTH = 480
CELL_HEIGHT = 270
COLUMNS = 2


def main():
    directory = Path(sys.argv[1])
    scene_id = sys.argv[2]
    paths = sorted((path for path in directory.glob(f"{scene_id}@move-*.png") if path.stem.rsplit("-", 1)[1].isdigit()), key=lambda path: int(path.stem.rsplit("-", 1)[1]))
    rows = (len(paths) + COLUMNS - 1) // COLUMNS
    sheet = Image.new("RGB", (CELL_WIDTH * COLUMNS, CELL_HEIGHT * rows))
    for index, path in enumerate(paths):
        cell = Image.open(path).convert("RGB").resize((CELL_WIDTH, CELL_HEIGHT), Image.LANCZOS)
        ImageDraw.Draw(cell).text((6, 4), f"move frame {index + 1}", fill=(255, 255, 255))
        sheet.paste(cell, (CELL_WIDTH * (index % COLUMNS), CELL_HEIGHT * (index // COLUMNS)))
    output = directory / f"{scene_id}@move-sheet.png"
    sheet.save(output)
    print(output)


main()
