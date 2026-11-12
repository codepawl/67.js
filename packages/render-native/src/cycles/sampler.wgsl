// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Stateless 4D sampler (`smp_*`) for the Cycles-parity native kernel. The default is an Owen-scrambled Sobol
// sequence with Burley's hash-based scrambling ("Practical Hash-based Owen Scrambling", JCGT 2020), the sampler
// Cycles uses. `KERNEL_FLAG_PCG_SAMPLER` selects the earlier uncorrelated 4D PCG hash instead.

const SMP_UINT_TO_UNIT_FLOAT: f32 = 1.0 / 16777216.0;

struct SmpState {
  pixel_x: u32,
  pixel_y: u32,
  sample_index: u32,
  dimension: u32,
  seed: u32,
  pixel_seed: u32,
  use_pcg: u32,
}

// First four dimensions of the Joe-Kuo Sobol sequence, one row per bit of the sample index.
const SMP_SOBOL_MATRIX = array<vec4<u32>, 32>(
  vec4<u32>(0x80000000u, 0x80000000u, 0x80000000u, 0x80000000u),
  vec4<u32>(0x40000000u, 0xC0000000u, 0xC0000000u, 0xC0000000u),
  vec4<u32>(0x20000000u, 0xA0000000u, 0x60000000u, 0x20000000u),
  vec4<u32>(0x10000000u, 0xF0000000u, 0x90000000u, 0x50000000u),
  vec4<u32>(0x08000000u, 0x88000000u, 0xE8000000u, 0xF8000000u),
  vec4<u32>(0x04000000u, 0xCC000000u, 0x5C000000u, 0x74000000u),
  vec4<u32>(0x02000000u, 0xAA000000u, 0x8E000000u, 0xA2000000u),
  vec4<u32>(0x01000000u, 0xFF000000u, 0xC5000000u, 0x93000000u),
  vec4<u32>(0x00800000u, 0x80800000u, 0x68800000u, 0xD8800000u),
  vec4<u32>(0x00400000u, 0xC0C00000u, 0x9CC00000u, 0x25400000u),
  vec4<u32>(0x00200000u, 0xA0A00000u, 0xEE600000u, 0x59E00000u),
  vec4<u32>(0x00100000u, 0xF0F00000u, 0x55900000u, 0xE6D00000u),
  vec4<u32>(0x00080000u, 0x88880000u, 0x80680000u, 0x78080000u),
  vec4<u32>(0x00040000u, 0xCCCC0000u, 0xC09C0000u, 0xB40C0000u),
  vec4<u32>(0x00020000u, 0xAAAA0000u, 0x60EE0000u, 0x82020000u),
  vec4<u32>(0x00010000u, 0xFFFF0000u, 0x90550000u, 0xC3050000u),
  vec4<u32>(0x00008000u, 0x80008000u, 0xE8808000u, 0x208F8000u),
  vec4<u32>(0x00004000u, 0xC000C000u, 0x5CC0C000u, 0x51474000u),
  vec4<u32>(0x00002000u, 0xA000A000u, 0x8E606000u, 0xFBEA2000u),
  vec4<u32>(0x00001000u, 0xF000F000u, 0xC5909000u, 0x75D93000u),
  vec4<u32>(0x00000800u, 0x88008800u, 0x6868E800u, 0xA0858800u),
  vec4<u32>(0x00000400u, 0xCC00CC00u, 0x9C9C5C00u, 0x914E5400u),
  vec4<u32>(0x00000200u, 0xAA00AA00u, 0xEEEE8E00u, 0xDBE79E00u),
  vec4<u32>(0x00000100u, 0xFF00FF00u, 0x5555C500u, 0x25DB6D00u),
  vec4<u32>(0x00000080u, 0x80808080u, 0x8000E880u, 0x58800080u),
  vec4<u32>(0x00000040u, 0xC0C0C0C0u, 0xC0005CC0u, 0xE54000C0u),
  vec4<u32>(0x00000020u, 0xA0A0A0A0u, 0x60008E60u, 0x79E00020u),
  vec4<u32>(0x00000010u, 0xF0F0F0F0u, 0x9000C590u, 0xB6D00050u),
  vec4<u32>(0x00000008u, 0x88888888u, 0xE8006868u, 0x800800F8u),
  vec4<u32>(0x00000004u, 0xCCCCCCCCu, 0x5C009C9Cu, 0xC00C0074u),
  vec4<u32>(0x00000002u, 0xAAAAAAAAu, 0x8E00EEEEu, 0x200200A2u),
  vec4<u32>(0x00000001u, 0xFFFFFFFFu, 0xC5005555u, 0x50050093u),
);


fn smp_hash_u32(input_word: u32) -> u32 {
  var v = input_word;
  v ^= v >> 16u;
  v *= 0x7feb352du;
  v ^= v >> 15u;
  v *= 0x846ca68bu;
  v ^= v >> 16u;
  return v;
}

