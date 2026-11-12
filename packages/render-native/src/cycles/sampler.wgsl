// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Random numbers for the Cycles-parity native kernel (`smp_*`). Two patterns, chosen by
// `KERNEL_FLAG_WHITE_NOISE_SAMPLER`:
//   - default: Cycles 5.3 BLUE_NOISE_PURE, a translation of kernel/sample/{pattern,sobol_burley,util}.h and
//     util/hash.h: one Owen-scrambled Sobol sequence (seed 0) where each pixel owns a section of
//     `total_samples` consecutive indices, found by a base-4 Owen scrambled Morton code of the pixel.
//   - white: a stateless PCG4D hash per draw, unstratified across samples.
// Sobol-Burley decisions are addressed by a dimension set. The path loop calls `smp_seek` before each decision so
// that a bounce that skips a light kind does not shift the sets of the others (Cycles reserves PRNG_BOUNCE_NUM = 16
// sets per path step the same way).

const SMP_UINT_TO_UNIT_FLOAT: f32 = 1.0 / 16777216.0;
const SMP_UINT_TO_UNIT_FLOAT_EXCLUSIVE: f32 = 1.0 / 4294967808.0;
const SMP_SETS_PER_STEP: u32 = 16u;

// Dimension-set slots inside one path step. Each draw call takes the next set, so a 1D plus 2D pair uses two slots.
const SMP_SLOT_TERMINATE: u32 = 0u;
const SMP_SLOT_ANALYTIC_PICK: u32 = 1u;
const SMP_SLOT_ANALYTIC_POINT: u32 = 2u;
const SMP_SLOT_EMISSIVE_PICK: u32 = 3u;
const SMP_SLOT_EMISSIVE_POINT: u32 = 4u;
const SMP_SLOT_ENVIRONMENT: u32 = 5u;
const SMP_SLOT_SURFACE_BSDF: u32 = 6u;
const SMP_SLOT_TRANSPARENT: u32 = 7u;
const SMP_SLOT_VOLUME_DISTANCE: u32 = 8u;
const SMP_SLOT_VOLUME_ANALYTIC_PICK: u32 = 9u;
const SMP_SLOT_VOLUME_ANALYTIC_POINT: u32 = 10u;
const SMP_SLOT_VOLUME_ENVIRONMENT: u32 = 11u;
const SMP_SLOT_VOLUME_PHASE: u32 = 12u;

struct SmpState {
  pixel_x: u32,
  pixel_y: u32,
  sample_index: u32,
  dimension: u32,
  seed: u32,
  pixel_sequence_start: u32,
  use_sobol_burley: u32,
}

// Rows 1 to 3 of Cycles' `sobol_burley_table` (kernel/tables.h); row 0 is the identity and handled by bit reversal.
var<private> SMP_SOBOL_TABLE: array<u32, 96> = array<u32, 96>(
    0x00000001u, 0x00000003u, 0x00000005u, 0x0000000fu,
    0x00000011u, 0x00000033u, 0x00000055u, 0x000000ffu,
    0x00000101u, 0x00000303u, 0x00000505u, 0x00000f0fu,
    0x00001111u, 0x00003333u, 0x00005555u, 0x0000ffffu,
    0x00010001u, 0x00030003u, 0x00050005u, 0x000f000fu,
    0x00110011u, 0x00330033u, 0x00550055u, 0x00ff00ffu,
    0x01010101u, 0x03030303u, 0x05050505u, 0x0f0f0f0fu,
    0x11111111u, 0x33333333u, 0x55555555u, 0xffffffffu,
    0x00000001u, 0x00000003u, 0x00000006u, 0x00000009u,
    0x00000017u, 0x0000003au, 0x00000071u, 0x000000a3u,
    0x00000116u, 0x00000339u, 0x00000677u, 0x000009aau,
    0x00001601u, 0x00003903u, 0x00007706u, 0x0000aa09u,
    0x00010117u, 0x0003033au, 0x00060671u, 0x000909a3u,
    0x00171616u, 0x003a3939u, 0x00717777u, 0x00a3aaaau,
    0x01170001u, 0x033a0003u, 0x06710006u, 0x09a30009u,
    0x16160017u, 0x3939003au, 0x77770071u, 0xaaaa00a3u,
    0x00000001u, 0x00000003u, 0x00000004u, 0x0000000au,
    0x0000001fu, 0x0000002eu, 0x00000045u, 0x000000c9u,
    0x0000011bu, 0x000002a4u, 0x0000079au, 0x00000b67u,
    0x0000101eu, 0x0000302du, 0x00004041u, 0x0000a0c3u,
    0x0001f104u, 0x0002e28au, 0x000457dfu, 0x000c9baeu,
    0x0011a105u, 0x002a7289u, 0x0079e7dbu, 0x00b6dba4u,
    0x0100011au, 0x030002a7u, 0x0400079eu, 0x0a000b6du,
    0x1f001001u, 0x2e003003u, 0x45004004u, 0xc900a00au,
);

