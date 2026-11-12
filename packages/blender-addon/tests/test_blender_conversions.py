"""Checks for the parts of the add-on that need no Blender. Run from the repository root:

  uv run --no-project --with numpy python -m unittest discover -s packages/blender-addon/tests -p "test_blender_conversions.py"
"""
import math
import os
import sys
import tempfile
import unittest

import numpy

ADDON_PARENT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, ADDON_PARENT)

from cook_blender import blender_conversions as conversions  # noqa: E402
from cook_blender import native_runner  # noqa: E402

IDENTITY_ROWS = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def decode_rgbe(data, width, height):
    """The same decoding as src/hdri.js for an uncompressed file."""
    rows = numpy.frombuffer(data, dtype=numpy.uint8).reshape(height, width, 4).astype(numpy.float64)
    scale = numpy.where(rows[..., 3] == 0, 0.0, 2.0 ** (rows[..., 3] - 136.0))
    return rows[..., :3] * scale[..., None]


class CoordinateTests(unittest.TestCase):
    def test_blender_up_becomes_y_up(self):
        self.assertEqual(conversions.to_yup((1.0, 2.0, 3.0)), [1.0, 3.0, -2.0])

    def test_translation_matrix_is_column_major_in_y_up(self):
        matrix = [row[:] for row in IDENTITY_ROWS]
        matrix[0][3], matrix[1][3], matrix[2][3] = 1.0, 2.0, 3.0
        flat = conversions.column_major_yup_matrix(matrix)
        self.assertEqual(flat[12:15], [1.0, 3.0, -2.0])
        self.assertEqual(flat[15], 1.0)

    def test_field_of_view_uses_the_sensor_fit(self):
        wide = conversions.effective_horizontal_sensor_width("AUTO", 36.0, 24.0, 1920, 1080)
        tall = conversions.effective_horizontal_sensor_width("AUTO", 36.0, 24.0, 1080, 1920)
        self.assertEqual(wide, 36.0)
        self.assertAlmostEqual(tall, 24.0 * 1080 / 1920)
        self.assertAlmostEqual(conversions.vertical_fov_degrees(36.0, 18.0, 1000, 1000), 90.0)


class LightTests(unittest.TestCase):
    def test_point_and_area_watts_become_intensity(self):
        point = conversions.point_light_entry([0, 0, 0], [1, 1, 1], 4.0 * math.pi * 10.0, 0.1)
        self.assertAlmostEqual(point["intensity"], 10.0)
        area = conversions.area_light_entry([0, 0, 0], [1, 1, 1], math.pi * 5.0, [0, -1, 0], [0, 0, 1], "SQUARE", 2.0, 9.0, 3.0, 4.0, math.pi)
        self.assertAlmostEqual(area["intensity"], 5.0)
        self.assertEqual((area["width"], area["height"]), (6.0, 8.0))
        self.assertEqual(area["up"], [-0.0, -0.0, -1.0])

    def test_sun_points_toward_the_light(self):
        sun = conversions.sun_environment_fields([1.0, 0.5, 0.0], 3.0, [0.0, -1.0, 0.0], 0.1)
        self.assertEqual(sun["lightDirection"], [-0.0, 1.0, -0.0])
        self.assertEqual(sun["keyColor"], [3.0, 1.5, 0.0])
        self.assertAlmostEqual(sun["sunAngularRadius"], 0.05)


class AreaLightScaleTests(unittest.TestCase):
    def build(self, shape, scale_x, scale_y):
        return conversions.area_light_entry([0, 0, 0], [1, 1, 1], 10.0, [0, -1, 0], [0, 0, 1], shape, 2.0, 5.0, scale_x, scale_y, math.pi)

    def test_square_strip_light_keeps_its_y_scale(self):
        strip = self.build("SQUARE", 4.0, 1.0)
        self.assertEqual((strip["width"], strip["height"]), (8.0, 2.0))

    def test_disk_uses_both_scales_and_rectangle_uses_its_second_size(self):
        disk = self.build("DISK", 2.0, 3.0)
        self.assertEqual((disk["width"], disk["height"]), (4.0, 6.0))
        rectangle = self.build("RECTANGLE", 2.0, 3.0)
        self.assertEqual((rectangle["width"], rectangle["height"]), (4.0, 15.0))


