"""Verify lobe white-furnace directional albedo, eval/sample consistency, and 2D Pearson chi-square."""
import json
import math
import os
import sys
import tempfile

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FURNACE_TOLERANCE = 0.01
FURNACE_LIMB_TOLERANCE = 0.015
CHI_SQUARE_MIN_P_VALUE = 0.001
CHI_SQUARE_MIN_EXPECTED = 5.0
HISTOGRAM_PHI_BINS = 32
HISTOGRAM_Z_BINS = 32
EVAL_CONSISTENCY_TOLERANCE = 2e-3
PDF_INTEGRAL_TOLERANCE = 0.005


def regularized_gamma_upper(shape_a, value_x):
    if value_x <= 0.0:
        return 1.0
    if value_x < shape_a + 1.0:
        term = 1.0 / shape_a
        series_sum = term
        for step in range(1, 2000):
            term *= value_x / (shape_a + step)
            series_sum += term
            if abs(term) < abs(series_sum) * 1e-15:
                break
        log_prefix = -value_x + shape_a * math.log(value_x) - math.lgamma(shape_a)
        lower_ratio = series_sum * math.exp(log_prefix)
        return max(0.0, min(1.0, 1.0 - lower_ratio))
    tiny = 1e-300
    denominator = value_x + 1.0 - shape_a
    if abs(denominator) < tiny:
        denominator = tiny
    c_val = 1.0 / tiny
    d_val = 1.0 / denominator
    fraction = d_val
    for step in range(1, 2000):
        an_val = -step * (step - shape_a)
        b_val = value_x + 2.0 * step + 1.0 - shape_a
        d_val = an_val * d_val + b_val
        if abs(d_val) < tiny:
            d_val = tiny
        c_val = b_val + an_val / c_val
        if abs(c_val) < tiny:
            c_val = tiny
        d_val = 1.0 / d_val
        delta = d_val * c_val
        fraction *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    log_prefix = -value_x + shape_a * math.log(value_x) - math.lgamma(shape_a)
    return max(0.0, min(1.0, fraction * math.exp(log_prefix)))


def chi_square_survival_p_value(chi2_statistic, degrees_of_freedom):
    if not math.isfinite(chi2_statistic) or degrees_of_freedom <= 0:
        return 0.0
    return regularized_gamma_upper(0.5 * degrees_of_freedom, 0.5 * chi2_statistic)


def pool_histogram_bins(observed_counts, expected_counts):
    leaked_zero_pdf = int(observed_counts[expected_counts <= 1e-12].sum())
    pooled_obs = []
    pooled_exp = []
    carry_obs = 0.0
    carry_exp = 0.0
    for obs_val, exp_val in zip(observed_counts.tolist(), expected_counts.tolist()):
        if exp_val <= 1e-12:
            continue
        carry_obs += obs_val
        carry_exp += exp_val
        if carry_exp >= CHI_SQUARE_MIN_EXPECTED:
            pooled_obs.append(carry_obs)
            pooled_exp.append(carry_exp)
            carry_obs = 0.0
            carry_exp = 0.0
    if carry_exp > 0.0:
        if pooled_exp:
            pooled_obs[-1] += carry_obs
            pooled_exp[-1] += carry_exp
        else:
            pooled_obs.append(carry_obs)
            pooled_exp.append(carry_exp)
    return numpy.array(pooled_obs, dtype=numpy.float64), numpy.array(pooled_exp, dtype=numpy.float64), leaked_zero_pdf