fn smp_rotate_left(value: u32, count: u32) -> u32 {
  return (value << count) | (value >> (32u - count));
}

// util/hash.h hash_uint: Bob Jenkins' lookup3 final mix.
fn smp_hash_uint(key: u32) -> u32 {
  var a = 0xdeadbeefu + 17u + key;
  var b = 0xdeadbeefu + 17u;
  var c = 0xdeadbeefu + 17u;
  c ^= b;
  c -= smp_rotate_left(b, 14u);
  a ^= c;
  a -= smp_rotate_left(c, 11u);
  b ^= a;
  b -= smp_rotate_left(a, 25u);
  c ^= b;
  c -= smp_rotate_left(b, 16u);
  a ^= c;
  a -= smp_rotate_left(c, 4u);
  b ^= a;
  b -= smp_rotate_left(a, 14u);
  c ^= b;
  c -= smp_rotate_left(b, 24u);
  return c;
}

// util/hash.h hash_hp_uint: the Hash Prospector mixing function.
fn smp_hash_hp_uint(value: u32) -> u32 {
  var mixed = value;
  mixed ^= mixed >> 16u;
  mixed *= 0x21f0aaadu;
  mixed ^= mixed >> 15u;
  mixed *= 0xd35a2d97u;
  mixed ^= mixed >> 15u;
  return mixed ^ 0xe6fe3bebu;
}

// kernel/sample/util.h reversed_bit_owen.
fn smp_reversed_bit_owen(value: u32, seed: u32) -> u32 {
  var scrambled = value;
  scrambled ^= scrambled * 0x3d20adeau;
  scrambled += seed;
  scrambled *= (seed >> 16u) | 1u;
  scrambled ^= scrambled * 0x05526c56u;
  scrambled ^= scrambled * 0x53a22864u;
  return scrambled;
}

fn smp_reversed_bit_owen_base4(value: u32, seed: u32) -> u32 {
  var scrambled = value;
  scrambled ^= scrambled * 0x3d20adeau;
  scrambled ^= (scrambled >> 1u) & (scrambled << 1u) & 0x55555555u;
  scrambled += seed;
  scrambled *= (seed >> 16u) | 1u;
  scrambled ^= (scrambled >> 1u) & (scrambled << 1u) & 0x55555555u;
  scrambled ^= scrambled * 0x05526c56u;
  scrambled ^= scrambled * 0x53a22864u;
  return scrambled;
}

fn smp_nested_uniform_scramble_base4(value: u32, seed: u32) -> u32 {
  return reverseBits(smp_reversed_bit_owen_base4(reverseBits(value), seed));
}

fn smp_expand_bits(value: u32) -> u32 {
  var expanded = value & 0x0000ffffu;
  expanded = (expanded ^ (expanded << 8u)) & 0x00ff00ffu;
  expanded = (expanded ^ (expanded << 4u)) & 0x0f0f0f0fu;
  expanded = (expanded ^ (expanded << 2u)) & 0x33333333u;
  expanded = (expanded ^ (expanded << 1u)) & 0x55555555u;
  return expanded;
}

