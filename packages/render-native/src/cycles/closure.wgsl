/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/svm/closure.h, kernel/closure/bsdf.h, kernel/closure/bsdf_sheen.h). */

const CLOSURE_WEIGHT_CUTOFF: f32 = 1e-5;
const CLOSURE_SINGULAR_WEIGHT: f32 = 1e6;
const CLOSURE_PCG_INV_24: f32 = 5.960464477539063e-8;

const CYCLES_LUT_OFFSET_CLOSURE_LUT_SHEEN_U32: u32 = 28176u;

fn closure_lut_sheen_u32(word_idx: u32) -> u32 {
  return cycles_lut[CYCLES_LUT_OFFSET_CLOSURE_LUT_SHEEN_U32 + word_idx];
}

struct ClosureSheenSetup {
  lobe: Lobe,
  layer_albedo: vec3<f32>,
  valid: bool,
}

fn closure_empty_lobe() -> Lobe {
  var lobe: Lobe;
  lobe.weight = vec3<f32>(0.0);
  lobe.sample_weight = 0.0;
  lobe.normal = vec3<f32>(0.0, 0.0, 1.0);
  lobe.lobe_type = LOBE_NONE;
  lobe.tangent = vec3<f32>(0.0);
  lobe.flags = 0u;
  lobe.f0 = vec3<f32>(0.0);
  lobe.ior = 1.0;
  lobe.f82_or_tint = vec3<f32>(0.0);
  lobe.diffuse_roughness = 0.0;
  lobe.alpha_x = 0.0;
  lobe.alpha_y = 0.0;
  lobe.thin_film_thickness = 0.0;
  lobe.thin_film_ior = 0.0;
  return lobe;
}

fn closure_layering_weight(layer_albedo: vec3<f32>, current_weight: vec3<f32>) -> vec3<f32> {
  return clamp(current_weight - layer_albedo, vec3<f32>(0.0), current_weight);
}

fn closure_srgb_channel_to_linear(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn closure_srgb_to_linear(rgb: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    closure_srgb_channel_to_linear(rgb.x),
    closure_srgb_channel_to_linear(rgb.y),
    closure_srgb_channel_to_linear(rgb.z),
  );
}

fn closure_wrap_coord(coord: f32, wrap_mode: u32) -> f32 {
  if (wrap_mode == 1u) {
    return clamp(coord, 0.0, 1.0);
  }
  if (wrap_mode == 2u) {
    let period = coord - 2.0 * floor(0.5 * coord);
    return select(period, 2.0 - period, period > 1.0);
  }
  return coord - floor(coord);
}

fn closure_wrap_texel_index(idx: i32, dim: i32, wrap_mode: u32) -> i32 {
  if (wrap_mode == 0u) {
    let rem = idx % dim;
    return select(rem, rem + dim, rem < 0);
  }
  return clamp(idx, 0, dim - 1);
}

fn closure_fetch_texel(desc: TextureDescriptor, ix: i32, iy: i32, format: u32) -> vec4<f32> {
  let texel_idx = u32(iy) * desc.width + u32(ix);
  if (format == 2u) {
    let base = desc.data_offset + texel_idx * 4u;
    return vec4<f32>(
      bitcast<f32>(texture_texels[base + 0u]),
      bitcast<f32>(texture_texels[base + 1u]),
      bitcast<f32>(texture_texels[base + 2u]),
      bitcast<f32>(texture_texels[base + 3u]),
    );
  }
  if (format == 3u) {
    let rg = unpack2x16float(texture_texels[desc.data_offset + texel_idx]);
    return vec4<f32>(rg.x, rg.y, 0.0, 1.0);
  }
  let rgba = unpack4x8unorm(texture_texels[desc.data_offset + texel_idx]);
  if (format == 1u) {
    return vec4<f32>(closure_srgb_to_linear(rgba.rgb), rgba.a);
  }
  return rgba;
}

fn closure_sample_texture_uv(tex_index: i32, raw_uv0: vec2<f32>, raw_uv1: vec2<f32>) -> vec4<f32> {
  if (tex_index < 0) {
    return vec4<f32>(1.0);
  }
  let u_idx = u32(tex_index);
  if (u_idx >= kernel_params.texture_count) {
    return vec4<f32>(1.0);
  }
  let desc = texture_descriptors[u_idx];
  if (desc.width == 0u || desc.height == 0u) {
    return vec4<f32>(1.0);
  }
  let flags = desc.format_and_sampler;
  let format = flags & 0xFFu;
  let wrap_u = (flags >> 16u) & 3u;
  let wrap_v = (flags >> 18u) & 3u;
  let is_nearest = ((flags >> 20u) & 1u) != 0u;
  let use_uv1 = ((flags >> 21u) & 1u) != 0u;

  let base_uv = select(raw_uv0, raw_uv1, use_uv1);
  let uv = base_uv * desc.uv_scale + desc.uv_offset;
  let u_wrapped = closure_wrap_coord(uv.x, wrap_u);
  let v_wrapped = closure_wrap_coord(uv.y, wrap_v);
  let w_i = i32(desc.width);
  let h_i = i32(desc.height);

  if (is_nearest) {
    let ix = clamp(i32(floor(u_wrapped * f32(w_i))), 0, w_i - 1);
    let iy = clamp(i32(floor(v_wrapped * f32(h_i))), 0, h_i - 1);
    return closure_fetch_texel(desc, ix, iy, format);
  }

  let fx = u_wrapped * f32(w_i) - 0.5;
  let fy = v_wrapped * f32(h_i) - 0.5;
  let bx0 = i32(floor(fx));
  let by0 = i32(floor(fy));
  let tx = fx - f32(bx0);
  let ty = fy - f32(by0);
  let ix0 = closure_wrap_texel_index(bx0, w_i, wrap_u);
  let ix1 = closure_wrap_texel_index(bx0 + 1, w_i, wrap_u);
  let iy0 = closure_wrap_texel_index(by0, h_i, wrap_v);
  let iy1 = closure_wrap_texel_index(by0 + 1, h_i, wrap_v);

  let c00 = closure_fetch_texel(desc, ix0, iy0, format);
  let c10 = closure_fetch_texel(desc, ix1, iy0, format);
  let c01 = closure_fetch_texel(desc, ix0, iy1, format);
  let c11 = closure_fetch_texel(desc, ix1, iy1, format);
  return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty);
}

fn closure_sample_texture(tex_index: i32, point: ptr<function, ShadingPoint>) -> vec4<f32> {
  return closure_sample_texture_uv(tex_index, (*point).uv0, (*point).uv1);
}

