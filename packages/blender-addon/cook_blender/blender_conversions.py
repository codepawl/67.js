"""Blender to Cook conversions that need no bpy: coordinates, camera, light units, depth and the Radiance HDR writer.

Only `math` is imported at module level, so the unit tests in tests/test_blender_conversions.py run in plain Python
(numpy is imported inside the functions that need arrays).
"""
import math

WATTS_PER_POINT_INTENSITY = 4.0 * math.pi
WATTS_PER_AREA_INTENSITY = math.pi
HDR_RADIANCE_LIMIT = 60000.0
# Blender is Z up, Cook is Y up: (x, y, z) becomes (x, z, -y). Row-major 4x4.
BLENDER_TO_YUP_ROWS = (
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
)
AREA_SHAPES = {"SQUARE": "rectangle", "RECTANGLE": "rectangle", "DISK": "disk", "ELLIPSE": "ellipse"}
LUMINANCE_WEIGHTS = (0.2126, 0.7152, 0.0722)


def to_yup(vector):
    return [float(vector[0]), float(vector[2]), float(-vector[1])]


def column_major_yup_matrix(blender_matrix_rows):
    """Takes four rows of four numbers (a Blender world matrix) and returns Cook's 16 numbers, column by column."""
    product = [
        [sum(BLENDER_TO_YUP_ROWS[row][inner] * blender_matrix_rows[inner][column] for inner in range(4)) for column in range(4)]
        for row in range(4)
    ]
    return [float(product[row][column]) for column in range(4) for row in range(4)]


def effective_horizontal_sensor_width(sensor_fit, sensor_width, sensor_height, width, height):
    fit = sensor_fit
    if fit == "AUTO":
        fit = "HORIZONTAL" if width >= height else "VERTICAL"
    if fit == "HORIZONTAL":
        return sensor_width
    return sensor_height * width / height


def vertical_fov_degrees(horizontal_sensor_width, lens_millimetres, width, height):
    half_tangent_x = horizontal_sensor_width / (2.0 * lens_millimetres)
    half_tangent_y = half_tangent_x * height / width
    return math.degrees(2.0 * math.atan(half_tangent_y))


def sun_environment_fields(color, energy, emission_direction, angle):
    toward_light = [-component for component in emission_direction]
    return {
        "keyColor": [channel * energy for channel in color],
        "lightDirection": toward_light,
        "sunAngularRadius": angle / 2.0,
    }


def point_light_entry(position, color, energy, radius):
    return {"position": position, "color": color, "intensity": energy / WATTS_PER_POINT_INTENSITY, "radius": radius}


def spot_light_entry(position, color, energy, radius, emission_direction, spot_size, spot_blend):
    entry = point_light_entry(position, color, energy, radius)
    entry["direction"] = emission_direction
    entry["angle"] = spot_size / 2.0
    entry["penumbra"] = spot_blend
    return entry


def area_light_entry(position, color, energy, emission_direction, local_up, shape, size, size_y, scale_x, scale_y, spread):
    width_value = size * abs(scale_x)
    height_value = (size if shape in ("SQUARE", "DISK") else size_y) * abs(scale_y)
    return {
        "position": position,
        "color": color,
        "intensity": energy / WATTS_PER_AREA_INTENSITY,
        "width": width_value,
        "height": height_value,
        "direction": emission_direction,
        "up": [-component for component in local_up],
        "shape": AREA_SHAPES[shape],
        "spread": max(0.0001, min(math.pi, spread)),
    }