def evaluate_spherical_chi_square(mode_zero_rows, pdf_grid):
    sample_count = mode_zero_rows.shape[0]
    grid_height, grid_width = pdf_grid.shape
    if grid_height % HISTOGRAM_Z_BINS != 0 or grid_width % HISTOGRAM_PHI_BINS != 0:
        raise ValueError(f"Mode 1 PDF grid {pdf_grid.shape} must be divisible by ({HISTOGRAM_Z_BINS}, {HISTOGRAM_PHI_BINS}).")
    d_omega = 4.0 * math.pi / float(grid_height * grid_width)
    sub_z = grid_height // HISTOGRAM_Z_BINS
    sub_phi = grid_width // HISTOGRAM_PHI_BINS
    reshaped_grid = pdf_grid.astype(numpy.float64).reshape(HISTOGRAM_Z_BINS, sub_z, HISTOGRAM_PHI_BINS, sub_phi)
    bin_probabilities = reshaped_grid.sum(axis=(1, 3)) * d_omega
    raw_pdf_integral = float(bin_probabilities.sum())

    sampled_pdf = mode_zero_rows[:, 3].astype(numpy.float64)
    valid_mask = sampled_pdf > 0.0
    invalid_count = int((~valid_mask).sum())
    wi = mode_zero_rows[valid_mask, 0:3].astype(numpy.float64)
    norms = numpy.maximum(numpy.linalg.norm(wi, axis=1, keepdims=True), 1e-15)
    wi_unit = wi / norms
    z_bin = numpy.clip(numpy.floor((1.0 - wi_unit[:, 2]) * 0.5 * HISTOGRAM_Z_BINS).astype(numpy.int64), 0, HISTOGRAM_Z_BINS - 1)
    phi_angles = numpy.mod(numpy.arctan2(wi_unit[:, 1], wi_unit[:, 0]), 2.0 * math.pi)
    phi_bin = numpy.clip(numpy.floor(phi_angles / (2.0 * math.pi) * HISTOGRAM_PHI_BINS).astype(numpy.int64), 0, HISTOGRAM_PHI_BINS - 1)
    flat_indices = z_bin * HISTOGRAM_PHI_BINS + phi_bin
    observed_bins = numpy.bincount(flat_indices, minlength=HISTOGRAM_Z_BINS * HISTOGRAM_PHI_BINS).astype(numpy.float64)

    expected_probs = bin_probabilities.ravel().copy()
    # Do not rescale when integral > 1; fail hard via integral_valid check below.
    invalid_prob = max(0.0, 1.0 - raw_pdf_integral)
    all_observed = numpy.append(observed_bins, float(invalid_count))
    all_expected = numpy.append(expected_probs, invalid_prob) * float(sample_count)
    pooled_obs, pooled_exp, leaked_zero_pdf = pool_histogram_bins(all_observed, all_expected)
    degrees_of_freedom = max(1, int(len(pooled_exp) - 1))
    if leaked_zero_pdf > 0:
        chi2_stat = float("inf")
        p_value = 0.0
    else:
        chi2_stat = float(numpy.sum(((pooled_obs - pooled_exp) ** 2) / pooled_exp))
        p_value = chi_square_survival_p_value(chi2_stat, degrees_of_freedom)
    integral_valid = raw_pdf_integral <= 1.0 + PDF_INTEGRAL_TOLERANCE
    passed = bool(leaked_zero_pdf == 0 and integral_valid and p_value >= CHI_SQUARE_MIN_P_VALUE)
    return {
        "rawPdfIntegral": round(raw_pdf_integral, 6),
        "invalidSampleCount": invalid_count,
        "leakedZeroPdfSamples": leaked_zero_pdf,
        "pooledBinCount": int(len(pooled_exp)),
        "degreesOfFreedom": degrees_of_freedom,
        "chiSquare": round(chi2_stat, 4) if math.isfinite(chi2_stat) else None,
        "reducedChiSquare": round(chi2_stat / degrees_of_freedom, 4) if math.isfinite(chi2_stat) else None,
        "pValue": round(p_value, 6),
        "minPValue": CHI_SQUARE_MIN_P_VALUE,
        "pass": passed,
    }


