# SPDX-FileCopyrightText: 2011-2022 Blender Foundation
# SPDX-License-Identifier: Apache-2.0
"""Reference values for the Cook Sobol-Burley sampler, from an independent Python port of the published algorithm.

The port follows Brent Burley, "Practical Hash-based Owen Scrambling" (JCGT 2020) and Cycles 5.3
(kernel/sample/sobol_burley.h, kernel/sample/util.h, util/hash.h). It shares no code with the WGSL: the Sobol generator
matrices are rebuilt here from the Joe-Kuo direction numbers instead of copied from kernel/tables.h.

  uv run --no-project python bench/cycles-parity/sampler-reference.py [--cycles-tables <tables.h>]

writes bench/cycles-parity/sampler-reference.json. With --cycles-tables the rebuilt matrices are first checked against the
table in that file.
"""
import json
import re
import sys
from pathlib import Path

import struct

MASK = 0xFFFFFFFF
DIMENSION_SETS = [0, 1, 7, 35, 1000]
BLOCK_LENGTH = 32
BLOCK_STARTS = [0, 4097, 123456789, 0xFFFFFFC0]
INDICES = [start + offset for start in BLOCK_STARTS for offset in range(BLOCK_LENGTH)]


def reverse_bits(value):
    return int(f"{value & MASK:032b}"[::-1], 2)


def joe_kuo_direction_table(polynomial_degree, polynomial_coefficients, initial_numbers):
    """The 32 direction numbers of one Sobol dimension, bit reversed as Cycles stores them."""
    numbers = list(initial_numbers)
    for k in range(polynomial_degree, 32):
        value = (1 << polynomial_degree) * numbers[k - polynomial_degree] ^ numbers[k - polynomial_degree]
        for j in range(1, polynomial_degree):
            if (polynomial_coefficients >> (polynomial_degree - 1 - j)) & 1:
                value ^= (1 << j) * numbers[k - j]
        numbers.append(value)
    return [reverse_bits(numbers[k] << (32 - (k + 1))) for k in range(32)]


SOBOL_TABLE = [
    [1 << i for i in range(32)],
    joe_kuo_direction_table(1, 0, [1]),
    joe_kuo_direction_table(2, 1, [1, 3]),
    joe_kuo_direction_table(3, 1, [1, 3, 1]),
]


def check_against_cycles_tables(tables_path):
    text = Path(tables_path).read_text()
    start = text.index("sobol_burley_table[4][32]")
    block = text[start:text.index("};", start)]
    values = [int(token, 16) for token in re.findall(r"0x[0-9a-fA-F]{8}", block)]
    assert len(values) == 128, len(values)
    for dimension in range(4):
        assert values[dimension * 32:(dimension + 1) * 32] == SOBOL_TABLE[dimension], f"dimension {dimension} differs"


def hash_hp_uint(value):
    value ^= value >> 16
    value = (value * 0x21F0AAAD) & MASK
    value ^= value >> 15
    value = (value * 0xD35A2D97) & MASK
    value ^= value >> 15
    return value ^ 0xE6FE3BEB


def reversed_bit_owen(n, seed):
    n ^= (n * 0x3D20ADEA) & MASK
    n = (n + seed) & MASK
    n = (n * ((seed >> 16) | 1)) & MASK
    n ^= (n * 0x05526C56) & MASK
    n ^= (n * 0x53A22864) & MASK
    return n


def reversed_bit_owen_base4(n, seed):
    n ^= (n * 0x3D20ADEA) & MASK
    n ^= (n >> 1) & ((n << 1) & MASK) & 0x55555555
    n = (n + seed) & MASK
    n = (n * ((seed >> 16) | 1)) & MASK
    n ^= (n >> 1) & ((n << 1) & MASK) & 0x55555555
    n ^= (n * 0x05526C56) & MASK
    n ^= (n * 0x53A22864) & MASK
    return n


def expand_bits(x):
    x &= 0x0000FFFF
    x = (x ^ (x << 8)) & 0x00FF00FF
    x = (x ^ (x << 4)) & 0x0F0F0F0F
    x = (x ^ (x << 2)) & 0x33333333
    x = (x ^ (x << 1)) & 0x55555555
    return x


