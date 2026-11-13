"""Side by side: Cook, Cycles and Cook with the sheet at weight 0, for the backlit and the front lit sheet (#1058).

  uv run --no-project --with numpy --with pillow python bench/cycles-parity/make-diffuse-transmission-figure.py <outputDirectory> <output.jpg> [--label cook]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

LABEL_PADDING = 6


def linear_to_srgb_bytes(linear_rgb: np.ndarray) -> np.ndarray:
    clipped = np.clip(linear_rgb, 0.0, 1.0)
    encoded = np.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * np.power(clipped, 1 / 2.4) - 0.055)
    return np.round(encoded * 255).astype(np.uint8)


def panel(npy_path: Path, label: str) -> Image.Image:
    image = Image.fromarray(linear_to_srgb_bytes(np.load(npy_path)))
    draw = ImageDraw.Draw(image)
    text_box = draw.textbbox((LABEL_PADDING, LABEL_PADDING), label)
    draw.rectangle((text_box[0] - 3, text_box[1] - 2, text_box[2] + 3, text_box[3] + 2), fill=(0, 0, 0))
    draw.text((LABEL_PADDING, LABEL_PADDING), label, fill=(255, 255, 255))
    return image


def main() -> None:
    renders = Path(sys.argv[1]) / "renders"
    output_path = Path(sys.argv[2])
    label = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "cook"
    rows = [
        [
            panel(renders / f"sheet-backlit-{label}.npy", "Cook, lit from behind"),
            panel(renders / "sheet-backlit-cycles.npy", "Cycles 5.3"),
            panel(renders / f"sheet-backlit-weight-0-{label}.npy", "Cook, weight 0"),
        ],
        [
            panel(renders / f"sheet-front-{label}.npy", "Cook, lit from the front"),
            panel(renders / "sheet-front-cycles.npy", "Cycles 5.3"),
            panel(renders / f"sheet-backlit-weight-0-cycles.npy", "Cycles, weight 0"),
        ],
    ]
    width, height = rows[0][0].size
    sheet = Image.new("RGB", (width * 3, height * len(rows)))
    for row_index, row in enumerate(rows):
        for column_index, picture in enumerate(row):
            sheet.paste(picture, (column_index * width, row_index * height))
    sheet.save(output_path, quality=88)
    print(output_path)


if __name__ == "__main__":
    main()
