/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2022 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_diffuse.h, kernel/closure/bsdf_oren_nayar.h, kernel/sample/mapping.h). */

const BSDF_DIFFUSE_HALF_PI: f32 = 1.5707963267948966;
const BSDF_DIFFUSE_QUARTER_PI: f32 = 0.7853981633974483;
const BSDF_DIFFUSE_TWO_THIRDS: f32 = 0.6666666666666666;
const BSDF_DIFFUSE_ONE_THIRD: f32 = 0.3333333333333333;
const BSDF_DIFFUSE_FLT_MIN: f32 = 1.17549435e-38;

struct BsdfDiffuseEval {
  value: vec3<f32>,
  pdf: f32,
}

struct BsdfDiffuseSample {
  wi: vec3<f32>,
  pdf: f32,
  eval: vec3<f32>,
}

fn bsdf_diffuse_make_orthonormals(normal: vec3<f32>) -> mat2x3<f32> {
  if (normal.z < -0.9999999) {
    return mat2x3<f32>(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0));
  }
  let denom_inv = 1.0 / (1.0 + normal.z);
  let cross_term = -normal.x * normal.y * denom_inv;
  let tangent = vec3<f32>(1.0 - normal.x * normal.x * denom_inv, cross_term, -normal.x);
  let bitangent = vec3<f32>(cross_term, 1.0 - normal.y * normal.y * denom_inv, -normal.y);
  return mat2x3<f32>(tangent, bitangent);
}

fn bsdf_diffuse_sample_uniform_disk(rand: vec2<f32>) -> vec2<f32> {
  let mapped_x = 2.0 * rand.x - 1.0;
  let mapped_y = 2.0 * rand.y - 1.0;
  if (mapped_x == 0.0 && mapped_y == 0.0) {
    return vec2<f32>(0.0);
  }
  var radius = 0.0;
  var phi = 0.0;
  if (mapped_x * mapped_x > mapped_y * mapped_y) {
    radius = mapped_x;
    phi = BSDF_DIFFUSE_QUARTER_PI * (mapped_y / mapped_x);
  } else {
    radius = mapped_y;
    phi = BSDF_DIFFUSE_HALF_PI - BSDF_DIFFUSE_QUARTER_PI * (mapped_x / mapped_y);
  }
  return vec2<f32>(radius * cos(phi), radius * sin(phi));
}

fn bsdf_diffuse_sample_cos_hemisphere(normal: vec3<f32>, rand: vec2<f32>) -> vec4<f32> {
  let disk = bsdf_diffuse_sample_uniform_disk(rand);
  let cos_theta = sqrt(max(0.0, 1.0 - dot(disk, disk)));
  let frame = bsdf_diffuse_make_orthonormals(normal);
  let direction = disk.x * frame[0] + disk.y * frame[1] + cos_theta * normal;
  let pdf = cos_theta * INV_PI;
  return vec4<f32>(direction, pdf);
}

fn bsdf_diffuse_oren_nayar_g(cos_theta: f32) -> f32 {
  let clamped_cos = clamp(cos_theta, 0.0, 1.0);
  if (clamped_cos < 1e-3) {
    let c3 = clamped_cos * clamped_cos * clamped_cos;
    return (BSDF_DIFFUSE_HALF_PI - BSDF_DIFFUSE_TWO_THIRDS) - clamped_cos + 0.5 * c3;
  }
  let sin_theta = sqrt(max(0.0, 1.0 - clamped_cos * clamped_cos));
  let theta = acos(clamped_cos);
  let sin_cubed = sin_theta * sin_theta * sin_theta;
  let first = sin_theta * (theta - BSDF_DIFFUSE_TWO_THIRDS - sin_theta * clamped_cos);
  let second = BSDF_DIFFUSE_TWO_THIRDS * (sin_theta / clamped_cos) * (1.0 - sin_cubed);
  return first + second;
}

