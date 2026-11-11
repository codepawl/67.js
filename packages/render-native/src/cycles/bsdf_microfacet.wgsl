/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_microfacet.h, kernel/closure/bsdf_util.h, kernel/util/lookup_table.h). */

const BSDF_MF_SPECULAR_THRESHOLD: f32 = 2e-10;
const BSDF_MF_SINGULAR_WEIGHT: f32 = 1e6;
const BSDF_MF_THINFILM_CUTOFF: f32 = 0.1;
const BSDF_MF_ONE_THIRD: f32 = 0.3333333333333333;
const BSDF_MF_INV_255: f32 = 0.00392156862745098;
const BSDF_MF_INV_65535: f32 = 1.5259021896696422e-5;
const BSDF_MF_THIN_FILM_SIZE: i32 = 512;

const CYCLES_LUT_OFFSET_BSDF_MF_LUT_SMALL_U32: u32 = 17408u;

fn bsdf_mf_lut_small_u32(word_idx: u32) -> u32 {
  return cycles_lut[CYCLES_LUT_OFFSET_BSDF_MF_LUT_SMALL_U32 + word_idx];
}

const CYCLES_LUT_OFFSET_BSDF_MF_LUT_THIN_FILM_RGB: u32 = 18448u;

fn bsdf_mf_lut_thin_film_rgb(elem_idx: u32) -> vec3<u32> {
  let base = CYCLES_LUT_OFFSET_BSDF_MF_LUT_THIN_FILM_RGB + elem_idx * 3u;
  return vec3<u32>(cycles_lut[base], cycles_lut[base + 1u], cycles_lut[base + 2u]);
}

const CYCLES_LUT_OFFSET_BSDF_MF_LUT_IOR_S_U32: u32 = 19984u;

fn bsdf_mf_lut_ior_s_u32(word_idx: u32) -> u32 {
  return cycles_lut[CYCLES_LUT_OFFSET_BSDF_MF_LUT_IOR_S_U32 + word_idx];
}

struct BsdfMfEval {
  value: vec3<f32>,
  pdf: f32,
}

struct BsdfMfSample {
  wi: vec3<f32>,
  pdf: f32,
  eval: vec3<f32>,
  is_singular: bool,
}

struct BsdfMfPolarizedFresnel {
  reflectance: vec2<f32>,
  cos_theta_t: f32,
  phasor_real: vec2<f32>,
  is_tir: bool,
}

struct BsdfMfConductorPolarized {
  reflectance: vec2<f32>,
  phasor_s: vec2<f32>,
  phasor_p: vec2<f32>,
}

struct BsdfMfSpecularSetup {
  lobe: Lobe,
  layer_albedo: vec3<f32>,
}

fn bsdf_mf_sqr(x: f32) -> f32 {
  return x * x;
}

fn bsdf_mf_average(v: vec3<f32>) -> f32 {
  return (v.x + v.y + v.z) * BSDF_MF_ONE_THIRD;
}

fn bsdf_mf_max_component(v: vec3<f32>) -> f32 {
  return max(v.x, max(v.y, v.z));
}

fn bsdf_mf_inverse_lerp(a: f32, b: f32, x: f32) -> f32 {
  let denom = b - a;
  if (abs(denom) < 1e-8) {
    return 0.0;
  }
  return (x - a) / denom;
}

fn bsdf_mf_is_singular(alpha_x: f32, alpha_y: f32) -> bool {
  return (alpha_x * alpha_y) <= BSDF_MF_SPECULAR_THRESHOLD;
}

fn bsdf_mf_alpha_to_roughness_index(alpha_x: f32, alpha_y: f32) -> f32 {
  return sqrt(sqrt(max(alpha_x * alpha_y, 0.0)));
}

fn bsdf_mf_ior_to_z_index(ior: f32) -> f32 {
  return sqrt(abs((ior - 1.0) / max(ior + 1.0, 1e-6)));
}

fn bsdf_mf_mu_to_y_index(mu: f32) -> f32 {
  return sqrt(max(mu, 0.0));
}

fn bsdf_mf_fetch_small_u16(word_base: u32, elem_idx: u32) -> f32 {
  let word = bsdf_mf_lut_small_u32(word_base + (elem_idx >> 1u));
  let shift = (elem_idx & 1u) * 16u;
  return f32((word >> shift) & 0xFFFFu) * BSDF_MF_INV_65535;
}

fn bsdf_mf_read_ggx_eavg(x: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let i0 = min(u32(sx), 31u);
  let i1 = min(i0 + 1u, 31u);
  let tx = sx - f32(i0);
  let limit = 2u;
  var res = 0.0;
  for (var k: u32 = 0u; k < limit; k = k + 1u) {
    let idx = select(i0, i1, k == 1u);
    let w = select(1.0 - tx, tx, k == 1u);
    res = res + w * bsdf_mf_fetch_small_u16(512u, idx);
  }
  return res;
}

