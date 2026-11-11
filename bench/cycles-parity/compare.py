"""Compare linear RGB float renders (.npy or .exr) and summarize M0 sample ladders and T_eq."""
import json
import math
import os
import statistics
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REL_MSE_EPSILON = 1e-2
TILE_GRID_SIZE = 8
TILE_ELIGIBLE_MEAN_THRESHOLD = 0.01
TILE_RATIO_TOLERANCE = 0.05


def load_linear_rgb_image(image_path):
    lower_path = image_path.lower()
    if lower_path.endswith(".npy"):
        array = numpy.load(image_path)
        return array.astype(numpy.float64)
    if lower_path.endswith(".exr"):
        import OpenEXR
        with OpenEXR.File(image_path) as exr_file:
            channels = exr_file.channels()
            if "RGB" in channels:
                pixels = channels["RGB"].pixels
            elif "RGBA" in channels:
                pixels = channels["RGBA"].pixels[..., :3]
            else:
                pixels = numpy.stack([channels[name].pixels for name in ("R", "G", "B")], axis=-1)
        return pixels.astype(numpy.float64)
    raise ValueError(f"Unsupported image extension for '{image_path}'. Pass a .npy or .exr file.")


def compute_relative_mse(reference_rgb, candidate_rgb):
    denominator = reference_rgb ** 2 + REL_MSE_EPSILON
    squared_relative = ((candidate_rgb - reference_rgb) ** 2) / denominator
    per_pixel = squared_relative.mean(axis=-1).ravel()
    keep_count = max(1, int(per_pixel.size * 0.9999))
    trimmed = numpy.partition(per_pixel, keep_count - 1)[:keep_count]
    clipped_reference = numpy.clip(reference_rgb, 0.0, 1000.0)
    clipped_candidate = numpy.clip(candidate_rgb, 0.0, 1000.0)
    clipped_error = ((clipped_candidate - clipped_reference) ** 2) / (clipped_reference ** 2 + REL_MSE_EPSILON)
    return {
        "relMse": float(per_pixel.mean()),
        "relMseClipped1000": float(clipped_error.mean()),
        "relMseTrimmed": float(trimmed.mean()),
    }


def compute_tile_grid_ratios(reference_rgb, candidate_rgb):
    row_strips_ref = numpy.array_split(reference_rgb, TILE_GRID_SIZE, axis=0)
    row_strips_cand = numpy.array_split(candidate_rgb, TILE_GRID_SIZE, axis=0)
    grid_ratios = []
    eligible_entries = []
    for row_index in range(TILE_GRID_SIZE):
        cols_ref = numpy.array_split(row_strips_ref[row_index], TILE_GRID_SIZE, axis=1)
        cols_cand = numpy.array_split(row_strips_cand[row_index], TILE_GRID_SIZE, axis=1)
        row_values = []
        for column_index in range(TILE_GRID_SIZE):
            ref_tile = cols_ref[column_index]
            cand_tile = cols_cand[column_index]
            ref_mean = float(ref_tile.mean())
            cand_mean = float(cand_tile.mean())
            ratio = cand_mean / ref_mean if ref_mean > 0.0 else None
            row_values.append(round(ratio, 4) if ratio is not None else None)
            if ref_mean > TILE_ELIGIBLE_MEAN_THRESHOLD and ratio is not None:
                ref_channels = ref_tile.reshape(-1, 3).mean(axis=0)
                cand_channels = cand_tile.reshape(-1, 3).mean(axis=0)
                channel_ratios = [round(float(cand_channels[ch] / max(ref_channels[ch], 1e-9)), 4) for ch in range(3)]
                eligible_entries.append({
                    "row": row_index,
                    "column": column_index,
                    "ratio": round(ratio, 4),
                    "absDeviation": abs(ratio - 1.0),
                    "referenceMean": round(ref_mean, 5),
                    "candidateMean": round(cand_mean, 5),
                    "channelRatios": channel_ratios,
                })
        grid_ratios.append(row_values)
    ratios_only = [entry["ratio"] for entry in eligible_entries]
    within_tolerance = [entry for entry in eligible_entries if entry["absDeviation"] <= TILE_RATIO_TOLERANCE]
    worst_tiles = sorted(eligible_entries, key=lambda entry: entry["absDeviation"], reverse=True)[:8]
    for entry in worst_tiles:
        entry.pop("absDeviation", None)
    return {
        "gridShape": [TILE_GRID_SIZE, TILE_GRID_SIZE],
        "eligibleMeanThreshold": TILE_ELIGIBLE_MEAN_THRESHOLD,
        "eligibleTileCount": len(eligible_entries),
        "withinFivePercentCount": len(within_tolerance),
        "outsideFivePercentCount": len(eligible_entries) - len(within_tolerance),
        "minRatio": round(min(ratios_only), 4) if ratios_only else None,
        "medianRatio": round(float(statistics.median(ratios_only)), 4) if ratios_only else None,
        "maxRatio": round(max(ratios_only), 4) if ratios_only else None,
        "gridRatios": grid_ratios,
        "worstTiles": worst_tiles,
    }