class ColorSpaceTests(unittest.TestCase):
    def test_names_are_sorted_into_srgb_linear_or_unknown(self):
        for name in ("sRGB", "sRGB EOTF"):
            self.assertEqual(conversions.classify_color_space(name), "srgb")
        for name in ("Non-Color", "Raw", "Linear Rec.709", "Linear CIE-XYZ E", "scene linear"):
            self.assertEqual(conversions.classify_color_space(name), "linear")
        for name in ("Filmic Log", "AgX Base sRGB", "Khronos PBR Neutral sRGB"):
            self.assertIsNone(conversions.classify_color_space(name), name)

    def test_srgb_decode_matches_the_standard_curve(self):
        decoded = conversions.srgb_to_linear(numpy.array([0.0, 0.04045, 0.5, 1.0]))
        self.assertAlmostEqual(float(decoded[0]), 0.0)
        self.assertAlmostEqual(float(decoded[1]), 0.04045 / 12.92)
        self.assertAlmostEqual(float(decoded[2]), 0.21404, places=4)
        self.assertAlmostEqual(float(decoded[3]), 1.0)


class LightNoteTests(unittest.TestCase):
    def test_plain_light_has_no_notes(self):
        self.assertEqual(conversions.light_feature_notes("Lamp", "POINT", False, True, 1.0, 1.0, False), [])

    def test_each_unread_feature_is_named(self):
        notes = conversions.light_feature_notes("Lamp", "POINT", True, False, 0.5, 1.0, True)
        self.assertEqual(len(notes), 4)
        self.assertTrue(any("blackbody" in note for note in notes))
        self.assertTrue(any("shadows off" in note for note in notes))


class DepthTests(unittest.TestCase):
    def test_centre_keeps_distance_and_corners_shorten_it(self):
        ray_distance = numpy.full((3, 3), 10.0, dtype=numpy.float32)
        ray_distance[0, 0] = 0.0
        depth = conversions.z_depth_from_ray_distance(ray_distance, 1.0, 1.0)
        self.assertAlmostEqual(float(depth[1, 1]), 10.0)
        self.assertLess(float(depth[2, 2]), 10.0)
        self.assertEqual(float(depth[0, 0]), 1.0e10)


