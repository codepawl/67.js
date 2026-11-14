# Measures the speckle and streaks that FLIP does not punish: the high-frequency energy of a Crucible frame, against Cycles.
#   uv run --no-project --python 3.12 --with pillow --with numpy --with scipy python -I bench/reference/noise.py <Crucible png> <cycles npy> [<label>]
# Both images go to display space with the tone curve of src/post.js. The energy of a region is the standard deviation of
# (image - gaussian blur of the image) over that region, as a percentage of display luminance.
#   dark   : pixels where Cycles is darker than DARK_LUMINANCE and farther than DARK_MARGIN pixels from a brighter pixel.
#            Streaks and blotches on walls, floors and ceilings land here.
#   glow   : the ring from GLOW_INNER to GLOW_OUTER pixels around the pixels where Cycles is brighter than GLOW_SOURCE.
# Lower is smoother, and the Cycles value is the floor a clean render reaches (Cycles has its own path tracing noise).
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

GAMMA = 2.2
BLUR_SIGMA = 6
DARK_LUMINANCE = 0.1
DARK_MARGIN = 12
GLOW_SOURCE = 0.5
GLOW_INNER = 30
GLOW_OUTER = 60
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def display_luminance(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return (mapped ** (1 / GAMMA)) @ LUMA


def load_png_luminance(path):
    image = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255
    return image @ LUMA


def high_frequency(luminance):
    return luminance - ndimage.gaussian_filter(luminance, BLUR_SIGMA)


def region_masks(cycles_luminance):
    bright = cycles_luminance >= DARK_LUMINANCE
    distance_to_bright = ndimage.distance_transform_edt(~bright)
    dark = distance_to_bright > DARK_MARGIN
    source = cycles_luminance >= GLOW_SOURCE
    distance_to_source = ndimage.distance_transform_edt(~source) if source.any() else np.zeros_like(distance_to_bright)
    glow = source.any() & (distance_to_source >= GLOW_INNER) & (distance_to_source <= GLOW_OUTER)
    return dark, glow


def energy(luminance, mask):
    if not mask.any():
        return None
    return round(float(high_frequency(luminance)[mask].std()) * 100, 3)


def measure(png_path, cycles_path):
    cycles = display_luminance(np.load(cycles_path).astype(np.float32))
    image = load_png_luminance(png_path)
    dark, glow = region_masks(cycles)
    source = cycles >= GLOW_SOURCE
    ring = (ndimage.distance_transform_edt(~source) >= 30) & (ndimage.distance_transform_edt(~source) <= 45) if source.any() else glow
    return {
        "ring-30-45": round(float(image[ring].mean()), 4), "ring-30-45-cycles": round(float(cycles[ring].mean()), 4),
        "dark": energy(image, dark), "dark-cycles": energy(cycles, dark),
        "glow": energy(image, glow), "glow-cycles": energy(cycles, glow),
        "dark-pixels": int(dark.sum()), "glow-pixels": int(glow.sum()),
    }


if __name__ == "__main__":
    result = measure(sys.argv[1], sys.argv[2])
    label = sys.argv[3] if len(sys.argv) > 3 else sys.argv[1]
    print(label, json.dumps(result))
