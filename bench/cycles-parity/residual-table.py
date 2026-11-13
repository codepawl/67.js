"""Cook over Cycles for the residual variants of #1030: mean ratio per channel, relMSE and a coarse luminance ratio grid.

  uv run --no-project python bench/cycles-parity/residual-table.py <cookPrefix> <cyclesPrefix> [<label>]
"""
import sys

import numpy

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

GRID_COLUMNS = 8
GRID_ROWS = 4
RELATIVE_MSE_EPSILON = 0.01


def luminance(rgb):
    return rgb @ numpy.array([0.2126, 0.7152, 0.0722], dtype=numpy.float64)


def main():
    cook_prefix, cycles_prefix = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else cook_prefix
    cook = numpy.load(f"{cook_prefix}.npy").astype(numpy.float64)
    cycles = numpy.load(f"{cycles_prefix}.npy").astype(numpy.float64)
    channel_ratios = cook.reshape(-1, 3).mean(axis=0) / cycles.reshape(-1, 3).mean(axis=0)
    relative_mse = numpy.mean((cook - cycles) ** 2 / (cycles ** 2 + RELATIVE_MSE_EPSILON))
    print(f"{label}: ratio {channel_ratios[0]:.4f} {channel_ratios[1]:.4f} {channel_ratios[2]:.4f} relMSE {relative_mse:.2e} cycles-mean {cycles.mean():.5f}")
    cook_luma = luminance(cook)
    cycles_luma = luminance(cycles)
    height, width = cook_luma.shape
    for grid_row in range(GRID_ROWS):
        cells = []
        for grid_column in range(GRID_COLUMNS):
            rows = slice(grid_row * height // GRID_ROWS, (grid_row + 1) * height // GRID_ROWS)
            columns = slice(grid_column * width // GRID_COLUMNS, (grid_column + 1) * width // GRID_COLUMNS)
            cells.append(f"{cook_luma[rows, columns].mean() / max(cycles_luma[rows, columns].mean(), 1e-9):.3f}")
        print("   " + " ".join(cells))


main()
