"""Run or score the 6-scene M1 Cycles 5.3 parity suite (noise floor, legacy kernel, or Cook cycles kernel)."""
import json
import os
import subprocess
import sys

from compare import compare_image_pair, load_linear_rgb_image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

M1_SCENES = [
    "spot-area",
    "light-linking",
    "metal",
    "glass",
    "outdoor-hdri",
    "lit-interior",
]


def read_flag_value(argument_list, flag_name, fallback_value):
    if flag_name not in argument_list:
        return fallback_value
    flag_index = argument_list.index(flag_name)
    if flag_index + 1 >= len(argument_list):
        raise ValueError(f"Flag {flag_name} requires a value.")
    return argument_list[flag_index + 1]


def parse_arguments():
    argument_list = sys.argv[1:]
    if not argument_list or argument_list[0].startswith("--"):
        raise ValueError(
            "Usage: run-m1-parity.py <workDirectory> [--kernel cycles|legacy] [--samples 1024] "
            "[--bounces 8] [--seed 1] [--reference-samples 4096] [--noise-floor-only] [--score-only] [--skip-existing]"
        )
    scenes_text = read_flag_value(argument_list, "--scenes", ",".join(M1_SCENES))
    scenes = [token.strip() for token in scenes_text.split(",") if token.strip()]
    return {
        "work_directory": os.path.abspath(argument_list[0]),
        "kernel": read_flag_value(argument_list, "--kernel", "cycles"),
        "samples": int(read_flag_value(argument_list, "--samples", "1024")),
        "bounces": int(read_flag_value(argument_list, "--bounces", "8")),
        "seed": int(read_flag_value(argument_list, "--seed", "1")),
        "reference_samples": int(read_flag_value(argument_list, "--reference-samples", "4096")),
        "node_binary": read_flag_value(argument_list, "--node-bin", "node"),
        "json_out": read_flag_value(argument_list, "--json-out", ""),
        "scenes": scenes,
        "noise_floor_only": "--noise-floor-only" in argument_list,
        "score_only": "--score-only" in argument_list,
        "skip_existing": "--skip-existing" in argument_list,
    }


def wrap_with_gpu_lock(inner_command):
    bash_binary = os.environ.get("GIT_BASH_BIN")
    gpu_lock_script = os.environ.get("GPU_LOCK_SCRIPT")
    if bash_binary and gpu_lock_script:
        normalized_script = gpu_lock_script.replace("\\", "/")
        normalized_inner = [token.replace("\\", "/") if os.path.sep in token else token for token in inner_command]
        return [bash_binary, normalized_script, *normalized_inner]
    return inner_command