def evaluate_lobe_probe(probe_entry):
    rows = numpy.load(probe_entry["modeZeroPath"]).astype(numpy.float64)
    finite_all = bool(numpy.isfinite(rows).all())
    sample_count = rows.shape[0]
    samp_pdf = rows[:, 3]
    samp_eval = rows[:, 4:7]
    ev_value = rows[:, 8:11]
    ev_pdf = rows[:, 11]

    valid_mask = samp_pdf > 0.0
    weights = numpy.zeros((sample_count, 3), dtype=numpy.float64)
    weights[valid_mask] = samp_eval[valid_mask] / samp_pdf[valid_mask, None]
    furnace_mean = weights.mean(axis=0)
    furnace_stderr = weights.std(axis=0, ddof=1) / math.sqrt(sample_count)

    if valid_mask.any():
        eval_scale = numpy.maximum(numpy.maximum(numpy.abs(samp_eval[valid_mask]), numpy.abs(ev_value[valid_mask])), 1.0)
        rel_eval_diff = float(numpy.max(numpy.abs(samp_eval[valid_mask] - ev_value[valid_mask]) / eval_scale))
        pdf_scale = numpy.maximum(numpy.maximum(samp_pdf[valid_mask], ev_pdf[valid_mask]), 1.0)
        rel_pdf_diff = float(numpy.max(numpy.abs(samp_pdf[valid_mask] - ev_pdf[valid_mask]) / pdf_scale))
    else:
        rel_eval_diff = float("inf")
        rel_pdf_diff = float("inf")
    consistency_pass = bool(rel_eval_diff <= EVAL_CONSISTENCY_TOLERANCE and rel_pdf_diff <= EVAL_CONSISTENCY_TOLERANCE)

    if probe_entry["expectWhiteFurnace"]:
        furnace_pass = bool(all(abs(val - 1.0) <= FURNACE_TOLERANCE for val in furnace_mean))
    else:
        bounded = all(0.01 <= val <= 1.0 + FURNACE_TOLERANCE for val in furnace_mean)
        order = probe_entry.get("expectColorOrder")
        ordered = True if not order else all(furnace_mean[order[idx]] > furnace_mean[order[idx + 1]] for idx in range(len(order) - 1))
        furnace_pass = bool(bounded and ordered)

    chi_square_report = None
    chi_square_pass = True
    if probe_entry["expectChiSquare"]:
        pdf_grid = numpy.load(probe_entry["modeOnePath"])
        chi_square_report = evaluate_spherical_chi_square(rows, pdf_grid)
        chi_square_pass = chi_square_report["pass"]

    overall_pass = bool(finite_all and furnace_pass and consistency_pass and chi_square_pass)
    return {
        "id": probe_entry["id"],
        "family": probe_entry["family"],
        "frontFace": probe_entry["frontFace"],
        "wo": probe_entry["wo"],
        "sampleCount": int(sample_count),
        "validSampleCount": int(valid_mask.sum()),
        "finiteAll": finite_all,
        "expectWhiteFurnace": probe_entry["expectWhiteFurnace"],
        "furnaceMeanRgb": [round(float(val), 6) for val in furnace_mean],
        "furnaceStdErrRgb": [round(float(val), 6) for val in furnace_stderr],
        "furnaceTolerance": FURNACE_TOLERANCE,
        "furnacePass": furnace_pass,
        "maxRelativeEvalMismatch": round(rel_eval_diff, 7) if math.isfinite(rel_eval_diff) else None,
        "maxRelativePdfMismatch": round(rel_pdf_diff, 7) if math.isfinite(rel_pdf_diff) else None,
        "consistencyPass": consistency_pass,
        "chiSquare": chi_square_report,
        "pass": overall_pass,
    }


