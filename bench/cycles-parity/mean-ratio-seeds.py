"""Mean ratio of Cook against Cycles over many seeds, with a standard error, plus relMSE with and without the worst pixels.

  uv run --no-project --with numpy python bench/cycles-parity/mean-ratio-seeds.py \
      --reference "<cycles glob>" --candidate "<cook glob>" [--parts <partsPrefix>] \
      [--rel-mse-reference <image.npy> --rel-mse-skip-worst 100] [--label name]

Each image is one seed. The per-seed channel means are averaged on each side, the ratio is candidate over reference, and the
standard error of the ratio follows from the standard errors of the two means (delta method, the two sides independent).
Fireflies make a single image mean heavy tailed, so the standard error comes from the spread across seeds, never from the pixels.
"""
import glob
import json
import math
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REL_MSE_EPSILON = 1e-2


def read_flag(argument_list, flag_name, fallback=None):
    if flag_name in argument_list:
        return argument_list[argument_list.index(flag_name) + 1]
    return fallback


def load_images(pattern):
    paths = sorted(path for part in pattern.split(",") for path in glob.glob(part))
    if not paths:
        raise ValueError(f"No image matches {pattern!r}.")
    return paths, [numpy.load(path).astype(numpy.float64) for path in paths]


def mean_and_standard_error(values):
    values = numpy.asarray(values, dtype=numpy.float64)
    count = values.shape[0]
    mean = values.mean(axis=0)
    if count < 2:
        return mean, numpy.full_like(mean, numpy.nan)
    return mean, values.std(axis=0, ddof=1) / math.sqrt(count)


def ratio_with_error(candidate_means, reference_means):
    candidate_mean, candidate_error = mean_and_standard_error(candidate_means)
    reference_mean, reference_error = mean_and_standard_error(reference_means)
    ratio = candidate_mean / reference_mean
    relative_variance = (candidate_error / candidate_mean) ** 2 + (reference_error / reference_mean) ** 2
    return ratio, ratio * numpy.sqrt(relative_variance)


def format_channels(values, digits=5):
    return "[" + ", ".join(f"{value:.{digits}f}" for value in values) + "]"


def per_pixel_rel_mse(reference, candidate):
    return (((candidate - reference) ** 2) / (reference ** 2 + REL_MSE_EPSILON)).mean(axis=-1).ravel()


def rel_mse_values(reference, candidate, skip_worst):
    per_pixel = per_pixel_rel_mse(reference, candidate)
    kept = numpy.sort(per_pixel)[: per_pixel.size - skip_worst] if skip_worst > 0 else per_pixel
    return float(per_pixel.mean()), float(kept.mean())


def rel_mse_report(reference_images, candidate_images, rel_mse_reference, skip_worst):
    report = {}
    for side, images in (("reference", reference_images), ("candidate", candidate_images)):
        full = []
        trimmed = []
        for image in images:
            full_value, trimmed_value = rel_mse_values(rel_mse_reference, image, skip_worst)
            full.append(full_value)
            trimmed.append(trimmed_value)
        report[side] = {
            "relMse": [float(numpy.mean(full)), float(numpy.std(full, ddof=1) / math.sqrt(len(full))) if len(full) > 1 else None],
            f"relMseWithout{skip_worst}Worst": [float(numpy.mean(trimmed)), float(numpy.std(trimmed, ddof=1) / math.sqrt(len(trimmed))) if len(trimmed) > 1 else None],
            "imageCount": len(images),
        }
    return report


def part_report(reference_images, candidate_images, parts_prefix):
    part_indices = numpy.load(f"{parts_prefix}-parts.npy")
    with open(f"{parts_prefix}-parts.json", encoding="utf-8") as handle:
        part_names = json.load(handle)
    rows = []
    for index, part_name in enumerate(part_names, start=1):
        mask = part_indices == index
        if int(mask.sum()) == 0:
            continue
        reference_means = [image[mask].mean(axis=0) for image in reference_images]
        candidate_means = [image[mask].mean(axis=0) for image in candidate_images]
        ratio, error = ratio_with_error(candidate_means, reference_means)
        rows.append({"part": part_name, "pixels": int(mask.sum()), "ratio": ratio.tolist(), "standardError": error.tolist()})
    return rows


def main():
    argument_list = sys.argv[1:]
    label = read_flag(argument_list, "--label", "")
    reference_paths, reference_images = load_images(read_flag(argument_list, "--reference"))
    candidate_paths, candidate_images = load_images(read_flag(argument_list, "--candidate"))
    reference_means = [image.reshape(-1, 3).mean(axis=0) for image in reference_images]
    candidate_means = [image.reshape(-1, 3).mean(axis=0) for image in candidate_images]
    ratio, error = ratio_with_error(candidate_means, reference_means)
    result = {
        "label": label,
        "referenceImages": len(reference_paths),
        "candidateImages": len(candidate_paths),
        "referenceMean": mean_and_standard_error(reference_means)[0].tolist(),
        "candidateMean": mean_and_standard_error(candidate_means)[0].tolist(),
        "meanRatio": ratio.tolist(),
        "meanRatioStandardError": error.tolist(),
    }
    print(f"{label}: ratio {format_channels(ratio)} +- {format_channels(error)} ({len(candidate_paths)} cand, {len(reference_paths)} ref)")
    parts_prefix = read_flag(argument_list, "--parts")
    if parts_prefix is not None:
        result["parts"] = part_report(reference_images, candidate_images, parts_prefix)
        for row in result["parts"]:
            print(f"  part {row['part']:<10} px {row['pixels']:>7} ratio {format_channels(row['ratio'], 4)} +- {format_channels(row['standardError'], 4)}")
    rel_mse_path = read_flag(argument_list, "--rel-mse-reference")
    if rel_mse_path is not None:
        skip_worst = int(read_flag(argument_list, "--rel-mse-skip-worst", "100"))
        result["relMse"] = rel_mse_report(reference_images, candidate_images, numpy.load(rel_mse_path).astype(numpy.float64), skip_worst)
        print(f"  relMSE {json.dumps(result['relMse'])}")
    print("JSON " + json.dumps(result))


main()