fn closure_apply_normal_map(
  tex_index: i32,
  strength: f32,
  point: ptr<function, ShadingPoint>,
  base_normal: vec3<f32>,
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
) -> vec3<f32> {
  if (tex_index < 0 || u32(tex_index) >= kernel_params.texture_count || strength <= 0.0) {
    return base_normal;
  }
  let desc = texture_descriptors[u32(tex_index)];
  let format = desc.format_and_sampler & 0xFFu;
  let texel = closure_sample_texture(tex_index, point).rgb;
  let nx = (texel.x * 2.0 - 1.0) * strength;
  let ny = (texel.y * 2.0 - 1.0) * strength;
  var nz = texel.z * 2.0 - 1.0;
  if (format == 3u) {
    nz = sqrt(max(0.0, 1.0 - (texel.x * 2.0 - 1.0) * (texel.x * 2.0 - 1.0) - (texel.y * 2.0 - 1.0) * (texel.y * 2.0 - 1.0)));
  }
  let mapped = tangent * nx + bitangent * ny + base_normal * nz;
  return bsdf_mf_safe_normalize_fallback(mapped, base_normal);
}

fn closure_apply_bump_map(
  tex_index: i32,
  bump_distance: f32,
  point: ptr<function, ShadingPoint>,
  base_normal: vec3<f32>,
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
) -> vec3<f32> {
  if (tex_index < 0 || u32(tex_index) >= kernel_params.texture_count || bump_distance == 0.0) {
    return base_normal;
  }
  let desc = texture_descriptors[u32(tex_index)];
  if (desc.width == 0u || desc.height == 0u) {
    return base_normal;
  }
  let du = vec2<f32>(1.0 / f32(desc.width), 0.0);
  let dv = vec2<f32>(0.0, 1.0 / f32(desc.height));
  let h_c = bsdf_mf_average(closure_sample_texture_uv(tex_index, (*point).uv0, (*point).uv1).rgb);
  let h_u = bsdf_mf_average(closure_sample_texture_uv(tex_index, (*point).uv0 + du, (*point).uv1 + du).rgb);
  let h_v = bsdf_mf_average(closure_sample_texture_uv(tex_index, (*point).uv0 + dv, (*point).uv1 + dv).rgb);
  let dh_du = (h_u - h_c) * f32(desc.width) * bump_distance;
  let dh_dv = (h_v - h_c) * f32(desc.height) * bump_distance;
  let perturbed = base_normal - dh_du * tangent - dh_dv * bitangent;
  return bsdf_mf_safe_normalize_fallback(perturbed, base_normal);
}

fn closure_read_sheen_ltc(x: f32, y: f32) -> vec3<f32> {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let limit = 12u;
  var res = vec3<f32>(0.0);
  for (var q: u32 = 0u; q < limit; q = q + 1u) {
    let plane = q >> 2u;
    let corner = q & 3u;
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    let elem_idx = plane * 1024u + cy * 32u + cx;
    let pair = unpack2x16float(closure_lut_sheen_u32(elem_idx >> 1u));
    let val = select(pair.x, pair.y, (elem_idx & 1u) != 0u) * (wx * wy);
    if (plane == 0u) {
      res.x = res.x + val;
    } else if (plane == 1u) {
      res.y = res.y + val;
    } else {
      res.z = res.z + val;
    }
  }
  return res;
}

fn closure_sheen_make_safe_tangent(normal: vec3<f32>, dir: vec3<f32>) -> mat2x3<f32> {
  let raw_b = cross(normal, dir);
  let len_b = length(raw_b);
  if (len_b < 1e-4) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let bitangent = raw_b / len_b;
  if (dot(bitangent, bitangent) < 0.99) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let tangent = cross(bitangent, normal);
  return mat2x3<f32>(tangent, bitangent);
}