fn bsdf_diffuse_setup_lobe(
  normal: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  base_color: vec3<f32>,
  roughness: f32,
) -> Lobe {
  var lobe: Lobe;
  let clamped_roughness = clamp(roughness, 0.0, 1.0);
  let clamped_albedo = clamp(base_color, vec3<f32>(0.0), vec3<f32>(1.0));
  lobe.weight = weight;
  lobe.sample_weight = (weight.x + weight.y + weight.z) * BSDF_DIFFUSE_ONE_THIRD;
  lobe.normal = normal;
  lobe.lobe_type = LOBE_DIFFUSE;
  lobe.tangent = vec3<f32>(0.0);
  lobe.flags = 0u;
  lobe.f0 = clamped_albedo;
  lobe.ior = 1.0;
  lobe.diffuse_roughness = clamped_roughness;
  lobe.thin_film_thickness = 0.0;
  lobe.thin_film_ior = 0.0;

  if (clamped_roughness < 1e-5) {
    lobe.alpha_x = INV_PI;
    lobe.alpha_y = 0.0;
    lobe.f82_or_tint = vec3<f32>(0.0);
    return lobe;
  }

  let coeff_a = 1.0 / (PI + clamped_roughness * (BSDF_DIFFUSE_HALF_PI - BSDF_DIFFUSE_TWO_THIRDS));
  let coeff_b = clamped_roughness * coeff_a;
  let e_avg = coeff_a * PI + ((TWO_PI - 5.6) * BSDF_DIFFUSE_ONE_THIRD) * coeff_b;
  let one_minus_e_avg = 1.0 - e_avg;
  let ms_denom = max(vec3<f32>(1.0) - clamped_albedo * one_minus_e_avg, vec3<f32>(1e-6));
  let e_ms = INV_PI * clamped_albedo * (e_avg / max(one_minus_e_avg, 1e-6)) / ms_denom;
  let cos_no = max(dot(normal, wo), 0.0);
  let e_v = coeff_a * PI + coeff_b * bsdf_diffuse_oren_nayar_g(cos_no);

  lobe.alpha_x = coeff_a;
  lobe.alpha_y = coeff_b;
  lobe.f82_or_tint = e_ms * (1.0 - e_v);
  return lobe;
}

fn bsdf_diffuse_eval(lobe: ptr<function, Lobe>, wi: vec3<f32>, wo: vec3<f32>) -> BsdfDiffuseEval {
  let cos_ni = dot((*lobe).normal, wi);
  if (cos_ni <= 0.0) {
    return BsdfDiffuseEval(vec3<f32>(0.0), 0.0);
  }
  let pdf = cos_ni * INV_PI;
  if ((*lobe).alpha_y <= 0.0) {
    return BsdfDiffuseEval((*lobe).weight * pdf, pdf);
  }

  let cos_no = max(dot((*lobe).normal, wo), 0.0);
  var s_term = dot(wi, wo) - cos_ni * cos_no;
  if (s_term > 0.0) {
    s_term = s_term / (max(cos_ni, cos_no) + BSDF_DIFFUSE_FLT_MIN);
  }
  let single_scatter = (*lobe).alpha_x + (*lobe).alpha_y * s_term;
  let e_l = (*lobe).alpha_x * PI + (*lobe).alpha_y * bsdf_diffuse_oren_nayar_g(cos_ni);
  let multi_scatter = (*lobe).f82_or_tint * (1.0 - e_l);
  let intensity = cos_ni * (vec3<f32>(single_scatter) + multi_scatter);
  return BsdfDiffuseEval((*lobe).weight * intensity, pdf);
}

fn bsdf_diffuse_sample(
  lobe: ptr<function, Lobe>,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfDiffuseSample {
  let sampled = bsdf_diffuse_sample_cos_hemisphere((*lobe).normal, rand);
  let wi = sampled.xyz;
  if (sampled.w <= 0.0 || dot(geometric_normal, wi) <= 0.0) {
    return BsdfDiffuseSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0));
  }
  let evaluated = bsdf_diffuse_eval(lobe, wi, wo);
  return BsdfDiffuseSample(wi, evaluated.pdf, evaluated.value);
}
