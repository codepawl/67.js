"""Run the M0 Cycles 5.3 vs 67js native parity benchmark suite."""
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_BLENDER_BINARY = r"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe"
DEFAULT_LADDER_SAMPLES = [16, 32, 64, 128, 256, 512, 1024]
DEFAULT_EXTENDED_NATIVE_SAMPLES = [2048, 4096]


def read_flag_value(argument_list, flag_name, fallback_value):
    if flag_name not in argument_list:
        return fallback_value
    flag_index = argument_list.index(flag_name)
    if flag_index + 1 >= len(argument_list):
        raise ValueError(f"Flag {flag_name} requires a value.")
    return argument_list[flag_index + 1]


def parse_suite_arguments():
    argument_list = sys.argv[1:]
    if not argument_list or argument_list[0].startswith("--"):
        raise ValueError("Usage: run-m0-suite.py <outputDirectory> [--scene lit-interior] [--repeats 3] [--bounces 8] [--mode all|references|ladder|compare]")
    blender_binary = read_flag_value(argument_list, "--blender-bin", os.environ.get("BLENDER_BIN", DEFAULT_BLENDER_BINARY))
    ladder_text = read_flag_value(argument_list, "--samples", ",".join(str(item) for item in DEFAULT_LADDER_SAMPLES))
    extra_text = read_flag_value(argument_list, "--native-extra-samples", ",".join(str(item) for item in DEFAULT_EXTENDED_NATIVE_SAMPLES))
    ladder_samples = [int(token) for token in ladder_text.split(",") if token.strip()]
    extra_samples = [int(token) for token in extra_text.split(",") if token.strip()]
    return {
        "output_directory": os.path.abspath(argument_list[0]),
        "scene_id": read_flag_value(argument_list, "--scene", "lit-interior"),
        "repeats": int(read_flag_value(argument_list, "--repeats", "3")),
        "bounces": int(read_flag_value(argument_list, "--bounces", "8")),
        "reference_samples": int(read_flag_value(argument_list, "--reference-samples", "4096")),
        "seed_a": int(read_flag_value(argument_list, "--seed-a", "1")),
        "seed_b": int(read_flag_value(argument_list, "--seed-b", "2")),
        "mode": read_flag_value(argument_list, "--mode", "all"),
        "blender_binary": blender_binary,
        "node_binary": read_flag_value(argument_list, "--node-bin", "node"),
        "ladder_samples": ladder_samples,
        "native_extra_samples": extra_samples,
        "skip_existing": "--skip-existing" in argument_list,
    }


