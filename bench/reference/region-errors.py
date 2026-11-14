"""FLIP error of one scene split by what each pixel shows (a part, the open floor, the sky), for Crucible, EEVEE and Cycles.

Usage: uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/region-errors.py <scene> [gpu|cpu]

Reads the work directory of run.mjs (artifacts/reference): the scene description, the Cycles and EEVEE arrays and the Crucible render.
Each part's triangles are drawn back to front into a label image with the scene's camera, so a pixel belongs to the nearest part.
The floor is drawn only as the pixels below the horizon that no other part covers, because its quad reaches behind the camera.
`share` is the part of the frame a region covers, `error` its mean FLIP, and `contribution` how much of the frame's mean FLIP it holds."""
import base64
import json
import sys
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2  # as in score.py, which runs its scoring on import and so cannot be imported
WORK_DIRECTORY = Path("artifacts/reference")
WIDTH, HEIGHT = 960, 540
OPEN_FLOOR_LABEL = 99
LUMINANCE_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
MINIMUM_DEPTH = 0.1


def tone_map_like_crucible(linear):
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


def decode(entry, dtype):
    return np.frombuffer(base64.b64decode(entry["base64"]), dtype=dtype)


def camera_projection(camera):
    eye = np.array(camera["eye"])
    forward = np.array(camera["target"]) - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.array(camera["up"]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    tangent = np.tan(np.radians(camera["fov"]) / 2)

    def project(points):
        relative = points - eye
        across, above, depth = relative @ right, relative @ up, relative @ forward
        pixel_x = (across / (depth * tangent * WIDTH / HEIGHT) * 0.5 + 0.5) * WIDTH
        pixel_y = (0.5 - above / (depth * tangent) * 0.5) * HEIGHT
        return pixel_x, pixel_y, depth

    return project


def label_image(description):
    project = camera_projection(description["camera"])
    triangles = []
    for part_index, part in enumerate(description["parts"]):
        geometry = description["geometries"][part["geometry"]]
        positions = decode(geometry["positions"], np.float32).reshape(-1, 3)
        indices = decode(geometry["indices"], np.uint32).reshape(-1, 3)
        matrix = np.array(part["matrix"]).reshape(4, 4)
        world = positions @ matrix[:3, :3] + matrix[3, :3]
        pixel_x, pixel_y, depth = project(world)
        for triangle in indices:
            if (depth[triangle] < MINIMUM_DEPTH).any():
                continue
            corners = [(pixel_x[corner], pixel_y[corner]) for corner in triangle]
            triangles.append((depth[triangle].mean(), part_index + 1, corners))
    triangles.sort(key=lambda entry: -entry[0])
    image = Image.new("I", (WIDTH, HEIGHT), 0)
    drawing = ImageDraw.Draw(image)
    for _, label, corners in triangles:
        drawing.polygon(corners, fill=label)
    labels = np.array(image)
    horizon_y = project(np.array([[0.0, 0.0, -100000.0]]))[1][0]
    rows = np.arange(HEIGHT)[:, None] * np.ones((1, WIDTH))
    return np.where((labels == 0) & (rows > horizon_y), OPEN_FLOOR_LABEL, labels)


def main():
    scene = sys.argv[1]
    backend = sys.argv[2] if len(sys.argv) > 2 else "gpu"
    description = json.loads((WORK_DIRECTORY / "scenes" / f"{scene}.json").read_text(encoding="utf-8"))
    names = ["sky"] + [part["name"] for part in description["parts"]]
    labels = label_image(description)
    cycles = tone_map_like_crucible(np.load(WORK_DIRECTORY / f"{scene}-cycles.npy")).astype(np.float32)
    eevee = tone_map_like_crucible(np.load(WORK_DIRECTORY / f"{scene}-eevee.npy")).astype(np.float32)
    render = load_png(WORK_DIRECTORY / f"{scene}-{backend}.png")
    render_map, render_mean, _ = flip_evaluator.evaluate(cycles, render.astype(np.float32), "LDR", inputsRGB=True)
    eevee_map, eevee_mean, _ = flip_evaluator.evaluate(cycles, eevee, "LDR", inputsRGB=True)
    render_error = render_map.mean(axis=-1) if render_map.ndim == 3 else render_map
    eevee_error = eevee_map.mean(axis=-1) if eevee_map.ndim == 3 else eevee_map
    print(f"{scene} ({backend}): Crucible {render_mean:.4f}, EEVEE {eevee_mean:.4f}, against Cycles")
    print("region        share  error crucible/EEVEE  contribution crucible/EEVEE  luminance crucible/Cycles/EEVEE")
    for label in list(range(len(names))) + [OPEN_FLOOR_LABEL]:
        mask = labels == label
        if not mask.any():
            continue
        name = "floor (open)" if label == OPEN_FLOOR_LABEL else names[label]
        luminance = [(image @ LUMINANCE_WEIGHTS)[mask].mean() for image in (render, cycles, eevee)]
        print(f"{name:12s} {mask.mean():6.3f}  {render_error[mask].mean():.4f} {eevee_error[mask].mean():.4f}"
              f"        {render_error[mask].sum() / mask.size:.4f} {eevee_error[mask].sum() / mask.size:.4f}"
              f"            {luminance[0]:.3f} {luminance[1]:.3f} {luminance[2]:.3f}")


main()