fn bsdf_mf_read_2d_small_u16(word_base: u32, x: f32, y: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let limit = 4u;
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    res = res + (wx * wy) * bsdf_mf_fetch_small_u16(word_base, cy * 32u + cx);
  }
  return res;
}

fn bsdf_mf_read_ggx_e(x: f32, y: f32) -> f32 {
  return bsdf_mf_read_2d_small_u16(0u, x, y);
}

fn bsdf_mf_read_gen_schlick_s(x: f32, y: f32, _z_unused: f32) -> f32 {
  return bsdf_mf_read_2d_small_u16(528u, x, y);
}

fn bsdf_mf_read_gen_schlick_ior_s(x: f32, y: f32, z: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let sz = clamp(z, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let z0 = min(u32(sz), 31u);
  let z1 = min(z0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let tz = sz - f32(z0);
  let limit = 8u;
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let cz = select(z0, z1, (corner & 4u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    let wz = select(1.0 - tz, tz, (corner & 4u) != 0u);
    let byte_idx = (cz * 32u + cy) * 32u + cx;
    let word = bsdf_mf_lut_ior_s_u32(byte_idx >> 2u);
    let val = f32((word >> ((byte_idx & 3u) * 8u)) & 0xFFu) * BSDF_MF_INV_255;
    res = res + (wx * wy * wz) * val;
  }
  return res;
}

struct BsdfMfSens3M {
  re1: vec3<f32>,
  im1: vec3<f32>,
  re2: vec3<f32>,
  im2: vec3<f32>,
  re3: vec3<f32>,
  im3: vec3<f32>,
}

fn bsdf_mf_iridescence_sensitivities_3m(opd: f32) -> BsdfMfSens3M {
  var out = BsdfMfSens3M(
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
  );
  let max_idx = u32(BSDF_MF_THIN_FILM_SIZE - 1);
  let scale = f32(BSDF_MF_THIN_FILM_SIZE - 1);
  let limit = 6u;
  for (var q: u32 = 0u; q < limit; q = q + 1u) {
    let m_idx = (q >> 1u) + 1u;
    let is_hi = (q & 1u) != 0u;
    let x = clamp(TWO_PI * (f32(m_idx) * opd) / 60000.0, 0.0, 1.0) * scale;
    let i0 = min(u32(x), max_idx);
    let i1 = min(i0 + 1u, max_idx);
    let tx = x - f32(i0);
    let idx = select(i0, i1, is_hi);
    let w = select(1.0 - tx, tx, is_hi);
    let packed = bsdf_mf_lut_thin_film_rgb(idx);
    let sr = unpack2x16float(packed.x);
    let sg = unpack2x16float(packed.y);
    let sb = unpack2x16float(packed.z);
    let re = vec3<f32>(sr.x, sg.x, sb.x) * w;
    let im = vec3<f32>(sr.y, sg.y, sb.y) * w;
    if (m_idx == 1u) {
      out.re1 = out.re1 + re;
      out.im1 = out.im1 + im;
    } else if (m_idx == 2u) {
      out.re2 = out.re2 + re;
      out.im2 = out.im2 + im;
    } else {
      out.re3 = out.re3 + re;
      out.im3 = out.im3 + im;
    }
  }
  return out;
}

fn bsdf_mf_complex_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn bsdf_mf_make_orthonormals(normal: vec3<f32>) -> mat2x3<f32> {
  var axis_a = vec3<f32>(normal.z - normal.y, normal.x - normal.z, normal.y - normal.x);
  if (normal.x == normal.y && normal.x == normal.z) {
    axis_a = vec3<f32>(normal.z - normal.y, normal.x + normal.z, -normal.y - normal.x);
  }
  let tangent = normalize(axis_a);
  let bitangent = cross(normal, tangent);
  return mat2x3<f32>(tangent, bitangent);
}

fn bsdf_mf_make_orthonormals_tangent(normal: vec3<f32>, tangent: vec3<f32>) -> mat2x3<f32> {
  let raw_b = cross(normal, tangent);
  let len_sq = dot(raw_b, raw_b);
  if (len_sq < 1e-8) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let bitangent = raw_b * inverseSqrt(len_sq);
  let ortho_tangent = cross(bitangent, normal);
  return mat2x3<f32>(ortho_tangent, bitangent);
}

fn bsdf_mf_rotate_around_axis(vec: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let cos_a = cos(angle);
  let sin_a = sin(angle);
  let one_minus_cos = 1.0 - cos_a;
  let rx = (cos_a + one_minus_cos * axis.x * axis.x) * vec.x
    + (one_minus_cos * axis.x * axis.y - axis.z * sin_a) * vec.y
    + (one_minus_cos * axis.x * axis.z + axis.y * sin_a) * vec.z;
  let ry = (one_minus_cos * axis.x * axis.y + axis.z * sin_a) * vec.x
    + (cos_a + one_minus_cos * axis.y * axis.y) * vec.y
    + (one_minus_cos * axis.y * axis.z - axis.x * sin_a) * vec.z;
  let rz = (one_minus_cos * axis.x * axis.z - axis.y * sin_a) * vec.x
    + (one_minus_cos * axis.y * axis.z + axis.x * sin_a) * vec.y
    + (cos_a + one_minus_cos * axis.z * axis.z) * vec.z;
  return vec3<f32>(rx, ry, rz);
}

fn bsdf_mf_safe_normalize_fallback(vec: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let len_sq = dot(vec, vec);
  if (len_sq > 1e-16) {
    return vec * inverseSqrt(len_sq);
  }
  return fallback;
}

fn bsdf_mf_ensure_valid_specular_reflection(
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  shading_normal: vec3<f32>,
) -> vec3<f32> {
  if (all(geometric_normal == shading_normal)) {
    return shading_normal;
  }
  let iz = dot(wo, geometric_normal);
  if (iz <= 0.0) {
    return shading_normal;
  }
  let reflected = 2.0 * dot(shading_normal, wo) * shading_normal - wo;
  let threshold = min(0.9 * iz, 0.01);
  if (dot(geometric_normal, reflected) >= threshold) {
    return shading_normal;
  }
  let ortho = shading_normal - dot(shading_normal, geometric_normal) * geometric_normal;
  let axis_x = bsdf_mf_safe_normalize_fallback(ortho, shading_normal);
  let ix = dot(wo, axis_x);
  let coeff_a = max(ix * ix + iz * iz, 1e-12);
  let coeff_b = 2.0 * (coeff_a + iz * threshold);
  let coeff_c = bsdf_mf_sqr(threshold + iz);
  let disc = sqrt(max(0.0, coeff_b * coeff_b - 4.0 * coeff_a * coeff_c));
  var nz2 = 0.25 * (coeff_b - disc) / coeff_a;
  if (ix < 0.0) {
    nz2 = 0.25 * (coeff_b + disc) / coeff_a;
  }
  let nx = sqrt(max(0.0, 1.0 - nz2));
  let nz = sqrt(max(0.0, nz2));
  return bsdf_mf_safe_normalize_fallback(nx * axis_x + nz * geometric_normal, geometric_normal);
}

fn bsdf_mf_f0_from_ior(ior: f32) -> f32 {
  return bsdf_mf_sqr((ior - 1.0) / max(ior + 1.0, 1e-6));
}

fn bsdf_mf_ior_from_f0(f0: f32) -> f32 {
  let sqrt_f0 = sqrt(clamp(f0, 0.0, 0.99));
  return (1.0 + sqrt_f0) / (1.0 - sqrt_f0);
}

fn bsdf_mf_fresnel_dielectric_polarized(cos_theta_i: f32, eta: f32) -> BsdfMfPolarizedFresnel {
  let eta_cos_t_sq = eta * eta - (1.0 - cos_theta_i * cos_theta_i);
  if (eta_cos_t_sq <= 0.0) {
    return BsdfMfPolarizedFresnel(vec2<f32>(1.0), 0.0, vec2<f32>(1.0), true);
  }
  let cos_i = abs(cos_theta_i);
  let cos_t = -sqrt(max(0.0, eta_cos_t_sq)) / eta;
  let r_s = (cos_i + eta * cos_t) / max(abs(cos_i - eta * cos_t), 1e-12) * sign(cos_i - eta * cos_t);
  let r_p = (cos_t + eta * cos_i) / max(abs(eta * cos_i - cos_t), 1e-12) * sign(eta * cos_i - cos_t);
  let ph_s = select(-1.0, 1.0, r_s >= 0.0);
  let ph_p = select(-1.0, 1.0, r_p >= 0.0);
  return BsdfMfPolarizedFresnel(vec2<f32>(r_s * r_s, r_p * r_p), cos_t, vec2<f32>(ph_s, ph_p), false);
}

fn bsdf_mf_fresnel_dielectric(cos_theta_i: f32, eta: f32) -> vec2<f32> {
  let pol = bsdf_mf_fresnel_dielectric_polarized(cos_theta_i, eta);
  let f = 0.5 * (pol.reflectance.x + pol.reflectance.y);
  return vec2<f32>(f, pol.cos_theta_t);
}

fn bsdf_mf_fresnel_dielectric_cos(cos_i: f32, eta: f32) -> f32 {
  return bsdf_mf_fresnel_dielectric(cos_i, eta).x;
}

fn bsdf_mf_fresnel_dielectric_fss(eta: f32) -> f32 {
  if (eta < 1.0) {
    return 0.997118 + eta * (0.1014 - eta * (0.965241 + eta * 0.130607));
  }
  return (eta - 1.0) / (4.08567 + 1.00071 * eta);
}

fn bsdf_mf_fresnel_f82tint_b(f0: vec3<f32>, tint: vec3<f32>) -> vec3<f32> {
  let f = 6.0 / 7.0;
  let f5 = f * f * f * f * f;
  let f_schlick = mix(f0, vec3<f32>(1.0), f5);
  return f_schlick * (7.0 / (f5 * f)) * (vec3<f32>(1.0) - tint);
}

fn bsdf_mf_fresnel_f82_b_scalar(f0: f32, f82: f32) -> f32 {
  let f = 6.0 / 7.0;
  let f5 = f * f * f * f * f;
  let f_schlick = mix(f0, 1.0, f5);
  return (7.0 / (f5 * f)) * (f_schlick - f82);
}

fn bsdf_mf_fresnel_f82_fss(f0: vec3<f32>, b_term: vec3<f32>) -> vec3<f32> {
  return mix(f0, vec3<f32>(1.0), 1.0 / 21.0) - b_term * (1.0 / 126.0);
}

fn bsdf_mf_fresnel_f82(cos_i: f32, f0: vec3<f32>, b_term: vec3<f32>) -> vec3<f32> {
  let s = clamp(1.0 - cos_i, 0.0, 1.0);
  let s5 = s * s * s * s * s;
  let f_schlick = mix(f0, vec3<f32>(1.0), s5);
  return clamp(f_schlick - b_term * cos_i * (s5 * s), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn bsdf_mf_fresnel_f82_scalar(cos_i: f32, f0: f32, b_term: f32) -> f32 {
  let s = clamp(1.0 - cos_i, 0.0, 1.0);
  let s5 = s * s * s * s * s;
  let f_schlick = mix(f0, 1.0, s5);
  return clamp(f_schlick - b_term * cos_i * (s5 * s), 0.0, 1.0);
}

fn bsdf_mf_fresnel_conductor_polarized(
  cos_i: f32,
  ambient_ior: f32,
  eta2: f32,
  k2: f32,
  f82_override: f32,
) -> BsdfMfConductorPolarized {
  let eta1 = ambient_ior;
  let eta1_sq = eta1 * eta1;
  let eta2_sq = eta2 * eta2;
  let k2_sq = k2 * k2;
  let two_eta2_k2 = 2.0 * eta2 * k2;
  let t1 = eta2_sq - k2_sq - eta1_sq * (1.0 - cos_i * cos_i);
  let t2 = sqrt(t1 * t1 + two_eta2_k2 * two_eta2_k2);
  let u_sq = max(0.5 * (t2 + t1), 0.0);
  let v_sq = max(0.5 * (t2 - t1), 0.0);
  let u_val = sqrt(u_sq);
  let v_val = sqrt(v_sq);

  var r_s = 0.0;
  var r_p = 0.0;
  if (f82_override >= 0.0) {
    let n_rel = eta2 / max(eta1, 1e-6);
    let k_sq = bsdf_mf_sqr(k2 / max(eta1, 1e-6));
    let f0 = (bsdf_mf_sqr(n_rel - 1.0) + k_sq) / max(bsdf_mf_sqr(n_rel + 1.0) + k_sq, 1e-12);
    r_s = bsdf_mf_fresnel_f82_scalar(cos_i, f0, bsdf_mf_fresnel_f82_b_scalar(f0, f82_override));
    r_p = r_s;
  } else {
    let denom_s = bsdf_mf_sqr(eta1 * cos_i + u_val) + v_sq;
    r_s = select(0.0, (bsdf_mf_sqr(eta1 * cos_i - u_val) + v_sq) / denom_s, denom_s != 0.0);
    let t3 = (eta2_sq - k2_sq) * cos_i;
    let t4 = two_eta2_k2 * cos_i;
    let denom_p = bsdf_mf_sqr(t3 + eta1 * u_val) + bsdf_mf_sqr(t4 + eta1 * v_val);
    r_p = select(0.0, (bsdf_mf_sqr(t3 - eta1 * u_val) + bsdf_mf_sqr(t4 - eta1 * v_val)) / denom_p, denom_p != 0.0);
  }

  let re_s = -u_sq - v_sq + bsdf_mf_sqr(eta1 * cos_i);
  let im_s = -2.0 * eta1 * cos_i * v_val;
  let mag_s = sqrt(re_s * re_s + im_s * im_s);
  let phasor_s = select(vec2<f32>(re_s / max(mag_s, 1e-12), im_s / max(mag_s, 1e-12)), vec2<f32>(1.0, 0.0), mag_s == 0.0);

  let re_p = bsdf_mf_sqr((eta2_sq + k2_sq) * cos_i) - eta1_sq * (u_sq + v_sq);
  let im_p = 2.0 * eta1 * cos_i * (two_eta2_k2 * u_val - (eta2_sq - k2_sq) * v_val);
  let mag_p = sqrt(re_p * re_p + im_p * im_p);
  let phasor_p = select(vec2<f32>(re_p / max(mag_p, 1e-12), im_p / max(mag_p, 1e-12)), vec2<f32>(1.0, 0.0), mag_p == 0.0);

  return BsdfMfConductorPolarized(vec2<f32>(r_s, r_p), phasor_s, phasor_p);
}

fn bsdf_mf_airy_rgb(
  r12: f32,
  r23: f32,
  phasor: vec2<f32>,
  sens: BsdfMfSens3M,
) -> vec3<f32> {
  let t121 = 1.0 - r12;
  let r123 = clamp(r12 * r23, 0.0, 0.999999);
  let root_r123 = sqrt(r123);
  let rs = (t121 * t121) * r23 / (1.0 - r123);
  let p1 = phasor;
  let p2 = bsdf_mf_complex_mul(p1, phasor);
  let p3 = bsdf_mf_complex_mul(p2, phasor);
  let c1 = (rs - t121) * root_r123;
  let c2 = c1 * root_r123;
  let c3 = c2 * root_r123;
  return vec3<f32>(rs + r12)
    + c1 * 2.0 * (p1.x * sens.re1 + p1.y * sens.im1)
    + c2 * 2.0 * (p2.x * sens.re2 + p2.y * sens.im2)
    + c3 * 2.0 * (p3.x * sens.re3 + p3.y * sens.im3);
}

fn bsdf_mf_iridescence_dielectric_rgb(
  film_thickness: f32,
  raw_film_ior: f32,
  substrate_ior: f32,
  cos_theta_1: f32,
) -> vec4<f32> {
  var film_ior = raw_film_ior;
  if (film_thickness < 1.0) {
    film_ior = mix(1.0, film_ior, smoothstep(0.0, 1.0, film_thickness));
  }
  let top = bsdf_mf_fresnel_dielectric_polarized(cos_theta_1, film_ior);
  if (top.is_tir) {
    return vec4<f32>(vec3<f32>(1.0), 0.0);
  }
  let bot = bsdf_mf_fresnel_dielectric_polarized(-top.cos_theta_t, substrate_ior / max(film_ior, 1e-6));
  if (bot.is_tir) {
    return vec4<f32>(vec3<f32>(1.0), 0.0);
  }
  let opd = -2.0 * film_ior * film_thickness * top.cos_theta_t;
  let sens = bsdf_mf_iridescence_sensitivities_3m(opd);
  let phasor_s = vec2<f32>(-top.phasor_real.x * bot.phasor_real.x, 0.0);
  let phasor_p = vec2<f32>(-top.phasor_real.y * bot.phasor_real.y, 0.0);
  let r_s = bsdf_mf_airy_rgb(top.reflectance.x, bot.reflectance.x, phasor_s, sens);
  let r_p = bsdf_mf_airy_rgb(top.reflectance.y, bot.reflectance.y, phasor_p, sens);
  return vec4<f32>(clamp(0.5 * (r_s + r_p), vec3<f32>(0.0), vec3<f32>(1.0)), bot.cos_theta_t);
}

fn bsdf_mf_iridescence_conductor_rgb(
  film_thickness: f32,
  raw_film_ior: f32,
  f0_vec: vec3<f32>,
  b_vec: vec3<f32>,
  cos_theta_1: f32,
) -> vec3<f32> {
  var film_ior = raw_film_ior;
  if (film_thickness < 1.0) {
    film_ior = mix(1.0, film_ior, smoothstep(0.0, 1.0, film_thickness));
  }
  let top = bsdf_mf_fresnel_dielectric_polarized(cos_theta_1, film_ior);
  if (top.is_tir) {
    return vec3<f32>(1.0);
  }
  let opd = -2.0 * film_ior * film_thickness * top.cos_theta_t;
  let sens = bsdf_mf_iridescence_sensitivities_3m(opd);
  var refl = vec3<f32>(0.0);
  for (var ch: i32 = 0; ch < 3; ch = ch + 1) {
    let f0_c = f0_vec[ch];
    let b_c = b_vec[ch];
    let r_c = min(f0_c, 0.999);
    let g_c = bsdf_mf_fresnel_f82_scalar(1.0 / 7.0, f0_c, b_c);
    let sqrt_r = sqrt(max(r_c, 0.0));
    let n_c = mix((1.0 + sqrt_r) / (1.0 - sqrt_r), (1.0 - r_c) / (1.0 + r_c), g_c);
    let k_c = sqrt(max(0.0, (r_c * bsdf_mf_sqr(n_c + 1.0) - bsdf_mf_sqr(n_c - 1.0)) / (1.0 - r_c)));
    let bot = bsdf_mf_fresnel_conductor_polarized(-top.cos_theta_t, film_ior, n_c, k_c, g_c);
    let phasor_s = bot.phasor_s * (-top.phasor_real.x);
    let phasor_p = bot.phasor_p * (-top.phasor_real.y);
    let r_s = bsdf_mf_airy_rgb(top.reflectance.x, bot.reflectance.x, phasor_s, sens)[ch];
    let r_p = bsdf_mf_airy_rgb(top.reflectance.y, bot.reflectance.y, phasor_p, sens)[ch];
    refl[ch] = clamp(0.5 * (r_s + r_p), 0.0, 1.0);
  }
  return refl;
}

fn bsdf_mf_generalized_schlick_eval(
  f0: vec3<f32>,
  ior: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  cos_theta_i: f32,
) -> vec4<f32> {
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let irid = bsdf_mf_iridescence_dielectric_rgb(thin_film_thickness, thin_film_ior, ior, cos_theta_i);
    var refl = irid.xyz;
    let f0_real = bsdf_mf_f0_from_ior(ior);
    if (f0_real > 1e-5 && any(refl != vec3<f32>(1.0))) {
      let s0 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.x), 0.0, 1.0);
      let s1 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.y), 0.0, 1.0);
      let s2 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.z), 0.0, 1.0);
      refl.x = refl.x * mix(1.0, f0.x / f0_real, s0);
      refl.y = refl.y * mix(1.0, f0.y / f0_real, s1);
      refl.z = refl.z * mix(1.0, f0.z / f0_real, s2);
    }
    return vec4<f32>(clamp(refl, vec3<f32>(0.0), vec3<f32>(1.0)), irid.w);
  }
  let diel = bsdf_mf_fresnel_dielectric(cos_theta_i, ior);
  let f0_real = bsdf_mf_f0_from_ior(ior);
  var s = 1.0;
  if (diel.x < 1.0) {
    s = clamp(bsdf_mf_inverse_lerp(f0_real, 1.0, diel.x), 0.0, 1.0);
  }
  let refl = mix(f0, vec3<f32>(1.0), s);
  return vec4<f32>(refl, diel.y);
}

