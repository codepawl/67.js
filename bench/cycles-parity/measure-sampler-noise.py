"""Measure relMSE of Cook's sampler or light selection at equal sample counts against a high-sample reference.

  uv run --no-project --with numpy python bench/cycles-parity/measure-sampler-noise.py <sceneJson> <outputDirectory> \
      [--compare sampler|light-tree] [--samples 16,64,256] [--seeds 1,2] [--reference-samples 2048] [--width 480] [--height 270]

--compare sampler (default) pits the PCG hash against Sobol-Burley. --compare light-tree pits the cumulative-weight light pick
against the light tree, both on Sobol-Burley, and also reports sampling seconds and the time each needs to reach the error
the other reaches (interpolated on a log-log line through the sample ladder).
Renders go through the script named by GPU_LOCK_COMMAND when it is set. The reference uses the first variant with its own seed, so no candidate shares random
numbers with it. Prints one JSON object.
"""
import json
import math
import os
import subprocess
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPOSITORY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# A shared machine can queue GPU jobs: set GPU_LOCK_COMMAND to a wrapper script and every render runs through it.
GPU_LOCK_COMMAND = os.environ.get("GPU_LOCK_COMMAND")
REL_MSE_EPSILON = 1e-2
REFERENCE_SEED = 9001
VARIANT_FLAGS = {
    "sampler": {"pcg": ["--sampler", "white"], "sobol": ["--sampler", "sobol-burley"]},
    "light-tree": {
        "off": ["--sampler", "sobol-burley", "--light-sampling", "uniform"],
        "on": ["--sampler", "sobol-burley", "--light-sampling", "tree"],
    },
}


def read_flag(argument_list, flag_name, fallback):
    if flag_name not in argument_list:
        return fallback
    return argument_list[argument_list.index(flag_name) + 1]


def render(scene_json, output_prefix, variant_flags, samples, seed, width, height, weight):
    environment = dict(os.environ, GPU_LOCK_WEIGHT=weight)
    command = [
        *(["bash", GPU_LOCK_COMMAND] if GPU_LOCK_COMMAND else []), "node", os.path.join(REPOSITORY_ROOT, "bench", "cycles-parity", "trace-native.mjs"),
        scene_json, output_prefix, "--kernel", "cycles", "--samples", str(samples),
        "--seed", str(seed), "--width", str(width), "--height", str(height), *variant_flags,
    ]
    subprocess.run(command, check=True, env=environment, stdout=subprocess.DEVNULL)
    with open(output_prefix + ".json", encoding="utf-8") as handle:
        report = json.load(handle)
    return numpy.load(output_prefix + ".npy"), report


def relative_mse(reference_rgb, candidate_rgb):
    denominator = reference_rgb ** 2 + REL_MSE_EPSILON
    return float((((candidate_rgb - reference_rgb) ** 2) / denominator).mean())


def seconds_to_reach(error_target, points):
    """points: (samplingSeconds, relMse) per sample count, error falling as time rises. Log-log interpolation or extrapolation."""
    log_seconds = numpy.log([seconds for seconds, _ in points])
    log_errors = numpy.log([error for _, error in points])
    slope, intercept = numpy.polyfit(log_errors, log_seconds, 1)
    return float(math.exp(slope * math.log(error_target) + intercept))


def main():
    argument_list = sys.argv[1:]
    scene_json, output_directory = os.path.abspath(argument_list[0]), os.path.abspath(argument_list[1])
    comparison = read_flag(argument_list, "--compare", "sampler")
    sample_counts = [int(value) for value in read_flag(argument_list, "--samples", "16,64,256").split(",")]
    seeds = [int(value) for value in read_flag(argument_list, "--seeds", "1,2").split(",")]
    reference_samples = int(read_flag(argument_list, "--reference-samples", "2048"))
    width = int(read_flag(argument_list, "--width", "480"))
    height = int(read_flag(argument_list, "--height", "270"))
    variants = VARIANT_FLAGS[comparison]
    baseline_name, candidate_name = list(variants)
    os.makedirs(output_directory, exist_ok=True)
    reference_rgb, _ = render(
        scene_json, os.path.join(output_directory, "reference"), variants[baseline_name], reference_samples, REFERENCE_SEED, width, height, "heavy",
    )
    results = {}
    ladders = {baseline_name: [], candidate_name: []}
    for samples in sample_counts:
        for name, flags in variants.items():
            errors, seconds = [], []
            for seed in seeds:
                prefix = os.path.join(output_directory, f"{name}-{samples}-{seed}")
                candidate_rgb, report = render(scene_json, prefix, flags, samples, seed, width, height, "light")
                errors.append(relative_mse(reference_rgb, candidate_rgb))
                seconds.append(report["samplingSeconds"])
            mean_error, mean_seconds = float(numpy.mean(errors)), float(numpy.mean(seconds))
            results[f"{name}@{samples}"] = {"relMse": mean_error, "samplingSeconds": mean_seconds, "perSeed": errors}
            ladders[name].append((mean_seconds, mean_error))
        baseline = results[f"{baseline_name}@{samples}"]["relMse"]
        candidate = results[f"{candidate_name}@{samples}"]["relMse"]
        results[f"{candidate_name}@{samples}"]["dropVersus" + baseline_name.capitalize()] = 1.0 - candidate / baseline
    if comparison == "light-tree":
        mean_ratio = float(numpy.mean([
            numpy.load(os.path.join(output_directory, f"{candidate_name}-{sample_counts[-1]}-{seeds[0]}.npy")).mean()
            / numpy.load(os.path.join(output_directory, f"{baseline_name}-{sample_counts[-1]}-{seeds[0]}.npy")).mean()
        ]))
        target_error = ladders[baseline_name][-1][1]
        results["meanImageRatioTreeOverUniform"] = mean_ratio
        results["targetRelMse"] = target_error
        results["secondsToTargetWithout"] = ladders[baseline_name][-1][0]
        results["secondsToTargetWith"] = seconds_to_reach(target_error, ladders[candidate_name])
    print(json.dumps(results, indent=2))


main()