fn smp_morton_2d(x: u32, y: u32) -> u32 {
  return (smp_expand_bits(x) << 1u) | smp_expand_bits(y);
}

fn smp_uint_to_float_exclusive(value: u32) -> f32 {
  return f32(value) * SMP_UINT_TO_UNIT_FLOAT_EXCLUSIVE;
}

// kernel/sample/sobol_burley.h sobol_burley: one Owen-scrambled Sobol dimension (0 to 3) for a bit-reversed index.
fn smp_sobol_burley(reversed_index: u32, sobol_dimension: u32, scramble_seed: u32) -> f32 {
  var result = 0u;
  if (sobol_dimension == 0u) {
    result = reverseBits(reversed_index);
  } else {
    var remaining = reversed_index;
    var row_offset = (sobol_dimension - 1u) * 32u;
    while (remaining != 0u) {
      let leading_zeros = countLeadingZeros(remaining);
      result ^= SMP_SOBOL_TABLE[row_offset + leading_zeros];
      row_offset += leading_zeros + 1u;
      // Two shifts: a single shift by 32 would wrap instead of clearing the value.
      remaining <<= leading_zeros;
      remaining <<= 1u;
    }
  }
  result = reverseBits(smp_reversed_bit_owen(result, scramble_seed));
  return smp_uint_to_float_exclusive(result);
}

fn smp_shuffled_index(index: u32, seed: u32, shuffle_constant: u32) -> u32 {
  return smp_reversed_bit_owen(reverseBits(index), seed ^ shuffle_constant);
}

fn smp_sobol_burley_1d(index: u32, dimension: u32) -> f32 {
  let seed = smp_hash_hp_uint(dimension);
  let shuffled = smp_shuffled_index(index, seed, 0xbff95bfeu);
  return smp_sobol_burley(shuffled, 0u, seed ^ 0x635c77bdu);
}

fn smp_sobol_burley_2d(index: u32, dimension_set: u32) -> vec2<f32> {
  let seed = smp_hash_hp_uint(dimension_set);
  let shuffled = smp_shuffled_index(index, seed, 0xf8ade99au);
  return vec2<f32>(
    smp_sobol_burley(shuffled, 0u, seed ^ 0xe0aaaf76u),
    smp_sobol_burley(shuffled, 1u, seed ^ 0x94964d4eu),
  );
}

fn smp_sobol_burley_3d(index: u32, dimension_set: u32) -> vec3<f32> {
  let seed = smp_hash_hp_uint(dimension_set);
  let shuffled = smp_shuffled_index(index, seed, 0xcaa726acu);
  return vec3<f32>(
    smp_sobol_burley(shuffled, 0u, seed ^ 0x9e78e391u),
    smp_sobol_burley(shuffled, 1u, seed ^ 0x67c33241u),
    smp_sobol_burley(shuffled, 2u, seed ^ 0x78c395c5u),
  );
}

