// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Pixel reconstruction filter importance sampling (`flt_*`), ported from Cycles `scene/film.cpp`.

const FLT_LUT_LAST_INDEX: u32 = 64u;

const FLT_GAUSSIAN_INV_CDF = array<f32, 65>(
  0.0000000, 0.0048961, 0.0097940, 0.0146957, 0.0196031,
  0.0245180, 0.0294425, 0.0343784, 0.0393277, 0.0442925,
  0.0492748, 0.0542767, 0.0593005, 0.0643484, 0.0694226,
  0.0745256, 0.0796598, 0.0848279, 0.0900325, 0.0952764,
  0.1005625, 0.1058940, 0.1112741, 0.1167063, 0.1221941,
  0.1277415, 0.1333524, 0.1390314, 0.1447830, 0.1506124,
  0.1565248, 0.1625260, 0.1686224, 0.1748208, 0.1811286,
  0.1875538, 0.1941054, 0.2007931, 0.2076277, 0.2146211,
  0.2217866, 0.2291392, 0.2366954, 0.2444744, 0.2524975,
  0.2607896, 0.2693789, 0.2782986, 0.2875873, 0.2972911,
  0.3074647, 0.3181747, 0.3295027, 0.3415510, 0.3544493,
  0.3683669, 0.3835301, 0.4002522, 0.4189849, 0.4404176,
  0.4656830, 0.4968570, 0.5384687, 0.6043897, 1.5000000,
);

const FLT_BLACKMAN_HARRIS_INV_CDF = array<f32, 65>(
  0.0000000, 0.0056058, 0.0112136, 0.0168255, 0.0224434,
  0.0280694, 0.0337057, 0.0393542, 0.0450171, 0.0506965,
  0.0563948, 0.0621141, 0.0678568, 0.0736252, 0.0794219,
  0.0852493, 0.0911102, 0.0970072, 0.1029432, 0.1089211,
  0.1149442, 0.1210157, 0.1271389, 0.1333176, 0.1395556,
  0.1458569, 0.1522258, 0.1586668, 0.1651850, 0.1717856,
  0.1784741, 0.1852566, 0.1921397, 0.1991303, 0.2062363,
  0.2134660, 0.2208285, 0.2283338, 0.2359932, 0.2438187,
  0.2518240, 0.2600243, 0.2684367, 0.2770803, 0.2859770,
  0.2951516, 0.3046328, 0.3144536, 0.3246529, 0.3352763,
  0.3463782, 0.3580243, 0.3702950, 0.3832900, 0.3971356,
  0.4119955, 0.4280867, 0.4457076, 0.4652846, 0.4874611,
  0.5132813, 0.5446273, 0.5855150, 0.6478121, 1.0000000,
);

fn flt_lookup_gaussian_1d(unit_value: f32) -> f32 {
  let sign_scale = select(1.0, -1.0, unit_value < 0.5);
  let folded = clamp(abs(2.0 * unit_value - 1.0), 0.0, 1.0);
  let scaled = folded * f32(FLT_LUT_LAST_INDEX);
  let index_lo = min(u32(floor(scaled)), FLT_LUT_LAST_INDEX - 1u);
  let fraction = scaled - f32(index_lo);
  let magnitude = mix(FLT_GAUSSIAN_INV_CDF[index_lo], FLT_GAUSSIAN_INV_CDF[index_lo + 1u], fraction);
  return sign_scale * magnitude;
}

fn flt_lookup_blackman_harris_1d(unit_value: f32) -> f32 {
  let sign_scale = select(1.0, -1.0, unit_value < 0.5);
  let folded = clamp(abs(2.0 * unit_value - 1.0), 0.0, 1.0);
  let scaled = folded * f32(FLT_LUT_LAST_INDEX);
  let index_lo = min(u32(floor(scaled)), FLT_LUT_LAST_INDEX - 1u);
  let fraction = scaled - f32(index_lo);
  let magnitude = mix(FLT_BLACKMAN_HARRIS_INV_CDF[index_lo], FLT_BLACKMAN_HARRIS_INV_CDF[index_lo + 1u], fraction);
  return sign_scale * magnitude;
}

fn flt_sample_offset(unit_uv: vec2<f32>) -> vec2<f32> {
  let width = max(kernel_params.filter_width, 0.0);
  if (width == 0.0) {
    return vec2<f32>(0.0, 0.0);
  }
  if (kernel_params.filter_type == FILTER_GAUSSIAN) {
    return vec2<f32>(flt_lookup_gaussian_1d(unit_uv.x), flt_lookup_gaussian_1d(unit_uv.y)) * width;
  }
  if (kernel_params.filter_type == FILTER_BLACKMAN_HARRIS) {
    return vec2<f32>(flt_lookup_blackman_harris_1d(unit_uv.x), flt_lookup_blackman_harris_1d(unit_uv.y)) * width;
  }
  return (unit_uv - vec2<f32>(0.5, 0.5)) * width;
}
