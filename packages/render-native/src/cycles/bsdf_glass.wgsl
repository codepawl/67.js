/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_microfacet.h, kernel/closure/bsdf_util.h). */

const BSDF_GLASS_INV_255: f32 = 0.00392156862745098;
const BSDF_GLASS_INV_65535: f32 = 1.5259021896696422e-5;
const BSDF_GLASS_SINGULAR_WEIGHT: f32 = 1e6;

const CYCLES_LUT_OFFSET_BSDF_GLASS_LUT_E_U32: u32 = 0u;

fn bsdf_glass_lut_e_u32(word_idx: u32) -> u32 {
  return cycles_lut[CYCLES_LUT_OFFSET_BSDF_GLASS_LUT_E_U32 + word_idx];
}

const CYCLES_LUT_OFFSET_BSDF_GLASS_LUT_EAVG_U32: u32 = 16384u;

fn bsdf_glass_lut_eavg_u32(word_idx: u32) -> u32 {
  return cycles_lut[CYCLES_LUT_OFFSET_BSDF_GLASS_LUT_EAVG_U32 + word_idx];
}

struct BsdfGlassFresnel {
  reflectance: vec3<f32>,
  transmittance: vec3<f32>,
  cos_theta_t: f32,
}

fn bsdf_glass_read_e(x: f32, y: f32, z: f32, inverse_table: bool) -> f32 {
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
  let base_word = select(0u, 8192u, inverse_table);
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
    let word = bsdf_glass_lut_e_u32(base_word + (byte_idx >> 2u));
    let val = f32((word >> ((byte_idx & 3u) * 8u)) & 0xFFu) * BSDF_GLASS_INV_255;
    res = res + (wx * wy * wz) * val;
  }
  return res;
}

fn bsdf_glass_read_eavg(x: f32, z: f32, inverse_table: bool) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sz = clamp(z, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let z0 = min(u32(sz), 31u);
  let z1 = min(z0 + 1u, 31u);
  let tx = sx - f32(x0);
  let tz = sz - f32(z0);
  let base_word = select(0u, 512u, inverse_table);
  let limit = 4u;
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cz = select(z0, z1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wz = select(1.0 - tz, tz, (corner & 2u) != 0u);
    let elem_idx = cz * 32u + cx;
    let word = bsdf_glass_lut_eavg_u32(base_word + (elem_idx >> 1u));
    let val = f32((word >> ((elem_idx & 1u) * 16u)) & 0xFFFFu) * BSDF_GLASS_INV_65535;
    res = res + (wx * wz) * val;
  }
  return res;
}

fn bsdf_glass_refract_angle(incident: vec3<f32>, normal: vec3<f32>, cos_theta_t: f32, inv_eta: f32) -> vec3<f32> {
  return (inv_eta * dot(normal, incident) + cos_theta_t) * normal - inv_eta * incident;
}