def evaluate_furnace_scene(scene_entry):
    image = numpy.load(scene_entry["imagePath"]).astype(numpy.float64)
    finite_all = bool(numpy.isfinite(image).all())
    height, width, _ = image.shape
    ys, xs = numpy.ogrid[:height, :width]
    center_y = 0.5 * (height - 1.0)
    center_x = 0.5 * (width - 1.0)
    radius_px = numpy.sqrt((xs - center_x) ** 2 + (ys - center_y) ** 2)

    tan_half_fov = math.tan(math.radians(0.5 * scene_entry["cameraFovDegrees"]))
    sin_sil = scene_entry["sphereRadius"] / scene_entry["cameraEyeZ"]
    tan_sil = sin_sil / math.sqrt(max(1e-8, 1.0 - sin_sil * sin_sil))
    projected_radius = (tan_sil / tan_half_fov) * (0.5 * height)

    center_mask = radius_px <= 0.40 * projected_radius
    limb_mask = (radius_px >= 0.72 * projected_radius) & (radius_px <= 0.92 * projected_radius)
    full_mean = image.reshape(-1, 3).mean(axis=0)
    center_mean = image[center_mask].mean(axis=0)
    limb_mean = image[limb_mask].mean(axis=0)

    full_pass = all(abs(val - 1.0) <= FURNACE_TOLERANCE for val in full_mean)
    center_pass = all(abs(val - 1.0) <= FURNACE_TOLERANCE for val in center_mean)
    limb_pass = all(abs(val - 1.0) <= FURNACE_LIMB_TOLERANCE for val in limb_mean)
    passed = bool(finite_all and full_pass and center_pass and limb_pass)
    return {
        "id": scene_entry["id"],
        "shape": list(image.shape),
        "samples": scene_entry["samples"],
        "finiteAll": finite_all,
        "fullImageMeanRgb": [round(float(val), 6) for val in full_mean],
        "sphereCenterMeanRgb": [round(float(val), 6) for val in center_mean],
        "sphereLimbMeanRgb": [round(float(val), 6) for val in limb_mean],
        "fullPass": bool(full_pass),
        "centerPass": bool(center_pass),
        "limbPass": bool(limb_pass),
        "pass": passed,
    }


def build_synthetic_pdf_grid(grid_height, grid_width, pdf_function):
    iy = (numpy.arange(grid_height, dtype=numpy.float64) + 0.5) / grid_height
    ix = (numpy.arange(grid_width, dtype=numpy.float64) + 0.5) / grid_width
    z_vals = 1.0 - 2.0 * iy[:, None]
    phi_vals = 2.0 * math.pi * ix[None, :]
    evaluated = pdf_function(z_vals, phi_vals)
    return numpy.broadcast_to(evaluated, (grid_height, grid_width)).copy().astype(numpy.float32)


