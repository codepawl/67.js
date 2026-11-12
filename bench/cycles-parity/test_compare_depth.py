"""Unit tests for compare_depth.py on synthetic arrays. Run: uv run --no-project --with numpy python -m unittest bench/cycles-parity/test_compare_depth.py"""
import math
import os
import sys
import unittest

import numpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from compare_depth import DEPTH_AGREEMENT_GATE, compare_depth_maps, ray_distance_to_z_depth  # noqa: E402

HEIGHT = 32
WIDTH = 48


def flat_wall(z_depth):
    return numpy.full((HEIGHT, WIDTH), z_depth, dtype=numpy.float64)


class RayDistanceToZDepthTest(unittest.TestCase):
    def test_a_flat_wall_seen_as_ray_distance_becomes_constant_z(self):
        vertical_fov = 60.0
        wall_z = 5.0
        half_height_tangent = math.tan(math.radians(vertical_fov) / 2.0)
        horizontal = ((numpy.arange(WIDTH) + 0.5) / WIDTH * 2.0 - 1.0) * half_height_tangent * WIDTH / HEIGHT
        vertical = (1.0 - (numpy.arange(HEIGHT) + 0.5) / HEIGHT * 2.0) * half_height_tangent
        ray_distance = wall_z * numpy.sqrt(1.0 + horizontal[numpy.newaxis, :] ** 2 + vertical[:, numpy.newaxis] ** 2)
        converted = ray_distance_to_z_depth(ray_distance, vertical_fov)
        numpy.testing.assert_allclose(converted, wall_z, rtol=1e-12)

    def test_the_centre_pixels_barely_change_and_corners_shrink(self):
        converted = ray_distance_to_z_depth(flat_wall(10.0), 90.0)
        self.assertLess(converted[0, 0], converted[HEIGHT // 2, WIDTH // 2])
        self.assertAlmostEqual(converted[HEIGHT // 2, WIDTH // 2], 10.0, delta=0.05)

    def test_background_zero_stays_zero(self):
        self.assertEqual(float(ray_distance_to_z_depth(flat_wall(0.0), 60.0).max()), 0.0)


class CompareDepthMapsTest(unittest.TestCase):
    def test_identical_maps_agree_everywhere(self):
        result = compare_depth_maps(flat_wall(4.0), flat_wall(4.0))
        self.assertEqual(result["agreementFraction"], 1.0)
        self.assertTrue(result["depthPass"])
        self.assertEqual(result["disagreeingPixelCount"], 0)

    def test_a_constant_scale_beyond_the_tolerance_fails_and_shows_in_the_median(self):
        result = compare_depth_maps(flat_wall(4.0), flat_wall(4.0) * 1.05, relative_tolerance=0.01)
        self.assertEqual(result["agreementFraction"], 0.0)
        self.assertFalse(result["depthPass"])
        self.assertAlmostEqual(result["medianCandidateOverReference"], 1.05, places=9)
        self.assertEqual(result["agreementByTolerance"]["0.05"], 0.0)

    def test_a_scale_inside_the_tolerance_passes(self):
        result = compare_depth_maps(flat_wall(4.0), flat_wall(4.0) * 1.004, relative_tolerance=0.01)
        self.assertEqual(result["agreementFraction"], 1.0)

    def test_background_pixels_agree_when_both_miss_whatever_the_marker(self):
        reference = flat_wall(4.0)
        candidate = flat_wall(4.0)
        reference[:, :10] = 1.0e10
        candidate[:, :10] = 0.0
        result = compare_depth_maps(reference, candidate)
        self.assertEqual(result["agreementFraction"], 1.0)
        self.assertEqual(result["bothBackgroundCount"], 10 * HEIGHT)

    def test_a_pixel_missed_by_only_one_side_disagrees(self):
        reference = flat_wall(4.0)
        candidate = flat_wall(4.0)
        candidate[3, 7] = 0.0
        reference[5, 9] = 0.0
        result = compare_depth_maps(reference, candidate)
        self.assertEqual(result["disagreeingPixelCount"], 2)
        self.assertEqual(result["onlyReferenceHitCount"], 1)
        self.assertEqual(result["onlyCandidateHitCount"], 1)

    def test_non_finite_depth_counts_as_background(self):
        reference = flat_wall(4.0)
        candidate = flat_wall(4.0)
        reference[0, 0] = numpy.inf
        candidate[0, 0] = numpy.nan
        self.assertEqual(compare_depth_maps(reference, candidate)["agreementFraction"], 1.0)

    def test_the_gate_sits_at_99_9_percent(self):
        reference = flat_wall(4.0)
        candidate = flat_wall(4.0)
        disagreeing_count = int(HEIGHT * WIDTH * (1.0 - DEPTH_AGREEMENT_GATE)) + 1
        candidate.reshape(-1)[:disagreeing_count] = 8.0
        result = compare_depth_maps(reference, candidate)
        self.assertEqual(DEPTH_AGREEMENT_GATE, 0.999)
        self.assertEqual(result["disagreeingPixelCount"], disagreeing_count)
        self.assertFalse(result["depthPass"])

    def test_a_disagreeing_silhouette_is_counted_as_an_edge_pixel(self):
        reference = flat_wall(4.0)
        candidate = flat_wall(4.0)
        reference[:, 24:] = 12.0
        candidate[:, 24:] = 12.0
        candidate[10, 23] = 12.0
        result = compare_depth_maps(reference, candidate)
        self.assertEqual(result["disagreeingPixelCount"], 1)
        self.assertEqual(result["disagreeingEdgePixelCount"], 1)
        self.assertEqual(result["disagreeingInteriorPixelCount"], 0)

    def test_shape_mismatch_is_an_error(self):
        with self.assertRaises(ValueError):
            compare_depth_maps(flat_wall(1.0), numpy.ones((HEIGHT, WIDTH + 1)))


if __name__ == "__main__":
    unittest.main()
