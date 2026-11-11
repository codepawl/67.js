/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_microfacet.h: bsdf_coat_setup, slab_color_at_angle). */

const BSDF_COAT_SINGULAR_WEIGHT: f32 = 1e6;

struct BsdfCoatSetup {
  lobe: Lobe,
  layer_albedo: vec3<f32>,
}

fn bsdf_coat_slab_color_at_angle(color: vec3<f32>, cos_theta_i: f32, ior: f32) -> vec3<f32> {
  let sin_sq = 1.0 - cos_theta_i * cos_theta_i;
  let rad = max(ior * ior - sin_sq, 1e-6);
  let optical_depth = ior * inverseSqrt(rad);
  let safe_c = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec3<f32>(
    select(0.0, pow(safe_c.x, optical_depth), safe_c.x > 0.0),
    select(0.0, pow(safe_c.y, optical_depth), safe_c.y > 0.0),
    select(0.0, pow(safe_c.z, optical_depth), safe_c.z > 0.0),
  );
}

fn bsdf_coat_setup_lobe(
  geometric_normal: vec3<f32>,
  raw_coat_normal: vec3<f32>,
  wo: vec3<f32>,
  coat_weight_vec: vec3<f32>,
  coat_roughness: f32,
  coat_ior: f32,
  coat_tint: vec3<f32>,
  preserve_energy: bool,
) -> BsdfCoatSetup {
  let safe_ior = max(coat_ior, 1.0);
  let valid_n = bsdf_mf_ensure_valid_specular_reflection(geometric_normal, wo, raw_coat_normal);
  let clamped_r = clamp(coat_roughness, 0.0, 1.0);
  let alpha = clamp(clamped_r * clamped_r, 0.0, 1.0);
  let cos_no = max(dot(wo, valid_n), 0.0);

  var angled_tint = max(coat_tint, vec3<f32>(0.0));
  if (any(angled_tint != vec3<f32>(1.0))) {
    angled_tint = bsdf_coat_slab_color_at_angle(angled_tint, cos_no, safe_ior);
  }

  var albedo_scalar = bsdf_mf_fresnel_dielectric_cos(cos_no, safe_ior);
  if (safe_ior > 1.0) {
    let rough_idx = bsdf_mf_alpha_to_roughness_index(alpha, alpha);
    let y = bsdf_mf_mu_to_y_index(cos_no);
    let z = bsdf_mf_ior_to_z_index(safe_ior);
    let s = bsdf_mf_read_gen_schlick_ior_s(rough_idx, y, z);
    albedo_scalar = mix(bsdf_mf_f0_from_ior(safe_ior), 1.0, s);
  }

  var lobe: Lobe;
  lobe.weight = coat_weight_vec;
  lobe.sample_weight = bsdf_mf_average(coat_weight_vec) * albedo_scalar;
  lobe.normal = valid_n;
  lobe.lobe_type = LOBE_COAT_GGX;
  lobe.tangent = vec3<f32>(0.0);
  lobe.flags = 0u;
  lobe.f0 = vec3<f32>(bsdf_mf_f0_from_ior(safe_ior));
  lobe.ior = safe_ior;
  lobe.f82_or_tint = angled_tint;
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = alpha;
  lobe.alpha_y = alpha;
  lobe.thin_film_thickness = 0.0;
  lobe.thin_film_ior = 0.0;

  var coat_albedo = vec3<f32>(albedo_scalar);
  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let fss = vec3<f32>(bsdf_mf_fresnel_dielectric_fss(safe_ior));
    let pres = bsdf_mf_preserve_energy_glossy(valid_n, vec3<f32>(0.0), wo, alpha, alpha, fss);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
    coat_albedo = coat_albedo * pres.xyz;
  }

  let layer_albedo = (vec3<f32>(1.0) - angled_tint * (vec3<f32>(1.0) - coat_albedo)) * coat_weight_vec;
  return BsdfCoatSetup(lobe, layer_albedo);
}

fn bsdf_coat_eval(lobe: ptr<function, Lobe>, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  let cos_no = dot((*lobe).normal, wo);
  let cos_ni = dot((*lobe).normal, wi);
  if (cos_no <= 0.0 || cos_ni <= 0.0 || bsdf_mf_is_singular((*lobe).alpha_x, (*lobe).alpha_y)) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let sum_dir = wo + wi;
  let sum_len_sq = dot(sum_dir, sum_dir);
  if (sum_len_sq <= 1e-16) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let half_vec = sum_dir * inverseSqrt(sum_len_sq);
  let cos_ho = dot(half_vec, wo);
  let cos_nh = dot((*lobe).normal, half_vec);
  if (cos_ho <= 0.0 || cos_nh <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let fresnel = bsdf_mf_fresnel_dielectric_cos(cos_ho, (*lobe).ior);
  let alpha2 = (*lobe).alpha_x * (*lobe).alpha_y;
  let cross_nh = cross((*lobe).normal, half_vec);
  let ndf = bsdf_mf_d(alpha2, cos_nh, dot(cross_nh, cross_nh));
  let lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
  let lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let energy_scale = (*lobe).diffuse_roughness;
  let value = (*lobe).weight * (fresnel * energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfEval(value, pdf);
}

fn bsdf_coat_sample(
  lobe: ptr<function, Lobe>,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfMfSample {
  let cos_no = dot((*lobe).normal, wo);
  if (cos_no <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let singular = bsdf_mf_is_singular((*lobe).alpha_x, (*lobe).alpha_y);
  var half_vec = (*lobe).normal;
  var local_h = vec3<f32>(0.0, 0.0, 1.0);
  if (!singular) {
    let frame = bsdf_mf_make_orthonormals((*lobe).normal);
    let local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    local_h = bsdf_mf_sample_vndf(local_wo, (*lobe).alpha_x, (*lobe).alpha_y, rand);
    half_vec = local_h.x * frame[0] + local_h.y * frame[1] + local_h.z * (*lobe).normal;
  }
  let cos_ho = dot(half_vec, wo);
  if (cos_ho <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let wi = 2.0 * cos_ho * half_vec - wo;
  let cos_ni = dot((*lobe).normal, wi);
  if (cos_ni <= 0.0 || dot(geometric_normal, wi) <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let fresnel = bsdf_mf_fresnel_dielectric_cos(cos_ho, (*lobe).ior);
  let energy_scale = (*lobe).diffuse_roughness;
  if (singular) {
    let eval_sing = (*lobe).weight * (fresnel * energy_scale * BSDF_COAT_SINGULAR_WEIGHT);
    return BsdfMfSample(wi, BSDF_COAT_SINGULAR_WEIGHT, eval_sing, true);
  }
  let alpha2 = (*lobe).alpha_x * (*lobe).alpha_y;
  let ndf = bsdf_mf_d(alpha2, local_h.z, local_h.x * local_h.x + local_h.y * local_h.y);
  let lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
  let lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let eval_val = (*lobe).weight * (fresnel * energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfSample(wi, pdf, eval_val, false);
}