def run_self_test():
    rng = numpy.random.default_rng(894)
    sample_count = 65536
    grid_h, grid_w = 256, 512

    with tempfile.TemporaryDirectory() as temp_dir:
        u1 = rng.random(sample_count)
        u2 = rng.random(sample_count)
        z_cos = numpy.sqrt(u1)
        sin_t = numpy.sqrt(numpy.maximum(0.0, 1.0 - u1))
        phi = 2.0 * math.pi * u2
        pdf_lambert = z_cos / math.pi
        rows_lambert = numpy.zeros((sample_count, 12), dtype=numpy.float32)
        rows_lambert[:, 0] = sin_t * numpy.cos(phi)
        rows_lambert[:, 1] = sin_t * numpy.sin(phi)
        rows_lambert[:, 2] = z_cos
        rows_lambert[:, 3] = pdf_lambert
        rows_lambert[:, 4:7] = pdf_lambert[:, None]
        rows_lambert[:, 8:11] = pdf_lambert[:, None]
        rows_lambert[:, 11] = pdf_lambert
        lambert_m0 = os.path.join(temp_dir, "lambert-m0.npy")
        lambert_m1 = os.path.join(temp_dir, "lambert-m1.npy")
        numpy.save(lambert_m0, rows_lambert)
        numpy.save(lambert_m1, build_synthetic_pdf_grid(grid_h, grid_w, lambda z, _p: numpy.maximum(z, 0.0) / math.pi))
        lambert_res = evaluate_lobe_probe({
            "id": "self-lambert",
            "family": "diffuse",
            "frontFace": True,
            "wo": [0, 0, 1],
            "expectWhiteFurnace": True,
            "expectChiSquare": True,
            "modeZeroPath": lambert_m0,
            "modeOnePath": lambert_m1,
        })
        assert lambert_res["pass"], f"Lambert self-test failed: {lambert_res}"

        split_reflect = rng.random(sample_count) < 0.35
        rows_glass = rows_lambert.copy()
        rows_glass[~split_reflect, 2] = -z_cos[~split_reflect]
        rows_glass[split_reflect, 3] = 0.35 * pdf_lambert[split_reflect]
        rows_glass[~split_reflect, 3] = 0.65 * pdf_lambert[~split_reflect]
        rows_glass[:, 4:7] = rows_glass[:, 3:4]
        rows_glass[:, 8:11] = rows_glass[:, 3:4]
        rows_glass[:, 11] = rows_glass[:, 3]
        glass_m0 = os.path.join(temp_dir, "glass-m0.npy")
        glass_m1 = os.path.join(temp_dir, "glass-m1.npy")
        numpy.save(glass_m0, rows_glass)
        numpy.save(
            glass_m1,
            build_synthetic_pdf_grid(
                grid_h,
                grid_w,
                lambda z, _p: numpy.where(z >= 0.0, 0.35 * z / math.pi, 0.65 * (-z) / math.pi),
            ),
        )
        glass_res = evaluate_lobe_probe({
            "id": "self-glass-two-hemisphere",
            "family": "glass_ggx",
            "frontFace": True,
            "wo": [0, 0, 1],
            "expectWhiteFurnace": True,
            "expectChiSquare": True,
            "modeZeroPath": glass_m0,
            "modeOnePath": glass_m1,
        })
        assert glass_res["pass"], f"Two-hemisphere glass self-test failed: {glass_res}"

        bad_furnace_rows = rows_lambert.copy()
        bad_furnace_rows[:, 4:7] *= 0.94
        bad_furnace_rows[:, 8:11] *= 0.94
        bad_m0 = os.path.join(temp_dir, "bad-furnace.npy")
        numpy.save(bad_m0, bad_furnace_rows)
        bad_furnace_res = evaluate_lobe_probe({
            "id": "self-bad-furnace",
            "family": "diffuse",
            "frontFace": True,
            "wo": [0, 0, 1],
            "expectWhiteFurnace": True,
            "expectChiSquare": False,
            "modeZeroPath": bad_m0,
            "modeOnePath": None,
        })
        assert not bad_furnace_res["pass"] and not bad_furnace_res["furnacePass"], "6% energy loss was not rejected"

        skewed_grid = build_synthetic_pdf_grid(
            grid_h,
            grid_w,
            lambda z, p: numpy.maximum(z, 0.0) / math.pi * (1.0 + 0.5 * numpy.cos(p)),
        )
        skewed_m1 = os.path.join(temp_dir, "skewed-m1.npy")
        numpy.save(skewed_m1, skewed_grid)
        bad_chi_res = evaluate_lobe_probe({
            "id": "self-bad-chisquare",
            "family": "anisotropic_ggx",
            "frontFace": True,
            "wo": [0, 0, 1],
            "expectWhiteFurnace": True,
            "expectChiSquare": True,
            "modeZeroPath": lambert_m0,
            "modeOnePath": skewed_m1,
        })
        assert not bad_chi_res["pass"] and not bad_chi_res["chiSquare"]["pass"], "Skewed azimuthal PDF was not rejected"

        furnace_ok_path = os.path.join(temp_dir, "scene-ok.npy")
        furnace_img = (1.0 + rng.normal(0.0, 0.015, size=(128, 128, 3))).astype(numpy.float32)
        numpy.save(furnace_ok_path, furnace_img)
        scene_ok = evaluate_furnace_scene({
            "id": "self-scene-ok",
            "samples": 512,
            "cameraEyeZ": 3.2,
            "cameraFovDegrees": 40.0,
            "sphereRadius": 1.0,
            "imagePath": furnace_ok_path,
        })
        assert scene_ok["pass"], f"Valid sphere furnace scene failed: {scene_ok}"

        furnace_dark_rim_path = os.path.join(temp_dir, "scene-dark-rim.npy")
        ys, xs = numpy.ogrid[:128, :128]
        rad = numpy.sqrt((xs - 63.5) ** 2 + (ys - 63.5) ** 2)
        dark_rim = furnace_img.copy()
        dark_rim[(rad >= 40.0) & (rad <= 56.0)] *= 0.88
        numpy.save(furnace_dark_rim_path, dark_rim)
        scene_bad = evaluate_furnace_scene({
            "id": "self-scene-dark-rim",
            "samples": 512,
            "cameraEyeZ": 3.2,
            "cameraFovDegrees": 40.0,
            "sphereRadius": 1.0,
            "imagePath": furnace_dark_rim_path,
        })
        assert not scene_bad["pass"] and not scene_bad["limbPass"], "Dark-rim grazing energy loss was not rejected"

        # Verify that a synthetic PDF integrating to 1.006 fails without rescaling.
        over_integral_grid = build_synthetic_pdf_grid(
            grid_h, grid_w,
            lambda z, _p: numpy.maximum(z, 0.0) / math.pi * (1.006 / 1.0),
        )
        over_integral_m1 = os.path.join(temp_dir, "over-integral-m1.npy")
        numpy.save(over_integral_m1, over_integral_grid)
        over_integral_res = evaluate_lobe_probe({
            "id": "self-over-integral",
            "family": "diffuse",
            "frontFace": True,
            "wo": [0, 0, 1],
            "expectWhiteFurnace": True,
            "expectChiSquare": True,
            "modeZeroPath": lambert_m0,
            "modeOnePath": over_integral_m1,
        })
        assert not over_integral_res["pass"], (
            f"PDF integral {over_integral_res['chiSquare']['rawPdfIntegral']:.4f} "
            "should FAIL (> 1.005) — no rescaling"
        )

    print(json.dumps({
        "selfTest": "ok",
        "lambertPValue": lambert_res["chiSquare"]["pValue"],
        "glassPValue": glass_res["chiSquare"]["pValue"],
    }))