fn smp_laine_karras_permutation(index_word: u32, scramble_seed: u32) -> u32 {
  var x = index_word + scramble_seed;
  x ^= x * 0x6c50b47cu;
  x ^= x * 0xb82f1e52u;
  x ^= x * 0xc7afe638u;
  x ^= x * 0x8d22f6e6u;
  return x;
}

fn smp_nested_uniform_scramble(index_word: u32, scramble_seed: u32) -> u32 {
  return reverseBits(smp_laine_karras_permutation(reverseBits(index_word), scramble_seed));
}

fn smp_sobol_4d(index_word: u32) -> vec4<u32> {
  var result = vec4<u32>(0u);
  var remaining = index_word;
  for (var bit = 0u; bit < 32u; bit += 1u) {
    if (remaining == 0u) {
      break;
    }
    if ((remaining & 1u) != 0u) {
      result = result ^ SMP_SOBOL_MATRIX[bit];
    }
    remaining = remaining >> 1u;
  }
  return result;
}

fn smp_sobol_burley_words(state: ptr<function, SmpState>) -> vec4<u32> {
  let group = (*state).dimension >> 2u;
  (*state).dimension = (*state).dimension + 4u;
  let group_seed = smp_hash_u32((*state).pixel_seed ^ (group * 0x9E3779B9u + 0x7F4A7C15u));
  let shuffled_index = smp_nested_uniform_scramble((*state).sample_index, group_seed);
  let sobol_words = smp_sobol_4d(shuffled_index);
  return vec4<u32>(
    smp_nested_uniform_scramble(sobol_words.x, smp_hash_u32(group_seed ^ 0x68E31DA4u)),
    smp_nested_uniform_scramble(sobol_words.y, smp_hash_u32(group_seed ^ 0xB5297A4Du)),
    smp_nested_uniform_scramble(sobol_words.z, smp_hash_u32(group_seed ^ 0x1B56C4E9u)),
    smp_nested_uniform_scramble(sobol_words.w, smp_hash_u32(group_seed ^ 0x2545F491u)),
  );
}

fn smp_pcg4d(input_words: vec4<u32>) -> vec4<u32> {
  var v = input_words * 1664525u + 1013904223u;
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.w += v.y * v.z;
  v = v ^ (v >> vec4<u32>(16u));
  v.x += v.y * v.w;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.w += v.y * v.z;
  return v;
}

fn smp_word_to_unit_float(word: u32) -> f32 {
  return f32(word >> 8u) * SMP_UINT_TO_UNIT_FLOAT;
}

fn smp_draw_words(state: ptr<function, SmpState>) -> vec4<u32> {
  if ((*state).use_pcg == 0u) {
    return smp_sobol_burley_words(state);
  }
  let dim = (*state).dimension;
  (*state).dimension = dim + 1u;
  let seed = (*state).seed;
  let raw = vec4<u32>(
    (*state).pixel_x ^ (seed * 0x9E3779B9u),
    (*state).pixel_y ^ (seed * 0x85EBCA6Bu + 0x7F4A7C15u),
    (*state).sample_index ^ (seed * 0xC2B2AE35u + 0x165667B1u),
    dim + (seed ^ 0x27D4EB2Fu),
  );
  return smp_pcg4d(raw);
}

fn smp_init(pixel_x: u32, pixel_y: u32, sample_index: u32, seed: u32) -> SmpState {
  var state: SmpState;
  state.pixel_x = pixel_x;
  state.pixel_y = pixel_y;
  state.sample_index = sample_index;
  state.dimension = 0u;
  state.seed = seed;
  state.use_pcg = select(0u, 1u, (kernel_params.kernel_flags & KERNEL_FLAG_PCG_SAMPLER) != 0u);
  state.pixel_seed = smp_hash_u32(pixel_x ^ smp_hash_u32(pixel_y ^ smp_hash_u32(seed + 0x3C6EF372u)));
  return state;
}

fn smp_next_1d(state: ptr<function, SmpState>) -> f32 {
  let words = smp_draw_words(state);
  return smp_word_to_unit_float(words.x);
}

fn smp_next_2d(state: ptr<function, SmpState>) -> vec2<f32> {
  let words = smp_draw_words(state);
  return vec2<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
  );
}

fn smp_next_3d(state: ptr<function, SmpState>) -> vec3<f32> {
  let words = smp_draw_words(state);
  return vec3<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
    smp_word_to_unit_float(words.z),
  );
}

fn smp_next_4d(state: ptr<function, SmpState>) -> vec4<f32> {
  let words = smp_draw_words(state);
  return vec4<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
    smp_word_to_unit_float(words.z),
    smp_word_to_unit_float(words.w),
  );
}