fn bsdf_mf_eval_glossy_fresnel(lobe: Lobe, cos_theta_i: f32) -> vec3<f32> {
  if ((lobe.flags & LOBE_FLAG_F82_TINT) != 0u) {
    if ((lobe.flags & LOBE_FLAG_THIN_FILM) != 0u && lobe.thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
      return bsdf_mf_iridescence_conductor_rgb(
        lobe.thin_film_thickness,
        lobe.thin_film_ior,
        lobe.f0,
        lobe.f82_or_tint,
        cos_theta_i,
      );
    }
    return bsdf_mf_fresnel_f82(cos_theta_i, lobe.f0, lobe.f82_or_tint);
  }
  return bsdf_mf_generalized_schlick_eval(
    lobe.f0,
    lobe.ior,
    lobe.thin_film_thickness,
    lobe.thin_film_ior,
    cos_theta_i,
  ).xyz;
}

fn bsdf_mf_lambda(alpha2: f32, cos_n: f32) -> f32 {
  let cos2 = max(cos_n * cos_n, 1e-16);
  let sqr_alpha_tan = alpha2 * max(1.0 / cos2 - 1.0, 0.0);
  return 0.5 * (sqrt(1.0 + sqr_alpha_tan) - 1.0);
}

fn bsdf_mf_aniso_lambda(alpha_x: f32, alpha_y: f32, local_v: vec3<f32>) -> f32 {
  let vz2 = max(local_v.z * local_v.z, 1e-16);
  let sqr_alpha_tan = (bsdf_mf_sqr(alpha_x * local_v.x) + bsdf_mf_sqr(alpha_y * local_v.y)) / vz2;
  return 0.5 * (sqrt(1.0 + sqr_alpha_tan) - 1.0);
}