def compute_part_breakdown(reference_rgb, candidate_rgb, parts_prefix):
    part_indices = numpy.load(f"{parts_prefix}-parts.npy")
    with open(f"{parts_prefix}-parts.json", encoding="utf-8") as handle:
        part_names = json.load(handle)
    breakdown = []
    denominator = reference_rgb ** 2 + REL_MSE_EPSILON
    pixel_rel_mse = (((candidate_rgb - reference_rgb) ** 2) / denominator).mean(axis=-1)
    for index, part_name in enumerate(part_names, start=1):
        mask = part_indices == index
        pixel_count = int(mask.sum())
        if pixel_count == 0:
            continue
        ref_pixels = reference_rgb[mask]
        cand_pixels = candidate_rgb[mask]
        ref_mean = ref_pixels.mean(axis=0)
        cand_mean = cand_pixels.mean(axis=0)
        ratios = [round(float(cand_mean[ch] / max(ref_mean[ch], 1e-9)), 4) for ch in range(3)]
        scalar_ratio = float(cand_pixels.mean() / max(ref_pixels.mean(), 1e-9))
        breakdown.append({
            "part": part_name,
            "pixelCount": pixel_count,
            "relMse": round(float(pixel_rel_mse[mask].mean()), 6),
            "scalarMeanRatio": round(scalar_ratio, 4),
            "channelMeanRatio": ratios,
            "referenceMeanRgb": [round(float(value), 5) for value in ref_mean],
            "candidateMeanRgb": [round(float(value), 5) for value in cand_mean],
        })
    breakdown.sort(key=lambda item: item["relMse"], reverse=True)
    return breakdown


def compare_image_pair(reference_rgb, candidate_rgb, parts_prefix=None):
    error_metrics = compute_relative_mse(reference_rgb, candidate_rgb)
    abs_diff = numpy.abs(candidate_rgb - reference_rgb)
    differing_mask = abs_diff.max(axis=-1) > 0.0
    ref_mean_channels = reference_rgb.reshape(-1, 3).mean(axis=0)
    cand_mean_channels = candidate_rgb.reshape(-1, 3).mean(axis=0)
    channel_ratios = [round(float(cand_mean_channels[ch] / max(ref_mean_channels[ch], 1e-12)), 4) for ch in range(3)]
    result = {
        **error_metrics,
        "differingPixelCount": int(differing_mask.sum()),
        "totalPixelCount": int(reference_rgb.shape[0] * reference_rgb.shape[1]),
        "maxAbsDiff": float(abs_diff.max()),
        "meanAbsDiff": float(abs_diff.mean()),
        "referenceChannelMean": [round(float(val), 6) for val in ref_mean_channels],
        "candidateChannelMean": [round(float(val), 6) for val in cand_mean_channels],
        "channelMeanRatio": channel_ratios,
        "scalarMeanRatio": round(float(cand_mean_channels.mean() / max(ref_mean_channels.mean(), 1e-12)), 4),
        "tileGrid8x8": compute_tile_grid_ratios(reference_rgb, candidate_rgb),
    }
    if parts_prefix is not None:
        result["partBreakdown"] = compute_part_breakdown(reference_rgb, candidate_rgb, parts_prefix)
    return result