def z_depth_from_ray_distance(ray_distance, field_of_view_horizontal_tangent, field_of_view_vertical_tangent, missing_value=1.0e10):
    """Converts the tracer's distance along each ray into Blender's Z (distance along the view axis).

    `ray_distance` is a (height, width) array, 0 where the ray missed. The tangents are the half-field-of-view tangents of the
    pinhole camera. A miss becomes `missing_value`, which is what Cycles writes to Z for background pixels."""
    import numpy

    height, width = ray_distance.shape
    column_offsets = ((numpy.arange(width) + 0.5) / width * 2.0 - 1.0) * field_of_view_horizontal_tangent
    row_offsets = (1.0 - (numpy.arange(height) + 0.5) / height * 2.0) * field_of_view_vertical_tangent
    direction_length = numpy.sqrt(1.0 + row_offsets[:, None] ** 2 + column_offsets[None, :] ** 2)
    depth = ray_distance / direction_length
    return numpy.where(ray_distance > 0.0, depth, missing_value).astype(numpy.float32)


def rgbe_bytes(linear_rgb):
    """Packs a (height, width, 3) float array into Radiance RGBE bytes, one flat scanline after the other."""
    import numpy

    positive = numpy.maximum(linear_rgb.astype(numpy.float64), 0.0)
    brightest = positive.max(axis=2)
    mantissa, exponent = numpy.frexp(brightest)
    safe_brightest = numpy.where(brightest > 1e-32, brightest, 1.0)
    scale = numpy.where(brightest > 1e-32, mantissa * 256.0 / safe_brightest, 0.0)
    packed = numpy.zeros(positive.shape[:2] + (4,), dtype=numpy.uint8)
    packed[..., :3] = numpy.clip(positive * scale[..., None], 0, 255).astype(numpy.uint8)
    packed[..., 3] = numpy.where(brightest > 1e-32, exponent + 128, 0).astype(numpy.uint8)
    return packed.tobytes()


def write_radiance_hdr(path, linear_rgb_top_first):
    """Writes an uncompressed .hdr, which the Cook loader reads. The array has its first row at the top."""
    height, width, _ = linear_rgb_top_first.shape
    header = f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n".encode("ascii")
    with open(path, "wb") as handle:
        handle.write(header)
        handle.write(rgbe_bytes(linear_rgb_top_first))


def light_feature_notes(light_name, light_type, use_temperature, use_shadow, diffuse_factor, specular_factor, uses_nodes):
    """What a light carries that Cook does not read, one sentence each."""
    notes = []
    if use_temperature:
        notes.append(f"light {light_name} uses a blackbody temperature; Cook uses its plain colour")
    if not use_shadow:
        notes.append(f"light {light_name} has shadows off; Cook casts them")
    if abs(diffuse_factor - 1.0) > 1e-6 or abs(specular_factor - 1.0) > 1e-6:
        notes.append(f"light {light_name} has a diffuse or specular factor other than 1; Cook ignores the factors")
    if uses_nodes:
        notes.append(f"light {light_name} has a node tree; Cook ignores it")
    return notes


def blender_environment_to_cook_rows(linear_rgb_bottom_first):
    """Re-orients a Blender equirectangular image (first row at the bottom) for Cook: rows top first, turned a quarter.

    Blender puts the +X direction at the horizontal centre of the image; Cook puts +Y (Blender axes) there. A quarter of the
    width turns one into the other."""
    import numpy

    top_first = linear_rgb_bottom_first[::-1]
    return numpy.roll(top_first, top_first.shape[1] // 4, axis=1)


def classify_color_space(name):
    """'srgb', 'linear', or None for a colour space Cook has no decoder for (the caller reports it)."""
    lowered = name.lower()
    if lowered == "srgb" or lowered.startswith("srgb "):
        return "srgb"
    if lowered in ("non-color", "raw") or lowered.startswith("linear") or lowered.startswith("scene linear"):
        return "linear"
    return None


def srgb_to_linear(encoded):
    import numpy

    return numpy.where(encoded <= 0.04045, encoded / 12.92, ((encoded + 0.055) / 1.055) ** 2.4)


def luminance(rgb):
    return sum(weight * channel for weight, channel in zip(LUMINANCE_WEIGHTS, rgb))


def note_once(notes_by_name, name, text):
    """Adds `text` to the notes of `name` unless it is already there, so a log line appears once per material."""
    notes = notes_by_name.setdefault(name, [])
    if text not in notes:
        notes.append(text)