fn bsdf_mf_g1(alpha2: f32, cos_n: f32) -> f32 {
  return 1.0 / (1.0 + bsdf_mf_lambda(alpha2, cos_n));
}

fn bsdf_mf_d(alpha2: f32, cos_nh: f32, sin_nh2: f32) -> f32 {
  let cos_nh2 = min(cos_nh * cos_nh, 1.0);
  let clamped_sin2 = max(sin_nh2, 0.0);
  let denom_term = clamped_sin2 + alpha2 * cos_nh2;
  return alpha2 / max(PI * denom_term * denom_term, 1e-32);
}

fn bsdf_mf_aniso_d(alpha_x: f32, alpha_y: f32, local_h: vec3<f32>) -> f32 {
  let stretched = vec3<f32>(local_h.x / max(alpha_x, 1e-8), local_h.y / max(alpha_y, 1e-8), local_h.z);
  let len2 = dot(stretched, stretched);
  return INV_PI / max(alpha_x * alpha_y * len2 * len2, 1e-32);
}

fn bsdf_mf_sample_vndf(local_wo: vec3<f32>, alpha_x: f32, alpha_y: f32, rand: vec2<f32>) -> vec3<f32> {
  let wi_stretched = normalize(vec3<f32>(alpha_x * local_wo.x, alpha_y * local_wo.y, max(local_wo.z, 0.0)));
  let len_sq = wi_stretched.x * wi_stretched.x + wi_stretched.y * wi_stretched.y;
  var t1 = vec3<f32>(1.0, 0.0, 0.0);
  var t2 = vec3<f32>(0.0, 1.0, 0.0);
  if (len_sq > 1e-7) {
    t1 = vec3<f32>(-wi_stretched.y, wi_stretched.x, 0.0) * inverseSqrt(len_sq);
    t2 = cross(wi_stretched, t1);
  }
  var disk = bsdf_diffuse_sample_uniform_disk(rand);
  disk.y = mix(sqrt(max(0.0, 1.0 - disk.x * disk.x)), disk.y, 0.5 * (1.0 + wi_stretched.z));
  let disk_z = sqrt(max(0.0, 1.0 - dot(disk, disk)));
  let h_hemisphere = disk.x * t1 + disk.y * t2 + disk_z * wi_stretched;
  return normalize(vec3<f32>(alpha_x * h_hemisphere.x, alpha_y * h_hemisphere.y, max(0.0, h_hemisphere.z)));
}