def fit_asymptotic_bias_model(ladder_points):
    inverse_samples = numpy.array([1.0 / point["samples"] for point in ladder_points], dtype=numpy.float64)
    errors = numpy.array([point["relMse"] for point in ladder_points], dtype=numpy.float64)
    design_matrix = numpy.column_stack([numpy.ones_like(inverse_samples), inverse_samples])
    coefficients, _, _, _ = numpy.linalg.lstsq(design_matrix, errors, rcond=None)
    asymptotic_bias = float(coefficients[0])
    variance_slope = float(coefficients[1])
    predicted = asymptotic_bias + variance_slope * inverse_samples
    residual_rmse = float(numpy.sqrt(numpy.mean((errors - predicted) ** 2)))
    total_ss = float(numpy.sum((errors - errors.mean()) ** 2))
    r_squared = 1.0 - float(numpy.sum((errors - predicted) ** 2)) / total_ss if total_ss > 0.0 else 1.0
    return {
        "asymptoticBiasRelMse": round(asymptotic_bias, 6),
        "varianceSlopePerSample": round(variance_slope, 6),
        "fitResidualRmse": round(residual_rmse, 6),
        "fitRSquared": round(r_squared, 6),
    }


def interpolate_equal_error_time(target_rel_mse, native_points, time_key):
    ordered = sorted(native_points, key=lambda item: item["samples"])
    for index in range(len(ordered) - 1):
        first = ordered[index]
        second = ordered[index + 1]
        if first["relMse"] >= target_rel_mse >= second["relMse"] and first["relMse"] > second["relMse"]:
            log_error_first = math.log(first["relMse"])
            log_error_second = math.log(second["relMse"])
            log_target = math.log(target_rel_mse)
            fraction = (log_target - log_error_first) / (log_error_second - log_error_first)
            log_time = math.log(first[time_key]) + fraction * (math.log(second[time_key]) - math.log(first[time_key]))
            log_samples = math.log(first["samples"]) + fraction * (math.log(second["samples"]) - math.log(first["samples"]))
            return {
                "reachable": True,
                "interpolatedSeconds": round(math.exp(log_time), 6),
                "interpolatedSamples": round(math.exp(log_samples), 2),
                "bracketSamples": [first["samples"], second["samples"]],
            }
    best_point = min(ordered, key=lambda item: item["relMse"])
    return {
        "reachable": False,
        "interpolatedSeconds": None,
        "interpolatedSamples": None,
        "bestAchievedRelMse": round(best_point["relMse"], 6),
        "bestAchievedAtSamples": best_point["samples"],
        "targetRelMse": round(target_rel_mse, 6),
    }


def run_pair_cli(argument_list):
    parts_prefix = None
    filtered = []
    index = 0
    while index < len(argument_list):
        if argument_list[index] == "--parts":
            parts_prefix = argument_list[index + 1]
            index += 2
            continue
        filtered.append(argument_list[index])
        index += 1
    if len(filtered) < 2:
        raise ValueError("Usage: compare.py [pair] [--parts <partsPrefix>] <referenceImage> <candidateImage> [<candidateImage>...]")
    reference_rgb = load_linear_rgb_image(filtered[0])
    for candidate_path in filtered[1:]:
        candidate_rgb = load_linear_rgb_image(candidate_path)
        if candidate_rgb.shape != reference_rgb.shape:
            raise ValueError(f"Resolution mismatch for '{candidate_path}': {candidate_rgb.shape} vs {reference_rgb.shape}.")
        comparison = compare_image_pair(reference_rgb, candidate_rgb, parts_prefix=parts_prefix)
        comparison["image"] = candidate_path
        print(json.dumps(comparison))