def main():
    arguments = sys.argv[1:]
    if "--self-test" in arguments:
        run_self_test()
        return
    if not arguments or arguments[0].startswith("--"):
        raise ValueError("Usage: verify-lobes.py <lobesDirectoryOrManifestJson> [--json-out <outputPath>] | --self-test")
    target_path = os.path.abspath(arguments[0])
    manifest_path = os.path.join(target_path, "lobes-manifest.json") if os.path.isdir(target_path) else target_path
    json_out_path = None
    if "--json-out" in arguments:
        flag_idx = arguments.index("--json-out")
        json_out_path = os.path.abspath(arguments[flag_idx + 1])

    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    probe_results = [evaluate_lobe_probe(entry) for entry in manifest.get("probes", [])]
    scene_results = [evaluate_furnace_scene(entry) for entry in manifest.get("furnaceScenes", [])]
    all_probes_pass = all(item["pass"] for item in probe_results)
    all_scenes_pass = all(item["pass"] for item in scene_results)
    summary = {
        "manifestPath": manifest_path,
        "probeCount": len(probe_results),
        "probePassCount": sum(1 for item in probe_results if item["pass"]),
        "furnaceSceneCount": len(scene_results),
        "furnaceScenePassCount": sum(1 for item in scene_results if item["pass"]),
        "allProbesPass": bool(all_probes_pass),
        "allFurnaceScenesPass": bool(all_scenes_pass),
        "allPass": bool(all_probes_pass and all_scenes_pass),
        "probes": probe_results,
        "furnaceScenes": scene_results,
    }
    if json_out_path is not None:
        os.makedirs(os.path.dirname(json_out_path), exist_ok=True)
        with open(json_out_path, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))
    if not summary["allPass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
