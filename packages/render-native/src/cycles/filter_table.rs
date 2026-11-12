// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Pixel filter importance sampling tables, translated from Cycles `scene/film.cpp` (`filter_table`) and
// `util/math_cdf.{h,cpp}` (`util_cdf_evaluate`, `util_cdf_invert`). Cycles builds one 1024-entry table per film;
// the table is the inverse CDF of the filter, centred on the pixel centre (0.5), and the kernel reads it with a
// linear lookup. The shape depends on the filter width only by a scale, so the host builds the tables once for
// filter width 1 and the kernel scales the offset from 0.5 by the width of the job.

use std::f32::consts::TAU;

/// Entries per table (`FILTER_TABLE_SIZE` in Cycles `kernel/types.h`).
pub(crate) const FILTER_TABLE_SIZE: usize = 1024;

/// Which importance-sampled filter a table describes. The box filter needs no table.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FilterKind {
    Gaussian,
    BlackmanHarris,
}

fn filter_function(kind: FilterKind, value: f32, width: f32) -> f32 {
    match kind {
        FilterKind::Gaussian => {
            let scaled = value * (6.0 / width);
            (-2.0 * scaled * scaled).exp()
        }
        FilterKind::BlackmanHarris => {
            let angle = TAU * (value / width + 0.5);
            0.35875 - 0.48829 * angle.cos() + 0.14128 * (2.0 * angle).cos() - 0.01168 * (3.0 * angle).cos()
        }
    }
}

/// `util_cdf_evaluate`: cumulative sum of |f| over `resolution` steps, normalised so the last entry is exactly 1.
fn evaluate_cdf(resolution: usize, from: f32, to: f32, function: &dyn Fn(f32) -> f32) -> Vec<f32> {
    let range = to - from;
    let mut cdf = vec![0.0f32; resolution + 1];
    for index in 0..resolution {
        let position = from + range * index as f32 / (resolution - 1) as f32;
        cdf[index + 1] = cdf[index] + function(position).abs();
    }
    let total = cdf[resolution];
    let factor = if total == 0.0 { 0.0 } else { 1.0 / total };
    for entry in cdf.iter_mut() {
        *entry *= factor;
    }
    cdf[resolution] = 1.0;
    cdf
}

/// `util_cdf_invert` with `make_symmetric = true`.
fn invert_cdf_symmetric(resolution: usize, range: f32, cdf: &[f32]) -> Vec<f32> {
    let cdf_size = cdf.len();
    let half_size = (resolution - 1) / 2;
    let mut inverse = vec![0.0f32; resolution];
    for offset in 0..=half_size {
        let probability = offset as f32 / half_size as f32;
        let mut index = cdf.partition_point(|&entry| entry <= probability);
        let fraction = if index < cdf_size - 1 {
            (probability - cdf[index]) / (cdf[index + 1] - cdf[index])
        } else {
            index = cdf_size - 1;
            0.0
        };
        let distance = ((index as f32 + fraction) / (resolution - 1) as f32) * (2.0 * range);
        inverse[half_size + offset] = 0.5 * (1.0 + distance);
        inverse[half_size - offset] = 0.5 * (1.0 - distance);
    }
    inverse
}

/// Builds the Cycles filter table for `filter_width` (in pixels). Entry `i` is the sample position inside the
/// pixel, in pixels from its corner, for the unit random number `i / (FILTER_TABLE_SIZE - 1)`. Entry 1023 stays 0,
/// exactly as in Cycles: its even-sized symmetric table writes only entries 0..1022, so a unit random number above
/// 1022/1023 interpolates toward 0 (about 0.1% of samples). It is kept so the kernel matches Cycles sample for sample.
pub(crate) fn build_filter_table(kind: FilterKind, filter_width: f32) -> Vec<f32> {
    let support_width = match kind {
        FilterKind::Gaussian => filter_width * 3.0,
        FilterKind::BlackmanHarris => filter_width * 2.0,
    };
    let range = support_width * 0.5;
    let cdf = evaluate_cdf(FILTER_TABLE_SIZE - 1, 0.0, range, &|position| {
        filter_function(kind, position, support_width)
    });
    invert_cdf_symmetric(FILTER_TABLE_SIZE, range, &cdf)
}

/// Both tables for filter width 1, Gaussian first, as raw f32 bits ready to append to the LUT buffer.
pub(crate) fn unit_filter_table_words() -> Vec<u32> {
    let mut words = Vec::with_capacity(2 * FILTER_TABLE_SIZE);
    for kind in [FilterKind::Gaussian, FilterKind::BlackmanHarris] {
        words.extend(build_filter_table(kind, 1.0).iter().map(|value| value.to_bits()));
    }
    words
}

#[cfg(test)]
mod filter_table_tests {
    use super::*;

