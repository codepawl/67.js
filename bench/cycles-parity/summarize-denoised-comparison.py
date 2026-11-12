"""Turns the rows of the denoised comparison run into a Markdown table and the equal-time reading.

    uv run --no-project python bench/cycles-parity/summarize-denoised-comparison.py <rows.json>

One row per scene, sample count and variant: median sampling seconds, median denoise seconds, total, relMSE (epsilon 0.01) and
mean ratio (medians over rounds; the images are the same in every round, only the timing moves), and FLIP (LDR) from round 1.
The equal-time lines pick, per scene, the cheapest sample count of each renderer's best denoised variant that reaches a
given total-seconds budget and compare the relMSE at that budget by linear interpolation in log-log.
"""
import json
import math
import statistics
import sys

VARIANT_ORDER = ["cook-raw", "cook-atrous", "cook-oidn-cuda", "cook-oidn-cpu", "cycles-raw", "cycles-oidn"]


def median_of(values):
    values = [value for value in values if value is not None]
    return statistics.median(values) if values else None


def settle_cycles_denoise_seconds(rows):
    """Cycles denoises inside its render call, so there is no separate timer. The denoise seconds of a denoised render are
    the time it spends from the first sample to the end of the call, minus the same time of the raw render of the same
    rung and round; its sampling seconds are those of that raw render."""
    raw_rows = {(row["scene"], row["samples"], row["round"]): row for row in rows if row.get("variant") == "cycles-raw" and "relMse" in row}
    settled = []
    for row in rows:
        if row.get("variant") == "cycles-oidn" and "relMse" in row:
            raw = raw_rows[(row["scene"], row["samples"], row["round"])]
            render_seconds = row["samplingSeconds"] + row["secondsAfterLastSample"]
            raw_render_seconds = raw["samplingSeconds"] + raw["secondsAfterLastSample"]
            row = {**row, "samplingSeconds": raw["samplingSeconds"], "denoiseSeconds": max(0.0, render_seconds - raw_render_seconds)}
        settled.append(row)
    return settled


def build_table(rows):
    rows = settle_cycles_denoise_seconds(rows)
    groups = {}
    for row in rows:
        if "relMse" not in row:
            continue
        key = (row["scene"], row["samples"], row["variant"])
        groups.setdefault(key, []).append(row)
    table = {}
    for key, group in groups.items():
        table[key] = {
            "sampling": median_of([row["samplingSeconds"] for row in group]),
            "denoise": median_of([row["denoiseSeconds"] for row in group]),
            "relMse": median_of([row["relMse"] for row in group]),
            "meanRatio": median_of([row["meanRatio"] for row in group]),
            "flip": median_of([row.get("flip") for row in group]),
            "rounds": len(group),
        }
        table[key]["total"] = table[key]["sampling"] + table[key]["denoise"]
    return table


def interpolate_error_at(points, seconds):
    """relMSE at a total-seconds budget, log-log between the two nearest measured rungs; None outside the measured range."""
    ordered = sorted(points)
    for (low_seconds, low_error), (high_seconds, high_error) in zip(ordered, ordered[1:]):
        if low_seconds <= seconds <= high_seconds:
            fraction = (math.log(seconds) - math.log(low_seconds)) / (math.log(high_seconds) - math.log(low_seconds))
            return math.exp(math.log(low_error) + fraction * (math.log(high_error) - math.log(low_error)))
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    with open(sys.argv[1], encoding="utf-8") as handle:
        rows = json.load(handle)
    table = build_table(rows)
    scenes = sorted({key[0] for key in table})
    print("| scene | spp | variant | sampling s | denoise s | total s | relMSE | FLIP | mean ratio |")
    print("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for scene in scenes:
        for samples in sorted({key[1] for key in table if key[0] == scene}):
            for variant in VARIANT_ORDER:
                entry = table.get((scene, samples, variant))
                if not entry:
                    continue
                flip = "" if entry["flip"] is None else f"{entry['flip']:.3f}"
                print(f"| {scene} | {samples} | {variant} | {entry['sampling']:.2f} | {entry['denoise']:.2f} | {entry['total']:.2f} | "
                      f"{entry['relMse']:.3g} | {flip} | {entry['meanRatio']:.3f} |")
    print()
    print("Equal total seconds (relMSE interpolated log-log between measured rungs):")
    for scene in scenes:
        curves = {}
        for variant in VARIANT_ORDER:
            points = [(table[key]["total"], table[key]["relMse"]) for key in table if key[0] == scene and key[2] == variant]
            if len(points) >= 2:
                curves[variant] = points
        for budget_variant, other_variant in (("cook-oidn-cuda", "cycles-oidn"), ("cook-atrous", "cycles-oidn"), ("cook-raw", "cycles-raw")):
            if budget_variant not in curves or other_variant not in curves:
                continue
            low = max(min(seconds for seconds, _ in curves[budget_variant]), min(seconds for seconds, _ in curves[other_variant]))
            high = min(max(seconds for seconds, _ in curves[budget_variant]), max(seconds for seconds, _ in curves[other_variant]))
            if low >= high:
                print(f"- {scene}: {budget_variant} and {other_variant} share no total-seconds range.")
                continue
            budget = math.sqrt(low * high)
            first = interpolate_error_at(curves[budget_variant], budget)
            second = interpolate_error_at(curves[other_variant], budget)
            print(f"- {scene} at {budget:.1f} s: {budget_variant} relMSE {first:.3g}, {other_variant} relMSE {second:.3g} (ratio {first / second:.2f})")


if __name__ == "__main__":
    main()
