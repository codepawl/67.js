// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Stateless uncorrelated 4D PCG hash sampler (`smp_*`) for the Cycles-parity native kernel.

const SMP_UINT_TO_UNIT_FLOAT: f32 = 1.0 / 16777216.0;

struct SmpState {
  pixel_x: u32,
  pixel_y: u32,
  sample_index: u32,
  dimension: u32,
  seed: u32,
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
