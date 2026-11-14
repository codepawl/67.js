# Scores each Crucible render against Cycles and EEVEE with FLIP, and saves side by side images.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/score.py <work directory> <output directory>
# A scene that declares brightRegion (scenes.js) also gets region-* scores over the bright pixels of its Cycles image.
# FLIP is 0 for identical images, and higher means a larger visible difference. EEVEE against Cycles is a yardstick:
# it shows what a good rasterizer scores on the same scene.
# Quantisation (#258): Crucible is read back from an 8-bit PNG, so the EEVEE array is rounded to 8 bits in display space the same
# way before FLIP. Cycles stays float because it is the reference both sides are measured against. Crucible is not read back as
# float because the harness reads canvas pixels, which are 8-bit by construction.
#   uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I bench/reference/score.py --self-test
import json
import sys
import tempfile
from pathlib import Path

import flip_evaluator
import numpy as np
from PIL import Image, ImageDraw

GAMMA = 2.2
LABEL_HEIGHT = 22
PANEL_WIDTH = 480
PANEL_HEIGHT = 270


def tone_map_like_crucible(linear):
    """The same curve and gamma as the post-processing shader in src/post.js, so both sides meet in one display space."""
    color = np.maximum(linear, 0)
    mapped = np.clip((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0, 1)
    return mapped ** (1 / GAMMA)


def quantise_to_8_bit(display):
    """Rounds display-space values to the nearest of 256 steps, as writing an 8-bit PNG does."""
    return np.round(np.clip(display, 0, 1) * 255).astype(np.float32) / 255


def load_eevee(path):
    """An EEVEE render in the same 8-bit display space as a Crucible PNG, so FLIP sees equal rounding on both sides."""
    return quantise_to_8_bit(tone_map_like_crucible(np.load(path)))


def self_test():
    rng = np.random.default_rng(258)
    linear = rng.random((16, 16, 3), dtype=np.float32) * 3
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "scene-eevee.npy"
        np.save(path, linear)
        loaded = load_eevee(path)
        png_path = Path(directory) / "scene.png"
        Image.fromarray(np.round(np.clip(tone_map_like_crucible(linear), 0, 1) * 255).astype(np.uint8)).save(png_path)
        written = load_png(png_path)
    assert np.array_equal(loaded, written), "the EEVEE array does not match what an 8-bit PNG of it reads back as"
    assert np.array_equal(np.round(loaded * 255), np.round(loaded * 255).astype(np.uint8)), "values are not whole 8-bit steps"
    assert np.array_equal(quantise_to_8_bit(loaded), loaded), "quantising twice changed the values"
    float_display = tone_map_like_crucible(linear)
    assert 0 < np.abs(loaded - float_display).max() <= 0.5 / 255 + 1e-6, "the rounding error is outside half a step"
    print("score self-test ok")


def load_png(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255


COVERAGE_THRESHOLD = 0.03


def asset_coverage_mask(background, asset_render):
    """The pixels the asset changes, so a score is not diluted by the sky that both sides draw the same way."""
    return np.abs(asset_render - background).max(axis=2) > COVERAGE_THRESHOLD


def bright_region_mask(cycles, region):
    """The pixels where the Cycles image is bright, grown by a few pixels, so a mostly black frame can not hide wrong shafts.
    The Cycles image picks the region, so no renderer under test decides what is scored."""
    luminance = cycles @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    bright = luminance > region["luminance"]
    radius = int(region["dilation"])
    height, width = bright.shape
    padded = np.pad(bright, radius)
    grown = np.zeros_like(bright)
    for shift_y in range(-radius, radius + 1):
        for shift_x in range(-radius, radius + 1):
            if shift_y * shift_y + shift_x * shift_x <= radius * radius:
                grown |= padded[radius + shift_y:radius + shift_y + height, radius + shift_x:radius + shift_x + width]
    return grown


def masked_flip_score(reference, test, mask):
    error_map, _, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(error_map[mask].mean()), 4)


def flip_score(reference, test):
    _, mean_error, _ = flip_evaluator.evaluate(reference.astype(np.float32), test.astype(np.float32), "LDR", inputsRGB=True)
    return round(float(mean_error), 4)


def panel(pixels, label):
    image = Image.fromarray((np.clip(pixels, 0, 1) * 255).astype(np.uint8)).resize((PANEL_WIDTH, PANEL_HEIGHT), Image.LANCZOS)
    framed = Image.new("RGB", (PANEL_WIDTH, PANEL_HEIGHT + LABEL_HEIGHT), (20, 20, 20))
    framed.paste(image, (0, LABEL_HEIGHT))
    ImageDraw.Draw(framed).text((6, 5), label, fill=(240, 240, 240))
    return framed


def side_by_side(cycles, eevee, gpu, scores):
    error_map, _, _ = flip_evaluator.evaluate(cycles.astype(np.float32), gpu.astype(np.float32), "LDR", inputsRGB=True)
    panels = [
        panel(cycles, "Cycles"),
        panel(eevee, f"EEVEE (FLIP {scores['eevee-vs-cycles']})"),
        panel(gpu, f"Crucible GPU (FLIP {scores['gpu-vs-cycles']})"),
        panel(error_map, "FLIP error, Crucible GPU against Cycles"),
    ]
    sheet = Image.new("RGB", (PANEL_WIDTH * 2, (PANEL_HEIGHT + LABEL_HEIGHT) * 2))
    for index, item in enumerate(panels):
        sheet.paste(item, ((index % 2) * PANEL_WIDTH, (index // 2) * (PANEL_HEIGHT + LABEL_HEIGHT)))
    return sheet


def score_path_tracer(work_directory, output_directory, backend_suffix=""):
    """FLIP of each path traced render against the Cycles render of the same scene, with the time it took."""
    timings = json.loads((work_directory / f"pathtracer{backend_suffix}-timings.json").read_text(encoding="utf-8"))
    results = {}
    for scene_id in sorted(timings):
        cycles = tone_map_like_crucible(np.load(work_directory / f"{scene_id}-cycles.npy"))
        traced = load_png(work_directory / f"{scene_id}-pathtracer{backend_suffix}.png")
        results[scene_id] = {"pathtracer-vs-cycles": flip_score(cycles, traced), **timings[scene_id]}
    report = {"metric": "FLIP (LDR), mean error against Cycles, lower is better", "scores": results}
    (output_directory / f"path-tracer{backend_suffix}.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print("scene".ljust(20) + "pathtracer-vs-cycles".rjust(22) + "seconds".rjust(10))
    for scene_id, entry in results.items():
        print(scene_id.ljust(20) + f"{entry['pathtracer-vs-cycles']:.4f}".rjust(22) + f"{entry['seconds']:.1f}".rjust(10))


def score_baked(work_directory, output_directory, scene_ids):
    """FLIP of the GPU render of each baked scene against Cycles and EEVEE, into bake.json. The CPU render is not needed."""
    images_directory = output_directory / "images"
    images_directory.mkdir(parents=True, exist_ok=True)
    results = {}
    for scene_id in scene_ids:
        cycles = tone_map_like_crucible(np.load(work_directory / f"{scene_id}-cycles.npy"))
        eevee = load_eevee(work_directory / f"{scene_id}-eevee.npy")
        gpu = load_png(work_directory / f"{scene_id}-gpu.png")
        scores = {
            "gpu-vs-cycles": flip_score(cycles, gpu),
            "gpu-vs-eevee": flip_score(eevee, gpu),
            "eevee-vs-cycles": flip_score(cycles, eevee),
        }
        region = json.loads((work_directory / "scenes" / f"{scene_id}.json").read_text(encoding="utf-8")).get("brightRegion")
        if region:
            mask = bright_region_mask(cycles, region)
            scores["region-pixels"] = round(float(mask.mean()), 4)
            scores["region-gpu-vs-cycles"] = masked_flip_score(cycles, gpu, mask)
            scores["region-gpu-vs-eevee"] = masked_flip_score(eevee, gpu, mask)
            scores["region-eevee-vs-cycles"] = masked_flip_score(cycles, eevee, mask)
        results[scene_id] = scores
        side_by_side(cycles, eevee, gpu, scores).save(images_directory / f"{scene_id}-baked.jpg", quality=80)
    graphics = json.loads((work_directory / "graphics.json").read_text(encoding="utf-8"))
    timings = json.loads((work_directory / "blender-timings.json").read_text(encoding="utf-8"))
    report = {
        "metric": "FLIP (LDR), mean error of the baked GPU render against Cycles, lower is better",
        "blenderVersion": timings["blenderVersion"],
        "graphics": {"gpu": graphics["gpu"]},
        "scores": results,
    }
    (output_directory / "bake.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print("scene".ljust(20) + "".join(column.rjust(18) for column in ["gpu-vs-cycles", "gpu-vs-eevee", "eevee-vs-cycles"]))
    for scene_id, scores in results.items():
        print(scene_id.ljust(20) + "".join(f"{scores[column]:.4f}".rjust(18) for column in ["gpu-vs-cycles", "gpu-vs-eevee", "eevee-vs-cycles"]))


def main():
    if "--self-test" in sys.argv:
        self_test()
        return
    if "--bake" in sys.argv:
        score_baked(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[sys.argv.index("--bake") + 1].split(","))
        return
    if "--path-tracer" in sys.argv:
        score_path_tracer(Path(sys.argv[1]), Path(sys.argv[2]), "-gpu" if "--gpu-tracer" in sys.argv else "")
        return
    # Khronos assets and cloth sheets sit in front of a sky that both sides draw alike, so they also get a score over the
    # pixels the scene covers.
    set_name = "khronos" if "--khronos" in sys.argv else "cloth" if "--cloth" in sys.argv else "grand" if "--grand" in sys.argv else None
    khronos = set_name in ("khronos", "cloth")
    work_directory = Path(sys.argv[1])
    output_directory = Path(sys.argv[2])
    images_directory = output_directory / "images"
    images_directory.mkdir(parents=True, exist_ok=True)
    scene_ids = sorted(path.stem for path in (work_directory / "scenes").glob("*.json"))
    results = {}
    for scene_id in scene_ids:
        cycles = tone_map_like_crucible(np.load(work_directory / f"{scene_id}-cycles.npy"))
        eevee = load_eevee(work_directory / f"{scene_id}-eevee.npy")
        gpu = load_png(work_directory / f"{scene_id}-gpu.png")
        cpu = load_png(work_directory / f"{scene_id}-cpu.png")
        scores = {
            "gpu-vs-cycles": flip_score(cycles, gpu),
            "gpu-vs-eevee": flip_score(eevee, gpu),
            "cpu-vs-cycles": flip_score(cycles, cpu),
            "cpu-vs-eevee": flip_score(eevee, cpu),
            "eevee-vs-cycles": flip_score(cycles, eevee),
            "gpu-vs-cpu": flip_score(cpu, gpu),
        }
        if khronos:
            mask = asset_coverage_mask(load_png(work_directory / f"{scene_id}-background.png"), gpu)
            scores["asset-pixels"] = round(float(mask.mean()), 4)
            scores["asset-gpu-vs-cycles"] = masked_flip_score(cycles, gpu, mask)
            scores["asset-gpu-vs-eevee"] = masked_flip_score(eevee, gpu, mask)
            scores["asset-eevee-vs-cycles"] = masked_flip_score(cycles, eevee, mask)
        region = json.loads((work_directory / "scenes" / f"{scene_id}.json").read_text(encoding="utf-8")).get("brightRegion")
        if region and not set_name:
            mask = bright_region_mask(cycles, region)
            scores["region-pixels"] = round(float(mask.mean()), 4)
            scores["region-gpu-vs-cycles"] = masked_flip_score(cycles, gpu, mask)
            scores["region-gpu-vs-eevee"] = masked_flip_score(eevee, gpu, mask)
            scores["region-eevee-vs-cycles"] = masked_flip_score(cycles, eevee, mask)
        results[scene_id] = scores
        image_name = f"{set_name}-{scene_id}" if set_name else scene_id
        side_by_side(cycles, eevee, gpu, scores).save(images_directory / f"{image_name}.jpg", quality=80)
    timings = json.loads((work_directory / "blender-timings.json").read_text(encoding="utf-8"))
    graphics = json.loads((work_directory / "graphics.json").read_text(encoding="utf-8"))
    report = {"metric": "FLIP (LDR), mean error, lower is better", **timings, "graphics": graphics, "scores": results}
    report_name = f"{set_name}.json" if set_name else "baseline.json"
    (output_directory / report_name).write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    columns = ["gpu-vs-cycles", "gpu-vs-eevee", "cpu-vs-cycles", "cpu-vs-eevee", "eevee-vs-cycles", "gpu-vs-cpu"]
    if khronos:
        columns += ["asset-pixels", "asset-gpu-vs-cycles", "asset-gpu-vs-eevee", "asset-eevee-vs-cycles"]
    print("scene".ljust(20) + "".join(column.rjust(17) for column in columns))
    for scene_id, scores in results.items():
        print(scene_id.ljust(20) + "".join(f"{scores[column]:.4f}".rjust(17) for column in columns))
    region_columns = ["region-pixels", "region-gpu-vs-cycles", "region-gpu-vs-eevee", "region-eevee-vs-cycles"]
    region_results = {scene_id: scores for scene_id, scores in results.items() if "region-pixels" in scores}
    if region_results:
        print()
        print("scene".ljust(20) + "".join(column.rjust(24) for column in region_columns))
        for scene_id, scores in region_results.items():
            print(scene_id.ljust(20) + "".join(f"{scores[column]:.4f}".rjust(24) for column in region_columns))


main()
