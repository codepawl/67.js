# Measures shadow depth of Crucible frames against Cycles (issue #197), from the files the harness already writes.
#   uv run --no-project --python 3.12 --with pillow --with numpy --with scipy python -I bench/reference/shadow-depth.py <work directory> <scene id>[,<scene id>...] [<label>] [--gpu-suffix <suffix>]
# <work directory> holds <id>-gpu.png (Crucible) and <id>-cycles.npy (linear Cycles radiance). Both go to display space with
# the tone curve of src/post.js, so the numbers compare what a viewer sees. Per scene it prints one JSON line:
#   percentiles  display luminance at the 1st, 5th and 25th percentile, and the share of pixels under 0.05 and 0.10.
#   shadow tiles  24 x 24 pixel tiles where Cycles has both lit and shadowed pixels (its 90th over 10th percentile is at least 2
#                 and the 10th is above 0.01). A tile that holds a shadow edge on one surface is a proxy for "lit against shadow
#                 on the same surface"; it is not a per surface mask, so a tile may also hold an object edge.
#     shadow-floor   mean over the tiles of the 10th percentile, Crucible over Cycles (above 1 means shadows are too light).
#     lit-level      the same for the 90th percentile (below 1 means the lit side is too dim).
#     contrast       mean of log2(90th over 10th), Crucible and Cycles. More is deeper contrast.
#     edge-width     median over the tiles of (90th - 10th) / steepest gradient after a 1 pixel blur, in pixels: the width of
#                    the transition. Reported for the upper half of the frame (far from the camera, mostly) and the lower half
#                    (near), as a proxy for distance; the distance from the caster is not in the files.
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

GAMMA = 2.2
TILE = 24
MINIMUM_RATIO = 2.0
MINIMUM_SHADOW = 0.01
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def display_luminance(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return (mapped ** (1 / GAMMA)) @ LUMA


def load_png_luminance(path):
    image = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255
    return image @ LUMA


def tiles_of(luminance):
    height, width = luminance.shape
    rows, columns = height // TILE, width // TILE
    cropped = luminance[: rows * TILE, : columns * TILE]
    return cropped.reshape(rows, TILE, columns, TILE).transpose(0, 2, 1, 3).reshape(rows, columns, TILE * TILE)


def gradient_tiles(luminance):
    blurred = ndimage.gaussian_filter(luminance, 1)
    gradient = np.hypot(ndimage.sobel(blurred, axis=1) / 8, ndimage.sobel(blurred, axis=0) / 8)
    return tiles_of(gradient).max(axis=2)


def tile_statistics(luminance):
    tiles = tiles_of(luminance)
    return np.percentile(tiles, 10, axis=2), np.percentile(tiles, 90, axis=2), gradient_tiles(luminance)


def measure(image, cycles):
    result = {}
    for name, values in (("crucible", image), ("cycles", cycles)):
        result[f"p1-{name}"], result[f"p5-{name}"], result[f"p25-{name}"] = (round(float(v), 4) for v in np.percentile(values, [1, 5, 25]))
        result[f"under-0.05-{name}"] = round(float((values < 0.05).mean()), 4)
        result[f"under-0.10-{name}"] = round(float((values < 0.10).mean()), 4)
    low_cycles, high_cycles, gradient_cycles = tile_statistics(cycles)
    low_image, high_image, gradient_image = tile_statistics(image)
    selected = (high_cycles / np.maximum(low_cycles, 1e-4) >= MINIMUM_RATIO) & (low_cycles > MINIMUM_SHADOW)
    result["shadow-tiles"] = int(selected.sum())
    if not selected.any():
        return result
    result["shadow-floor"] = round(float((low_image[selected] / low_cycles[selected]).mean()), 3)
    result["lit-level"] = round(float((high_image[selected] / high_cycles[selected]).mean()), 3)
    result["contrast-crucible"] = round(float(np.log2(high_image[selected] / np.maximum(low_image[selected], 1e-4)).mean()), 3)
    result["contrast-cycles"] = round(float(np.log2(high_cycles[selected] / low_cycles[selected]).mean()), 3)
    rows = np.arange(selected.shape[0])[:, None] * np.ones(selected.shape[1], dtype=int)
    for half, in_half in (("far", rows < selected.shape[0] / 2), ("near", rows >= selected.shape[0] / 2)):
        picked = selected & in_half
        for name, high, low, gradient in (("crucible", high_image, low_image, gradient_image), ("cycles", high_cycles, low_cycles, gradient_cycles)):
            widths = (high[picked] - low[picked]) / np.maximum(gradient[picked], 1e-4)
            result[f"edge-{half}-{name}"] = round(float(np.median(widths)), 2) if picked.any() else None
    return result


def self_test():
    # A lit half (0.6) beside a shadowed half (0.1 in Crucible, 0.05 in Cycles) with the edge inside one tile.
    shape = (96, 96)
    image = np.full(shape, 0.6, dtype=np.float32)
    image[:, 36:] = 0.1
    cycles = np.full(shape, 0.6, dtype=np.float32)
    cycles[:, 36:] = 0.05
    result = measure(image, cycles)
    assert result["shadow-tiles"] == 4, result
    assert abs(result["shadow-floor"] - 2.0) < 1e-3, result
    assert abs(result["lit-level"] - 1.0) < 1e-3, result
    assert result["contrast-crucible"] < result["contrast-cycles"], result
    assert 1.0 < result["edge-far-crucible"] < 6.0, result
    assert abs(result["p5-crucible"] - 0.1) < 1e-4, result
    print("shadow-depth self-test ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        sys.exit(0)
    work_directory = sys.argv[1]
    scene_ids = sys.argv[2].split(",")
    label = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else ""
    suffix = sys.argv[sys.argv.index("--gpu-suffix") + 1] if "--gpu-suffix" in sys.argv else "gpu"
    for scene_id in scene_ids:
        cycles = display_luminance(np.load(f"{work_directory}/{scene_id}-cycles.npy").astype(np.float32))
        image = load_png_luminance(f"{work_directory}/{scene_id}-{suffix}.png")
        print(json.dumps({"scene": scene_id, "label": label, **measure(image, cycles)}))
