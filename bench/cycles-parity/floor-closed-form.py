"""Closed-form pixel values of the top-down floor scenes against what Cycles and Cook measured (#1104).

  uv run --no-project --with numpy python bench/cycles-parity/floor-closed-form.py <dataDirectory> [--tags td-sun,td-sky,...]

The floor is Lambert with albedo 0.8, the camera looks straight down and nothing shadows the floor, so a pixel is
  sun:  albedo / pi * sunColor * cos(angle between the sun and the floor normal)
  sky:  albedo / pi * the integral of sky radiance times cosine over the upper hemisphere (a flat sky of radiance L gives albedo * L).
For the Kloofendal map the integral is taken twice from the Radiance file's own bytes: with the texel decoded as mantissa times
2^(exponent-136) (what Cook's parser and the Radiance format give) and as (mantissa + 0.5) times 2^(exponent-136).
  uv run --no-project --with numpy python bench/cycles-parity/floor-closed-form.py --cap-order
needs only the sky file: it prints how many texels exceed the radiance limit and the sky term with the limit applied to the texels before
the bilinear lookup (Cook) and to the interpolated value after it (what render-cycles.py did before #1104), on a 2-D grid.
Prints, per tag, the closed forms, each renderer's mean over the seeds with its standard error, and each mean over the closed form.
"""
import glob
import math
import os
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ALBEDO = 0.8
SUN_COLOR = numpy.array([3.0, 2.8, 2.5])
SUN_DIRECTION = numpy.array([-3.0, 6.0, 4.0])
RADIANCE_LIMIT = 16.0
SKY_FILE = "public/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr"
POLAR_STEPS = 200000


def decode_radiance_bytes(path):
    with open(path, "rb") as handle:
        content = handle.read()
    header_end = content.index(b"\n\n") + 2
    resolution_end = content.index(b"\n", header_end)
    _, height_text, _, width_text = content[header_end:resolution_end].decode("ascii").split()
    height = int(height_text)
    width = int(width_text)
    position = resolution_end + 1
    rgbe = numpy.zeros((height, width, 4), dtype=numpy.uint8)
    for row in range(height):
        position += 4
        for channel in range(4):
            column = 0
            while column < width:
                count = content[position]
                if count > 128:
                    run = count - 128
                    rgbe[row, column:column + run, channel] = content[position + 1]
                    position += 2
                else:
                    rgbe[row, column:column + count, channel] = numpy.frombuffer(content[position + 1:position + 1 + count], dtype=numpy.uint8)
                    position += 1 + count
                column += run if count > 128 else count
    return rgbe


def decode_texels(rgbe, mantissa_offset):
    scale = numpy.where(rgbe[..., 3] == 0, 0.0, 2.0 ** (rgbe[..., 3].astype(numpy.float64) - 136.0))
    texels = (rgbe[..., :3].astype(numpy.float64) + mantissa_offset) * scale[..., None]
    return numpy.minimum(texels, RADIANCE_LIMIT)


def cosine_irradiance_over_pi(texels):
    """Hemisphere integral of radiance times cosine, over pi, for a map whose up axis is the row axis (bilinear in rows, row means in azimuth)."""
    height = texels.shape[0]
    row_means = texels.mean(axis=1)
    polar = (numpy.arange(POLAR_STEPS) + 0.5) / POLAR_STEPS * (math.pi / 2.0)
    texel_y = polar / math.pi * height - 0.5
    lower = numpy.floor(texel_y).astype(int)
    fraction = (texel_y - lower)[:, None]
    low_row = row_means[numpy.clip(lower, 0, height - 1)]
    high_row = row_means[numpy.clip(lower + 1, 0, height - 1)]
    radiance = low_row * (1.0 - fraction) + high_row * fraction
    weight = (numpy.cos(polar) * numpy.sin(polar) * (math.pi / 2.0 / POLAR_STEPS))[:, None]
    return 2.0 * (radiance * weight).sum(axis=0)


def sun_pixel():
    normal_cosine = SUN_DIRECTION[1] / numpy.linalg.norm(SUN_DIRECTION)
    return ALBEDO / math.pi * SUN_COLOR * normal_cosine


def closed_forms():
    rgbe = decode_radiance_bytes(SKY_FILE)
    sky_plain = ALBEDO * cosine_irradiance_over_pi(decode_texels(rgbe, 0.0))
    sky_half = ALBEDO * cosine_irradiance_over_pi(decode_texels(rgbe, 0.5))
    flat_a = numpy.full(3, ALBEDO * 128 / 256)
    flat_b = numpy.full(3, ALBEDO * 255 / 256)
    return {
        "td-sun": (sun_pixel(), sun_pixel()),
        "td-flat-a": (flat_a, flat_a * 128.5 / 128.0),
        "td-flat-b": (flat_b, flat_b * 255.5 / 255.0),
        "td-const": (numpy.full(3, ALBEDO * 0.5), numpy.full(3, ALBEDO * 0.5)),
        "td-sky": (sky_plain, sky_half),
        "td-both": (sky_plain + sun_pixel(), sky_half + sun_pixel()),
    }


