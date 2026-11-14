# Measures shadow depth: how dark the darks are, how far a surface falls from lit to shadowed, how wide shadow edges are and how much
# a scene darkens where objects meet other surfaces. It compares a Crucible render with the Cycles render of the same scene (issue #197).
#   uv run --no-project --python 3.12 --with numpy --with pillow --with scipy python -I bench/reference/measure-depth.py <work directory> <scene id>,<scene id> [--candidate <directory with Crucible pngs>] [--json <file>]
# Images are compared in display space after the tone curve of src/post.js, the same space score.py uses.
# All measures are on luminance. The surface and edge measures are proxies: the renders carry no object ids, so a surface is a
# tile of one hue, a shadow edge is a luminance step of one stop or more, and contact darkening is read against the neighbourhood.
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

GAMMA = 2.2
LUMA = np.array([0.2126, 0.7152, 0.0722])
PERCENTILES = (1, 5, 25, 50)
TILE = 24
NEIGHBOURHOOD = 31
EDGE_STEP_STOPS = 1.0
FLOOR = 1e-3
KEYS = ["p1", "p5", "p25", "p50", "surface_stops", "edge_median_px", "edge_p90_px", "contact_stops"]


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def load_cycles(path):
    return tone_map_like_crucible(np.load(path))


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def display_luminance(display):
    return (display ** GAMMA) @ LUMA


def percentile_measures(luminance):
    values = np.percentile(luminance, PERCENTILES)
    return {f"p{percentile}": float(value) for percentile, value in zip(PERCENTILES, values)}


def surface_contrast(display, luminance):
    """Largest lit to shadow step inside one surface: for each tile of one hue, p95 over p5 luminance in stops; the 90th percentile over tiles."""
    height, width, _ = display.shape
    chroma = display / np.maximum(display.sum(axis=2, keepdims=True), 1e-4)
    stops = []
    for top in range(0, height - TILE + 1, TILE):
        for left in range(0, width - TILE + 1, TILE):
            tile_chroma = chroma[top:top + TILE, left:left + TILE].reshape(-1, 3)
            if tile_chroma.std(axis=0).max() > 0.02:
                continue
            tile = luminance[top:top + TILE, left:left + TILE].ravel()
            high, low = np.percentile(tile, [95, 5])
            if high < 0.02:
                continue
            stops.append(np.log2((high + FLOOR) / (low + FLOOR)))
    if not stops:
        return 0.0
    return float(np.percentile(stops, 90))


def edge_widths(luminance):
    """Width in pixels of horizontal luminance steps of one stop or more, as the run of pixels between 10 and 90 percent of the step."""
    logged = np.log2(luminance + FLOOR)
    gradient = ndimage.gaussian_filter1d(logged, 0.7, axis=1, order=1)
    widths = []
    height, width = logged.shape
    for row in range(0, height, 2):
        line = logged[row]
        slope = np.abs(gradient[row])
        peaks = np.where((slope[1:-1] > slope[:-2]) & (slope[1:-1] >= slope[2:]) & (slope[1:-1] > 0.15))[0] + 1
        for peak in peaks:
            window = line[max(peak - 40, 0):min(peak + 40, width)]
            step = window.max() - window.min()
            if step < EDGE_STEP_STOPS:
                continue
            low_level = window.min() + 0.1 * step
            high_level = window.min() + 0.9 * step
            inside = np.count_nonzero((window > low_level) & (window < high_level))
            if inside:
                widths.append(inside)
    if not widths:
        return {"edges": 0, "median": 0.0, "p90": 0.0}
    return {"edges": len(widths), "median": float(np.median(widths)), "p90": float(np.percentile(widths, 90))}


def contact_darkening(luminance):
    """Stops below the neighbourhood mean (in stops) at the darkest 2 percent of pixels: creases and contact shadows read as a dip."""
    logged = np.log2(luminance + FLOOR)
    neighbourhood = ndimage.uniform_filter(logged, size=NEIGHBOURHOOD, mode="nearest")
    return float(-np.percentile(logged - neighbourhood, 2))


def measure(display):
    luminance = display_luminance(display)
    edge = edge_widths(luminance)
    return {
        **percentile_measures(luminance),
        "surface_stops": surface_contrast(display, luminance),
        "edge_median_px": edge["median"],
        "edge_p90_px": edge["p90"],
        "contact_stops": contact_darkening(luminance),
    }


GAP_LABELS = ["p1", "p5", "p25", "p50", "surface", "edge", "contact"]


def gap_row(cycles, ours):
    """Crucible minus Cycles: luminance percentiles in stops (positive is lighter than Cycles), surface and contact in stops, edge width in pixels."""
    stops = [float(np.log2((ours[key] + FLOOR) / (cycles[key] + FLOOR))) for key in ("p1", "p5", "p25", "p50")]
    return stops + [ours["surface_stops"] - cycles["surface_stops"], ours["edge_median_px"] - cycles["edge_median_px"], ours["contact_stops"] - cycles["contact_stops"]]


def main():
    work = Path(sys.argv[1])
    scene_ids = sys.argv[2].split(",")
    candidates = [Path(argument) for argument in sys.argv[sys.argv.index("--candidate") + 1:] if not argument.startswith("--")] if "--candidate" in sys.argv else [work]
    json_path = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    summary = "--summary" in sys.argv
    cycles_measures = {scene_id: measure(load_cycles(work / f"{scene_id}-cycles.npy")) for scene_id in scene_ids}
    results = {}
    for candidate in candidates:
        print(f"== {candidate.name}")
        if summary:
            print(f"{'scene':<20}" + "".join(f"{label:>10}" for label in GAP_LABELS))
        else:
            print(f"{'scene':<20}{'':<8}" + "".join(f"{key:>15}" for key in KEYS))
        gaps = []
        for scene_id in scene_ids:
            cycles = cycles_measures[scene_id]
            ours = measure(load_png(candidate / f"{scene_id}-gpu.png"))
            results.setdefault(candidate.name, {})[scene_id] = {"cycles": cycles, "crucible": ours}
            if summary:
                gap = gap_row(cycles, ours)
                gaps.append(gap)
                if len(candidates) == 1:
                    print(f"{scene_id:<20}" + "".join(f"{value:>10.2f}" for value in gap))
                continue
            print(f"{scene_id:<20}{'cycles':<8}" + "".join(f"{cycles[key]:>15.4f}" for key in KEYS))
            print(f"{'':<20}{'crucible':<8}" + "".join(f"{ours[key]:>15.4f}" for key in KEYS))
        if summary:
            mean = np.mean(np.abs(np.array(gaps)), axis=0)
            print(f"{'mean absolute gap':<20}" + "".join(f"{value:>10.2f}" for value in mean))
            signed = np.mean(np.array(gaps), axis=0)
            print(f"{'mean signed gap':<20}" + "".join(f"{value:>10.2f}" for value in signed))
    if json_path:
        Path(json_path).write_text(json.dumps(results, indent=1))


main()
