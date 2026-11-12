// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Analytic lights, emissive mesh triangles, environment HDRI sampling, forward MIS, and
// 64-bit light-linking (`lgt_*`), ported from Cycles `kernel/light/*.h`.

struct LgtDirectSample {
  valid: u32,
  is_delta: u32,
  wi: vec3<f32>,
  distance: f32,
  radiance: vec3<f32>,
  pdf: f32,
  target_instance: u32,
  target_triangle: u32,
  cast_shadow: u32,
}

fn lgt_empty_sample() -> LgtDirectSample {
  var sample: LgtDirectSample;
  sample.valid = 0u;
  sample.is_delta = 0u;
  sample.wi = vec3<f32>(0.0, 1.0, 0.0);
  sample.distance = 0.0;
  sample.radiance = vec3<f32>(0.0);
  sample.pdf = 0.0;
  sample.target_instance = INVALID_INDEX;
  sample.target_triangle = INVALID_INDEX;
  sample.cast_shadow = 1u;
  return sample;
}

// Shading point of the last surface bounce, kept for the MIS weight of the next hit. `lgt_mis_picked_by_tree` is false after a
// volume scatter, whose direct light is picked from the flat analytic table.
var<private> lgt_mis_picked_by_tree: bool = false;
var<private> lgt_mis_position: vec3<f32> = vec3<f32>(0.0);
var<private> lgt_mis_normal: vec3<f32> = vec3<f32>(0.0, 0.0, 1.0);
var<private> lgt_mis_has_transmission: bool = false;

fn lgt_use_light_tree() -> bool {
  return SCENE_HAS_LIGHT_TREE && (kernel_params.kernel_flags & KERNEL_FLAG_USE_LIGHT_TREE) != 0u;
}

fn lgt_remember_mis_origin(position: vec3<f32>, normal: vec3<f32>, has_transmission: bool, picked_by_tree: bool) {
  lgt_mis_position = position;
  lgt_mis_normal = normal;
  lgt_mis_has_transmission = has_transmission;
  lgt_mis_picked_by_tree = picked_by_tree;
}

// Probability that the direct light pick chose this emitter from the last shading point. `flat_probability` is the
// per-table probability used when the pick did not go through the tree.
fn lgt_selection_probability(unified_index: u32, flat_probability: f32) -> f32 {
  if (lgt_use_light_tree() && lgt_mis_picked_by_tree) {
    return ltr_pdf(lgt_mis_position, lgt_mis_normal, lgt_mis_has_transmission, unified_index);
  }
  return flat_probability;
}

fn lgt_power_heuristic(pdf_a: f32, pdf_b: f32) -> f32 {
  if (pdf_a <= 0.0) {
    return 0.0;
  }
  if (pdf_b <= 0.0) {
    return 1.0;
  }
  if (pdf_a >= pdf_b) {
    let ratio = pdf_b / pdf_a;
    return 1.0 / (1.0 + ratio * ratio);
  }
  let ratio = pdf_a / pdf_b;
  return (ratio * ratio) / (1.0 + ratio * ratio);
}

fn lgt_links_match(receiver_lo: u32, receiver_hi: u32, emitter_lo: u32, emitter_hi: u32) -> bool {
  if (!SCENE_HAS_LIGHT_LINKING) {
    return true;
  }
  return ((receiver_lo & emitter_lo) | (receiver_hi & emitter_hi)) != 0u;
}

fn lgt_make_orthonormal_basis(axis_z: vec3<f32>, axis_x: ptr<function, vec3<f32>>, axis_y: ptr<function, vec3<f32>>) {
  let sign_z = select(-1.0, 1.0, axis_z.z >= 0.0);
  let coeff_a = -1.0 / (sign_z + axis_z.z);
  let coeff_b = axis_z.x * axis_z.y * coeff_a;
  *axis_x = vec3<f32>(1.0 + sign_z * axis_z.x * axis_z.x * coeff_a, sign_z * coeff_b, -sign_z * axis_z.x);
  *axis_y = vec3<f32>(coeff_b, sign_z + axis_z.y * axis_z.y * coeff_a, -axis_z.y);
}

fn lgt_sample_uniform_cone(axis: vec3<f32>, one_minus_cos_max: f32, rand_uv: vec2<f32>, cos_theta_out: ptr<function, f32>) -> vec3<f32> {
  let one_minus_cos = rand_uv.x * one_minus_cos_max;
  let cos_theta = 1.0 - one_minus_cos;
  let sin_theta = sqrt(max(0.0, one_minus_cos * (2.0 - one_minus_cos)));
  let phi = TWO_PI * rand_uv.y;
  var tangent_x: vec3<f32>;
  var tangent_y: vec3<f32>;
  lgt_make_orthonormal_basis(axis, &tangent_x, &tangent_y);
  *cos_theta_out = cos_theta;
  return normalize(
    tangent_x * (sin_theta * cos(phi))
    + tangent_y * (sin_theta * sin(phi))
    + axis * cos_theta
  );
}

fn lgt_sample_uniform_sphere(rand_uv: vec2<f32>) -> vec3<f32> {
  let z = 1.0 - 2.0 * rand_uv.x;
  let radial = sqrt(max(0.0, 1.0 - z * z));
  let phi = TWO_PI * rand_uv.y;
  return vec3<f32>(radial * cos(phi), radial * sin(phi), z);
}

fn lgt_sin_sqr_to_one_minus_cos(sin_sq: f32) -> f32 {
  let clamped = clamp(sin_sq, 0.0, 1.0);
  let cos_val = sqrt(max(0.0, 1.0 - clamped));
  return clamped / (1.0 + cos_val);
}