fn bsdf_mf_albedo_coords(
  normal: vec3<f32>,
  _tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
) -> vec2<f32> {
  let cos_no = max(dot(wo, normal), 0.0);
  return vec2<f32>(
    bsdf_mf_alpha_to_roughness_index(alpha_x, alpha_y),
    bsdf_mf_mu_to_y_index(cos_no),
  );
}

fn bsdf_mf_albedo_avg_roughness(alpha_x: f32, alpha_y: f32) -> f32 {
  return bsdf_mf_alpha_to_roughness_index(alpha_x, alpha_y);
}

fn bsdf_mf_preserve_energy_glossy(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  fss: vec3<f32>,
) -> vec4<f32> {
  let coords = bsdf_mf_albedo_coords(normal, tangent, wo, alpha_x, alpha_y);
  let rough_avg = bsdf_mf_albedo_avg_roughness(alpha_x, alpha_y);
  let e_dir = max(bsdf_mf_read_ggx_e(coords.x, coords.y), 1e-5);
  let e_avg = clamp(bsdf_mf_read_ggx_eavg(rough_avg), 1e-5, 1.0);
  let missing_factor = (1.0 - e_dir) / e_dir;
  let energy_scale = 1.0 + missing_factor;
  if (all(fss == vec3<f32>(1.0))) {
    return vec4<f32>(vec3<f32>(1.0), energy_scale);
  }
  let denom = max(vec3<f32>(1.0) - fss * (1.0 - e_avg), vec3<f32>(1e-6));
  let fms = fss * e_avg / denom;
  let darkening = (vec3<f32>(1.0) + fms * missing_factor) / energy_scale;
  return vec4<f32>(darkening, energy_scale);
}