def summarize_repeated_runs(records):
    by_samples = {}
    for record in records:
        by_samples.setdefault(record["samples"], []).append(record)
    summary_rows = []
    for samples in sorted(by_samples.keys()):
        group = by_samples[samples]
        wall_values = [item["wallSeconds"] for item in group]
        setup_values = [item["setupSeconds"] for item in group]
        sampling_values = [item["samplingSeconds"] for item in group]
        total_trace_values = [item["totalTraceSeconds"] for item in group]
        ram_values = [item["peakRamMegabytes"] for item in group]
        vram_delta_values = [item["peakVramDeltaMegabytes"] for item in group]
        vram_peak_values = [item["peakCardVramMegabytes"] for item in group]
        rel_mse_values = [item["relMse"] for item in group]
        cycles_peak_values = [item["cyclesPeakMemoryMegabytes"] for item in group if item.get("cyclesPeakMemoryMegabytes") is not None]
        representative = group[0]
        row = {
            "samples": samples,
            "runCount": len(group),
            "gpuExclusiveAllRuns": all(item["gpuExclusive"] for item in group),
            "relMse": round(float(statistics.median(rel_mse_values)), 6),
            "relMseClipped1000": representative["relMseClipped1000"],
            "relMseTrimmed": representative["relMseTrimmed"],
            "channelMeanRatio": representative["channelMeanRatio"],
            "scalarMeanRatio": representative["scalarMeanRatio"],
            "setupSecondsMedian": round(float(statistics.median(setup_values)), 4),
            "setupSecondsSpread": [round(min(setup_values), 4), round(max(setup_values), 4)],
            "samplingSecondsMedian": round(float(statistics.median(sampling_values)), 4),
            "samplingSecondsSpread": [round(min(sampling_values), 4), round(max(sampling_values), 4)],
            "totalTraceSecondsMedian": round(float(statistics.median(total_trace_values)), 4),
            "totalTraceSecondsSpread": [round(min(total_trace_values), 4), round(max(total_trace_values), 4)],
            "wallSecondsMedian": round(float(statistics.median(wall_values)), 4),
            "wallSecondsSpread": [round(min(wall_values), 4), round(max(wall_values), 4)],
            "peakRamMegabytesMedian": round(float(statistics.median(ram_values)), 2),
            "peakRamMegabytesSpread": [round(min(ram_values), 2), round(max(ram_values), 2)],
            "peakVramDeltaMegabytesMedian": round(float(statistics.median(vram_delta_values)), 2),
            "peakVramDeltaMegabytesSpread": [round(min(vram_delta_values), 2), round(max(vram_delta_values), 2)],
            "peakCardVramMegabytesMedian": round(float(statistics.median(vram_peak_values)), 2),
            "cyclesPeakMemoryMegabytesMedian": round(float(statistics.median(cycles_peak_values)), 2) if cycles_peak_values else None,
        }
        summary_rows.append(row)
    return summary_rows


def load_run_record(prefix_path, reference_rgb):
    with open(f"{prefix_path}.json", encoding="utf-8") as handle:
        trace_info = json.load(handle)
    with open(f"{prefix_path}.metrics.json", encoding="utf-8") as handle:
        metrics_info = json.load(handle)
    candidate_rgb = load_linear_rgb_image(f"{prefix_path}.npy")
    pair_metrics = compare_image_pair(reference_rgb, candidate_rgb)
    return {
        "prefix": prefix_path,
        "engine": trace_info["engine"],
        "samples": trace_info["samples"],
        "seed": trace_info["seed"],
        "setupSeconds": trace_info["setupSeconds"],
        "samplingSeconds": trace_info["samplingSeconds"],
        "totalTraceSeconds": trace_info["totalTraceSeconds"],
        "cyclesPeakMemoryMegabytes": trace_info.get("cyclesPeakMemoryMegabytes"),
        "wallSeconds": metrics_info["wallSeconds"],
        "peakRamMegabytes": metrics_info["peakRamMegabytes"],
        "peakVramDeltaMegabytes": metrics_info["peakVramDeltaMegabytes"],
        "peakCardVramMegabytes": metrics_info["peakCardVramMegabytes"],
        "gpuExclusive": metrics_info["gpuExclusive"],
        "relMse": pair_metrics["relMse"],
        "relMseClipped1000": round(pair_metrics["relMseClipped1000"], 6),
        "relMseTrimmed": round(pair_metrics["relMseTrimmed"], 6),
        "channelMeanRatio": pair_metrics["channelMeanRatio"],
        "scalarMeanRatio": pair_metrics["scalarMeanRatio"],
    }


