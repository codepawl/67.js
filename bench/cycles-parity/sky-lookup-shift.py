"""How does Cycles' picture of the sky differ from Cook's, pixel by pixel? (#1104)

  uv run --no-project --with numpy python bench/cycles-parity/sky-lookup-shift.py --label name \
      --reference "<cycles glob>" --candidate "<cook glob>" [--sky-rows <count>]

Averages each side's pictures over the seeds, keeps the pixels that show only sky (all rows, or the first --sky-rows rows), and fits
  cycles - cook = scale * cook + shift_rows * d(cook)/d(row) + shift_columns * d(cook)/d(column)
per channel by least squares. A pure brightness difference lands in `scale`; a sky that Cycles reads slightly higher or lower on the
map lands in `shift_rows` (in pixels of the picture). The residual is the share of the difference the three terms leave unexplained.
"""
import glob
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_flag(name, fallback=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else fallback


def mean_image(pattern):
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise ValueError(f"No image matches {pattern!r}.")
    return numpy.mean([numpy.load(path).astype(numpy.float64) for path in paths], axis=0), len(paths)


def fit_channel(reference, candidate, row_limit):
    gradient_rows, gradient_columns = numpy.gradient(candidate)
    window = (slice(2, row_limit - 2), slice(2, candidate.shape[1] - 2))
    difference = (reference - candidate)[window].ravel()
    design = numpy.stack([candidate[window].ravel(), gradient_rows[window].ravel(), gradient_columns[window].ravel()], axis=1)
    coefficients, *_ = numpy.linalg.lstsq(design, difference, rcond=None)
    residual = difference - design @ coefficients
    return coefficients, float(numpy.sqrt((residual ** 2).mean() / (difference ** 2).mean()))


def main():
    reference, reference_count = mean_image(read_flag("--reference"))
    candidate, candidate_count = mean_image(read_flag("--candidate"))
    row_limit = int(read_flag("--sky-rows", reference.shape[0]))
    print(f"{read_flag('--label', '')}: {candidate_count} cook, {reference_count} cycles pictures, rows 2..{row_limit - 2}")
    for channel, name in enumerate("RGB"):
        coefficients, residual_share = fit_channel(reference[..., channel], candidate[..., channel], row_limit)
        print(f"  {name}: scale {coefficients[0]:+.5f}  shift_rows {coefficients[1]:+.4f} px  shift_columns {coefficients[2]:+.4f} px  unexplained {residual_share:.3f}")
    ratio = reference[:row_limit].reshape(-1, 3).mean(axis=0) / candidate[:row_limit].reshape(-1, 3).mean(axis=0)
    print(f"  mean cycles over cook {numpy.array2string(ratio, precision=5)}")


main()