fn bsdf_mf_setup_conductor_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  f0_color: vec3<f32>,
  f82_tint: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> Lobe {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let f0 = clamp(f0_color, vec3<f32>(0.0), vec3<f32>(1.0));
  let tint = clamp(f82_tint, vec3<f32>(0.0), vec3<f32>(1.0));
  var b_term = vec3<f32>(0.0);
  if (any(tint != vec3<f32>(1.0))) {
    b_term = bsdf_mf_fresnel_f82tint_b(f0, tint);
  }

  var flags = LOBE_FLAG_F82_TINT;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLOSSY_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = 1.0;
  lobe.f82_or_tint = b_term;
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, max(thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(1.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    albedo_est = bsdf_mf_eval_glossy_fresnel(lobe, cos_no);
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let s = bsdf_mf_read_gen_schlick_s(coords.x, coords.y, 0.5);
    albedo_est = mix(f0, vec3<f32>(1.0), s);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let fss = clamp(bsdf_mf_fresnel_f82_fss(f0, b_term), vec3<f32>(0.0), vec3<f32>(1.0));
    let pres = bsdf_mf_preserve_energy_glossy(normal, tangent, wo, ax, ay, fss);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }
  return lobe;
}

fn bsdf_mf_setup_dielectric_specular_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  f0_color: vec3<f32>,
  eta: f32,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> BsdfMfSpecularSetup {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let f0 = clamp(f0_color, vec3<f32>(0.0), vec3<f32>(1.0));

  var flags = 0u;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLOSSY_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = eta;
  lobe.f82_or_tint = vec3<f32>(1.0);
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, max(thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(0.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    albedo_est = bsdf_mf_eval_glossy_fresnel(lobe, cos_no);
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let z = bsdf_mf_ior_to_z_index(eta);
    let s = bsdf_mf_read_gen_schlick_ior_s(coords.x, coords.y, z);
    albedo_est = mix(f0, vec3<f32>(1.0), s);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let f0_real = bsdf_mf_f0_from_ior(eta);
    let fss_real = bsdf_mf_fresnel_dielectric_fss(eta);
    let s_fss = clamp(bsdf_mf_inverse_lerp(f0_real, 1.0, fss_real), 0.0, 1.0);
    let fss = mix(f0, vec3<f32>(1.0), s_fss);
    let pres = bsdf_mf_preserve_energy_glossy(normal, tangent, wo, ax, ay, fss);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }

  let layer_albedo = lobe.weight * bsdf_mf_max_component(albedo_est);
  return BsdfMfSpecularSetup(lobe, layer_albedo);
}

fn bsdf_mf_eval(lobe: Lobe, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  let cos_no = dot(lobe.normal, wo);
  let cos_ni = dot(lobe.normal, wi);
  if (cos_no <= 0.0 || cos_ni <= 0.0 || bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y)) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let sum_dir = wo + wi;
  let sum_len_sq = dot(sum_dir, sum_dir);
  if (sum_len_sq <= 1e-16) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let half_vec = sum_dir * inverseSqrt(sum_len_sq);
  let cos_ho = dot(half_vec, wo);
  let cos_nh = dot(lobe.normal, half_vec);
  if (cos_ho <= 0.0 || cos_nh <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let fresnel = bsdf_mf_eval_glossy_fresnel(lobe, cos_ho);
  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    let cross_nh = cross(lobe.normal, half_vec);
    ndf = bsdf_mf_d(alpha2, cos_nh, dot(cross_nh, cross_nh));
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    let local_h = vec3<f32>(dot(frame[0], half_vec), dot(frame[1], half_vec), cos_nh);
    let local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let energy_scale = lobe.diffuse_roughness;
  let value = lobe.weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi)) * fresnel;
  return BsdfMfEval(value, pdf);
}