def run_suite_cli(argument_list):
    if not argument_list:
        raise ValueError("Usage: compare.py suite <manifestJsonPath>")
    manifest_path = os.path.abspath(argument_list[0])
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    seed_a_rgb = load_linear_rgb_image(f"{manifest['referenceSeedAPrefix']}.npy")
    seed_b_rgb = load_linear_rgb_image(f"{manifest['referenceSeedBPrefix']}.npy")
    noise_floor = compare_image_pair(seed_a_rgb, seed_b_rgb)
    cycles_records = [load_run_record(prefix, seed_a_rgb) for prefix in manifest["cyclesLadderPrefixes"]]
    native_records = [load_run_record(prefix, seed_a_rgb) for prefix in manifest["nativeLadderPrefixes"]]
    cycles_ladder = summarize_repeated_runs(cycles_records)
    native_ladder = summarize_repeated_runs(native_records)
    cycles_256 = next(row for row in cycles_ladder if row["samples"] == 256)
    native_256 = next(row for row in native_ladder if row["samples"] == 256)
    native_high_prefix = manifest["nativeDetailPrefix"]
    parts_prefix = manifest.get("partsPrefix")
    native_detail = compare_image_pair(seed_a_rgb, load_linear_rgb_image(f"{native_high_prefix}.npy"), parts_prefix=parts_prefix)
    bias_fit_native = fit_asymptotic_bias_model(native_ladder)
    bias_fit_cycles = fit_asymptotic_bias_model(cycles_ladder)
    teq_sampling = interpolate_equal_error_time(cycles_256["relMse"], native_ladder, "samplingSecondsMedian")
    teq_total = interpolate_equal_error_time(cycles_256["relMse"], native_ladder, "totalTraceSecondsMedian")
    teq_wall = interpolate_equal_error_time(cycles_256["relMse"], native_ladder, "wallSecondsMedian")
    summary = {
        "sceneId": manifest["sceneId"],
        "noiseFloorSeedAVsSeedB": noise_floor,
        "cyclesLadder": cycles_ladder,
        "nativeLadder": native_ladder,
        "cyclesBiasModelFit": bias_fit_cycles,
        "nativeBiasModelFit": bias_fit_native,
        "equalSpp256Comparison": {
            "cyclesRelMse": cycles_256["relMse"],
            "nativeRelMse": native_256["relMse"],
            "relMseRatioNativeOverCycles": round(native_256["relMse"] / cycles_256["relMse"], 4),
            "samplingTimeRatioNativeOverCycles": round(native_256["samplingSecondsMedian"] / max(cycles_256["samplingSecondsMedian"], 1e-9), 4),
            "totalTraceTimeRatioNativeOverCycles": round(native_256["totalTraceSecondsMedian"] / max(cycles_256["totalTraceSecondsMedian"], 1e-9), 4),
            "wallTimeRatioNativeOverCycles": round(native_256["wallSecondsMedian"] / max(cycles_256["wallSecondsMedian"], 1e-9), 4),
            "setupTimeRatioNativeOverCycles": round(native_256["setupSecondsMedian"] / max(cycles_256["setupSecondsMedian"], 1e-9), 4),
        },
        "equalErrorTargetCycles256": {
            "targetRelMse": cycles_256["relMse"],
            "cyclesSamplingSeconds": cycles_256["samplingSecondsMedian"],
            "cyclesTotalTraceSeconds": cycles_256["totalTraceSecondsMedian"],
            "cyclesWallSeconds": cycles_256["wallSecondsMedian"],
            "nativeSamplingCurve": teq_sampling,
            "nativeTotalTraceCurve": teq_total,
            "nativeWallCurve": teq_wall,
        },
        "nativeDetailedComparison": native_detail,
    }
    output_path = manifest.get("outputSummaryPath")
    if output_path:
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


def main():
    arguments = sys.argv[1:]
    if not arguments:
        raise ValueError("Usage: compare.py [pair|suite] ...")
    if arguments[0] == "suite":
        run_suite_cli(arguments[1:])
        return
    if arguments[0] == "pair":
        run_pair_cli(arguments[1:])
        return
    run_pair_cli(arguments)


if __name__ == "__main__":
    main()