def run_checked_command(command):
    completed = subprocess.run(command, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {completed.returncode}: {' '.join(command)}")


def wrap_with_gpu_lock(inner_command):
    bash_binary = os.environ.get("GIT_BASH_BIN")
    gpu_lock_script = os.environ.get("GPU_LOCK_SCRIPT")
    if bash_binary and gpu_lock_script:
        return [bash_binary, gpu_lock_script, *inner_command]
    return inner_command


def run_measured_gpu_step(prefix_path, render_command, skip_existing):
    npy_file = f"{prefix_path}.npy"
    json_file = f"{prefix_path}.json"
    metrics_file = f"{prefix_path}.metrics.json"
    if skip_existing and os.path.exists(npy_file) and os.path.exists(json_file) and os.path.exists(metrics_file):
        return
    measure_command = [
        "uv",
        "run",
        "--no-project",
        "--with",
        "psutil",
        "python",
        "bench/cycles-parity/measure-gpu-run.py",
        metrics_file,
        "--",
        *render_command,
    ]
    run_checked_command(wrap_with_gpu_lock(measure_command))


def build_cycles_command(options, scene_json_path, prefix_path, samples, seed, keep_exr):
    command = [
        options["blender_binary"],
        "-b",
        "--factory-startup",
        "--python",
        "bench/cycles-parity/render-cycles.py",
        "--",
        scene_json_path,
        prefix_path,
        "--samples",
        str(samples),
        "--bounces",
        str(options["bounces"]),
        "--seed",
        str(seed),
    ]
    if keep_exr:
        command.append("--keep-exr")
    return command


def build_native_command(options, scene_json_path, prefix_path, samples, seed):
    return [
        options["node_binary"],
        "bench/cycles-parity/trace-native.mjs",
        scene_json_path,
        prefix_path,
        "--samples",
        str(samples),
        "--bounces",
        str(options["bounces"]),
        "--seed",
        str(seed),
        "--firefly-clamp",
        "1000000000",
        "--noise-threshold",
        "0",
    ]


def ensure_scene_and_parts(options, scene_json_path, parts_prefix):
    if not os.path.exists(scene_json_path):
        run_checked_command([
            options["node_binary"],
            "bench/cycles-parity/export-scene.mjs",
            options["output_directory"],
            "--scene",
            options["scene_id"],
        ])
    if not os.path.exists(f"{parts_prefix}-parts.npy"):
        part_command = [
            options["blender_binary"],
            "-b",
            "--factory-startup",
            "--python",
            "bench/cycles-parity/render-cycles.py",
            "--",
            scene_json_path,
            parts_prefix,
            "--part-ids",
        ]
        run_checked_command(wrap_with_gpu_lock(part_command))


def main():
    options = parse_suite_arguments()
    scene_id = options["scene_id"]
    out_dir = options["output_directory"]
    scene_json_path = os.path.join(out_dir, "scenes", f"{scene_id}.json")
    parts_prefix = os.path.join(out_dir, "scenes", scene_id)
    ensure_scene_and_parts(options, scene_json_path, parts_prefix)
    ref_dir = os.path.join(out_dir, "reference")
    ladder_dir = os.path.join(out_dir, "ladder")
    os.makedirs(ref_dir, exist_ok=True)
    os.makedirs(ladder_dir, exist_ok=True)
    ref_seed_a = os.path.join(ref_dir, f"{scene_id}-cycles-{options['reference_samples']}-seed{options['seed_a']}")
    ref_seed_b = os.path.join(ref_dir, f"{scene_id}-cycles-{options['reference_samples']}-seed{options['seed_b']}")
    mode = options["mode"]
    if mode in ("all", "references"):
        cmd_a = build_cycles_command(options, scene_json_path, ref_seed_a, options["reference_samples"], options["seed_a"], True)
        run_measured_gpu_step(ref_seed_a, cmd_a, options["skip_existing"])
        cmd_b = build_cycles_command(options, scene_json_path, ref_seed_b, options["reference_samples"], options["seed_b"], True)
        run_measured_gpu_step(ref_seed_b, cmd_b, options["skip_existing"])
    cycles_prefixes = []
    native_prefixes = []
    for sample_count in options["ladder_samples"]:
        for repeat_index in range(1, options["repeats"] + 1):
            cycles_prefix = os.path.join(ladder_dir, f"{scene_id}-cycles-s{sample_count}-r{repeat_index}")
            native_prefix = os.path.join(ladder_dir, f"{scene_id}-native-s{sample_count}-r{repeat_index}")
            cycles_prefixes.append(cycles_prefix)
            native_prefixes.append(native_prefix)
            if mode in ("all", "ladder"):
                cycles_cmd = build_cycles_command(options, scene_json_path, cycles_prefix, sample_count, options["seed_a"], False)
                run_measured_gpu_step(cycles_prefix, cycles_cmd, options["skip_existing"])
                native_cmd = build_native_command(options, scene_json_path, native_prefix, sample_count, options["seed_a"])
                run_measured_gpu_step(native_prefix, native_cmd, options["skip_existing"])
    for extra_sample_count in options["native_extra_samples"]:
        for repeat_index in range(1, options["repeats"] + 1):
            extra_prefix = os.path.join(ladder_dir, f"{scene_id}-native-s{extra_sample_count}-r{repeat_index}")
            native_prefixes.append(extra_prefix)
            if mode in ("all", "ladder"):
                extra_cmd = build_native_command(options, scene_json_path, extra_prefix, extra_sample_count, options["seed_a"])
                run_measured_gpu_step(extra_prefix, extra_cmd, options["skip_existing"])
    highest_native_samples = max(options["ladder_samples"] + options["native_extra_samples"])
    detail_prefix = os.path.join(ladder_dir, f"{scene_id}-native-s{highest_native_samples}-r1")
    manifest_path = os.path.join(out_dir, f"{scene_id}-manifest.json")
    summary_path = os.path.join(out_dir, f"{scene_id}-summary.json")
    manifest = {
        "sceneId": scene_id,
        "referenceSeedAPrefix": ref_seed_a,
        "referenceSeedBPrefix": ref_seed_b,
        "cyclesLadderPrefixes": cycles_prefixes,
        "nativeLadderPrefixes": native_prefixes,
        "nativeDetailPrefix": detail_prefix,
        "partsPrefix": parts_prefix,
        "outputSummaryPath": summary_path,
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    if mode in ("all", "compare"):
        run_checked_command([
            "uv",
            "run",
            "--no-project",
            "--with",
            "numpy",
            "python",
            "bench/cycles-parity/compare.py",
            "suite",
            manifest_path,
        ])


if __name__ == "__main__":
    main()
