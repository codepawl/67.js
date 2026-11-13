"""Finds the Cook native tracer and runs it as a subprocess. No bpy: usable and testable in plain Python."""
import json
import os
import shutil
import subprocess
import time

NATIVE_DIRECTORY_VARIABLE = "COOK_NATIVE_DIR"
TRACE_SCRIPT_PARTS = ("bench", "cycles-parity", "trace-native.mjs")
NATIVE_ADDON_PARTS = ("packages", "render-native", "build", "render-native.node")
POLL_SECONDS = 0.25
LOG_TAIL_CHARACTERS = 2000


class CookSetupError(RuntimeError):
    """The tracer cannot be started; the message says what to set."""


def resolve_native_directory(preference_value, environment=None):
    environment = os.environ if environment is None else environment
    candidate = (preference_value or "").strip() or environment.get(NATIVE_DIRECTORY_VARIABLE, "").strip()
    if not candidate:
        raise CookSetupError(
            f"Cook does not know where the native tracer is. Set 'Native tracer folder' in Preferences > Add-ons > Cook, "
            f"or set the {NATIVE_DIRECTORY_VARIABLE} environment variable, to a 67js checkout whose packages/render-native is built."
        )
    directory = os.path.abspath(os.path.expanduser(candidate))
    for parts, fix in ((TRACE_SCRIPT_PARTS, "Point it at the root of a 67js checkout."),
                       (NATIVE_ADDON_PARTS, "Build it with: cd packages/render-native && node build.mjs")):
        missing = os.path.join(directory, *parts)
        if not os.path.isfile(missing):
            raise CookSetupError(f"The native tracer folder {directory} has no {'/'.join(parts)}. {fix}")
    return directory


def resolve_node_executable(preference_value):
    requested = (preference_value or "").strip() or "node"
    found = shutil.which(requested)
    if found is None:
        raise CookSetupError(f"Cook could not run '{requested}'. Install Node 20.19 or later, or set 'Node executable' in the Cook add-on preferences to its full path.")
    return found


def lens_arguments(lens_entry):
    if not lens_entry.get("enabled"):
        return []
    return [
        "--f-stop", str(lens_entry["fStop"]),
        "--focus-distance", str(max(lens_entry["focusDistance"], 0.001)),
        "--aperture-blades", str(int(lens_entry["apertureBlades"])),
        "--aperture-rotation", str(lens_entry["apertureRotation"]),
        "--sensor-width", str(lens_entry["sensorWidth"]),
    ]


def environment_cap_argument(environment_cap):
    """0 means no cap on the environment image; a positive number caps each texel at that radiance."""
    if environment_cap < 0:
        raise ValueError(f"The environment cap must be 0 (no cap) or a positive radiance, got {environment_cap}.")
    return "none" if environment_cap == 0 else str(environment_cap)


def build_trace_command(node_executable, native_directory, scene_path, output_prefix, options):
    """`options` holds width, height, samples, bounces, seed, filter_type, filter_width and lens (the lens entry of the export)."""
    for name in ("width", "height", "samples", "bounces", "seed", "filter_type", "filter_width"):
        if name not in options:
            raise KeyError(f"build_trace_command needs the option '{name}'.")
    return [
        node_executable,
        os.path.join(native_directory, *TRACE_SCRIPT_PARTS),
        scene_path,
        output_prefix,
        "--kernel", "cycles",
        "--instancing",
        "--write-depth",
        "--width", str(options["width"]),
        "--height", str(options["height"]),
        "--samples", str(options["samples"]),
        "--bounces", str(options["bounces"]),
        "--seed", str(options["seed"]),
        "--filter-type", options["filter_type"],
        "--filter-width", str(options["filter_width"]),
        "--hdri-radiance-limit", environment_cap_argument(options.get("environment_cap", 0.0)),
        *lens_arguments(options.get("lens", {})),
    ]


def run_with_cancel(command, working_directory, log_path, should_cancel):
    """Runs the command, writing its output to log_path. Returns (exit code, seconds); stops the process if should_cancel() turns true."""
    started = time.perf_counter()
    with open(log_path, "wb") as log_handle:
        process = subprocess.Popen(command, cwd=working_directory, stdout=log_handle, stderr=subprocess.STDOUT)
        while True:
            try:
                exit_code = process.wait(timeout=POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                if should_cancel():
                    process.terminate()
                    exit_code = process.wait()
                    break
    return exit_code, time.perf_counter() - started


def read_log_tail(log_path):
    with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()[-LOG_TAIL_CHARACTERS:]


def read_trace_report(output_prefix):
    with open(f"{output_prefix}.json", "r", encoding="utf-8") as handle:
        return json.load(handle)