fn smp_sobol_burley_4d(index: u32, dimension_set: u32) -> vec4<f32> {
  let seed = smp_hash_hp_uint(dimension_set);
  let shuffled = smp_shuffled_index(index, seed, 0xc2c1a055u);
  return vec4<f32>(
    smp_sobol_burley(shuffled, 0u, seed ^ 0x39468210u),
    smp_sobol_burley(shuffled, 1u, seed ^ 0xe9d8a845u),
    smp_sobol_burley(shuffled, 2u, seed ^ 0x5f32b482u),
    smp_sobol_burley(shuffled, 3u, seed ^ 0x1524cc56u),
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
  state.pixel_sequence_start = 0u;
  state.use_sobol_burley = 0u;
  if ((kernel_params.kernel_flags & KERNEL_FLAG_WHITE_NOISE_SAMPLER) == 0u) {
    state.use_sobol_burley = 1u;
    let pixel_rank = smp_nested_uniform_scramble_base4(smp_morton_2d(pixel_x, pixel_y), smp_hash_uint(seed));
    state.pixel_sequence_start = pixel_rank * kernel_params.total_samples;
  }
  return state;
}

// Jumps to the dimension sets reserved for `slot` in path step `step`. The white sampler keeps its running counter.
fn smp_seek(state: ptr<function, SmpState>, step: u32, slot: u32) {
  if ((*state).use_sobol_burley != 0u) {
    (*state).dimension = (step + 1u) * SMP_SETS_PER_STEP + slot;
  }
}

fn smp_take_sobol_dimension(state: ptr<function, SmpState>) -> u32 {
  let dimension = (*state).dimension;
  (*state).dimension = dimension + 1u;
  return dimension;
}

fn smp_sequence_index(state: ptr<function, SmpState>) -> u32 {
  return (*state).sample_index + (*state).pixel_sequence_start;
}

fn smp_next_1d(state: ptr<function, SmpState>) -> f32 {
  if ((*state).use_sobol_burley != 0u) {
    return smp_sobol_burley_1d(smp_sequence_index(state), smp_take_sobol_dimension(state));
  }
  let words = smp_draw_words(state);
  return smp_word_to_unit_float(words.x);
}

fn smp_next_2d(state: ptr<function, SmpState>) -> vec2<f32> {
  if ((*state).use_sobol_burley != 0u) {
    return smp_sobol_burley_2d(smp_sequence_index(state), smp_take_sobol_dimension(state));
  }
  let words = smp_draw_words(state);
  return vec2<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
  );
}

fn smp_next_3d(state: ptr<function, SmpState>) -> vec3<f32> {
  if ((*state).use_sobol_burley != 0u) {
    return smp_sobol_burley_3d(smp_sequence_index(state), smp_take_sobol_dimension(state));
  }
  let words = smp_draw_words(state);
  return vec3<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
    smp_word_to_unit_float(words.z),
  );
}

fn smp_next_4d(state: ptr<function, SmpState>) -> vec4<f32> {
  if ((*state).use_sobol_burley != 0u) {
    return smp_sobol_burley_4d(smp_sequence_index(state), smp_take_sobol_dimension(state));
  }
  let words = smp_draw_words(state);
  return vec4<f32>(
    smp_word_to_unit_float(words.x),
    smp_word_to_unit_float(words.y),
    smp_word_to_unit_float(words.z),
    smp_word_to_unit_float(words.w),
  );
}

// `kernel_flags` value that makes `test_lobe_samples` write sampler values instead of lobe samples (tests only).
const SMP_PROBE_MODE: u32 = 100u;

// Probe: the pattern functions at sequence index `kernel_params.sample_offset + idx` and dimension set `kernel_params.seed`. Planes 0 and 1 hold the 4D
// sample and the 1D, 2D and first 3D components; plane 2 holds integer hashes as raw bits; plane 3 the rest of the 3D sample.
fn smp_write_probe(slot: u32, total: u32) {
  let idx = kernel_params.sample_offset + slot;
  let dimension_set = kernel_params.seed;
  let one_dimensional = smp_sobol_burley_1d(idx, dimension_set);
  let two_dimensional = smp_sobol_burley_2d(idx, dimension_set);
  let three_dimensional = smp_sobol_burley_3d(idx, dimension_set);
  let pixel_x = idx % 64u;
  let pixel_y = idx / 64u;
  film_accumulation[slot] = smp_sobol_burley_4d(idx, dimension_set);
  film_accumulation[total + slot] = vec4<f32>(one_dimensional, two_dimensional.x, two_dimensional.y, three_dimensional.x);
  film_accumulation[2u * total + slot] = bitcast<vec4<f32>>(vec4<u32>(
    smp_hash_uint(idx),
    smp_morton_2d(pixel_x, pixel_y),
    smp_nested_uniform_scramble_base4(idx, dimension_set),
    smp_hash_hp_uint(idx),
  ));
  film_accumulation[3u * total + slot] = vec4<f32>(three_dimensional.y, three_dimensional.z, 0.0, 0.0);
}
