"""Three panels of the minified checker floor of texture-mips-bench.mjs: mip levels off, on, and the converged reference.

  uv run --no-project --with numpy --with pillow python bench/cycles-parity/make-texture-mips-figure.py <benchDirectory> <output.jpg> [--samples 16]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

PANEL_SCALE = 1
LABEL_PADDING = 6


def linear_to_srgb_bytes(linear_rgb: np.ndarray) -> np.ndarray:
    clipped = np.clip(linear_rgb, 0.0, 1.0)
    encoded = np.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * np.power(clipped, 1 / 2.4) - 0.055)
    return np.round(encoded * 255).astype(np.uint8)


def load_picture(path: Path, width: int, height: int) -> np.ndarray:
    return np.fromfile(path, dtype="<f4").reshape(height, width, 3)


def panel(picture: np.ndarray, label: str) -> Image.Image:
    image = Image.fromarray(linear_to_srgb_bytes(picture)).resize(
        (picture.shape[1] * PANEL_SCALE, picture.shape[0] * PANEL_SCALE), Image.NEAREST
    )
    draw = ImageDraw.Draw(image)
    text_box = draw.textbbox((LABEL_PADDING, LABEL_PADDING), label)
    draw.rectangle((text_box[0] - 3, text_box[1] - 2, text_box[2] + 3, text_box[3] + 2), fill=(0, 0, 0))
    draw.text((LABEL_PADDING, LABEL_PADDING), label, fill=(255, 255, 255))
    return image


def main() -> None:
    bench_directory = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    samples = int(sys.argv[sys.argv.index("--samples") + 1]) if "--samples" in sys.argv else 16
    metrics = json.loads((bench_directory / "metrics.json").read_text())
    width, height = metrics["width"], metrics["height"]
    run = next(entry for entry in metrics["receding"]["runs"] if entry["samples"] == samples)
    panels = [
        panel(load_picture(bench_directory / f"receding-off-{samples}spp.f32", width, height), f"mips off, {samples} spp, relMSE {run['relMseOffPerSeed'][0]:.4f}"),
        panel(load_picture(bench_directory / f"receding-on-{samples}spp.f32", width, height), f"mips on, {samples} spp, relMSE {run['relMseOnPerSeed'][0]:.4f}"),
        panel(load_picture(bench_directory / "receding-reference.f32", width, height), f"reference, {metrics['receding']['referenceSamples']} spp, mips off"),
    ]
    gap = 4
    sheet = Image.new("RGB", (sum(p.width for p in panels) + gap * (len(panels) - 1), panels[0].height), (255, 255, 255))
    cursor = 0
    for each in panels:
        sheet.paste(each, (cursor, 0))
        cursor += each.width + gap
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path, "JPEG", quality=86, optimize=True)
    print(output_path, sheet.size, output_path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