fn bsdf_mf_sample(
  lobe: Lobe,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfMfSample {
  let cos_no = dot(lobe.normal, wo);
  if (cos_no <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let singular = bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y);
  var half_vec = lobe.normal;
  var frame = mat2x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0));
  var local_wo = vec3<f32>(0.0, 0.0, cos_no);
  var local_h = vec3<f32>(0.0, 0.0, 1.0);

  if (!singular) {
    if (lobe.alpha_x == lobe.alpha_y) {
      frame = bsdf_mf_make_orthonormals(lobe.normal);
    } else {
      frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    }
    local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    local_h = bsdf_mf_sample_vndf(local_wo, lobe.alpha_x, lobe.alpha_y, rand);
    half_vec = local_h.x * frame[0] + local_h.y * frame[1] + local_h.z * lobe.normal;
  }

  let cos_ho = dot(half_vec, wo);
  if (cos_ho <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let wi = 2.0 * cos_ho * half_vec - wo;
  let cos_ni = dot(lobe.normal, wi);
  if (cos_ni <= 0.0 || dot(geometric_normal, wi) <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let fresnel = bsdf_mf_eval_glossy_fresnel(lobe, cos_ho);
  let energy_scale = lobe.diffuse_roughness;
  if (singular) {
    let eval_sing = lobe.weight * fresnel * (energy_scale * BSDF_MF_SINGULAR_WEIGHT);
    return BsdfMfSample(wi, BSDF_MF_SINGULAR_WEIGHT, eval_sing, true);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    ndf = bsdf_mf_d(alpha2, local_h.z, local_h.x * local_h.x + local_h.y * local_h.y);
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let eval_val = lobe.weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi)) * fresnel;
  return BsdfMfSample(wi, pdf, eval_val, false);
}