def seed_means(pattern):
    paths = sorted(glob.glob(pattern))
    if not paths:
        return None
    means = numpy.array([numpy.load(path).astype(numpy.float64).reshape(-1, 3).mean(axis=0) for path in paths])
    error = means.std(axis=0, ddof=1) / math.sqrt(len(paths)) if len(paths) > 1 else numpy.full(3, numpy.nan)
    return means.mean(axis=0), error, len(paths)


def format_channels(values, digits=5):
    return "[" + ", ".join(f"{value:.{digits}f}" for value in values) + "]"


def decode_uncapped_texels(rgbe):
    scale = numpy.where(rgbe[..., 3] == 0, 0.0, 2.0 ** (rgbe[..., 3].astype(numpy.float64) - 136.0))
    return rgbe[..., :3].astype(numpy.float64) * scale[..., None]


def hemisphere_term(texels, cap_after_lookup, polar_steps=1024, azimuth_steps=2048):
    """albedo-free E / pi of the upper hemisphere, bilinear in both axes on a polar x azimuth grid, capping the value if asked."""
    height, width, _ = texels.shape
    polar = (numpy.arange(polar_steps) + 0.5) / polar_steps * (math.pi / 2.0)
    texel_x = (numpy.arange(azimuth_steps) + 0.5) / azimuth_steps * width - 0.5
    left = numpy.floor(texel_x).astype(int)
    fraction_x = (texel_x - left)[:, None]
    total = numpy.zeros(3)
    for index in range(polar_steps):
        texel_y = polar[index] / math.pi * height - 0.5
        top = int(math.floor(texel_y))
        fraction_y = texel_y - top
        row = texels[min(max(top, 0), height - 1)] * (1.0 - fraction_y) + texels[min(max(top + 1, 0), height - 1)] * fraction_y
        line = row[left % width] * (1.0 - fraction_x) + row[(left + 1) % width] * fraction_x
        if cap_after_lookup:
            line = numpy.minimum(line, RADIANCE_LIMIT)
        weight = math.cos(polar[index]) * math.sin(polar[index]) * (math.pi / 2.0 / polar_steps)
        total += line.mean(axis=0) * weight
    return 2.0 * total


def print_cap_order():
    """Sky term with the radiance limit applied to the texels (Cook) and to the interpolated value (the old render-cycles.py)."""
    raw = decode_uncapped_texels(decode_radiance_bytes(SKY_FILE))
    brightest = raw.max(axis=2)
    print(f"{SKY_FILE}: {int((brightest > RADIANCE_LIMIT).sum())} texels above {RADIANCE_LIMIT:g}, largest channel value {raw.max():.0f}")
    cap_before = hemisphere_term(numpy.minimum(raw, RADIANCE_LIMIT), False)
    cap_after = hemisphere_term(raw, True)
    print(f"cap before the lookup {format_channels(cap_before, 6)}  cap after the lookup {format_channels(cap_after, 6)}")
    print(f"cap after over cap before {format_channels(cap_after / cap_before)}")


def main():
    if "--cap-order" in sys.argv:
        print_cap_order()
        return
    data_directory = sys.argv[1]
    tags = sys.argv[sys.argv.index("--tags") + 1].split(",") if "--tags" in sys.argv else list(closed_forms())
    forms = closed_forms()
    for tag in tags:
        plain, half = forms[tag.split("@")[0]]
        print(f"{tag}: closed form {format_channels(plain)}  with +0.5 texel decode {format_channels(half)}")
        measured = {}
        for side, prefix in (("cycles", "cycles"), ("cook", "cookcycles")):
            found = seed_means(os.path.join(data_directory, f"{prefix}-{tag}-s*.npy"))
            if found is None:
                continue
            mean, error, count = found
            measured[side] = (mean, error)
            print(f"  {side:<6} mean {format_channels(mean)} +- {format_channels(error, 6)} ({count} seeds)  over closed form {format_channels(mean / plain)}  over +0.5 form {format_channels(mean / half)}")
        if len(measured) == 2:
            ratio = measured["cook"][0] / measured["cycles"][0]
            relative = numpy.sqrt((measured["cook"][1] / measured["cook"][0]) ** 2 + (measured["cycles"][1] / measured["cycles"][0]) ** 2)
            print(f"  cook over cycles {format_channels(ratio)} +- {format_channels(ratio * relative, 6)}")


if __name__ == "__main__":
    main()