    const KINDS: [FilterKind; 2] = [FilterKind::Gaussian, FilterKind::BlackmanHarris];

    fn read_linear(table: &[f32], unit_value: f32) -> f32 {
        let scaled = unit_value.clamp(0.0, 1.0) * (table.len() - 1) as f32;
        let index = (scaled as usize).min(table.len() - 1);
        let next_index = (index + 1).min(table.len() - 1);
        let fraction = scaled - index as f32;
        (1.0 - fraction) * table[index] + fraction * table[next_index]
    }

    #[test]
    // Cycles writes only entries 0..1022 of its even-sized table (see the TODO in `film.cpp`); entry 1023 stays 0.
    fn table_has_cycles_size_and_pixel_centred_ends() {
        for kind in KINDS {
            let table = build_filter_table(kind, 1.5);
            assert_eq!(table.len(), 1024);
            let support = match kind {
                FilterKind::Gaussian => 1.5 * 3.0,
                FilterKind::BlackmanHarris => 1.5 * 2.0,
            };
            assert!((table[1022] - (0.5 + support * 0.5)).abs() < 1e-5, "{kind:?} upper end {}", table[1022]);
            assert!((table[0] - (0.5 - support * 0.5)).abs() < 1e-5, "{kind:?} lower end {}", table[0]);
            assert!((table[511] - 0.5).abs() < 1e-6, "{kind:?} centre");
        }
    }

    #[test]
    fn table_is_symmetric_about_the_pixel_centre() {
        for kind in KINDS {
            let table = build_filter_table(kind, 1.5);
            for offset in 0..=511 {
                let upper = table[511 + offset] - 0.5;
                let lower = 0.5 - table[511 - offset];
                assert!((upper - lower).abs() < 1e-6, "{kind:?} offset {offset}");
            }
        }
    }

    #[test]
    fn inverse_cdf_is_monotonic() {
        for kind in KINDS {
            let table = build_filter_table(kind, 1.5);
            for pair in table[..1023].windows(2) {
                assert!(pair[1] >= pair[0], "{kind:?} decreases from {} to {}", pair[0], pair[1]);
            }
        }
    }

    #[test]
    fn sampling_the_table_reproduces_the_normalised_filter() {
        // The fraction of unit random numbers that land inside [-w/2, w/2] of the pixel centre must equal the
        // integral of the filter over that interval divided by its total integral.
        for kind in KINDS {
            let filter_width = 1.5f32;
            let table = build_filter_table(kind, filter_width);
            let support_width = match kind {
                FilterKind::Gaussian => filter_width * 3.0,
                FilterKind::BlackmanHarris => filter_width * 2.0,
            };
            let half_support = support_width * 0.5;
            let steps = 20000;
            let integral = |limit: f64| -> f64 {
                let mut sum = 0.0f64;
                for step in 0..steps {
                    let position = (step as f64 + 0.5) / steps as f64 * limit;
                    sum += filter_function(kind, position as f32, support_width) as f64;
                }
                sum * limit / steps as f64
            };
            let total = integral(half_support as f64);
            let inner_limit = 0.5f64;
            let expected_mass = integral(inner_limit) / total;
            let low = (0.5 - inner_limit) as f32;
            let high = (0.5 + inner_limit) as f32;
            let in_range = (0..100_000)
                .map(|index| read_linear(&table, (index as f32 + 0.5) / 100_000.0))
                .filter(|&position| position >= low && position <= high)
                .count() as f64
                / 100_000.0;
            assert!((in_range - expected_mass).abs() < 0.01, "{kind:?} mass {in_range} vs {expected_mass}");
        }
    }

    #[test]
    fn width_only_scales_the_offset_from_the_pixel_centre() {
        for kind in KINDS {
            let unit = build_filter_table(kind, 1.0);
            let wide = build_filter_table(kind, 1.5);
            for index in 0..FILTER_TABLE_SIZE - 1 {
                let scaled = 0.5 + (unit[index] - 0.5) * 1.5;
                assert!((scaled - wide[index]).abs() < 2e-5, "{kind:?} entry {index}");
            }
        }
    }

    #[test]
    fn wgsl_constants_match_the_host_tables() {
        let source = include_str!("filter.wgsl");
        assert!(source.contains(&format!("const FLT_TABLE_SIZE: u32 = {}u;", FILTER_TABLE_SIZE)));
        let offset = crate::cycles::CYCLES_LUT_WORDS.len();
        assert!(source.contains(&format!("const FLT_TABLE_GAUSSIAN_OFFSET: u32 = {}u;", offset)));
        assert!(source.contains(&format!(
            "const FLT_TABLE_BLACKMAN_HARRIS_OFFSET: u32 = {}u;",
            offset + FILTER_TABLE_SIZE
        )));
    }
}