def load_optional_json(file_path):
    if not os.path.exists(file_path):
        return None
    with open(file_path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def evaluate_noise_floor(work_dir, scene_id, ref_samples):
    ref_dir = os.path.join(work_dir, "references")
    prefix_a = os.path.join(ref_dir, f"{scene_id}-cycles-{ref_samples}-seed1")
    prefix_b = os.path.join(ref_dir, f"{scene_id}-cycles-{ref_samples}-seed2")
    rgb_a = load_linear_rgb_image(f"{prefix_a}.npy")
    rgb_b = load_linear_rgb_image(f"{prefix_b}.npy")
    pair = compare_image_pair(rgb_a, rgb_b, include_flip=True)
    meta_a = load_optional_json(f"{prefix_a}.json") or {}
    meta_b = load_optional_json(f"{prefix_b}.json") or {}
    metrics_a = load_optional_json(f"{prefix_a}.metrics.json") or {}
    metrics_b = load_optional_json(f"{prefix_b}.metrics.json") or {}
    tile_grid = pair["tileGrid8x8"]
    return {
        "sceneId": scene_id,
        "samples": ref_samples,
        "relMse": round(pair["relMse"], 6),
        "channelMeanSeed1": pair["referenceChannelMean"],
        "channelMeanSeed2": pair["candidateChannelMean"],
        "channelMeanRatio": pair["channelMeanRatio"],
        "channelMeanRatioExact": pair["parityGates"]["channelMeanRatioExact"],
        "eligibleTileCount": tile_grid["eligibleTileCount"],
        "tileMinRatio": tile_grid["minRatio"],
        "tileMedianRatio": tile_grid["medianRatio"],
        "tileMaxRatio": tile_grid["maxRatio"],
        "flipLdrSeed1VsSeed2": pair["flipLdr"],
        "flipLdrCeiling": round(pair["flipLdr"] + 0.02, 6),
        "flipHdrSeed1VsSeed2": pair["flipHdr"],
        "seed1SamplingSeconds": meta_a.get("samplingSeconds"),
        "seed2SamplingSeconds": meta_b.get("samplingSeconds"),
        "seed1SetupSeconds": meta_a.get("setupSeconds"),
        "seed1GpuExclusive": metrics_a.get("gpuExclusive"),
        "seed2GpuExclusive": metrics_b.get("gpuExclusive"),
        "fullComparison": pair,
    }


def run_trace_if_needed(options, scene_id, candidate_prefix):
    if options["score_only"]:
        return
    npy_path = f"{candidate_prefix}.npy"
    json_path = f"{candidate_prefix}.json"
    metrics_path = f"{candidate_prefix}.metrics.json"
    if options["skip_existing"] and os.path.exists(npy_path) and os.path.exists(json_path):
        return
    scene_json = os.path.join(options["work_directory"], "scenes", f"{scene_id}.json")
    trace_cmd = [
        options["node_binary"],
        "bench/cycles-parity/trace-native.mjs",
        scene_json,
        candidate_prefix,
        "--kernel",
        options["kernel"],
        "--samples",
        str(options["samples"]),
        "--bounces",
        str(options["bounces"]),
        "--seed",
        str(options["seed"]),
        "--firefly-clamp",
        "1000000000",
        "--noise-threshold",
        "0",
    ]
    measure_cmd = [
        "uv",
        "run",
        "--no-project",
        "--with",
        "psutil",
        "python",
        "bench/cycles-parity/measure-gpu-run.py",
        metrics_path,
        "--",
        *trace_cmd,
    ]
    completed = subprocess.run(wrap_with_gpu_lock(measure_cmd), check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"trace-native failed for '{scene_id}' with exit code {completed.returncode}.")


def evaluate_candidate(options, scene_id, noise_entry):
    work_dir = options["work_directory"]
    ref_samples = options["reference_samples"]
    ref_a_npy = os.path.join(work_dir, "references", f"{scene_id}-cycles-{ref_samples}-seed1.npy")
    cand_dir = os.path.join(work_dir, "harness", f"{options['kernel']}-s{options['samples']}")
    os.makedirs(cand_dir, exist_ok=True)
    cand_prefix = os.path.join(cand_dir, f"{scene_id}-{options['kernel']}-{options['samples']}-seed{options['seed']}")
    run_trace_if_needed(options, scene_id, cand_prefix)

    rgb_a = load_linear_rgb_image(ref_a_npy)
    rgb_cand = load_linear_rgb_image(f"{cand_prefix}.npy")
    parts_prefix = os.path.join(work_dir, "scenes", scene_id)
    has_parts = os.path.exists(f"{parts_prefix}-parts.npy")
    comparison = compare_image_pair(
        rgb_a,
        rgb_cand,
        parts_prefix=parts_prefix if has_parts else None,
        include_flip=True,
        seed_ab_comparison=noise_entry["fullComparison"],
    )
    trace_meta = load_optional_json(f"{cand_prefix}.json") or {}
    metrics_meta = load_optional_json(f"{cand_prefix}.metrics.json") or {}
    gates = comparison["parityGates"]
    tiles = comparison["tileGrid8x8"]
    return {
        "sceneId": scene_id,
        "kernel": options["kernel"],
        "samples": options["samples"],
        "allGatesPass": gates["allGatesPass"],
        "channelMeanPass": gates["channelMeanPass"],
        "tileGridPass": gates["tileGridPass"],
        "flipPass": gates["flipPass"],
        "channelMeanRatio": comparison["channelMeanRatio"],
        "channelMeanRatioExact": gates["channelMeanRatioExact"],
        "eligibleTileCount": tiles["eligibleTileCount"],
        "withinFivePercentCount": tiles["withinFivePercentCount"],
        "tileMinRatio": tiles["minRatio"],
        "tileMaxRatio": tiles["maxRatio"],
        "flipLdr": comparison["flipLdr"],
        "flipLdrSeed1VsSeed2": gates["flipLdrAVsB"],
        "flipLdrCeiling": gates["flipLdrCeiling"],
        "flipHdr": comparison["flipHdr"],
        "relMse": round(comparison["relMse"], 6),
        "setupSeconds": trace_meta.get("setupSeconds"),
        "samplingSeconds": trace_meta.get("samplingSeconds"),
        "totalTraceSeconds": trace_meta.get("totalTraceSeconds"),
        "gpuExclusive": metrics_meta.get("gpuExclusive"),
        "comparison": comparison,
    }


def strip_heavy_nested(noise_rows):
    cleaned = []
    for row in noise_rows:
        copied = dict(row)
        copied.pop("fullComparison", None)
        cleaned.append(copied)
    return cleaned


def main():
    options = parse_arguments()
    noise_rows = [
        evaluate_noise_floor(options["work_directory"], scene_id, options["reference_samples"])
        for scene_id in options["scenes"]
    ]
    if options["noise_floor_only"]:
        payload = {
            "referenceSamples": options["reference_samples"],
            "sceneCount": len(noise_rows),
            "noiseFloor": strip_heavy_nested(noise_rows),
        }
    else:
        scene_results = [
            evaluate_candidate(options, scene_id, noise_row)
            for scene_id, noise_row in zip(options["scenes"], noise_rows)
        ]
        payload = {
            "kernel": options["kernel"],
            "samples": options["samples"],
            "bounces": options["bounces"],
            "referenceSamples": options["reference_samples"],
            "sceneCount": len(scene_results),
            "scenePassCount": sum(1 for item in scene_results if item["allGatesPass"]),
            "allScenesPass": all(item["allGatesPass"] for item in scene_results),
            "noiseFloor": strip_heavy_nested(noise_rows),
            "scenes": scene_results,
        }
    if options["json_out"]:
        out_path = os.path.abspath(options["json_out"])
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
