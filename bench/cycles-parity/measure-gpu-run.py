"""Execute one GPU benchmark command while recording wall time, peak process-tree RAM, and 50 ms polled VRAM."""
import json
import os
import re
import subprocess
import sys
import threading
import time

import psutil

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RAM_POLL_INTERVAL_SECONDS = 0.025
VRAM_POLL_INTERVAL_MILLISECONDS = 50
BLENDER_PEAK_PATTERN = re.compile(r"Peak\s+([0-9.]+)([KMGTP]?)", re.IGNORECASE)
BLENDER_FRA_PATTERN = re.compile(r"Fra:\d+.*\|\s*Time:(\d+):(\d+\.\d+)\s*\|\s*(.+)")
DESKTOP_SHELL_BINARIES = {
    "applicationframehost.exe",
    "cloudflare warp.exe",
    "discord.exe",
    "explorer.exe",
    "logioptionsplus_agent.exe",
    "msedgewebview2.exe",
    "oh-snap.exe",
    "powertoys.colorpickerui.exe",
    "powertoys.fancyzones.exe",
    "searchhost.exe",
    "shellexperiencehost.exe",
    "shellhost.exe",
    "startmenuexperiencehost.exe",
    "systemsettings.exe",
    "textinputhost.exe",
    "zalo.exe",
    "zalocall.exe",
}


def is_desktop_shell_process(process_name):
    basename = os.path.basename(process_name).lower()
    return basename in DESKTOP_SHELL_BINARIES


def parse_cli_arguments():
    if "--" not in sys.argv or len(sys.argv) < 4:
        raise ValueError("Usage: measure-gpu-run.py <metricsJsonPath> -- <command> [arguments...]")
    separator_index = sys.argv.index("--")
    metrics_path = os.path.abspath(sys.argv[1])
    command = sys.argv[separator_index + 1:]
    if not command:
        raise ValueError("Missing command after '--'.")
    return metrics_path, command


def query_gpu_snapshot():
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        check=False,
    )
    first_line = next((line.strip() for line in result.stdout.splitlines() if line.strip()), "")
    fields = [field.strip() for field in first_line.split(",")]
    if len(fields) < 4:
        return {
            "gpuName": "unknown",
            "usedMegabytes": 0.0,
            "totalMegabytes": 0.0,
            "utilizationPercent": 0.0,
        }
    return {
        "gpuName": fields[0],
        "usedMegabytes": float(fields[1]),
        "totalMegabytes": float(fields[2]),
        "utilizationPercent": float(fields[3]),
    }


def query_compute_processes():
    result = subprocess.run(
        ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        check=False,
    )
    entries = []
    for raw_line in result.stdout.splitlines():
        fields = [field.strip() for field in raw_line.split(",")]
        if len(fields) >= 2 and fields[0].isdigit():
            used_megabytes = float(fields[2]) if len(fields) >= 3 and fields[2].replace(".", "", 1).isdigit() else None
            entries.append({
                "pid": int(fields[0]),
                "processName": fields[1],
                "usedMegabytes": used_megabytes,
            })
    return entries


