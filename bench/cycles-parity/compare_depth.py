"""Compare a Cook depth buffer with a Cycles camera Z depth: the share of pixels that agree within a relative tolerance.

Conventions (found in the code, not assumed):
- Cycles writes the Z depth: distance along the camera's view axis. render-cycles.py --z-depth writes it as <prefix>-depth.npy.
- Cook's depth buffer is the first-hit distance along the unit ray direction (integrator.wgsl first_depth = surface_hit.t,
  camera.wgsl normalises the direction). trace-native.mjs --write-depth writes it as <prefix>-depth.npy and records
  depthConvention "ray-distance" and cameraVerticalFovDegrees in its JSON.
This module converts the Cook side to Z depth: z = distance * cos(angle between the pixel's ray and the view axis).
- Both write 0 where nothing is hit, and the pixel value is the mean over the samples (misses count as 0), so a pixel on a
  silhouette holds a coverage-weighted mean in both renderers.
"""
import json
import math
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEPTH_AGREEMENT_GATE = 0.999
DEFAULT_RELATIVE_TOLERANCE = 0.01
REPORTED_TOLERANCES = (0.001, 0.005, 0.01, 0.05)
BACKGROUND_DEPTH_LIMIT = 1.0e9
EDGE_RELATIVE_JUMP = 0.05


def ray_distance_to_z_depth(ray_distance, vertical_fov_degrees):
    """Converts distance along each pixel-centre ray into distance along the view axis (symmetric perspective camera)."""
    height, width = ray_distance.shape
    half_height_tangent = math.tan(math.radians(vertical_fov_degrees) / 2.0)
    half_width_tangent = half_height_tangent * width / height
    horizontal = ((numpy.arange(width) + 0.5) / width * 2.0 - 1.0) * half_width_tangent
    vertical = (1.0 - (numpy.arange(height) + 0.5) / height * 2.0) * half_height_tangent
    cosine_to_axis = 1.0 / numpy.sqrt(1.0 + horizontal[numpy.newaxis, :] ** 2 + vertical[:, numpy.newaxis] ** 2)
    return ray_distance.astype(numpy.float64) * cosine_to_axis


def hit_mask_of(depth):
    return numpy.isfinite(depth) & (depth > 0.0) & (depth < BACKGROUND_DEPTH_LIMIT)


def mark_edges(reference_depth, candidate_depth, reference_hit, candidate_hit):
    """Pixels whose 8-neighbourhood holds a hit/miss change or a depth jump over 5 percent in either image."""
    edge = numpy.zeros(reference_depth.shape, dtype=bool)
    for depth, hit in ((reference_depth, reference_hit), (candidate_depth, candidate_hit)):
        for row_shift in (-1, 0, 1):
            for column_shift in (-1, 0, 1):
                if row_shift == 0 and column_shift == 0:
                    continue
                shifted_depth = numpy.roll(depth, (row_shift, column_shift), axis=(0, 1))
                shifted_hit = numpy.roll(hit, (row_shift, column_shift), axis=(0, 1))
                both = hit & shifted_hit
                jump = both & (numpy.abs(depth - shifted_depth) > EDGE_RELATIVE_JUMP * numpy.maximum(depth, 1e-12))
                edge |= jump | (hit != shifted_hit)
    return edge


def agreement_at(reference_depth, candidate_depth, reference_hit, candidate_hit, relative_tolerance):
    both_hit = reference_hit & candidate_hit
    both_background = ~reference_hit & ~candidate_hit
    close = both_hit & (numpy.abs(candidate_depth - reference_depth) <= relative_tolerance * reference_depth)
    return close | both_background


def compare_depth_maps(reference_z_depth, candidate_z_depth, relative_tolerance=DEFAULT_RELATIVE_TOLERANCE):
    """Both arguments are (height, width) Z depths, 0 or non-finite or huge where nothing is hit. Gate: DEPTH_AGREEMENT_GATE."""
    if reference_z_depth.shape != candidate_z_depth.shape or reference_z_depth.ndim != 2:
        raise ValueError(f"Depth maps must be two-dimensional and equal in shape, got {reference_z_depth.shape} and {candidate_z_depth.shape}.")
    reference = reference_z_depth.astype(numpy.float64)
    candidate = candidate_z_depth.astype(numpy.float64)
    reference_hit = hit_mask_of(reference)
    candidate_hit = hit_mask_of(candidate)
    reference = numpy.where(reference_hit, reference, 0.0)
    candidate = numpy.where(candidate_hit, candidate, 0.0)
    total_pixels = reference.size
    both_hit = reference_hit & candidate_hit
    agree = agreement_at(reference, candidate, reference_hit, candidate_hit, relative_tolerance)
    edge = mark_edges(reference, candidate, reference_hit, candidate_hit)
    relative_error = numpy.abs(candidate[both_hit] - reference[both_hit]) / reference[both_hit]
    ratio = candidate[both_hit] / reference[both_hit]
    agreement_fraction = float(agree.sum()) / total_pixels
    interior = ~edge
    result = {
        "relativeTolerance": relative_tolerance,
        "agreementFraction": agreement_fraction,
        "gate": DEPTH_AGREEMENT_GATE,
        "depthPass": bool(agreement_fraction >= DEPTH_AGREEMENT_GATE),
        "totalPixelCount": int(total_pixels),
        "disagreeingPixelCount": int(total_pixels - agree.sum()),
        "bothHitCount": int(both_hit.sum()),
        "bothBackgroundCount": int((~reference_hit & ~candidate_hit).sum()),
        "onlyReferenceHitCount": int((reference_hit & ~candidate_hit).sum()),
        "onlyCandidateHitCount": int((~reference_hit & candidate_hit).sum()),
        "agreementByTolerance": {str(tolerance): float(agreement_at(reference, candidate, reference_hit, candidate_hit, tolerance).sum()) / total_pixels for tolerance in REPORTED_TOLERANCES},
        "edgePixelCount": int(edge.sum()),
        "disagreeingEdgePixelCount": int((~agree & edge).sum()),
        "disagreeingInteriorPixelCount": int((~agree & interior).sum()),
        "agreementFractionAwayFromEdges": float((agree & interior).sum()) / max(int(interior.sum()), 1),
        "medianCandidateOverReference": float(numpy.median(ratio)) if ratio.size else None,
        "p99RelativeError": float(numpy.percentile(relative_error, 99)) if relative_error.size else None,
        "maxRelativeError": float(relative_error.max()) if relative_error.size else None,
    }
    return result


def run_cli(argument_list):
    if len(argument_list) < 3 or argument_list[0].startswith("--"):
        raise ValueError("Usage: compare_depth.py <cyclesZDepth.npy> <cookRayDistanceDepth.npy> <verticalFovDegrees> [--tolerance 0.01] [--json-out <path>]")
    tolerance = float(argument_list[argument_list.index("--tolerance") + 1]) if "--tolerance" in argument_list else DEFAULT_RELATIVE_TOLERANCE
    reference = numpy.load(argument_list[0])
    cook_ray_distance = numpy.load(argument_list[1])
    comparison = compare_depth_maps(reference, ray_distance_to_z_depth(cook_ray_distance, float(argument_list[2])), tolerance)
    print(json.dumps(comparison))
    if "--json-out" in argument_list:
        with open(argument_list[argument_list.index("--json-out") + 1], "w", encoding="utf-8") as handle:
            json.dump(comparison, handle, indent=2)


if __name__ == "__main__":
    run_cli(sys.argv[1:])