class HdrTests(unittest.TestCase):
    def test_rgbe_round_trip_is_close(self):
        source = numpy.array([[[0.0, 0.0, 0.0], [1.0, 0.5, 0.25]], [[30.0, 26.0, 20.0], [0.01, 0.02, 0.03]]], dtype=numpy.float32)
        decoded = decode_rgbe(conversions.rgbe_bytes(source), 2, 2)
        # RGBE keeps an 8-bit mantissa per channel relative to the pixel's brightest channel.
        brightest = source.max(axis=2, keepdims=True)
        error_against_brightest = numpy.abs(decoded - source) / numpy.maximum(brightest, 1e-6)
        self.assertTrue(numpy.all(error_against_brightest < 1.0 / 128.0))
        self.assertTrue(numpy.all(decoded[source == 0] == 0))

    def test_file_has_the_radiance_header(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sky.hdr")
            conversions.write_radiance_hdr(path, numpy.ones((4, 8, 3), dtype=numpy.float32))
            with open(path, "rb") as handle:
                content = handle.read()
        self.assertTrue(content.startswith(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n"))
        self.assertEqual(len(content), len(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n") + 4 * 8 * 4)

    def test_environment_is_flipped_and_turned_a_quarter(self):
        rows = numpy.zeros((2, 8, 3), dtype=numpy.float32)
        rows[0, 2] = 1.0  # bottom row, column 2
        turned = conversions.blender_environment_to_cook_rows(rows)
        self.assertEqual(float(turned[1, 4, 0]), 1.0)  # now the last row, moved 8 // 4 = 2 columns on
        self.assertEqual(float(turned.sum()), 3.0)


class NativeRunnerTests(unittest.TestCase):
    def test_missing_directory_names_both_ways_to_set_it(self):
        with self.assertRaises(native_runner.CookSetupError) as caught:
            native_runner.resolve_native_directory("", environment={})
        self.assertIn("COOK_NATIVE_DIR", str(caught.exception))
        self.assertIn("Preferences", str(caught.exception))

    def test_unbuilt_checkout_says_how_to_build(self):
        with tempfile.TemporaryDirectory() as directory:
            script_directory = os.path.join(directory, *native_runner.TRACE_SCRIPT_PARTS[:-1])
            os.makedirs(script_directory)
            open(os.path.join(script_directory, native_runner.TRACE_SCRIPT_PARTS[-1]), "w").close()
            with self.assertRaises(native_runner.CookSetupError) as caught:
                native_runner.resolve_native_directory(directory, environment={})
        self.assertIn("node build.mjs", str(caught.exception))

    def test_environment_variable_is_the_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            for parts in (native_runner.TRACE_SCRIPT_PARTS, native_runner.NATIVE_ADDON_PARTS):
                os.makedirs(os.path.join(directory, *parts[:-1]), exist_ok=True)
                open(os.path.join(directory, *parts), "w").close()
            resolved = native_runner.resolve_native_directory("", environment={"COOK_NATIVE_DIR": directory})
            self.assertEqual(resolved, os.path.abspath(directory))

    def test_command_carries_every_option_and_the_lens(self):
        options = {"width": 480, "height": 270, "samples": 64, "bounces": 8, "seed": 3, "filter_type": "box", "filter_width": 1.0}
        command = native_runner.build_trace_command("node", "/repo", "scene.json", "out", options)
        self.assertEqual(command[0], "node")
        for flag, value in (("--samples", "64"), ("--width", "480"), ("--filter-type", "box"), ("--kernel", "cycles")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--instancing", command)
        self.assertNotIn("--f-stop", command)
        options["lens"] = {"enabled": True, "fStop": 2.8, "focusDistance": 5.0, "apertureBlades": 0, "apertureRotation": 0.0, "sensorWidth": 36.0}
        with_lens = native_runner.build_trace_command("node", "/repo", "scene.json", "out", options)
        self.assertEqual(with_lens[with_lens.index("--f-stop") + 1], "2.8")

    def test_environment_cap_is_off_by_default_and_a_number_when_set(self):
        options = {"width": 4, "height": 4, "samples": 1, "bounces": 1, "seed": 0, "filter_type": "box", "filter_width": 1.0}
        command = native_runner.build_trace_command("node", "/repo", "scene.json", "out", options)
        self.assertEqual(command[command.index("--hdri-radiance-limit") + 1], "none")
        command = native_runner.build_trace_command("node", "/repo", "scene.json", "out", {**options, "environment_cap": 16.0})
        self.assertEqual(command[command.index("--hdri-radiance-limit") + 1], "16.0")
        with self.assertRaises(ValueError):
            native_runner.build_trace_command("node", "/repo", "scene.json", "out", {**options, "environment_cap": -1.0})

    def test_missing_option_is_named(self):
        with self.assertRaises(KeyError):
            native_runner.build_trace_command("node", "/repo", "scene.json", "out", {"width": 1})


class NoteTests(unittest.TestCase):
    def test_a_note_is_kept_once(self):
        notes = {}
        conversions.note_once(notes, "Clay", "Roughness is procedural")
        conversions.note_once(notes, "Clay", "Roughness is procedural")
        conversions.note_once(notes, "Clay", "Sheen is set")
        self.assertEqual(notes, {"Clay": ["Roughness is procedural", "Sheen is set"]})


if __name__ == "__main__":
    unittest.main()
