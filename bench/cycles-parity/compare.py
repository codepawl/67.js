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
CHANNEL_MEAN_TOLERANCE = 0.02
FLIP_NOISE_MARGIN = 0.02
DISPLAY_GAMMA = 2.2


def tone_map_like_crucible(linear_rgb):
    positive_color = numpy.maximum(linear_rgb, 0.0)
    numerator = positive_color * (2.51 * positive_color + 0.03)
    denominator = positive_color * (2.43 * positive_color + 0.59) + 0.14
    mapped = numpy.clip(numerator / denominator, 0.0, 1.0)
    return (mapped ** (1.0 / DISPLAY_GAMMA)).astype(numpy.float32)


def compute_flip_scores(reference_rgb, candidate_rgb):
    try:
        import flip_evaluator
    except ImportError as error:
        raise RuntimeError("flip_evaluator is required for FLIP scoring. Run via 'uv run --no-project --with flip-evaluator ...' or pass --no-flip.") from error
    reference_ldr = tone_map_like_crucible(reference_rgb)
    candidate_ldr = tone_map_like_crucible(candidate_rgb)
    _, mean_ldr, _ = flip_evaluator.evaluate(reference_ldr, candidate_ldr, "LDR", inputsRGB=True)
    reference_hdr = numpy.maximum(reference_rgb, 0.0).astype(numpy.float32)
    candidate_hdr = numpy.maximum(candidate_rgb, 0.0).astype(numpy.float32)
    _, mean_hdr, _ = flip_evaluator.evaluate(reference_hdr, candidate_hdr, "HDR")
    return {
        "flipLdr": float(mean_ldr),
        "flipHdr": float(mean_hdr),
    }


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
    dark_tile_abs_error_sum = 0.0
    dark_tile_value_count = 0
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
                    "ratioExact": ratio,
                    "absDeviation": abs(ratio - 1.0),
                    "referenceMean": round(ref_mean, 5),
                    "candidateMean": round(cand_mean, 5),
                    "channelRatios": channel_ratios,
                })
            else:
                dark_tile_abs_error_sum += float(numpy.abs(cand_tile - ref_tile).sum())
                dark_tile_value_count += int(ref_tile.size)
        grid_ratios.append(row_values)
    total_tile_count = TILE_GRID_SIZE * TILE_GRID_SIZE
    excluded_dark_tile_count = total_tile_count - len(eligible_entries)
    excluded_dark_tile_mae = (
        round(dark_tile_abs_error_sum / dark_tile_value_count, 6)
        if dark_tile_value_count > 0
        else None
    )
    ratios_only = [entry["ratioExact"] for entry in eligible_entries]
    within_tolerance = [entry for entry in eligible_entries if entry["absDeviation"] <= TILE_RATIO_TOLERANCE]
    min_tile_index = min(range(len(eligible_entries)), key=lambda idx: eligible_entries[idx]["ratioExact"]) if eligible_entries else None
    max_tile_index = max(range(len(eligible_entries)), key=lambda idx: eligible_entries[idx]["ratioExact"]) if eligible_entries else None
    worst_tiles = sorted(eligible_entries, key=lambda entry: entry["absDeviation"], reverse=True)[:8]
    for entry in eligible_entries:
        entry.pop("absDeviation", None)
        entry.pop("ratioExact", None)
    return {
        "gridShape": [TILE_GRID_SIZE, TILE_GRID_SIZE],
        "eligibleMeanThreshold": TILE_ELIGIBLE_MEAN_THRESHOLD,
        "totalTileCount": total_tile_count,
        "eligibleTileCount": len(eligible_entries),
        "excludedDarkTileCount": excluded_dark_tile_count,
        "excludedDarkTileMeanAbsError": excluded_dark_tile_mae,
        "withinFivePercentCount": len(within_tolerance),
        "outsideFivePercentCount": len(eligible_entries) - len(within_tolerance),
        "minRatio": round(min(ratios_only), 4) if ratios_only else None,
        "medianRatio": round(float(statistics.median(ratios_only)), 4) if ratios_only else None,
        "maxRatio": round(max(ratios_only), 4) if ratios_only else None,
        "minTile": dict(eligible_entries[min_tile_index]) if min_tile_index is not None else None,
        "maxTile": dict(eligible_entries[max_tile_index]) if max_tile_index is not None else None,
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


def build_parity_gates(raw_channel_ratios, tile_grid, candidate_flip, seed_ab_flip):
    channel_mean_pass = all(abs(ratio - 1.0) <= CHANNEL_MEAN_TOLERANCE for ratio in raw_channel_ratios)
    tile_grid_pass = tile_grid["outsideFivePercentCount"] == 0
    gates = {
        "channelMeanRatioExact": [round(float(ratio), 6) for ratio in raw_channel_ratios],
        "channelMeanTolerance": CHANNEL_MEAN_TOLERANCE,
        "channelMeanPass": bool(channel_mean_pass),
        "tileGridTolerance": TILE_RATIO_TOLERANCE,
        "tileGridEligibleCount": tile_grid["eligibleTileCount"],
        "tileGridWithinFivePercentCount": tile_grid["withinFivePercentCount"],
        "tileGridOutsideFivePercentCount": tile_grid["outsideFivePercentCount"],
        "tileGridMinRatio": tile_grid["minRatio"],
        "tileGridMaxRatio": tile_grid["maxRatio"],
        "tileGridPass": bool(tile_grid_pass),
    }
    if candidate_flip is not None:
        gates["flipLdrCandidateVsA"] = round(candidate_flip["flipLdr"], 6)
        gates["flipHdrCandidateVsA"] = round(candidate_flip["flipHdr"], 6)
    if candidate_flip is not None and seed_ab_flip is not None:
        ceiling = seed_ab_flip["flipLdr"] + FLIP_NOISE_MARGIN
        flip_pass = candidate_flip["flipLdr"] <= ceiling
        gates["flipLdrAVsB"] = round(seed_ab_flip["flipLdr"], 6)
        gates["flipHdrAVsB"] = round(seed_ab_flip["flipHdr"], 6)
        gates["flipLdrMargin"] = FLIP_NOISE_MARGIN
        gates["flipLdrCeiling"] = round(ceiling, 6)
        gates["flipPass"] = bool(flip_pass)
        gates["allGatesPass"] = bool(channel_mean_pass and tile_grid_pass and flip_pass)
    else:
        gates["flipLdrAVsB"] = None
        gates["flipHdrAVsB"] = None
        gates["flipLdrMargin"] = FLIP_NOISE_MARGIN
        gates["flipLdrCeiling"] = None
        gates["flipPass"] = None
        gates["allGatesPass"] = None
    return gates


def compare_image_pair(reference_rgb, candidate_rgb, parts_prefix=None, include_flip=False, seed_ab_comparison=None):
    error_metrics = compute_relative_mse(reference_rgb, candidate_rgb)
    abs_diff = numpy.abs(candidate_rgb - reference_rgb)
    differing_mask = abs_diff.max(axis=-1) > 0.0
    ref_mean_channels = reference_rgb.reshape(-1, 3).mean(axis=0)
    cand_mean_channels = candidate_rgb.reshape(-1, 3).mean(axis=0)
    raw_channel_ratios = [float(cand_mean_channels[ch] / max(ref_mean_channels[ch], 1e-12)) for ch in range(3)]
    channel_ratios = [round(ratio, 4) for ratio in raw_channel_ratios]
    tile_grid = compute_tile_grid_ratios(reference_rgb, candidate_rgb)
    candidate_flip = compute_flip_scores(reference_rgb, candidate_rgb) if include_flip else None
    seed_ab_flip = None
    if seed_ab_comparison is not None and seed_ab_comparison.get("flipLdr") is not None:
        seed_ab_flip = {
            "flipLdr": seed_ab_comparison["flipLdr"],
            "flipHdr": seed_ab_comparison["flipHdr"],
        }
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
        "flipLdr": round(candidate_flip["flipLdr"], 6) if candidate_flip is not None else None,
        "flipLdrRounded4": round(candidate_flip["flipLdr"], 4) if candidate_flip is not None else None,
        "flipHdr": round(candidate_flip["flipHdr"], 6) if candidate_flip is not None else None,
        "parityGates": build_parity_gates(raw_channel_ratios, tile_grid, candidate_flip, seed_ab_flip),
        "tileGrid8x8": tile_grid,
    }
    if seed_ab_comparison is not None:
        result["seedAVsSeedB"] = seed_ab_comparison
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