def hash_uint(key):
    def rot(x, k):
        return ((x << k) | (x >> (32 - k))) & MASK

    a = b = c = (0xDEADBEEF + (1 << 2) + 13) & MASK
    a = (a + key) & MASK
    c ^= b
    c = (c - rot(b, 14)) & MASK
    a ^= c
    a = (a - rot(c, 11)) & MASK
    b ^= a
    b = (b - rot(a, 25)) & MASK
    c ^= b
    c = (c - rot(b, 16)) & MASK
    a ^= c
    a = (a - rot(c, 4)) & MASK
    b ^= a
    b = (b - rot(a, 14)) & MASK
    c ^= b
    c = (c - rot(b, 24)) & MASK
    return c


def to_float32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


INVERSE_UINT_RANGE = to_float32(1.0 / 4294967808.0)


def uint_to_float_excl(n):
    return to_float32(to_float32(n) * INVERSE_UINT_RANGE)


def sobol_burley(rev_bit_index, dimension, scramble_seed):
    result = 0
    if dimension == 0:
        result = reverse_bits(rev_bit_index)
    else:
        i = 0
        while rev_bit_index != 0:
            j = 32 - rev_bit_index.bit_length()  # count leading zeros
            result ^= SOBOL_TABLE[dimension][i + j]
            i += j + 1
            rev_bit_index = (rev_bit_index << j) & MASK
            rev_bit_index = (rev_bit_index << 1) & MASK
    result = reverse_bits(reversed_bit_owen(result, scramble_seed))
    return uint_to_float_excl(result)


SHUFFLE_CONSTANTS = {1: 0xBFF95BFE, 2: 0xF8ADE99A, 3: 0xCAA726AC, 4: 0xC2C1A055}
COMPONENT_CONSTANTS = {
    1: [0x635C77BD],
    2: [0xE0AAAF76, 0x94964D4E],
    3: [0x9E78E391, 0x67C33241, 0x78C395C5],
    4: [0x39468210, 0xE9D8A845, 0x5F32B482, 0x1524CC56],
}


def float32_digits(value):
    return float(f"{value:.9g}")


def sobol_burley_sample(size, index, dimension_set, seed=0, mask=MASK):
    seed ^= hash_hp_uint(dimension_set)
    shuffled = reversed_bit_owen(reverse_bits(index), seed ^ SHUFFLE_CONSTANTS[size]) & mask
    return [float32_digits(sobol_burley(shuffled, component, seed ^ constant))
            for component, constant in enumerate(COMPONENT_CONSTANTS[size])]



def build_reference():
    entries = []
    for dimension_set in DIMENSION_SETS:
        for index in INDICES:
            pixel_x, pixel_y = index % 64, index // 64
            entries.append({
                "index": index,
                "dimensionSet": dimension_set,
                "sample4": sobol_burley_sample(4, index, dimension_set),
                "sample1": sobol_burley_sample(1, index, dimension_set),
                "sample2": sobol_burley_sample(2, index, dimension_set),
                "sample3": sobol_burley_sample(3, index, dimension_set),
                "hashUint": hash_uint(index),
                "morton": (expand_bits(pixel_x) << 1) | expand_bits(pixel_y),
                "nestedBase4": reverse_bits(reversed_bit_owen_base4(reverse_bits(index), dimension_set)),
                "hashHp": hash_hp_uint(index),
            })
    return entries


def main():
    arguments = sys.argv[1:]
    if "--cycles-tables" in arguments:
        check_against_cycles_tables(arguments[arguments.index("--cycles-tables") + 1])
        print("direction numbers match kernel/tables.h")
    output_path = Path(__file__).with_name("sampler-reference.json")
    output_path.write_text(json.dumps({"blockLength": BLOCK_LENGTH, "blockStarts": BLOCK_STARTS, "dimensionSets": DIMENSION_SETS, "entries": build_reference()}, separators=(",", ":")) + "\n")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