fn closure_sheen_setup_lobe(
  normal: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  roughness: f32,
) -> ClosureSheenSetup {
  let clamped_r = clamp(roughness, 1e-3, 1.0);
  let frame = closure_sheen_make_safe_tangent(normal, wo);
  let cos_no = dot(normal, wo);
  let sheen_ltc = closure_read_sheen_ltc(cos_no, clamped_r);
  let transform_a = sheen_ltc.x;
  let transform_b = sheen_ltc.y;
  let albedo = sheen_ltc.z;

  if (abs(transform_a) < 1e-5 || albedo < 1e-5) {
    return ClosureSheenSetup(closure_empty_lobe(), vec3<f32>(0.0), false);
  }

  var lobe = closure_empty_lobe();
  lobe.weight = weight * albedo;
  lobe.sample_weight = bsdf_mf_average(lobe.weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_SHEEN;
  lobe.tangent = frame[0];
  lobe.f82_or_tint = frame[1];
  lobe.diffuse_roughness = clamped_r;
  lobe.alpha_x = transform_a;
  lobe.alpha_y = transform_b;

  let layer_albedo = vec3<f32>(bsdf_mf_max_component(lobe.weight));
  return ClosureSheenSetup(lobe, layer_albedo, lobe.sample_weight > 0.0);
}

fn closure_sheen_eval(lobe: ptr<function, Lobe>, wi: vec3<f32>) -> BsdfMfEval {
  let local_wi = vec3<f32>(dot(wi, (*lobe).tangent), dot(wi, (*lobe).f82_or_tint), dot(wi, (*lobe).normal));
  if (local_wi.z <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let a = (*lobe).alpha_x;
  let b = (*lobe).alpha_y;
  let len_sqr = bsdf_mf_sqr(a * local_wi.x + b * local_wi.z) + bsdf_mf_sqr(a * local_wi.y) + bsdf_mf_sqr(local_wi.z);
  if (len_sqr <= 1e-20) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let val = INV_PI * local_wi.z * bsdf_mf_sqr(a / len_sqr);
  return BsdfMfEval((*lobe).weight * val, val);
}

fn closure_sheen_sample(
  lobe: ptr<function, Lobe>,
  geometric_normal: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfMfSample {
  let a = (*lobe).alpha_x;
  let b = (*lobe).alpha_y;
  let disk = bsdf_diffuse_sample_uniform_disk(rand);
  let disk_z = sqrt(max(0.0, 1.0 - dot(disk, disk)));
  let unnorm = vec3<f32>(disk.x - disk_z * b, disk.y, disk_z * a);
  let len_sq = dot(unnorm, unnorm);
  if (len_sq <= 1e-20) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let local_wi = unnorm * inverseSqrt(len_sq);
  if (local_wi.z <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let wi = local_wi.x * (*lobe).tangent + local_wi.y * (*lobe).f82_or_tint + local_wi.z * (*lobe).normal;
  if (dot(geometric_normal, wi) <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let denom = bsdf_mf_sqr(a * local_wi.x + b * local_wi.z) + bsdf_mf_sqr(a * local_wi.y) + bsdf_mf_sqr(local_wi.z);
  let val = INV_PI * local_wi.z * bsdf_mf_sqr(a / max(denom, 1e-20));
  return BsdfMfSample(wi, val, (*lobe).weight * val, false);
}

fn closure_transparent_setup_lobe(normal: vec3<f32>, weight: vec3<f32>) -> Lobe {
  var lobe = closure_empty_lobe();
  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_TRANSPARENT;
  return lobe;
}

fn closure_thin_glass_transmission_alpha(alpha: f32, eta: f32) -> f32 {
  let safe_eta = max(eta, 1e-4);
  return clamp(alpha * 3.4 * abs(safe_eta - 1.0) * bsdf_mf_sqr(safe_eta - 0.5) / (safe_eta * safe_eta * safe_eta), 0.0, 1.0);
}

fn closure_thin_glass_fresnel(
  reflection_tint: vec3<f32>,
  transmission_tint: vec3<f32>,
  ior: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  cos_theta_i: f32,
) -> BsdfGlassFresnel {
  let f0 = clamp(bsdf_mf_f0_from_ior(ior) * max(reflection_tint, vec3<f32>(0.0)), vec3<f32>(0.0), vec3<f32>(1.0));
  let front4 = bsdf_mf_generalized_schlick_eval(f0, ior, thin_film_thickness, thin_film_ior, cos_theta_i);
  let front_refl = clamp(front4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let front_trans = vec3<f32>(1.0) - front_refl;
  let cos_t = front4.w;
  var slab_color = vec3<f32>(0.0);
  if (cos_t < -1e-6) {
    let inv_cos = -1.0 / cos_t;
    let tc = clamp(transmission_tint, vec3<f32>(0.0), vec3<f32>(1.0));
    slab_color = vec3<f32>(
      select(0.0, pow(tc.x, inv_cos), tc.x > 0.0),
      select(0.0, pow(tc.y, inv_cos), tc.y > 0.0),
      select(0.0, pow(tc.z, inv_cos), tc.z > 0.0),
    );
  }
  var back_refl = front_refl;
  var back_trans = front_trans;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let inv_ior = 1.0 / max(ior, 1e-5);
    let back4 = bsdf_mf_generalized_schlick_eval(f0, inv_ior, thin_film_thickness, thin_film_ior * inv_ior, -cos_t);
    back_refl = clamp(back4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    back_trans = vec3<f32>(1.0) - back_refl;
  }
  let denom = max(vec3<f32>(1.0) - (back_refl * slab_color) * (back_refl * slab_color), vec3<f32>(1e-6));
  let trans = (slab_color * front_trans * back_trans) / denom;
  let refl = front_refl + trans * back_refl * slab_color;
  return BsdfGlassFresnel(clamp(refl, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(trans, vec3<f32>(0.0), vec3<f32>(1.0)), cos_t);
}

// Without pruning the lobe goes straight into the closure; with pruning it waits in the scratch array.
// lobe_count doubles as the candidate count until closure_build finishes.
fn closure_add_candidate(closure: ptr<function, Closure>, scratch: ptr<function, array<Lobe, CLOSURE_SCRATCH_LOBES>>, lobe: Lobe) {
  let slot = (*closure).lobe_count;
  if (CLOSURE_PRUNES_CANDIDATES) {
    (*scratch)[slot] = lobe;
  } else {
    (*closure).lobes[slot] = lobe;
    (*closure).total_sample_weight = (*closure).total_sample_weight + lobe.sample_weight;
  }
  (*closure).lobe_count = slot + 1u;
}

fn closure_build(point: ptr<function, ShadingPoint>, wo: vec3<f32>) -> Closure {
  var closure: Closure;
  for (var lobe_slot: u32 = 0u; lobe_slot < MAX_CLOSURE_LOBES; lobe_slot = lobe_slot + 1u) {
    closure.lobes[lobe_slot] = closure_empty_lobe();
  }
  closure.emission = vec3<f32>(0.0);
  closure.lobe_count = 0u;
  closure.absorption_sigma = vec3<f32>(0.0);
  closure.total_sample_weight = 0.0;
  closure.geometric_normal = (*point).geometric_normal;
  closure.front_face = (*point).front_face;

  let wo_len_sq = dot(wo, wo);
  if (wo_len_sq <= 1e-16) {
    return closure;
  }
  let wo_dir = wo * inverseSqrt(wo_len_sq);
  let mat = materials[(*point).material_index];

  var vertex_color = (*point).vertex_color;
  if ((*point).triangle_index < kernel_params.triangle_count) {
    if ((triangles[(*point).triangle_index].flags & TRIANGLE_FLAG_HAS_VERTEX_COLORS) == 0u) {
      vertex_color = vec3<f32>(1.0);
    }
  }

  let smooth_normal = bsdf_mf_safe_normalize_fallback((*point).shading_normal, (*point).geometric_normal);
  var frame_t = (*point).tangent;
  var frame_b = (*point).bitangent;
  if (dot(frame_t, frame_t) < 1e-6 || dot(frame_b, frame_b) < 1e-6) {
    let fallback_frame = bsdf_mf_make_orthonormals(smooth_normal);
    frame_t = fallback_frame[0];
    frame_b = fallback_frame[1];
  } else {
    frame_t = normalize(frame_t);
    frame_b = normalize(frame_b);
  }

  var base_color = max(mat.base_color * vertex_color, vec3<f32>(0.0));
  var tex_alpha = 1.0;
  if (mat.base_color_tex >= 0) {
    let bc_tex = closure_sample_texture(mat.base_color_tex, point);
    base_color = max(base_color * bc_tex.rgb, vec3<f32>(0.0));
    tex_alpha = bc_tex.a;
  }
  if (SCENE_HAS_ALPHA_MASK && mat.alpha_tex >= 0) {
    tex_alpha = tex_alpha * closure_sample_texture(mat.alpha_tex, point).r;
  }

  var opacity = 1.0;
  let raw_alpha = clamp(mat.alpha * tex_alpha, 0.0, 1.0);
  if (SCENE_HAS_ALPHA_MASK && mat.alpha_mode == ALPHA_MODE_MASK) {
    if (raw_alpha < mat.alpha_cutoff) {
      let trans_lobe = closure_transparent_setup_lobe(smooth_normal, vec3<f32>(1.0));
      closure.lobes[0] = trans_lobe;
      closure.lobe_count = 1u;
      closure.total_sample_weight = trans_lobe.sample_weight;
      return closure;
    }
  } else if (SCENE_HAS_TRANSPARENT && mat.alpha_mode == ALPHA_MODE_BLEND) {
    opacity = raw_alpha;
    if (opacity <= 0.0) {
      let trans_lobe = closure_transparent_setup_lobe(smooth_normal, vec3<f32>(1.0));
      closure.lobes[0] = trans_lobe;
      closure.lobe_count = 1u;
      closure.total_sample_weight = trans_lobe.sample_weight;
      return closure;
    }
  }

  var roughness = clamp(mat.roughness, 0.0, 1.0);
  var metallic = clamp(mat.metallic, 0.0, 1.0);
  if (mat.metallic_roughness_tex >= 0) {
    let mr_tex = closure_sample_texture(mat.metallic_roughness_tex, point);
    roughness = clamp(roughness * mr_tex.g, 0.0, 1.0);
    metallic = clamp(metallic * mr_tex.b, 0.0, 1.0);
  }

  var transmission_weight = select(0.0, clamp(mat.transmission_weight, 0.0, 1.0), SCENE_HAS_GLASS);
  if (SCENE_HAS_GLASS && mat.transmission_tex >= 0) {
    transmission_weight = clamp(transmission_weight * closure_sample_texture(mat.transmission_tex, point).r, 0.0, 1.0);
  }

  var coat_weight = select(0.0, max(mat.coat_weight, 0.0), SCENE_HAS_COAT);
  var coat_roughness = clamp(mat.coat_roughness, 0.0, 1.0);
  if (SCENE_HAS_COAT && mat.coat_weight_roughness_tex >= 0) {
    let cwr_tex = closure_sample_texture(mat.coat_weight_roughness_tex, point);
    coat_weight = max(coat_weight * cwr_tex.r, 0.0);
    coat_roughness = clamp(coat_roughness * cwr_tex.g, 0.0, 1.0);
  }
  var coat_tint = max(mat.coat_tint, vec3<f32>(0.0));
  if (SCENE_HAS_COAT && mat.coat_tint_tex >= 0) {
    coat_tint = max(coat_tint * closure_sample_texture(mat.coat_tint_tex, point).rgb, vec3<f32>(0.0));
  }

  var sheen_weight = select(0.0, max(mat.sheen_weight, 0.0), SCENE_HAS_SHEEN);
  var sheen_tint = max(mat.sheen_tint, vec3<f32>(0.0));
  var sheen_roughness = clamp(mat.sheen_roughness, 0.0, 1.0);
  if (SCENE_HAS_SHEEN && mat.sheen_color_roughness_tex >= 0) {
    let scr_tex = closure_sample_texture(mat.sheen_color_roughness_tex, point);
    sheen_tint = max(sheen_tint * scr_tex.rgb, vec3<f32>(0.0));
    sheen_roughness = clamp(sheen_roughness * scr_tex.a, 0.0, 1.0);
  }

  var anisotropic = select(0.0, clamp(mat.anisotropy, 0.0, 1.0), SCENE_HAS_ANISOTROPY);
  var aniso_rotation = mat.anisotropy_rotation;
  if (SCENE_HAS_ANISOTROPY && mat.anisotropy_tex >= 0) {
    let ani_tex = closure_sample_texture(mat.anisotropy_tex, point);
    anisotropic = clamp(anisotropic * ani_tex.b, 0.0, 1.0);
    let dir_xy = ani_tex.rg * 2.0 - vec2<f32>(1.0);
    if (dot(dir_xy, dir_xy) > 1e-6) {
      aniso_rotation = aniso_rotation + atan2(dir_xy.y, dir_xy.x) * INV_TWO_PI;
    }
  }

  var emission_color = max(mat.emission_color, vec3<f32>(0.0));
  if (mat.emission_tex >= 0) {
    emission_color = max(emission_color * closure_sample_texture(mat.emission_tex, point).rgb, vec3<f32>(0.0));
  }

  var shading_n = smooth_normal;
  if (SCENE_HAS_NORMAL_MAP) {
    shading_n = closure_apply_normal_map(mat.normal_tex, mat.normal_scale, point, smooth_normal, frame_t, frame_b);
    shading_n = closure_apply_bump_map(mat.bump_tex, mat.bump_distance, point, shading_n, frame_t, frame_b);
  }

  var raw_coat_n = bsdf_mf_safe_normalize_fallback((*point).coat_normal, shading_n);
  if (SCENE_HAS_NORMAL_MAP) {
    raw_coat_n = closure_apply_normal_map(mat.coat_normal_tex, mat.coat_normal_scale, point, raw_coat_n, frame_t, frame_b);
  }

  let preserve_energy = (mat.flags & MATERIAL_FLAG_MULTISCATTER_GGX) != 0u;
  let thin_walled = (mat.flags & MATERIAL_FLAG_THIN_WALLED) != 0u;

  var candidates: array<Lobe, CLOSURE_SCRATCH_LOBES>;
  var layer_weight = vec3<f32>(1.0);

  if (SCENE_HAS_TRANSPARENT && opacity < 1.0) {
    let trans_lobe = closure_transparent_setup_lobe(shading_n, vec3<f32>(1.0 - opacity));
    if (trans_lobe.sample_weight > 0.0) {
      closure_add_candidate(&closure, &candidates, trans_lobe);
    }
    layer_weight = vec3<f32>(opacity);
  }

  if (SCENE_HAS_SHEEN && sheen_weight > CLOSURE_WEIGHT_CUTOFF) {
    let sheen_n = bsdf_mf_safe_normalize_fallback(mix(shading_n, raw_coat_n, clamp(coat_weight, 0.0, 1.0)), shading_n);
    let sheen_w = sheen_weight * sheen_tint * layer_weight;
    let sheen_setup = closure_sheen_setup_lobe(sheen_n, wo_dir, sheen_w, sheen_roughness);
    if (sheen_setup.valid) {
      closure_add_candidate(&closure, &candidates, sheen_setup.lobe);
      layer_weight = closure_layering_weight(sheen_setup.layer_albedo, layer_weight);
    }
  }

  if (SCENE_HAS_COAT && coat_weight > CLOSURE_WEIGHT_CUTOFF) {
    let coat_w = coat_weight * layer_weight;
    let coat_setup = bsdf_coat_setup_lobe(
      (*point).geometric_normal,
      raw_coat_n,
      wo_dir,
      coat_w,
      coat_roughness,
      mat.coat_ior,
      coat_tint,
      preserve_energy,
    );
    if (coat_setup.lobe.sample_weight > 0.0) {
      closure_add_candidate(&closure, &candidates, coat_setup.lobe);
    }
    layer_weight = closure_layering_weight(coat_setup.layer_albedo, layer_weight);
  }

  let emission = emission_color * max(mat.emission_strength, 0.0);
  if (any(emission > vec3<f32>(0.0))) {
    closure.emission = emission * layer_weight;
  }

  let clamped_base_color = clamp(base_color, vec3<f32>(0.0), vec3<f32>(1.0));
  let ior = max(mat.ior, 1e-5);
  let valid_refl_n = bsdf_mf_ensure_valid_specular_reflection((*point).geometric_normal, wo_dir, shading_n);
  var specular_tint = max(mat.f82_tint, vec3<f32>(0.0));
  if ((mat.flags & MATERIAL_FLAG_F82_METALLIC) == 0u && all(specular_tint == vec3<f32>(0.0))) {
    specular_tint = vec3<f32>(1.0);
  }
  let thin_film_thickness = select(0.0, mat.thin_film_thickness, SCENE_HAS_THIN_FILM);
  let thin_film_ior = select(0.0, max(mat.thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  var alpha_x = roughness * roughness;
  var alpha_y = roughness * roughness;
  var aniso_t = vec3<f32>(0.0);
  if (anisotropic > 0.0) {
    aniso_t = frame_t;
    let aspect = sqrt(1.0 - anisotropic * 0.9);
    alpha_x = alpha_x / aspect;
    alpha_y = alpha_y * aspect;
    if (aniso_rotation != 0.0) {
      aniso_t = bsdf_mf_rotate_around_axis(aniso_t, shading_n, aniso_rotation * TWO_PI);
    }
  }

  if (metallic > CLOSURE_WEIGHT_CUTOFF) {
    let metal_w = metallic * layer_weight;
    let f82 = min(specular_tint, vec3<f32>(1.0));
    let metal_lobe = bsdf_mf_setup_conductor_lobe(
      valid_refl_n,
      aniso_t,
      wo_dir,
      metal_w,
      clamped_base_color,
      f82,
      alpha_x,
      alpha_y,
      thin_film_thickness,
      thin_film_ior,
      preserve_energy,
    );
    if (metal_lobe.sample_weight > 0.0) {
      closure_add_candidate(&closure, &candidates, metal_lobe);
    }
    layer_weight = layer_weight * (1.0 - metallic);
  }

  if (SCENE_HAS_GLASS && transmission_weight > CLOSURE_WEIGHT_CUTOFF && bsdf_mf_max_component(layer_weight) > CLOSURE_WEIGHT_CUTOFF) {
    let trans_w = transmission_weight * layer_weight;
    if (thin_walled) {
      let cos_no = max(dot(valid_refl_n, wo_dir), 0.0);
      let tf = closure_thin_glass_fresnel(specular_tint, clamped_base_color, ior, thin_film_thickness, thin_film_ior, cos_no);
      let base_alpha = roughness * roughness;
      var refl_lobe = closure_empty_lobe();
      refl_lobe.weight = tf.reflectance * trans_w;
      refl_lobe.sample_weight = bsdf_mf_average(refl_lobe.weight);
      refl_lobe.normal = valid_refl_n;
      refl_lobe.lobe_type = LOBE_GLOSSY_GGX;
      refl_lobe.flags = LOBE_FLAG_F82_TINT;
      refl_lobe.f0 = vec3<f32>(1.0);
      refl_lobe.diffuse_roughness = 1.0;
      refl_lobe.alpha_x = base_alpha;
      refl_lobe.alpha_y = base_alpha;
      if (preserve_energy) {
        let pres = bsdf_mf_preserve_energy_glossy(valid_refl_n, vec3<f32>(0.0), wo_dir, base_alpha, base_alpha, clamp(specular_tint, vec3<f32>(0.0), vec3<f32>(1.0)));
        refl_lobe.weight = refl_lobe.weight * pres.xyz;
        refl_lobe.sample_weight = bsdf_mf_average(refl_lobe.weight);
        refl_lobe.diffuse_roughness = pres.w;
      }
      if (refl_lobe.sample_weight > 0.0) {
        closure_add_candidate(&closure, &candidates, refl_lobe);
      }

      let trans_alpha = closure_thin_glass_transmission_alpha(base_alpha, ior);
      var thin_trans_lobe = closure_empty_lobe();
      thin_trans_lobe.weight = tf.transmittance * trans_w;
      thin_trans_lobe.sample_weight = bsdf_mf_average(thin_trans_lobe.weight);
      thin_trans_lobe.normal = -valid_refl_n;
      thin_trans_lobe.lobe_type = LOBE_GLOSSY_GGX;
      thin_trans_lobe.flags = LOBE_FLAG_THIN_WALLED | LOBE_FLAG_F82_TINT;
      thin_trans_lobe.f0 = vec3<f32>(1.0);
      thin_trans_lobe.diffuse_roughness = 1.0;
      thin_trans_lobe.alpha_x = trans_alpha;
      thin_trans_lobe.alpha_y = trans_alpha;
      if (preserve_energy) {
        let wo_mirrored = wo_dir - 2.0 * dot(wo_dir, valid_refl_n) * valid_refl_n;
        let pres_t = bsdf_mf_preserve_energy_glossy(-valid_refl_n, vec3<f32>(0.0), wo_mirrored, trans_alpha, trans_alpha, vec3<f32>(1.0));
        thin_trans_lobe.diffuse_roughness = pres_t.w;
      }
      if (thin_trans_lobe.sample_weight > 0.0) {
        closure_add_candidate(&closure, &candidates, thin_trans_lobe);
      }
    } else {
      let glass_lobe = bsdf_glass_setup_lobe(
        valid_refl_n,
        aniso_t,
        wo_dir,
        trans_w,
        ior,
        (*point).front_face,
        specular_tint,
        sqrt(clamped_base_color),
        alpha_x,
        alpha_y,
        thin_film_thickness,
        thin_film_ior,
        preserve_energy,
      );
      if (glass_lobe.sample_weight > 0.0) {
        closure_add_candidate(&closure, &candidates, glass_lobe);
      }
      if (mat.absorption_distance > 0.0) {
        let clamped_abs = clamp(mat.absorption_color, vec3<f32>(1e-6), vec3<f32>(1.0));
        closure.absorption_sigma = max(-log(clamped_abs) / mat.absorption_distance, vec3<f32>(0.0));
      }
    }
    layer_weight = layer_weight * (1.0 - transmission_weight);
  }

  let specular_ior_level = max(mat.specular_ior_level, 0.0);
  var eta_spec = ior;
  var f0_scalar = bsdf_mf_f0_from_ior(eta_spec);
  if (specular_ior_level != 0.5) {
    f0_scalar = f0_scalar * 2.0 * specular_ior_level;
    eta_spec = bsdf_mf_ior_from_f0(f0_scalar);
    if (ior < 1.0) {
      eta_spec = 1.0 / eta_spec;
    }
  }

  if (bsdf_mf_max_component(layer_weight) > CLOSURE_WEIGHT_CUTOFF && (eta_spec != 1.0 || thin_film_thickness > BSDF_MF_THINFILM_CUTOFF)) {
    let spec_setup = bsdf_mf_setup_dielectric_specular_lobe(
      valid_refl_n,
      aniso_t,
      wo_dir,
      layer_weight,
      f0_scalar * specular_tint,
      eta_spec,
      alpha_x,
      alpha_y,
      thin_film_thickness,
      thin_film_ior,
      preserve_energy,
    );
    if (spec_setup.lobe.sample_weight > 0.0) {
      closure_add_candidate(&closure, &candidates, spec_setup.lobe);
    }
    layer_weight = closure_layering_weight(spec_setup.layer_albedo, layer_weight);
  }

  let diffuse_weight = base_color * layer_weight;
  if (bsdf_mf_max_component(diffuse_weight) > CLOSURE_WEIGHT_CUTOFF) {
    let diff_lobe = bsdf_diffuse_setup_lobe(
      shading_n,
      wo_dir,
      diffuse_weight,
      clamped_base_color,
      mat.diffuse_roughness,
    );
    if (diff_lobe.sample_weight > 0.0) {
      closure_add_candidate(&closure, &candidates, diff_lobe);
    }
  }

  if (CLOSURE_PRUNES_CANDIDATES) {
    let cand_count = closure.lobe_count;
    closure.lobe_count = 0u;
    if (cand_count <= MAX_CLOSURE_LOBES) {
      for (var i: u32 = 0u; i < cand_count; i = i + 1u) {
        closure.lobes[i] = candidates[i];
        closure.total_sample_weight = closure.total_sample_weight + candidates[i].sample_weight;
      }
      closure.lobe_count = cand_count;
    } else {
      var used_mask: u32 = 0u;
      var out_idx: u32 = 0u;
      if (candidates[0].lobe_type == LOBE_TRANSPARENT) {
        closure.lobes[0] = candidates[0];
        closure.total_sample_weight = closure.total_sample_weight + candidates[0].sample_weight;
        used_mask = 1u;
        out_idx = 1u;
      }
      for (; out_idx < MAX_CLOSURE_LOBES; out_idx = out_idx + 1u) {
        var best_j: u32 = 0u;
        var best_w: f32 = -1.0;
        for (var j: u32 = 0u; j < cand_count; j = j + 1u) {
          if (((used_mask >> j) & 1u) == 0u && candidates[j].sample_weight > best_w) {
            best_w = candidates[j].sample_weight;
            best_j = j;
          }
        }
        used_mask = used_mask | (1u << best_j);
        closure.lobes[out_idx] = candidates[best_j];
        closure.total_sample_weight = closure.total_sample_weight + candidates[best_j].sample_weight;
      }
      closure.lobe_count = MAX_CLOSURE_LOBES;
    }
  }

  return closure;
}

fn closure_eval_single_lobe(lobe: ptr<function, Lobe>, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  if ((*lobe).lobe_type == LOBE_DIFFUSE) {
    let d = bsdf_diffuse_eval(lobe, wi, wo);
    return BsdfMfEval(d.value, d.pdf);
  }
  if ((*lobe).lobe_type == LOBE_GLOSSY_GGX) {
    let is_tw = ((*lobe).flags & LOBE_FLAG_THIN_WALLED) != 0u;
    let eval_wo = select(wo, wo - 2.0 * dot(wo, (*lobe).normal) * (*lobe).normal, is_tw);
    return bsdf_mf_eval(lobe, wi, eval_wo);
  }
  if ((*lobe).lobe_type == LOBE_GLASS_GGX) {
    return bsdf_glass_eval(lobe, wi, wo);
  }
  if ((*lobe).lobe_type == LOBE_COAT_GGX) {
    return bsdf_coat_eval(lobe, wi, wo);
  }
  if ((*lobe).lobe_type == LOBE_SHEEN) {
    return closure_sheen_eval(lobe, wi);
  }
  return BsdfMfEval(vec3<f32>(0.0), 0.0);
}

fn closure_eval(closure: ptr<function, Closure>, wi: vec3<f32>, wo: vec3<f32>) -> ClosureEval {
  if ((*closure).lobe_count == 0u || (*closure).total_sample_weight <= 0.0) {
    return ClosureEval(vec3<f32>(0.0), 0.0);
  }
  var total_value = vec3<f32>(0.0);
  var total_pdf = 0.0;
  let inv_total_w = 1.0 / (*closure).total_sample_weight;
  for (var i: u32 = 0u; i < (*closure).lobe_count; i = i + 1u) {
    var lobe_copy = (*closure).lobes[i];
    if (lobe_copy.sample_weight <= 0.0 || lobe_copy.lobe_type == LOBE_TRANSPARENT) {
      continue;
    }
    let lobe_prob = lobe_copy.sample_weight * inv_total_w;
    let ev = closure_eval_single_lobe(&lobe_copy, wi, wo);
    total_value = total_value + ev.value;
    total_pdf = total_pdf + lobe_prob * ev.pdf;
  }
  return ClosureEval(total_value, total_pdf);
}

fn closure_sample_single_lobe(
  lobe: ptr<function, Lobe>,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand_xy: vec2<f32>,
  rand_lobe: f32,
) -> BsdfMfSample {
  if ((*lobe).lobe_type == LOBE_DIFFUSE) {
    let s = bsdf_diffuse_sample(lobe, geometric_normal, wo, rand_xy);
    return BsdfMfSample(s.wi, s.pdf, s.eval, false);
  }
  if ((*lobe).lobe_type == LOBE_GLOSSY_GGX) {
    let is_tw = ((*lobe).flags & LOBE_FLAG_THIN_WALLED) != 0u;
    if (is_tw && bsdf_mf_is_singular((*lobe).alpha_x, (*lobe).alpha_y)) {
      return BsdfMfSample(-wo, CLOSURE_SINGULAR_WEIGHT, (*lobe).weight * CLOSURE_SINGULAR_WEIGHT, true);
    }
    let samp_ng = select(geometric_normal, -geometric_normal, is_tw);
    let samp_wo = select(wo, wo - 2.0 * dot(wo, (*lobe).normal) * (*lobe).normal, is_tw);
    return bsdf_mf_sample(lobe, samp_ng, samp_wo, rand_xy);
  }
  if ((*lobe).lobe_type == LOBE_GLASS_GGX) {
    return bsdf_glass_sample(lobe, geometric_normal, wo, rand_xy, rand_lobe);
  }
  if ((*lobe).lobe_type == LOBE_COAT_GGX) {
    return bsdf_coat_sample(lobe, geometric_normal, wo, rand_xy);
  }
  if ((*lobe).lobe_type == LOBE_SHEEN) {
    return closure_sheen_sample(lobe, geometric_normal, rand_xy);
  }
  if ((*lobe).lobe_type == LOBE_TRANSPARENT) {
    return BsdfMfSample(-wo, CLOSURE_SINGULAR_WEIGHT, (*lobe).weight * CLOSURE_SINGULAR_WEIGHT, true);
  }
  return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
}

fn closure_sample(closure: ptr<function, Closure>, wo: vec3<f32>, u: vec3<f32>) -> ClosureSample {
  if ((*closure).lobe_count == 0u || (*closure).total_sample_weight <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }

  let cdf_target = clamp(u.x, 0.0, 0.99999994) * (*closure).total_sample_weight;
  var chosen_idx: u32 = (*closure).lobe_count - 1u;
  var cdf_prev = 0.0;
  for (var i: u32 = 0u; i < (*closure).lobe_count; i = i + 1u) {
    let next_cdf = cdf_prev + (*closure).lobes[i].sample_weight;
    if (cdf_target < next_cdf || i == (*closure).lobe_count - 1u) {
      chosen_idx = i;
      break;
    }
    cdf_prev = next_cdf;
  }

  var chosen_lobe = (*closure).lobes[chosen_idx];
  let chosen_sample_weight = chosen_lobe.sample_weight;
  let chosen_lobe_type = chosen_lobe.lobe_type;
  if (chosen_sample_weight <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }

  let lobe_prob = chosen_sample_weight / (*closure).total_sample_weight;
  let u_lobe = clamp((cdf_target - cdf_prev) / max(chosen_sample_weight, 1e-20), 0.0, 0.99999994);
  let rand_xy = clamp(u.yz, vec2<f32>(0.0), vec2<f32>(0.99999994));

  let s = closure_sample_single_lobe(&chosen_lobe, (*closure).geometric_normal, wo, rand_xy, u_lobe);
  if (s.pdf <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }
  if (s.is_singular) {
    return ClosureSample(s.wi, lobe_prob * s.pdf, s.eval, chosen_lobe_type);
  }

  let mix_ev = closure_eval(closure, s.wi, wo);
  if (mix_ev.pdf <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }
  return ClosureSample(s.wi, mix_ev.pdf, mix_ev.value, chosen_lobe_type);
}

fn closure_eval_albedo(closure: ptr<function, Closure>, wo: vec3<f32>) -> vec3<f32> {
  var albedo = vec3<f32>(0.0);
  for (var i: u32 = 0u; i < (*closure).lobe_count; i = i + 1u) {
    var lobe_copy = (*closure).lobes[i];
    if (lobe_copy.lobe_type == LOBE_DIFFUSE || lobe_copy.lobe_type == LOBE_SHEEN) {
      albedo = albedo + lobe_copy.weight;
    } else if (lobe_copy.lobe_type == LOBE_GLOSSY_GGX) {
      let fr = bsdf_mf_eval_glossy_fresnel(&lobe_copy, max(dot(lobe_copy.normal, wo), 0.0));
      albedo = albedo + lobe_copy.weight * fr;
    } else if (lobe_copy.lobe_type == LOBE_GLASS_GGX) {
      let gr = bsdf_glass_fresnel(&lobe_copy, max(dot(lobe_copy.normal, wo), 0.0));
      albedo = albedo + lobe_copy.weight * (gr.reflectance + gr.transmittance);
    } else if (lobe_copy.lobe_type == LOBE_COAT_GGX) {
      let fc = bsdf_mf_fresnel_dielectric_cos(max(dot(lobe_copy.normal, wo), 0.0), lobe_copy.ior);
      albedo = albedo + lobe_copy.weight * fc;
    }
  }
  return clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn closure_eval_normal(closure: ptr<function, Closure>) -> vec3<f32> {
  if ((*closure).lobe_count == 0u) {
    return (*closure).geometric_normal;
  }
  var sum_n = vec3<f32>(0.0);
  for (var i: u32 = 0u; i < (*closure).lobe_count; i = i + 1u) {
    var lobe_copy = (*closure).lobes[i];
    if (lobe_copy.lobe_type != LOBE_TRANSPARENT) {
      sum_n = sum_n + lobe_copy.normal * lobe_copy.sample_weight;
    }
  }
  return bsdf_mf_safe_normalize_fallback(sum_n, (*closure).geometric_normal);
}

fn closure_pcg3d(v_in: vec3<u32>) -> vec3<u32> {
  var v = v_in * 1664525u + vec3<u32>(1013904223u);
  v.x = v.x + v.y * v.z;
  v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y;
  v = v ^ (v >> vec3<u32>(16u));
  v.x = v.x + v.y * v.z;
  v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y;
  return v;
}

@compute @workgroup_size(64, 1, 1)
fn test_lobe_samples(@builtin(global_invocation_id) gid: vec3<u32>) {
  let width = kernel_params.image_width;
  let height = kernel_params.image_height;
  let total = width * height;
  let idx = gid.x;
  if (idx >= total) {
    return;
  }
  if (kernel_params.kernel_flags == SMP_PROBE_MODE) {
    smp_write_probe(idx, total);
    return;
  }

  var point: ShadingPoint;
  point.position = vec3<f32>(0.0, 0.0, 0.0);
  point.ray_t = 1.0;
  point.geometric_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.front_face = select(0u, 1u, kernel_params.camera_near >= 0.0);
  point.shading_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.material_index = 0u;
  point.coat_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.instance_index = 0u;
  point.tangent = vec3<f32>(1.0, 0.0, 0.0);
  point.triangle_index = 0u;
  point.bitangent = vec3<f32>(0.0, 1.0, 0.0);
  point.emissive_index = INVALID_INDEX;
  point.uv0 = vec2<f32>(0.5, 0.5);
  point.uv1 = vec2<f32>(0.5, 0.5);
  point.barycentrics = vec2<f32>(0.25, 0.25);
  point.object_random = 0.0;
  point.light_group_mask_lo = 0xFFFFFFFFu;
  point.vertex_color = vec3<f32>(1.0);
  point.light_group_mask_hi = 0xFFFFFFFFu;

  let wo = bsdf_mf_safe_normalize_fallback(kernel_params.camera_forward, vec3<f32>(0.0, 0.0, 1.0));
  var closure = closure_build(&point, wo);
  let mode = kernel_params.kernel_flags;

  var eval_wi = vec3<f32>(0.0);
  var do_eval = false;
  var jacobian = 1.0;
  var samp = ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  var u = vec3<f32>(0.0);

  if (mode == 1u) {
    let ix = idx % width;
    let iy = idx / width;
    let u_grid = (f32(ix) + 0.5) / f32(max(width, 1u));
    let v_grid = (f32(iy) + 0.5) / f32(max(height, 1u));
    let z = 1.0 - 2.0 * v_grid;
    let r = sqrt(max(0.0, 1.0 - z * z));
    let phi = TWO_PI * u_grid;
    eval_wi = vec3<f32>(r * cos(phi), r * sin(phi), z);
    do_eval = true;
  } else if (mode == 3u || mode == 4u) {
    let ix = idx % width;
    let iy = idx / width;
    let u_grid = (f32(ix) + 0.5) / f32(max(width, 1u));
    let v_grid = (f32(iy) + 0.5) / f32(max(height, 1u));
    let r_mat = clamp(materials[0].roughness, 0.0, 1.0);
    var alpha_char = clamp(r_mat * r_mat, 1e-4, 1.0);
    if (materials[0].coat_weight > 0.0) {
      let cr_mat = clamp(materials[0].coat_roughness, 0.0, 1.0);
      alpha_char = min(alpha_char, clamp(cr_mat * cr_mat, 1e-4, 1.0));
    }
    let one_minus_v = max(1.0 - v_grid, 1e-6);
    let v2 = v_grid * v_grid;
    let tan_half = (alpha_char * v_grid + v2 * v_grid) / one_minus_v;
    let s2 = tan_half * tan_half;
    let inv_1ps2 = 1.0 / (1.0 + s2);
    let cos_gamma = (1.0 - s2) * inv_1ps2;
    let sin_gamma = 2.0 * tan_half * inv_1ps2;
    let dtdv = (alpha_char + 3.0 * v2 - 2.0 * v2 * v_grid) / (one_minus_v * one_minus_v);
    let dcos_dv = 4.0 * tan_half * inv_1ps2 * inv_1ps2 * dtdv;
    let phi = TWO_PI * u_grid;
    var axis = normalize(vec3<f32>(-wo.x, -wo.y, wo.z));
    if (mode == 4u) {
      if ((materials[0].flags & MATERIAL_FLAG_THIN_WALLED) != 0u) {
        axis = -wo;
      } else {
        let eta_g = select(1.0 / max(materials[0].ior, 1e-5), max(materials[0].ior, 1e-5), point.front_face != 0u);
        let diel_g = bsdf_mf_fresnel_dielectric(max(wo.z, 0.0), eta_g);
        if (diel_g.y < 0.0) {
          axis = normalize(bsdf_glass_refract_angle(wo, vec3<f32>(0.0, 0.0, 1.0), diel_g.y, 1.0 / eta_g));
        } else {
          axis = vec3<f32>(0.0, 0.0, -1.0);
        }
      }
    }
    let frame = bsdf_mf_make_orthonormals(axis);
    eval_wi = sin_gamma * cos(phi) * frame[0] + sin_gamma * sin(phi) * frame[1] + cos_gamma * axis;
    jacobian = (TWO_PI * dcos_dv) / f32(max(total, 1u));
    do_eval = true;
  } else {
    let rng = closure_pcg3d(vec3<u32>(idx, kernel_params.seed, 0x9E3779B9u));
    u = vec3<f32>(
      f32(rng.x >> 8u) * CLOSURE_PCG_INV_24,
      f32(rng.y >> 8u) * CLOSURE_PCG_INV_24,
      f32(rng.z >> 8u) * CLOSURE_PCG_INV_24,
    );
    samp = closure_sample(&closure, wo, u);
    eval_wi = samp.wi;
    do_eval = samp.pdf > 0.0;
  }

  var ev = ClosureEval(vec3<f32>(0.0), 0.0);
  if (do_eval) {
    ev = closure_eval(&closure, eval_wi, wo);
  }

  if (mode == 1u) {
    film_accumulation[idx] = vec4<f32>(eval_wi, ev.pdf);
    film_accumulation[total + idx] = vec4<f32>(ev.value, 0.0);
    film_accumulation[2u * total + idx] = vec4<f32>(closure.emission, closure.total_sample_weight);
    film_accumulation[3u * total + idx] = vec4<f32>(closure.absorption_sigma, f32(closure.lobe_count));
    return;
  }
  if (mode == 3u || mode == 4u) {
    film_accumulation[idx] = vec4<f32>(eval_wi, ev.pdf * jacobian);
    film_accumulation[total + idx] = vec4<f32>(ev.value * jacobian, f32(closure.lobe_count));
    film_accumulation[2u * total + idx] = vec4<f32>(ev.value, ev.pdf);
    film_accumulation[3u * total + idx] = vec4<f32>(closure.absorption_sigma, closure.total_sample_weight);
    return;
  }

  film_accumulation[idx] = vec4<f32>(samp.wi, samp.pdf);
  film_accumulation[total + idx] = vec4<f32>(samp.eval, f32(samp.sampled_lobe_type));
  film_accumulation[2u * total + idx] = vec4<f32>(ev.value, ev.pdf);
  film_accumulation[3u * total + idx] = vec4<f32>(u, f32(closure.lobe_count));
}
