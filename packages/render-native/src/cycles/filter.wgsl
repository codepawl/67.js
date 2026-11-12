// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Pixel reconstruction filter importance sampling (`flt_*`), ported from Cycles `scene/film.cpp` and
// `kernel/util/lookup_table.h`. The host (`filter_table.rs`) builds the 1024-entry inverse-CDF tables for filter
// width 1 and appends them to the LUT buffer after `CYCLES_LUT_WORDS`. A table entry is a sample position inside
// the pixel centred on 0.5, so the offset from the pixel centre is `(entry - 0.5) * filter_width`.

const FLT_TABLE_SIZE: u32 = 1024u;
const FLT_TABLE_GAUSSIAN_OFFSET: u32 = 29712u;
const FLT_TABLE_BLACKMAN_HARRIS_OFFSET: u32 = 30736u;

// Cycles `lookup_table_read`: linear interpolation between neighbouring entries.
fn flt_table_read(table_offset: u32, unit_value: f32) -> f32 {
  let scaled = clamp(unit_value, 0.0, 1.0) * f32(FLT_TABLE_SIZE - 1u);
  let index = min(u32(scaled), FLT_TABLE_SIZE - 1u);
  let next_index = min(index + 1u, FLT_TABLE_SIZE - 1u);
  let fraction = scaled - f32(index);
  let lower = bitcast<f32>(cycles_lut[table_offset + index]);
  if (fraction == 0.0) {
    return lower;
  }
  let upper = bitcast<f32>(cycles_lut[table_offset + next_index]);
  return (1.0 - fraction) * lower + fraction * upper;
}

fn flt_sample_offset(unit_uv: vec2<f32>) -> vec2<f32> {
  let width = max(kernel_params.filter_width, 0.0);
  if (width == 0.0) {
    return vec2<f32>(0.0, 0.0);
  }
  if (kernel_params.filter_type == FILTER_GAUSSIAN) {
    let sampled = vec2<f32>(
      flt_table_read(FLT_TABLE_GAUSSIAN_OFFSET, unit_uv.x),
      flt_table_read(FLT_TABLE_GAUSSIAN_OFFSET, unit_uv.y));
    return (sampled - vec2<f32>(0.5, 0.5)) * width;
  }
  if (kernel_params.filter_type == FILTER_BLACKMAN_HARRIS) {
    let sampled = vec2<f32>(
      flt_table_read(FLT_TABLE_BLACKMAN_HARRIS_OFFSET, unit_uv.x),
      flt_table_read(FLT_TABLE_BLACKMAN_HARRIS_OFFSET, unit_uv.y));
    return (sampled - vec2<f32>(0.5, 0.5)) * width;
  }
  return (unit_uv - vec2<f32>(0.5, 0.5)) * width;
}