fn bsdf_glass_fresnel(lobe: ptr<function, Lobe>, cos_theta_i: f32) -> BsdfGlassFresnel {
  let eval4 = bsdf_mf_generalized_schlick_eval(
    (*lobe).f0,
    (*lobe).ior,
    (*lobe).thin_film_thickness,
    (*lobe).thin_film_ior,
    cos_theta_i,
  );
  let refl = clamp(eval4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let trans = (*lobe).f82_or_tint * (vec3<f32>(1.0) - refl);
  return BsdfGlassFresnel(refl, trans, eval4.w);
}

fn bsdf_glass_preserve_energy(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  eta: f32,
  fss: vec3<f32>,
) -> vec4<f32> {
  let coords = bsdf_mf_albedo_coords(normal, tangent, wo, alpha_x, alpha_y);
  let rough_avg = bsdf_mf_albedo_avg_roughness(alpha_x, alpha_y);
  let is_inv = eta < 1.0;
  let lookup_ior = select(eta, 1.0 / max(eta, 1e-5), is_inv);
  let z = bsdf_mf_ior_to_z_index(lookup_ior);
  let e_dir = max(bsdf_glass_read_e(coords.x, coords.y, z, is_inv), 1e-4);
  let e_avg = clamp(bsdf_glass_read_eavg(rough_avg, z, is_inv), 1e-4, 1.0);
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

fn bsdf_glass_setup_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  material_ior: f32,
  front_face: u32,
  reflection_tint: vec3<f32>,
  transmission_tint: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> Lobe {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let safe_ior = max(material_ior, 1e-5);
  let eta = select(1.0 / safe_ior, safe_ior, front_face != 0u);
  let f0 = clamp(bsdf_mf_f0_from_ior(safe_ior) * max(reflection_tint, vec3<f32>(0.0)), vec3<f32>(0.0), vec3<f32>(1.0));
  let trans_tint = clamp(transmission_tint, vec3<f32>(0.0), vec3<f32>(1.0));

  var adj_film_ior = max(thin_film_ior, 1e-5);
  if (front_face == 0u) {
    adj_film_ior = adj_film_ior * eta;
  }

  var flags = 0u;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLASS_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = eta;
  lobe.f82_or_tint = trans_tint;
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, adj_film_ior, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(1.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let fr = bsdf_glass_fresnel(&lobe, cos_no);
    albedo_est = fr.reflectance + fr.transmittance;
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let z = bsdf_mf_ior_to_z_index(eta);
    let s = bsdf_mf_read_gen_schlick_ior_s(coords.x, coords.y, z);
    let f_est = mix(f0, vec3<f32>(1.0), s);
    albedo_est = f_est + trans_tint * (vec3<f32>(1.0) - f_est);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let pres = bsdf_glass_preserve_energy(normal, tangent, wo, ax, ay, eta, trans_tint);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }
  return lobe;
}

fn bsdf_glass_eval(lobe: ptr<function, Lobe>, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  let cos_no = dot((*lobe).normal, wo);
  let cos_ni = dot((*lobe).normal, wi);
  if (cos_no <= 0.0 || cos_ni == 0.0 || bsdf_mf_is_singular((*lobe).alpha_x, (*lobe).alpha_y)) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let is_transmission = cos_ni < 0.0;
  let eta = (*lobe).ior;
  if (is_transmission && abs(eta - 1.0) < 1e-4) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  var raw_h = wo + wi;
  if (is_transmission) {
    raw_h = select(-(eta * wi + wo), eta * wi + wo, eta < 1.0);
  }
  let len_h_sq = dot(raw_h, raw_h);
  if (len_h_sq <= 1e-16) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let inv_len_h = inverseSqrt(len_h_sq);
  let half_vec = raw_h * inv_len_h;

  let cos_nh = dot((*lobe).normal, half_vec);
  let cos_ho = dot(half_vec, wo);
  let cos_hi = dot(half_vec, wi);
  if (cos_nh <= 0.0 || cos_ho <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  if (is_transmission && cos_hi >= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let coeff = bsdf_glass_fresnel(lobe, cos_ho);
  let sum_avg = bsdf_mf_average(coeff.reflectance + coeff.transmittance);
  if (sum_avg <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if ((*lobe).alpha_x == (*lobe).alpha_y) {
    let alpha2 = (*lobe).alpha_x * (*lobe).alpha_y;
    let cross_nh = cross((*lobe).normal, half_vec);
    ndf = bsdf_mf_d(alpha2, cos_nh, dot(cross_nh, cross_nh));
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let frame = bsdf_mf_make_orthonormals_tangent((*lobe).normal, (*lobe).tangent);
    let local_h = vec3<f32>(dot(frame[0], half_vec), dot(frame[1], half_vec), cos_nh);
    let local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d((*lobe).alpha_x, (*lobe).alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda((*lobe).alpha_x, (*lobe).alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda((*lobe).alpha_x, (*lobe).alpha_y, local_wi);
  }

  var jacobian = 0.25;
  if (is_transmission) {
    jacobian = bsdf_mf_sqr(eta * inv_len_h) * abs(cos_ho * cos_hi);
  }
  let common_factor = (ndf / cos_no) * jacobian;
  let pdf_reflect = bsdf_mf_average(coeff.reflectance) / sum_avg;
  let lobe_pdf = select(pdf_reflect, 1.0 - pdf_reflect, is_transmission);
  let pdf = common_factor * lobe_pdf / (1.0 + lambda_wo);
  if (pdf <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let spec_weight = select(coeff.reflectance, coeff.transmittance, is_transmission);
  let energy_scale = (*lobe).diffuse_roughness;
  let value = (*lobe).weight * spec_weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfEval(value, pdf);
}

fn bsdf_glass_sample(
  lobe: ptr<function, Lobe>,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand_xy: vec2<f32>,
  rand_lobe: f32,
) -> BsdfMfSample {
  let cos_no = dot((*lobe).normal, wo);
  if (cos_no <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  var singular = bsdf_mf_is_singular((*lobe).alpha_x, (*lobe).alpha_y);
  var half_vec = (*lobe).normal;
  var frame = mat2x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0));
  var local_wo = vec3<f32>(0.0, 0.0, cos_no);
  var local_h = vec3<f32>(0.0, 0.0, 1.0);

  if (!singular) {
    if ((*lobe).alpha_x == (*lobe).alpha_y) {
      frame = bsdf_mf_make_orthonormals((*lobe).normal);
    } else {
      frame = bsdf_mf_make_orthonormals_tangent((*lobe).normal, (*lobe).tangent);
    }
    local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    local_h = bsdf_mf_sample_vndf(local_wo, (*lobe).alpha_x, (*lobe).alpha_y, rand_xy);
    half_vec = local_h.x * frame[0] + local_h.y * frame[1] + local_h.z * (*lobe).normal;
  }

  let cos_ho = dot(half_vec, wo);
  if (cos_ho <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let coeff = bsdf_glass_fresnel(lobe, cos_ho);
  let sum_avg = bsdf_mf_average(coeff.reflectance + coeff.transmittance);
  if (sum_avg <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let pdf_reflect = bsdf_mf_average(coeff.reflectance) / sum_avg;
  let do_refract = rand_lobe >= pdf_reflect;
  let eta = (*lobe).ior;
  let inv_eta = 1.0 / max(eta, 1e-6);

  var wi = 2.0 * cos_ho * half_vec - wo;
  if (do_refract) {
    wi = bsdf_glass_refract_angle(wo, half_vec, coeff.cos_theta_t, inv_eta);
  }

  let cos_ni = dot((*lobe).normal, wi);
  let cos_ngi = dot(geometric_normal, wi);
  if ((cos_ngi < 0.0) != do_refract || (cos_ni < 0.0) != do_refract || cos_ni == 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  var spec_weight = coeff.reflectance;
  var branch_pdf = pdf_reflect;
  if (do_refract) {
    spec_weight = coeff.transmittance;
    branch_pdf = 1.0 - pdf_reflect;
    singular = singular || (abs(eta - 1.0) < 1e-4);
  }
  if (branch_pdf <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let energy_scale = (*lobe).diffuse_roughness;
  if (singular) {
    let throughput = (*lobe).weight * (spec_weight / branch_pdf) * energy_scale;
    return BsdfMfSample(wi, BSDF_GLASS_SINGULAR_WEIGHT, throughput * BSDF_GLASS_SINGULAR_WEIGHT, true);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if ((*lobe).alpha_x == (*lobe).alpha_y) {
    let alpha2 = (*lobe).alpha_x * (*lobe).alpha_y;
    ndf = bsdf_mf_d(alpha2, local_h.z, local_h.x * local_h.x + local_h.y * local_h.y);
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d((*lobe).alpha_x, (*lobe).alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda((*lobe).alpha_x, (*lobe).alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda((*lobe).alpha_x, (*lobe).alpha_y, local_wi);
  }

  var jacobian = 0.25;
  if (do_refract) {
    let denom = coeff.cos_theta_t + cos_ho * inv_eta;
    jacobian = abs(cos_ho * coeff.cos_theta_t) / max(denom * denom, 1e-20);
  }
  let common_factor = (ndf / cos_no) * jacobian;
  let pdf = branch_pdf * common_factor / (1.0 + lambda_wo);
  let eval_val = (*lobe).weight * spec_weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi));
  return BsdfMfSample(wi, pdf, eval_val, false);
}