def format_parity_summary_line(comparison):
    gates = comparison["parityGates"]
    tile_grid = comparison["tileGrid8x8"]
    ratios = comparison["channelMeanRatio"]
    flip_text = f"FLIP_LDR={comparison['flipLdr']:.4f}" if comparison["flipLdr"] is not None else "FLIP_LDR=n/a"
    if gates["flipLdrCeiling"] is not None:
        flip_text += f" (ceil {gates['flipLdrCeiling']:.4f}, A/B {gates['flipLdrAVsB']:.4f}, pass={gates['flipPass']})"
    tile_text = (
        f"tiles={tile_grid['withinFivePercentCount']}/{tile_grid['eligibleTileCount']} "
        f"(of {tile_grid['totalTileCount']} total, {tile_grid['excludedDarkTileCount']} dark excluded) "
        f"[{tile_grid['minRatio']}, {tile_grid['maxRatio']}] pass={gates['tileGridPass']}"
    )
    rel_mse_trimmed = comparison.get("relMseTrimmed")
    rel_mse_trimmed_text = f"{rel_mse_trimmed:.6f}" if rel_mse_trimmed is not None else "n/a"
    return (
        f"{os.path.basename(comparison['image'])}: "
        f"allGatesPass={gates['allGatesPass']} "
        f"RGB={ratios} (pass={gates['channelMeanPass']}) "
        f"{tile_text} {flip_text} relMSE={comparison['relMse']:.6f} relMSETrimmed={rel_mse_trimmed_text}"
    )