fn lgt_sun_one_minus_cos(light: LightRecord) -> f32 {
  if (light.area_or_solid_angle > 0.0 && light.cos_half_angle < 1.0) {
    return clamp(light.area_or_solid_angle * INV_TWO_PI, 0.0, 2.0);
  }
  return max(0.0, 1.0 - light.cos_half_angle);
}

fn lgt_spot_attenuation(light: LightRecord, ray_from_light: vec3<f32>) -> f32 {
  let cos_angle = dot(ray_from_light, light.direction);
  if (cos_angle <= light.cos_half_angle) {
    return 0.0;
  }
  if (light.spot_blend <= 0.0) {
    return 1.0;
  }
  let span = max((1.0 - light.cos_half_angle) * light.spot_blend, 1.0e-8);
  let t = clamp((cos_angle - light.cos_half_angle) / span, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn lgt_range_falloff(distance: f32, max_distance: f32) -> f32 {
  if (max_distance >= 1.0e29 || max_distance <= 0.0) {
    return 1.0;
  }
  if (distance >= max_distance) {
    return 0.0;
  }
  return 1.0;
}

fn lgt_ray_sphere_intersect(
  ray_origin: vec3<f32>,
  ray_dir: vec3<f32>,
  center: vec3<f32>,
  radius: f32,
  hit_t: ptr<function, f32>,
) -> bool {
  let to_center = center - ray_origin;
  let dist_sq = dot(to_center, to_center);
  let radius_sq = radius * radius;
  let proj = dot(to_center, ray_dir);
  if (dist_sq > radius_sq && proj <= 0.0) {
    return false;
  }
  let perp = to_center - ray_dir * proj;
  let disc = radius_sq - dot(perp, perp);
  if (disc < 0.0) {
    return false;
  }
  let half_chord = sqrt(disc);
  let candidate_t = select(proj + half_chord, proj - half_chord, dist_sq > radius_sq);
  if (candidate_t <= 0.0) {
    return false;
  }
  *hit_t = candidate_t;
  return true;
}

fn lgt_sphere_solid_angle_pdf(dist_sq: f32, radius: f32, hit_t: f32, ray_origin: vec3<f32>, ray_dir: vec3<f32>, center: vec3<f32>) -> f32 {
  let radius_sq = radius * radius;
  if (dist_sq > radius_sq) {
    let one_minus_cos = lgt_sin_sqr_to_one_minus_cos(radius_sq / dist_sq);
    return 1.0 / max(TWO_PI * one_minus_cos, 1.0e-30);
  }
  let hit_point = ray_origin + ray_dir * hit_t;
  let sphere_normal = normalize(hit_point - center);
  let cos_light = max(abs(dot(sphere_normal, ray_dir)), 1.0e-8);
  return (hit_t * hit_t) / max(4.0 * PI * radius_sq * cos_light, 1.0e-20);
}

fn lgt_area_spread_attenuation(wi: vec3<f32>, light_normal: vec3<f32>, tan_half_spread: f32, spread_normalization: f32) -> f32 {
  let cos_emit = dot(-wi, light_normal);
  if (cos_emit <= 0.0) {
    return 0.0;
  }
  let sin_emit = sqrt(max(0.0, 1.0 - cos_emit * cos_emit));
  let tan_emit = sin_emit / max(cos_emit, 1.0e-8);
  if (tan_half_spread <= 0.0) {
    return select(0.0, PI, tan_emit <= 1.0e-5);
  }
  return max((tan_half_spread - tan_emit) * spread_normalization, 0.0);
}

// Cycles `area_light_rect_sample` (Urena et al. solid-angle spherical rectangle parameterization).
fn lgt_area_rect_sample_or_pdf(
  shading_pos: vec3<f32>,
  rect_center: vec3<f32>,
  axis_u: vec3<f32>,
  len_u: f32,
  axis_v: vec3<f32>,
  len_v: f32,
  rand_uv: vec2<f32>,
  sample_coord: bool,
  point_in_out: ptr<function, vec3<f32>>,
) -> f32 {
  var axis_z = cross(axis_u, axis_v);
  let z_len = length(axis_z);
  if (z_len <= 1.0e-12 || len_u <= 0.0 || len_v <= 0.0) {
    return 0.0;
  }
  axis_z /= z_len;

  let to_center = rect_center - shading_pos;
  var z0 = dot(to_center, axis_z);
  if (z0 > 0.0) {
    axis_z = -axis_z;
    z0 = -z0;
  }
  if (-z0 <= 1.0e-8) {
    return 0.0;
  }

  let xc = dot(to_center, axis_u);
  let yc = dot(to_center, axis_v);
  let x0 = xc - 0.5 * len_u;
  let x1 = xc + 0.5 * len_u;
  let y0 = yc - 0.5 * len_v;
  let y1 = yc + 0.5 * len_v;

  var nz = vec4<f32>(-y0, x1, y1, -x0);
  nz /= sqrt(nz * nz + vec4<f32>(z0 * z0));

  let g0 = asin(clamp(-nz.x * nz.y, -1.0, 1.0));
  let g1 = asin(clamp(-nz.y * nz.z, -1.0, 1.0));
  let g2 = asin(clamp(-nz.z * nz.w, -1.0, 1.0));
  let g3 = asin(clamp(-nz.w * nz.x, -1.0, 1.0));
  let solid_angle = -(g0 + g1 + g2 + g3);
  let nz_sq = nz * nz;
  let min_nz_sq = min(min(nz_sq.x, nz_sq.y), min(nz_sq.z, nz_sq.w));
  let use_planar_fallback = solid_angle < 1.0e-5 || min_nz_sq > 0.99999;

  if (use_planar_fallback) {
    if (sample_coord) {
      let local_u = (rand_uv.x - 0.5) * len_u;
      let local_v = (rand_uv.y - 0.5) * len_v;
      *point_in_out = rect_center + axis_u * local_u + axis_v * local_v;
    }
    let dist = length((*point_in_out) - shading_pos);
    return (dist * dist * dist) / max(-z0 * len_u * len_v, 1.0e-20);
  }

  if (sample_coord) {
    let b0 = nz.x;
    let b1 = nz.z;
    let b0_sq = b0 * b0;
    let au = rand_uv.x * solid_angle + g2 + g3;
    let sin_au = sin(au);
    let fu = select(0.0, (cos(au) * b0 + b1) / sin_au, abs(sin_au) > 1.0e-12);
    let cu_sign = select(-1.0, 1.0, fu >= 0.0);
    let cu = clamp(cu_sign / sqrt(fu * fu + b0_sq), -1.0, 1.0);
    var xu = -(cu * z0) / max(sqrt(max(0.0, 1.0 - cu * cu)), 1.0e-7);
    xu = clamp(xu, x0, x1);

    let d2 = xu * xu + z0 * z0;
    let h0 = y0 / sqrt(d2 + y0 * y0);
    let h1 = y1 / sqrt(d2 + y1 * y1);
    let hv = h0 + rand_uv.y * (h1 - h0);
    let hv_sq = hv * hv;
    let yv = select(y1, hv * sqrt(d2 / max(1.0 - hv_sq, 1.0e-7)), hv_sq < 1.0 - 1.0e-6);
    *point_in_out = shading_pos + axis_u * xu + axis_v * yv + axis_z * z0;
  }

  return 1.0 / solid_angle;
}

fn lgt_sample_ellipse_point(center: vec3<f32>, axis_u: vec3<f32>, size_u: f32, axis_v: vec3<f32>, size_v: f32, rand_uv: vec2<f32>) -> vec3<f32> {
  let disk = cam_sample_uniform_disk(rand_uv);
  return center + axis_u * (disk.x * 0.5 * size_u) + axis_v * (disk.y * 0.5 * size_v);
}

fn lgt_binary_search_light_cdf(pick_u: f32, count: u32) -> u32 {
  var low = 0u;
  var high = count - 1u;
  for (var step = 0u; step < 24u; step += 1u) {
    if (low >= high) {
      break;
    }
    let mid = (low + high) >> 1u;
    if (lights[mid].cdf_upper <= pick_u) {
      low = mid + 1u;
    } else {
      high = mid;
    }
  }
  return low;
}

fn lgt_binary_search_emissive_cdf(pick_u: f32, count: u32) -> u32 {
  var low = 0u;
  var high = count - 1u;
  for (var step = 0u; step < 24u; step += 1u) {
    if (low >= high) {
      break;
    }
    let mid = (low + high) >> 1u;
    if (emissive_triangles[mid].cdf_upper <= pick_u) {
      low = mid + 1u;
    } else {
      high = mid;
    }
  }
  return low;
}

fn lgt_binary_search_env_cdf(base_offset: u32, count: u32, pick_u: f32) -> u32 {
  var low = 0u;
  var high = count - 1u;
  for (var step = 0u; step < 24u; step += 1u) {
    if (low >= high) {
      break;
    }
    let mid = (low + high) >> 1u;
    if (environment_texels[base_offset + mid].x <= pick_u) {
      low = mid + 1u;
    } else {
      high = mid;
    }
  }
  return low;
}

fn lgt_sample_point_or_spot_light(light: LightRecord, shading_pos: vec3<f32>, rand_uv: vec2<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  out.cast_shadow = select(0u, 1u, (light.flags & LIGHT_FLAG_CAST_SHADOW) != 0u);
  let is_spot = light.light_type == LIGHT_TYPE_SPOT;
  let to_center = light.position - shading_pos;
  let dist_sq = dot(to_center, to_center);

  if (light.radius <= 0.0) {
    if (dist_sq <= 1.0e-16) {
      return out;
    }
    let dist = sqrt(dist_sq);
    let falloff = lgt_range_falloff(dist, light.max_distance);
    if (falloff <= 0.0) {
      return out;
    }
    let wi = to_center / dist;
    var spot_weight = 1.0;
    if (is_spot) {
      spot_weight = lgt_spot_attenuation(light, -wi);
      if (spot_weight <= 0.0) {
        return out;
      }
    }
    out.valid = 1u;
    out.is_delta = 1u;
    out.wi = wi;
    out.distance = dist;
    out.radiance = light.radiance * (spot_weight * falloff / dist_sq);
    out.pdf = light.selection_pdf;
    return out;
  }

  let radius = light.radius;
  let radius_sq = radius * radius;
  var wi = vec3<f32>(0.0);
  var hit_t = 0.0;
  var pdf_solid_angle = 0.0;

  if (dist_sq > radius_sq) {
    let dist = sqrt(dist_sq);
    let center_dir = to_center / dist;
    let one_minus_cos_sphere = lgt_sin_sqr_to_one_minus_cos(radius_sq / dist_sq);
    let one_minus_cos_spot = max(0.0, 1.0 - light.cos_half_angle);

    if (is_spot && one_minus_cos_spot < one_minus_cos_sphere) {
      if (one_minus_cos_spot <= 1.0e-12) {
        return out;
      }
      var cos_cone = 1.0;
      wi = lgt_sample_uniform_cone(-light.direction, one_minus_cos_spot, rand_uv, &cos_cone);
      if (!lgt_ray_sphere_intersect(shading_pos, wi, light.position, radius, &hit_t)) {
        return out;
      }
      pdf_solid_angle = 1.0 / max(TWO_PI * one_minus_cos_spot, 1.0e-30);
    } else {
      var cos_theta = 1.0;
      wi = lgt_sample_uniform_cone(center_dir, one_minus_cos_sphere, rand_uv, &cos_theta);
      let proj = dot(to_center, wi);
      let perp = to_center - wi * proj;
      let disc = max(0.0, radius_sq - dot(perp, perp));
      hit_t = max(proj - sqrt(disc), 0.0);
      pdf_solid_angle = 1.0 / max(TWO_PI * one_minus_cos_sphere, 1.0e-30);
    }
  } else {
    let sphere_normal = lgt_sample_uniform_sphere(rand_uv);
    let light_point = light.position + sphere_normal * radius;
    let diff = light_point - shading_pos;
    let dist = length(diff);
    if (dist <= 1.0e-8) {
      return out;
    }
    wi = diff / dist;
    hit_t = dist;
    let cos_light = max(abs(dot(sphere_normal, wi)), 1.0e-8);
    pdf_solid_angle = (dist * dist) / max(4.0 * PI * radius_sq * cos_light, 1.0e-20);
  }

  let falloff = lgt_range_falloff(hit_t, light.max_distance);
  if (falloff <= 0.0 || pdf_solid_angle <= 0.0) {
    return out;
  }

  var spot_weight = 1.0;
  if (is_spot && dist_sq > radius_sq) {
    spot_weight = lgt_spot_attenuation(light, -wi);
    if (spot_weight <= 0.0) {
      return out;
    }
  }

  out.valid = 1u;
  out.is_delta = select(1u, 0u, (light.flags & LIGHT_FLAG_MULTIPLE_IMPORTANCE) != 0u);
  out.wi = wi;
  out.distance = hit_t;
  out.radiance = light.radiance * (spot_weight * falloff);
  out.pdf = light.selection_pdf * pdf_solid_angle;
  return out;
}

fn lgt_sample_area_light(light: LightRecord, shading_pos: vec3<f32>, rand_uv: vec2<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  out.cast_shadow = select(0u, 1u, (light.flags & LIGHT_FLAG_CAST_SHADOW) != 0u);
  let light_normal = light.direction;
  if (dot(shading_pos - light.position, light_normal) <= 0.0) {
    return out;
  }

  var sampled_point = light.position;
  var pdf_solid_angle = 0.0;
  var wi = vec3<f32>(0.0);
  var hit_t = 0.0;

  if (light.light_type == LIGHT_TYPE_AREA_RECT) {
    pdf_solid_angle = lgt_area_rect_sample_or_pdf(
      shading_pos,
      light.position,
      light.axis_u,
      light.size_u,
      light.axis_v,
      light.size_v,
      rand_uv,
      true,
      &sampled_point,
    );
    let diff = sampled_point - shading_pos;
    hit_t = length(diff);
    if (hit_t <= 1.0e-8 || pdf_solid_angle <= 0.0) {
      return out;
    }
    wi = diff / hit_t;
    if (dot(-wi, light_normal) <= 0.0) {
      return out;
    }
  } else {
    if (light.size_u <= 0.0 || light.size_v <= 0.0) {
      return out;
    }
    sampled_point = lgt_sample_ellipse_point(light.position, light.axis_u, light.size_u, light.axis_v, light.size_v, rand_uv);
    let diff = sampled_point - shading_pos;
    hit_t = length(diff);
    if (hit_t <= 1.0e-8) {
      return out;
    }
    wi = diff / hit_t;
    let cos_light = dot(-wi, light_normal);
    if (cos_light <= 0.0) {
      return out;
    }
    let ellipse_area = 0.25 * PI * light.size_u * light.size_v;
    pdf_solid_angle = (hit_t * hit_t) / max(ellipse_area * cos_light, 1.0e-20);
  }

  let falloff = lgt_range_falloff(hit_t, light.max_distance);
  if (falloff <= 0.0) {
    return out;
  }

  var spread_weight = 1.0;
  if (light.spread_normalization > 0.0) {
    spread_weight = lgt_area_spread_attenuation(wi, light_normal, light.tan_half_spread, light.spread_normalization);
    if (spread_weight <= 0.0) {
      return out;
    }
  }

  out.valid = 1u;
  out.is_delta = select(1u, 0u, (light.flags & LIGHT_FLAG_MULTIPLE_IMPORTANCE) != 0u);
  out.wi = wi;
  out.distance = hit_t;
  out.radiance = light.radiance * (spread_weight * falloff);
  out.pdf = light.selection_pdf * pdf_solid_angle;
  return out;
}

fn lgt_sample_sun_light(light: LightRecord, rand_uv: vec2<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  out.cast_shadow = select(0u, 1u, (light.flags & LIGHT_FLAG_CAST_SHADOW) != 0u);
  let to_sun = normalize(-light.direction);
  let one_minus_cos = lgt_sun_one_minus_cos(light);

  if (one_minus_cos <= 1.0e-12) {
    out.valid = 1u;
    out.is_delta = 1u;
    out.wi = to_sun;
    out.distance = 1.0e30;
    out.radiance = light.radiance;
    out.pdf = light.selection_pdf;
    return out;
  }

  var cos_theta = 1.0;
  let wi = lgt_sample_uniform_cone(to_sun, one_minus_cos, rand_uv, &cos_theta);
  let pdf_cone = 1.0 / max(TWO_PI * one_minus_cos, 1.0e-30);
  out.valid = 1u;
  out.is_delta = select(1u, 0u, (light.flags & LIGHT_FLAG_MULTIPLE_IMPORTANCE) != 0u);
  out.wi = wi;
  out.distance = 1.0e30;
  out.radiance = light.radiance;
  out.pdf = light.selection_pdf * pdf_cone;
  return out;
}

fn lgt_sample_analytic_light(
  shading_pos: vec3<f32>,
  receiver_lo: u32,
  receiver_hi: u32,
  pick_u: f32,
  sample_uv: vec2<f32>,
) -> LgtDirectSample {
  let count = kernel_params.light_count;
  if (count == 0u) {
    return lgt_empty_sample();
  }
  let light_index = lgt_binary_search_light_cdf(pick_u, count);
  return lgt_sample_analytic_light_at(light_index, lights[light_index].selection_pdf, shading_pos, receiver_lo, receiver_hi, sample_uv);
}

fn lgt_sample_analytic_light_at(
  light_index: u32,
  selection_pdf: f32,
  shading_pos: vec3<f32>,
  receiver_lo: u32,
  receiver_hi: u32,
  sample_uv: vec2<f32>,
) -> LgtDirectSample {
  var light = lights[light_index];
  light.selection_pdf = selection_pdf;
  if (light.selection_pdf <= 0.0) {
    return lgt_empty_sample();
  }
  if (!lgt_links_match(receiver_lo, receiver_hi, light.light_group_mask_lo, light.light_group_mask_hi)) {
    return lgt_empty_sample();
  }
  if (light.light_type == LIGHT_TYPE_POINT || light.light_type == LIGHT_TYPE_SPOT) {
    return lgt_sample_point_or_spot_light(light, shading_pos, sample_uv);
  }
  if (light.light_type == LIGHT_TYPE_AREA_RECT || light.light_type == LIGHT_TYPE_AREA_DISK) {
    return lgt_sample_area_light(light, shading_pos, sample_uv);
  }
  if (light.light_type == LIGHT_TYPE_SUN) {
    return lgt_sample_sun_light(light, sample_uv);
  }
  return lgt_empty_sample();
}

fn lgt_sample_emissive_triangle(point: ptr<function, ShadingPoint>, pick_u: f32, sample_uv: vec2<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  let count = kernel_params.emissive_triangle_count;
  if (count == 0u) {
    return out;
  }
  let index = lgt_binary_search_emissive_cdf(pick_u, count);
  return lgt_sample_emissive_triangle_at(point, index, emissive_triangles[index].selection_pdf, sample_uv);
}

// The radiance of a light sample on an emitter with an emission map: the map read at the sampled point, as a ray that hits the
// emitter reads it (closure_build), so light sampling and bounce rays estimate the same radiance. The packed `radiance` of such
// an emitter is the mean of the decoded texels, which only steers the choice of emitter (#1030).
fn lgt_textured_emitter_radiance(emitter: EmissiveTriangleRecord, bary_u: f32, bary_v: f32) -> vec3<f32> {
  let mat = materials[emitter.material_index];
  let uvs = int_interpolate_triangle_uvs(triangles[emitter.triangle_index], vec2<f32>(bary_u, bary_v));
  let tint = max(max(mat.emission_color, vec3<f32>(0.0)) * texture_sample(mat.emission_tex, uvs.uv0, uvs.uv1).rgb, vec3<f32>(0.0));
  return tint * max(mat.emission_strength, 0.0);
}

fn lgt_sample_emissive_triangle_at(point: ptr<function, ShadingPoint>, index: u32, selection_pdf: f32, sample_uv: vec2<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  let emitter = emissive_triangles[index];
  if (selection_pdf <= 0.0 || emitter.area <= 0.0) {
    return out;
  }
  if (!lgt_links_match((*point).light_group_mask_lo, (*point).light_group_mask_hi, emitter.light_group_mask_lo, emitter.light_group_mask_hi)) {
    return out;
  }
  if (emitter.instance_index == (*point).instance_index && emitter.triangle_index == (*point).triangle_index) {
    return out;
  }

  let su = sqrt(sample_uv.x);
  let bary_u = 1.0 - su;
  let bary_v = sample_uv.y * su;
  let light_point = emitter.p0 + emitter.edge1 * bary_u + emitter.edge2 * bary_v;
  let diff = light_point - (*point).position;
  let dist_sq = dot(diff, diff);
  if (dist_sq <= 1.0e-16) {
    return out;
  }
  let dist = sqrt(dist_sq);
  let wi = diff / dist;
  let cos_light = abs(dot(emitter.geometric_normal, wi));
  if (cos_light <= 1.0e-8) {
    return out;
  }

  let mat = materials[emitter.material_index];
  let mis_enabled = (mat.flags & MATERIAL_FLAG_EMISSIVE_MIS) != 0u;
  let pdf_solid_angle = dist_sq / max(emitter.area * cos_light, 1.0e-20);

  out.valid = 1u;
  out.is_delta = select(1u, 0u, mis_enabled);
  out.wi = wi;
  out.distance = dist;
  out.radiance = emitter.radiance;
  if (mat.emission_tex >= 0) {
    out.radiance = lgt_textured_emitter_radiance(emitter, bary_u, bary_v);
  }
  out.pdf = selection_pdf * pdf_solid_angle;
  out.target_instance = emitter.instance_index;
  out.target_triangle = emitter.triangle_index;
  out.cast_shadow = 1u;
  return out;
}

// Picks one emitter (analytic light or emissive triangle) through the light tree and samples a point on it.
fn lgt_sample_tree_emitter(
  point: ptr<function, ShadingPoint>,
  normal: vec3<f32>,
  has_transmission: bool,
  pick_u: f32,
  sample_uv: vec2<f32>,
) -> LgtDirectSample {
  var pick_probability = 0.0;
  let slot = ltr_sample((*point).position, normal, has_transmission, pick_u, &pick_probability);
  if (slot < 0 || pick_probability <= 0.0) {
    return lgt_empty_sample();
  }
  let emitter = light_tree_emitters[u32(slot)];
  if ((emitter.kind_and_depth & LTR_EMITTER_KIND_TRIANGLE) != 0u) {
    return lgt_sample_emissive_triangle_at(point, emitter.record_index, pick_probability, sample_uv);
  }
  return lgt_sample_analytic_light_at(
    emitter.record_index,
    pick_probability,
    (*point).position,
    (*point).light_group_mask_lo,
    (*point).light_group_mask_hi,
    sample_uv,
  );
}

fn lgt_direction_to_env_uv(direction: vec3<f32>, polar_out: ptr<function, f32>) -> vec2<f32> {
  let cosine = cos(kernel_params.env_rotation);
  let sine = sin(kernel_params.env_rotation);
  let map_x = cosine * direction.x - sine * direction.z;
  let map_z = sine * direction.x + cosine * direction.z;
  let u_raw = atan2(map_x, -map_z) * INV_TWO_PI + 0.5;
  let u_wrapped = u_raw - floor(u_raw);
  let polar = acos(clamp(direction.y, -1.0, 1.0));
  *polar_out = polar;
  return vec2<f32>(u_wrapped, polar * INV_PI);
}

fn lgt_env_uv_to_direction(uv: vec2<f32>, polar_out: ptr<function, f32>) -> vec3<f32> {
  let polar = uv.y * PI;
  let azimuth = (uv.x - 0.5) * TWO_PI;
  let sin_polar = sin(polar);
  let map_x = sin_polar * sin(azimuth);
  let map_z = -sin_polar * cos(azimuth);
  let cosine = cos(kernel_params.env_rotation);
  let sine = sin(kernel_params.env_rotation);
  *polar_out = polar;
  return vec3<f32>(
    cosine * map_x + sine * map_z,
    cos(polar),
    -sine * map_x + cosine * map_z,
  );
}

fn lgt_eval_hdri_radiance(direction: vec3<f32>) -> vec3<f32> {
  let width = kernel_params.env_width;
  let height = kernel_params.env_height;
  if (width == 0u || height == 0u) {
    return kernel_params.env_color;
  }
  var polar = 0.0;
  let uv = lgt_direction_to_env_uv(direction, &polar);
  let tex_x = uv.x * f32(width) - 0.5;
  let tex_y = uv.y * f32(height) - 0.5;
  let x0_f = floor(tex_x);
  let y0_f = floor(tex_y);
  let frac_x = tex_x - x0_f;
  let frac_y = tex_y - y0_f;
  let cols = i32(width);
  let rows = i32(height);

  var accum = vec3<f32>(0.0);
  for (var corner = 0u; corner < 4u; corner += 1u) {
    let dx = i32(corner & 1u);
    let dy = i32(corner >> 1u);
    let col = u32(((i32(x0_f) + dx) % cols + cols) % cols);
    let row = u32(clamp(i32(y0_f) + dy, 0, rows - 1));
    let weight_x = select(1.0 - frac_x, frac_x, dx == 1);
    let weight_y = select(1.0 - frac_y, frac_y, dy == 1);
    let texel = environment_texels[row * width + col].xyz;
    accum += texel * (weight_x * weight_y);
  }
  return accum * kernel_params.env_color;
}

fn lgt_environment_pdf(direction: vec3<f32>) -> f32 {
  let width = kernel_params.env_width;
  let height = kernel_params.env_height;
  if (width == 0u || height == 0u || kernel_params.background_mis_weight <= 0.0) {
    return 0.0;
  }
  var polar = 0.0;
  let uv = lgt_direction_to_env_uv(direction, &polar);
  let sin_polar = sin(polar);
  if (sin_polar <= 1.0e-8) {
    return 0.0;
  }
  let col = min(u32(floor(uv.x * f32(width))), width - 1u);
  let row = min(u32(floor(uv.y * f32(height))), height - 1u);
  let cdf_base = kernel_params.env_cdf_offset;
  let marginal_prob = environment_texels[cdf_base + row].y;
  let cond_prob = environment_texels[cdf_base + height + row * width + col].y;
  return (marginal_prob * cond_prob * f32(width * height)) / (TWO_PI * PI * sin_polar);
}

fn lgt_sample_environment(sample_u4: vec4<f32>) -> LgtDirectSample {
  var out = lgt_empty_sample();
  let width = kernel_params.env_width;
  let height = kernel_params.env_height;
  if (width == 0u || height == 0u || kernel_params.background_mis_weight <= 0.0) {
    return out;
  }
  let cdf_base = kernel_params.env_cdf_offset;
  let row = lgt_binary_search_env_cdf(cdf_base, height, sample_u4.x);
  let marginal_prob = environment_texels[cdf_base + row].y;
  if (marginal_prob <= 0.0) {
    return out;
  }
  let cond_base = cdf_base + height + row * width;
  let col = lgt_binary_search_env_cdf(cond_base, width, sample_u4.y);
  let cond_prob = environment_texels[cond_base + col].y;
  if (cond_prob <= 0.0) {
    return out;
  }

  let u_coord = (f32(col) + sample_u4.z) / f32(width);
  let v_coord = (f32(row) + sample_u4.w) / f32(height);
  var polar = 0.0;
  let wi = lgt_env_uv_to_direction(vec2<f32>(u_coord, v_coord), &polar);
  let sin_polar = sin(polar);
  if (sin_polar <= 1.0e-8) {
    return out;
  }

  let pdf_solid_angle = (marginal_prob * cond_prob * f32(width * height)) / (TWO_PI * PI * sin_polar);
  if (pdf_solid_angle <= 0.0) {
    return out;
  }

  out.valid = 1u;
  out.is_delta = 0u;
  out.wi = wi;
  out.distance = 1.0e30;
  out.radiance = lgt_eval_hdri_radiance(wi);
  out.pdf = pdf_solid_angle;
  out.cast_shadow = 1u;
  return out;
}

fn lgt_eval_analytic_lights_along_segment(
  ray_origin: vec3<f32>,
  ray_dir: vec3<f32>,
  t_min: f32,
  t_max: f32,
  is_camera_ray: bool,
  mis_skip: bool,
  prev_bsdf_pdf: f32,
  receiver_lo: u32,
  receiver_hi: u32,
  in_medium: bool,
  medium_sigma: vec3<f32>,
) -> vec3<f32> {
  let count = kernel_params.light_count;
  if (count == 0u) {
    return vec3<f32>(0.0);
  }
  var total = vec3<f32>(0.0);

  for (var index = 0u; index < count; index += 1u) {
    let light = lights[index];
    if (light.light_type == LIGHT_TYPE_SUN) {
      continue;
    }
    if (is_camera_ray) {
      if ((light.flags & LIGHT_FLAG_CAMERA_VISIBLE) == 0u) {
        continue;
      }
    } else {
      if ((light.flags & LIGHT_FLAG_MULTIPLE_IMPORTANCE) == 0u) {
        continue;
      }
      if (!lgt_links_match(receiver_lo, receiver_hi, light.light_group_mask_lo, light.light_group_mask_hi)) {
        continue;
      }
    }

    if (light.light_type == LIGHT_TYPE_POINT || light.light_type == LIGHT_TYPE_SPOT) {
      if (light.radius <= 0.0) {
        continue;
      }
      let is_spot = light.light_type == LIGHT_TYPE_SPOT;
      if (is_spot && dot(ray_dir, ray_origin - light.position) >= 0.0) {
        continue;
      }
      var hit_t = 0.0;
      if (!lgt_ray_sphere_intersect(ray_origin, ray_dir, light.position, light.radius, &hit_t)) {
        continue;
      }
      if (hit_t <= t_min || hit_t >= t_max) {
        continue;
      }
      let falloff = lgt_range_falloff(hit_t, light.max_distance);
      if (falloff <= 0.0) {
        continue;
      }
      let to_center = light.position - ray_origin;
      let dist_sq = dot(to_center, to_center);
      var spot_weight = 1.0;
      if (is_spot && dist_sq > light.radius * light.radius) {
        spot_weight = lgt_spot_attenuation(light, -ray_dir);
        if (spot_weight <= 0.0) {
          continue;
        }
      }
      var pdf_solid_angle = lgt_sphere_solid_angle_pdf(dist_sq, light.radius, hit_t, ray_origin, ray_dir, light.position);
      if (is_spot && dist_sq > light.radius * light.radius) {
        let one_minus_cos_sphere = lgt_sin_sqr_to_one_minus_cos((light.radius * light.radius) / dist_sq);
        let one_minus_cos_spot = max(0.0, 1.0 - light.cos_half_angle);
        let one_minus_cos = min(one_minus_cos_sphere, one_minus_cos_spot);
        pdf_solid_angle = 1.0 / max(TWO_PI * one_minus_cos, 1.0e-30);
      }
      var mis_weight = 1.0;
      if (!(is_camera_ray || mis_skip)) {
        let pdf_nee = lgt_selection_probability(index, light.selection_pdf) * pdf_solid_angle;
        mis_weight = lgt_power_heuristic(prev_bsdf_pdf, pdf_nee);
      }
      let medium_atten = select(vec3<f32>(1.0), exp(-medium_sigma * max(hit_t - t_min, 0.0)), in_medium);
      total += light.radiance * medium_atten * (spot_weight * falloff * mis_weight);
      continue;
    }

    if (light.light_type == LIGHT_TYPE_AREA_RECT || light.light_type == LIGHT_TYPE_AREA_DISK) {
      if (light.size_u <= 0.0 || light.size_v <= 0.0) {
        continue;
      }
      let light_normal = light.direction;
      let denom = dot(ray_dir, light_normal);
      if (denom >= -1.0e-8) {
        continue;
      }
      let hit_t = dot(light.position - ray_origin, light_normal) / denom;
      if (hit_t <= t_min || hit_t >= t_max) {
        continue;
      }
      let falloff = lgt_range_falloff(hit_t, light.max_distance);
      if (falloff <= 0.0) {
        continue;
      }
      var hit_point = ray_origin + ray_dir * hit_t;
      let in_plane = hit_point - light.position;
      let coord_u = dot(in_plane, light.axis_u) / light.size_u;
      let coord_v = dot(in_plane, light.axis_v) / light.size_v;

      var pdf_solid_angle = 0.0;
      if (light.light_type == LIGHT_TYPE_AREA_RECT) {
        if (abs(coord_u) > 0.5 || abs(coord_v) > 0.5) {
          continue;
        }
        pdf_solid_angle = lgt_area_rect_sample_or_pdf(
          ray_origin,
          light.position,
          light.axis_u,
          light.size_u,
          light.axis_v,
          light.size_v,
          vec2<f32>(0.0, 0.0),
          false,
          &hit_point,
        );
      } else {
        if (coord_u * coord_u + coord_v * coord_v > 0.25) {
          continue;
        }
        let ellipse_area = 0.25 * PI * light.size_u * light.size_v;
        let cos_light = max(-denom, 1.0e-8);
        pdf_solid_angle = (hit_t * hit_t) / max(ellipse_area * cos_light, 1.0e-20);
      }

      var spread_weight = 1.0;
      if (light.spread_normalization > 0.0) {
        spread_weight = lgt_area_spread_attenuation(ray_dir, light_normal, light.tan_half_spread, light.spread_normalization);
        if (spread_weight <= 0.0) {
          continue;
        }
      }
      var mis_weight = 1.0;
      if (!(is_camera_ray || mis_skip)) {
        let pdf_nee = lgt_selection_probability(index, light.selection_pdf) * pdf_solid_angle;
        mis_weight = lgt_power_heuristic(prev_bsdf_pdf, pdf_nee);
      }
      let medium_atten = select(vec3<f32>(1.0), exp(-medium_sigma * max(hit_t - t_min, 0.0)), in_medium);
      total += light.radiance * medium_atten * (spread_weight * falloff * mis_weight);
    }
  }

  return total;
}

fn lgt_eval_escaped_ray(
  ray_dir: vec3<f32>,
  is_camera_ray: bool,
  is_transparent_background_ray: bool,
  mis_skip: bool,
  prev_bsdf_pdf: f32,
  receiver_lo: u32,
  receiver_hi: u32,
) -> vec3<f32> {
  var total = vec3<f32>(0.0);

  if (!is_transparent_background_ray) {
    let env_radiance = lgt_eval_hdri_radiance(ray_dir);
    var env_mis = 1.0;
    if (!is_camera_ray && !mis_skip && SCENE_HAS_ENV_IMPORTANCE && kernel_params.env_width > 0u && kernel_params.env_height > 0u && kernel_params.background_mis_weight > 0.0) {
      let pdf_env = lgt_environment_pdf(ray_dir);
      env_mis = lgt_power_heuristic(prev_bsdf_pdf, pdf_env);
    }
    total += env_radiance * env_mis;
  }

  let count = kernel_params.light_count;
  for (var index = 0u; index < count; index += 1u) {
    let light = lights[index];
    if (light.light_type != LIGHT_TYPE_SUN) {
      continue;
    }
    if (is_camera_ray) {
      if ((light.flags & LIGHT_FLAG_CAMERA_VISIBLE) == 0u) {
        continue;
      }
    } else {
      if ((light.flags & LIGHT_FLAG_MULTIPLE_IMPORTANCE) == 0u) {
        continue;
      }
      if (!lgt_links_match(receiver_lo, receiver_hi, light.light_group_mask_lo, light.light_group_mask_hi)) {
        continue;
      }
    }
    let one_minus_cos = lgt_sun_one_minus_cos(light);
    if (one_minus_cos <= 1.0e-12) {
      continue;
    }
    let to_sun = normalize(-light.direction);
    if (dot(ray_dir, to_sun) < 1.0 - one_minus_cos) {
      continue;
    }
    var sun_mis = 1.0;
    if (!(is_camera_ray || mis_skip)) {
      let pdf_nee = lgt_selection_probability(index, light.selection_pdf) / max(TWO_PI * one_minus_cos, 1.0e-30);
      sun_mis = lgt_power_heuristic(prev_bsdf_pdf, pdf_nee);
    }
    total += light.radiance * sun_mis;
  }

  return total;
}

fn lgt_emissive_surface_weight(
  emissive_index: u32,
  hit_distance: f32,
  ray_dir: vec3<f32>,
  is_camera_ray: bool,
  mis_skip: bool,
  prev_bsdf_pdf: f32,
  receiver_lo: u32,
  receiver_hi: u32,
) -> f32 {
  if (emissive_index == INVALID_INDEX || emissive_index >= kernel_params.emissive_triangle_count) {
    return 1.0;
  }
  let emitter = emissive_triangles[emissive_index];
  if (!is_camera_ray) {
    if (!lgt_links_match(receiver_lo, receiver_hi, emitter.light_group_mask_lo, emitter.light_group_mask_hi)) {
      return 0.0;
    }
  }
  if (is_camera_ray || mis_skip || emitter.area <= 0.0) {
    return 1.0;
  }
  if ((kernel_params.kernel_flags & KERNEL_FLAG_TEST_NEE_ONLY) != 0u) {
    return 0.0;
  }
  if ((kernel_params.kernel_flags & KERNEL_FLAG_TEST_BSDF_ONLY) != 0u) {
    return 1.0;
  }
  let selection_probability = lgt_selection_probability(kernel_params.light_count + emissive_index, emitter.selection_pdf);
  if (selection_probability <= 0.0) {
    return 1.0;
  }
  let mat = materials[emitter.material_index];
  if ((mat.flags & MATERIAL_FLAG_EMISSIVE_MIS) == 0u) {
    return 1.0;
  }
  let cos_light = abs(dot(emitter.geometric_normal, ray_dir));
  if (cos_light <= 1.0e-8) {
    return 0.0;
  }
  let pdf_nee = selection_probability * (hit_distance * hit_distance) / max(emitter.area * cos_light, 1.0e-20);
  return lgt_power_heuristic(prev_bsdf_pdf, pdf_nee);
}