def start_vram_stream():
    stream_process = subprocess.Popen(
        [
            "nvidia-smi",
            "--query-gpu=memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
            "-lms",
            str(VRAM_POLL_INTERVAL_MILLISECONDS),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    samples = []
    first_sample_ready = threading.Event()

    def read_samples():
        assert stream_process.stdout is not None
        for raw_line in stream_process.stdout:
            fields = [field.strip() for field in raw_line.split(",")]
            if len(fields) >= 2:
                try:
                    used_value = float(fields[0])
                    utilization_value = float(fields[1])
                    samples.append((time.perf_counter(), used_value, utilization_value))
                    first_sample_ready.set()
                except ValueError:
                    continue

    reader_thread = threading.Thread(target=read_samples, daemon=True)
    reader_thread.start()
    first_sample_ready.wait(timeout=2.0)
    return stream_process, samples


def collect_process_tree(root_process):
    try:
        return [root_process] + root_process.children(recursive=True)
    except psutil.Error:
        return []


def parse_blender_stdout_metrics(output_lines):
    peak_megabytes = None
    first_render_time = None
    finished_time = None
    scale_by_unit = {"K": 1.0 / 1024.0, "M": 1.0, "": 1.0, "G": 1024.0, "T": 1024.0 * 1024.0}
    for line in output_lines:
        peak_match = BLENDER_PEAK_PATTERN.search(line)
        if peak_match:
            megabytes = float(peak_match.group(1)) * scale_by_unit.get(peak_match.group(2).upper(), 1.0)
            peak_megabytes = megabytes if peak_megabytes is None else max(peak_megabytes, megabytes)
        fra_match = BLENDER_FRA_PATTERN.search(line)
        if fra_match:
            minutes = int(fra_match.group(1))
            seconds = float(fra_match.group(2))
            stamp_seconds = minutes * 60.0 + seconds
            status_tail = fra_match.group(3)
            if "Rendering " in status_tail and first_render_time is None:
                first_render_time = stamp_seconds
            if "Finished" in status_tail or "Rendering " in status_tail:
                finished_time = stamp_seconds
    return {
        "stdoutPeakMegabytes": round(peak_megabytes, 2) if peak_megabytes is not None else None,
        "stdoutFirstRenderSeconds": round(first_render_time, 4) if first_render_time is not None else None,
        "stdoutFinishedSeconds": round(finished_time, 4) if finished_time is not None else None,
    }


def main():
    metrics_path, command = parse_cli_arguments()
    os.makedirs(os.path.dirname(metrics_path), exist_ok=True)
    pre_snapshot = query_gpu_snapshot()
    pre_compute_apps = query_compute_processes()
    smi_process, vram_samples = start_vram_stream()
    creation_flags = subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0
    captured_lines = []
    run_started = time.perf_counter()
    child_process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=creation_flags,
    )

    def forward_output():
        assert child_process.stdout is not None
        for line in child_process.stdout:
            captured_lines.append(line.rstrip("\r\n"))
            sys.stdout.write(line)
            sys.stdout.flush()

    output_thread = threading.Thread(target=forward_output, daemon=True)
    output_thread.start()
    psutil_root = psutil.Process(child_process.pid)
    peak_ram_bytes = 0
    tracked_pids = {child_process.pid}
    while child_process.poll() is None:
        members = collect_process_tree(psutil_root)
        tree_rss_bytes = 0
        for member in members:
            tracked_pids.add(member.pid)
            try:
                tree_rss_bytes += member.memory_info().rss
            except psutil.Error:
                continue
        peak_ram_bytes = max(peak_ram_bytes, tree_rss_bytes)
        time.sleep(RAM_POLL_INTERVAL_SECONDS)
    output_thread.join(timeout=5.0)
    wall_seconds = time.perf_counter() - run_started
    post_snapshot = query_gpu_snapshot()
    smi_process.terminate()
    try:
        smi_process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        smi_process.kill()
    post_compute_apps = query_compute_processes()
    window_samples = [(used_mb, util_pct) for stamp, used_mb, util_pct in vram_samples if stamp >= run_started]
    if not window_samples:
        window_samples = [(post_snapshot["usedMegabytes"], post_snapshot["utilizationPercent"])]
    peak_card_vram_mb = max(sample[0] for sample in window_samples)
    peak_gpu_utilization = max(sample[1] for sample in window_samples)
    baseline_vram_mb = pre_snapshot["usedMegabytes"]
    foreign_apps = [
        entry for entry in (pre_compute_apps + post_compute_apps)
        if entry["pid"] not in tracked_pids and not is_desktop_shell_process(entry["processName"])
    ]
    unique_foreign = {entry["pid"]: entry for entry in foreign_apps}
    gpu_exclusive = len(unique_foreign) == 0 and pre_snapshot["utilizationPercent"] < 15.0
    blender_stdout = parse_blender_stdout_metrics(captured_lines)
    report = {
        "command": command,
        "exitCode": child_process.returncode,
        "gpuName": pre_snapshot["gpuName"],
        "totalCardVramMegabytes": pre_snapshot["totalMegabytes"],
        "preRunGpuUtilizationPercent": pre_snapshot["utilizationPercent"],
        "postRunGpuUtilizationPercent": post_snapshot["utilizationPercent"],
        "wallSeconds": round(wall_seconds, 6),
        "peakRamMegabytes": round(peak_ram_bytes / (1024.0 * 1024.0), 2),
        "peakRamGigabytes": round(peak_ram_bytes / 1e9, 3),
        "baselineCardVramMegabytes": round(baseline_vram_mb, 2),
        "peakCardVramMegabytes": round(peak_card_vram_mb, 2),
        "peakVramDeltaMegabytes": round(max(0.0, peak_card_vram_mb - baseline_vram_mb), 2),
        "peakGpuUtilizationPercent": round(peak_gpu_utilization, 1),
        "vramSampleCount": len(window_samples),
        "gpuExclusive": gpu_exclusive,
        "foreignComputeProcesses": list(unique_foreign.values()),
        **blender_stdout,
    }
    with open(metrics_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print("GPU_RUN_METRICS " + json.dumps(report))
    sys.exit(child_process.returncode)


if __name__ == "__main__":
    main()