def run_pair_cli(argument_list):
    parts_prefix = None
    reference_b_path = None
    json_out_path = None
    skip_flip = False
    print_summary = False
    filtered = []
    index = 0
    while index < len(argument_list):
        token = argument_list[index]
        if token == "--parts":
            parts_prefix = argument_list[index + 1]
            index += 2
            continue
        if token == "--reference-b":
            reference_b_path = argument_list[index + 1]
            index += 2
            continue
        if token == "--json-out":
            json_out_path = argument_list[index + 1]
            index += 2
            continue
        if token == "--no-flip":
            skip_flip = True
            index += 1
            continue
        if token == "--summary":
            print_summary = True
            index += 1
            continue
        filtered.append(token)
        index += 1
    if len(filtered) < 2:
        raise ValueError(
            "Usage: compare.py [pair] [--reference-b <seed2Image>] [--parts <partsPrefix>] "
            "[--json-out <outputPath>] [--no-flip] [--summary] <referenceImage> <candidateImage> [<candidateImage>...]"
        )
    reference_rgb = load_linear_rgb_image(filtered[0])
    include_flip = not skip_flip
    seed_ab_comparison = None
    if reference_b_path is not None:
        reference_b_rgb = load_linear_rgb_image(reference_b_path)
        if reference_b_rgb.shape != reference_rgb.shape:
            raise ValueError(f"Resolution mismatch for --reference-b '{reference_b_path}': {reference_b_rgb.shape} vs {reference_rgb.shape}.")
        seed_ab_comparison = compare_image_pair(reference_rgb, reference_b_rgb, include_flip=include_flip)
        seed_ab_comparison["referenceAPath"] = filtered[0]
        seed_ab_comparison["referenceBPath"] = reference_b_path
    comparisons = []
    for candidate_path in filtered[1:]:
        candidate_rgb = load_linear_rgb_image(candidate_path)
        if candidate_rgb.shape != reference_rgb.shape:
            raise ValueError(f"Resolution mismatch for '{candidate_path}': {candidate_rgb.shape} vs {reference_rgb.shape}.")
        comparison = compare_image_pair(
            reference_rgb,
            candidate_rgb,
            parts_prefix=parts_prefix,
            include_flip=include_flip,
            seed_ab_comparison=seed_ab_comparison,
        )
        comparison["referenceImage"] = filtered[0]
        comparison["image"] = candidate_path
        comparisons.append(comparison)
        print(json.dumps(comparison))
        if print_summary:
            print(format_parity_summary_line(comparison), file=sys.stderr)
    if json_out_path is not None:
        os.makedirs(os.path.dirname(os.path.abspath(json_out_path)), exist_ok=True)
        payload = comparisons[0] if len(comparisons) == 1 else comparisons
        with open(json_out_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)


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
