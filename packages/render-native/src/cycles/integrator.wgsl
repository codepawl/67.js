// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Unidirectional MIS path integrator (`int_*` + `@compute fn main`), ported from Cycles
// `kernel/integrator/{shade_surface.h,shade_light.h,shade_background.h,intersect_closest.h,intersect_shadow.h}`.

const INT_MAX_PATH_STEPS: u32 = 128u;
const INT_ADAPTIVE_BATCH_SIZE: u32 = 8u;
const INT_ADAPTIVE_LUMINANCE_FLOOR: f32 = 1.0e-3;

struct IntSurfaceHit {
  hit: u32,
  t: f32,
  instance_index: u32,
  triangle_index: u32,
  barycentrics: vec2<f32>,
}

fn int_luminance(rgb: vec3<f32>) -> f32 {
  return 0.2126729 * rgb.x + 0.7151522 * rgb.y + 0.0721750 * rgb.z;
}

fn int_sanitize_radiance(value: vec3<f32>) -> vec3<f32> {
  let valid_x = value.x >= 0.0 && value.x < 1.0e30;
  let valid_y = value.y >= 0.0 && value.y < 1.0e30;
  let valid_z = value.z >= 0.0 && value.z < 1.0e30;
  return vec3<f32>(
    select(0.0, value.x, valid_x),
    select(0.0, value.y, valid_y),
    select(0.0, value.z, valid_z),
  );
}

// Probability that a path with this throughput continues after Russian roulette: the square root of the largest channel, as in
// Cycles `path_state_continuation_probability` (kernel/integrator/path_state.h), which keeps deep paths alive longer than the plain
// throughput and so adds less variance. The floor only guards against a division by a tiny survival probability.
fn int_russian_roulette_survival(throughput: vec3<f32>) -> f32 {
  let largest_channel = max(abs(throughput.x), max(abs(throughput.y), abs(throughput.z)));
  return clamp(sqrt(largest_channel), 0.05, 1.0);
}

fn int_clamp_contribution(raw_value: vec3<f32>, clamp_bounce: i32) -> vec3<f32> {
  var value = int_sanitize_radiance(raw_value);
  let ceiling = select(kernel_params.clamp_direct, kernel_params.clamp_indirect, clamp_bounce > 0);
  if (ceiling > 0.0 && ceiling < 1.0e29) {
    let channel_sum = value.x + value.y + value.z;
    if (channel_sum > ceiling) {
      value *= ceiling / channel_sum;
    }
  }
  return value;
}

fn int_pixel_has_converged(statistics: vec4<f32>) -> bool {
  if ((kernel_params.kernel_flags & KERNEL_FLAG_ADAPTIVE_SAMPLING) == 0u || kernel_params.adaptive_threshold <= 0.0) {
    return false;
  }
  if (statistics.z >= 0.5) {
    return true;
  }
  let min_samples = max(kernel_params.adaptive_min_samples, 16u);
  let taken = u32(statistics.w);
  if (taken < min_samples || (taken - min_samples) % INT_ADAPTIVE_BATCH_SIZE != 0u) {
    return false;
  }
  let count = f32(taken);
  let mean = statistics.x / count;
  let variance = max(0.0, statistics.y / count - mean * mean) * count / max(count - 1.0, 1.0);
  return sqrt(variance / count) < kernel_params.adaptive_threshold * (mean + INT_ADAPTIVE_LUMINANCE_FLOOR);
}

fn int_resolve_instance_index(custom_data: u32, _instance_slot: u32) -> u32 {
  return min(custom_data, max(kernel_params.instance_count, 1u) - 1u);
}

fn int_resolve_triangle_index(instance: InstanceRecord, geometry_index: u32, primitive_index: u32) -> u32 {
  let cutout_offset = select(0u, instance.opaque_triangle_count, geometry_index > 0u);
  return instance.triangle_offset + cutout_offset + primitive_index;
}

fn int_resolve_material_index(instance: InstanceRecord, triangle: TriangleRecord) -> u32 {
  return select(instance.material_override, triangle.material_index, instance.material_override == INVALID_INDEX);
}

struct IntTriangleUvs {
  uv0: vec2<f32>,
  uv1: vec2<f32>,
}

// Both uv sets of a triangle at barycentrics (weight of vertex 1, weight of vertex 2). A triangle without a second set reads
// the first for both.
fn int_interpolate_triangle_uvs(triangle: TriangleRecord, barycentrics: vec2<f32>) -> IntTriangleUvs {
  let u = barycentrics.x;
  let v = barycentrics.y;
  let w = 1.0 - u - v;
  var uvs: IntTriangleUvs;
  uvs.uv0 = w * vec2<f32>(triangle.uv0_u, triangle.uv0_v)
    + u * vec2<f32>(triangle.uv1_u, triangle.uv1_v)
    + v * vec2<f32>(triangle.uv2_u, triangle.uv2_v);
  uvs.uv1 = select(
    uvs.uv0,
    w * triangle.uv_set1_0 + u * triangle.uv_set1_1 + v * triangle.uv_set1_2,
    (triangle.flags & TRIANGLE_FLAG_HAS_UV1) != 0u,
  );
  return uvs;
}

fn int_evaluate_surface_opacity(triangle: TriangleRecord, material: MaterialRecord, barycentrics: vec2<f32>) -> f32 {
  if (material.alpha_mode == ALPHA_MODE_OPAQUE) {
    return 1.0;
  }
  var opacity = clamp(material.alpha, 0.0, 1.0);
  if (material.base_color_tex < 0 && material.alpha_tex < 0) {
    return opacity;
  }
  let uvs = int_interpolate_triangle_uvs(triangle, barycentrics);
  if (material.base_color_tex >= 0) {
    opacity *= texture_sample(material.base_color_tex, uvs.uv0, uvs.uv1).a;
  }
  if (material.alpha_tex >= 0) {
    opacity *= texture_sample(material.alpha_tex, uvs.uv0, uvs.uv1).r;
  }
  return clamp(opacity, 0.0, 1.0);
}

fn int_trace_closest_surface(
  ray_origin: vec3<f32>,
  ray_dir: vec3<f32>,
  initial_t_min: f32,
  t_max: f32,
  visibility_mask: u32,
  self_instance: u32,
  self_triangle: u32,
) -> IntSurfaceHit {
  var result: IntSurfaceHit;
  result.hit = 0u;
  result.t = t_max;
  result.instance_index = INVALID_INDEX;
  result.triangle_index = INVALID_INDEX;
  result.barycentrics = vec2<f32>(0.0, 0.0);

  if (kernel_params.instance_count == 0u || kernel_params.triangle_count == 0u) {
    return result;
  }

  var current_t_min = initial_t_min;
  let step_eps = max(kernel_params.ray_epsilon, 1.0e-6);

  for (var pass_step = 0u; pass_step <= INT_MAX_PATH_STEPS; pass_step += 1u) {
    if (current_t_min >= t_max) {
      return result;
    }

    var query: ray_query;
    rayQueryInitialize(&query, scene_tlas, RayDesc(0u, visibility_mask & 0xFFu, current_t_min, t_max, ray_origin, ray_dir));
    while (rayQueryProceed(&query)) {
      let candidate = rayQueryGetCandidateIntersection(&query);
      let cand_inst_idx = int_resolve_instance_index(candidate.instance_custom_data, candidate.instance_index);
      let cand_inst = instances[cand_inst_idx];
      if ((cand_inst.visibility_flags & visibility_mask) == 0u) {
        continue;
      }
      let cand_tri_idx = int_resolve_triangle_index(cand_inst, candidate.geometry_index, candidate.primitive_index);
      if (cand_inst_idx == self_instance && cand_tri_idx == self_triangle && candidate.t < initial_t_min + 1.0e-3) {
        continue;
      }
      let cand_tri = triangles[cand_tri_idx];
      let cand_mat = materials[int_resolve_material_index(cand_inst, cand_tri)];
      if (cand_mat.alpha_mode == ALPHA_MODE_MASK) {
        let opacity = int_evaluate_surface_opacity(cand_tri, cand_mat, candidate.barycentrics);
        if (opacity < cand_mat.alpha_cutoff) {
          continue;
        }
      }
      rayQueryConfirmIntersection(&query);
    }

    let committed = rayQueryGetCommittedIntersection(&query);
    if (committed.kind == RAY_QUERY_INTERSECTION_NONE) {
      return result;
    }

    let hit_inst_idx = int_resolve_instance_index(committed.instance_custom_data, committed.instance_index);
    let hit_inst = instances[hit_inst_idx];
    let hit_tri_idx = int_resolve_triangle_index(hit_inst, committed.geometry_index, committed.primitive_index);

    if (hit_inst_idx == self_instance && hit_tri_idx == self_triangle && committed.t < initial_t_min + 1.0e-3) {
      current_t_min = committed.t + step_eps;
      continue;
    }
    if ((hit_inst.visibility_flags & visibility_mask) == 0u) {
      current_t_min = committed.t + step_eps;
      continue;
    }

    let hit_tri = triangles[hit_tri_idx];
    let hit_mat = materials[int_resolve_material_index(hit_inst, hit_tri)];
    if (hit_mat.alpha_mode == ALPHA_MODE_MASK) {
      let opacity = int_evaluate_surface_opacity(hit_tri, hit_mat, committed.barycentrics);
      if (opacity < hit_mat.alpha_cutoff) {
        current_t_min = committed.t + step_eps;
        continue;
      }
    }

    result.hit = 1u;
    result.t = committed.t;
    result.instance_index = hit_inst_idx;
    result.triangle_index = hit_tri_idx;
    result.barycentrics = committed.barycentrics;
    return result;
  }

  return result;
}

fn int_volume_segment_overlap(ray_origin: vec3<f32>, ray_dir: vec3<f32>, min_t: f32, max_t: f32) -> vec2<f32> {
  let inv_dir = vec3<f32>(
    select(1.0 / ray_dir.x, 1.0e30 * select(-1.0, 1.0, ray_dir.x >= 0.0), abs(ray_dir.x) < 1.0e-12),
    select(1.0 / ray_dir.y, 1.0e30 * select(-1.0, 1.0, ray_dir.y >= 0.0), abs(ray_dir.y) < 1.0e-12),
    select(1.0 / ray_dir.z, 1.0e30 * select(-1.0, 1.0, ray_dir.z >= 0.0), abs(ray_dir.z) < 1.0e-12),
  );
  let t0s = (kernel_params.volume_bounds_min - ray_origin) * inv_dir;
  let t1s = (kernel_params.volume_bounds_max - ray_origin) * inv_dir;
  let t_enter = max(min_t, max(min(t0s.x, t1s.x), max(min(t0s.y, t1s.y), min(t0s.z, t1s.z))));
  let t_exit = min(max_t, min(max(t0s.x, t1s.x), min(max(t0s.y, t1s.y), max(t0s.z, t1s.z))));
  return vec2<f32>(t_enter, t_exit);
}

fn int_trace_shadow(
  ray_origin: vec3<f32>,
  ray_dir: vec3<f32>,
  max_distance: f32,
  self_instance: u32,
  self_triangle: u32,
  target_instance: u32,
  target_triangle: u32,
  path_transparent_bounces: u32,
) -> vec3<f32> {
  let step_eps = max(kernel_params.ray_epsilon, 1.0e-6);
  let shadow_t_max = select(1.0e30, max(max_distance - step_eps, 0.0), max_distance < 1.0e29);
  var transmittance = vec3<f32>(1.0);

  if (shadow_t_max > 0.0 && kernel_params.instance_count > 0u && kernel_params.triangle_count > 0u) {
    var current_t_min = 0.0;
    // `integrate_shadow_max_transparent_hits` (kernel/integrator/intersect_shadow.h) allows
    // max(transparent_max_bounce - transparent_bounce, 0) transparent hits: the transparent
    // surfaces the camera path already passed count against the same limit as the shadow ray's.
    var transparent_hits = path_transparent_bounces;
    for (var step = 0u; step <= INT_MAX_PATH_STEPS; step += 1u) {
      if (current_t_min >= shadow_t_max) {
        break;
      }
      var query: ray_query;
      rayQueryInitialize(
        &query,
        scene_tlas,
        RayDesc(0u, INSTANCE_VISIBILITY_SHADOW, current_t_min, shadow_t_max, ray_origin, ray_dir),
      );
      while (rayQueryProceed(&query)) {
        let candidate = rayQueryGetCandidateIntersection(&query);
        let cand_inst_idx = int_resolve_instance_index(candidate.instance_custom_data, candidate.instance_index);
        let cand_inst = instances[cand_inst_idx];
        if ((cand_inst.visibility_flags & INSTANCE_VISIBILITY_SHADOW) == 0u) {
          continue;
        }
        let cand_tri_idx = int_resolve_triangle_index(cand_inst, candidate.geometry_index, candidate.primitive_index);
        if (cand_inst_idx == self_instance && cand_tri_idx == self_triangle && candidate.t < 1.0e-3) {
          continue;
        }
        if (cand_inst_idx == target_instance && cand_tri_idx == target_triangle) {
          continue;
        }
        let cand_tri = triangles[cand_tri_idx];
        let cand_mat = materials[int_resolve_material_index(cand_inst, cand_tri)];
        if (cand_mat.alpha_mode == ALPHA_MODE_MASK) {
          let opacity = int_evaluate_surface_opacity(cand_tri, cand_mat, candidate.barycentrics);
          if (opacity < cand_mat.alpha_cutoff) {
            continue;
          }
        }
        rayQueryConfirmIntersection(&query);
      }

      let committed = rayQueryGetCommittedIntersection(&query);
      if (committed.kind == RAY_QUERY_INTERSECTION_NONE) {
        break;
      }
      let hit_inst_idx = int_resolve_instance_index(committed.instance_custom_data, committed.instance_index);
      let hit_inst = instances[hit_inst_idx];
      let hit_tri_idx = int_resolve_triangle_index(hit_inst, committed.geometry_index, committed.primitive_index);

      if ((hit_inst_idx == self_instance && hit_tri_idx == self_triangle && committed.t < 1.0e-3)
        || (hit_inst_idx == target_instance && hit_tri_idx == target_triangle)
        || (hit_inst.visibility_flags & INSTANCE_VISIBILITY_SHADOW) == 0u) {
        current_t_min = committed.t + step_eps;
        continue;
      }

      let hit_tri = triangles[hit_tri_idx];
      let hit_mat = materials[int_resolve_material_index(hit_inst, hit_tri)];
      let supports_transparent_shadow = hit_mat.alpha_mode == ALPHA_MODE_BLEND
        || (hit_mat.flags & MATERIAL_FLAG_TRANSPARENT_SHADOW) != 0u;
      if (supports_transparent_shadow) {
        let opacity = int_evaluate_surface_opacity(hit_tri, hit_mat, committed.barycentrics);
        if (opacity < 1.0) {
          if (transparent_hits >= kernel_params.max_transparent_bounces) {
            return vec3<f32>(0.0);
          }
          transmittance *= (1.0 - opacity);
          transparent_hits += 1u;
          current_t_min = committed.t + step_eps;
          continue;
        }
      }
      return vec3<f32>(0.0);
    }
  }

  if (SCENE_HAS_VOLUME && (kernel_params.kernel_flags & KERNEL_FLAG_HAS_VOLUME) != 0u && kernel_params.volume_density > 0.0) {
    let overlap = int_volume_segment_overlap(ray_origin, ray_dir, 0.0, shadow_t_max);
    if (overlap.y > overlap.x) {
      transmittance *= exp(-kernel_params.volume_density * (overlap.y - overlap.x));
    }
  }

  return transmittance;
}

fn int_transform_point(instance: InstanceRecord, point_obj: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(instance.object_to_world_row0.xyz, point_obj) + instance.object_to_world_row0.w,
    dot(instance.object_to_world_row1.xyz, point_obj) + instance.object_to_world_row1.w,
    dot(instance.object_to_world_row2.xyz, point_obj) + instance.object_to_world_row2.w,
  );
}

fn int_transform_vector(instance: InstanceRecord, vec_obj: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(instance.object_to_world_row0.xyz, vec_obj),
    dot(instance.object_to_world_row1.xyz, vec_obj),
    dot(instance.object_to_world_row2.xyz, vec_obj),
  );
}

fn int_transform_normal(instance: InstanceRecord, normal_obj: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let world_normal = normal_obj.x * instance.world_to_object_row0.xyz
    + normal_obj.y * instance.world_to_object_row1.xyz
    + normal_obj.z * instance.world_to_object_row2.xyz;
  let len = length(world_normal);
  if (len > 1.0e-12) {
    return world_normal / len;
  }
  return fallback;
}

// Ray cone of a camera ray: x is the width of the cone at the ray origin (a pixel for an orthographic camera, 0 for a pinhole),
// y its spread, the angle one pixel covers (twice the length of `camera_up`, the half height of the image plane at unit
// distance, over the image height). The aperture and the pixel filter are left out.
fn int_camera_ray_cone() -> vec2<f32> {
  let pixel_size = 2.0 * length(kernel_params.camera_up) / f32(max(kernel_params.image_height, 1u));
  if ((kernel_params.kernel_flags & KERNEL_FLAG_ORTHOGRAPHIC_CAMERA) != 0u) {
    return vec2<f32>(pixel_size, 0.0);
  }
  return vec2<f32>(0.0, pixel_size);
}

// How much a bounce widens the cone. A diffuse or sheen lobe scatters over a hemisphere, so it widens by one radian; a glossy,
// coat or glass lobe by twice its roughness alpha (at most one radian); a mirror or a straight-through lobe not at all.
// The curvature of the surface is not counted.
fn int_bounce_cone_spread(closure: ptr<function, Closure>, sampled_lobe_type: u32) -> f32 {
  if (sampled_lobe_type == LOBE_DIFFUSE || sampled_lobe_type == LOBE_SHEEN) {
    return 1.0;
  }
  var widest_alpha = 0.0;
  for (var lobe_index = 0u; lobe_index < (*closure).lobe_count; lobe_index += 1u) {
    let lobe = (*closure).lobes[lobe_index];
    if (lobe.lobe_type == sampled_lobe_type) {
      widest_alpha = max(widest_alpha, max(lobe.alpha_x, lobe.alpha_y));
    }
  }
  return min(2.0 * widest_alpha, 1.0);
}

// The width of the ray footprint on the surface in `uv0` units: the cone width at the hit, times the uv units per world unit
// of the triangle (sqrt of its uv area over its surface area). On the surface the footprint is an ellipse whose long axis is
// the cone width over cos, the cosine being that of the angle between the ray and the geometric normal. One mip level
// is chosen for both axes, from the geometric mean of the two: width over sqrt(cos), cos at least 0.1. The long axis would
// blur across the short one, the short axis would leave the long one aliased. `uv1` is read with the density of `uv0`.
// The samples of a pixel already average over its footprint, so the width is scaled by max(1/8, 1/sqrt(samples per pixel))
// as pbrt scales its ray differentials; a level as wide as the whole footprint would blur twice.
fn int_uv_footprint(
  ray_cone: vec2<f32>,
  hit_distance: f32,
  wo: vec3<f32>,
  geometric_normal: vec3<f32>,
  twice_surface_area: f32,
  twice_uv_area: f32,
) -> f32 {
  if (twice_surface_area <= 1.0e-20) {
    return 0.0;
  }
  let cone_width = ray_cone.x + ray_cone.y * hit_distance;
  let facing = max(abs(dot(wo, geometric_normal)), 0.1);
  let uv_per_world_unit = sqrt(twice_uv_area / twice_surface_area);
  let samples_per_pixel_scale = clamp(inverseSqrt(f32(max(kernel_params.total_samples, 1u))), 0.125, 1.0);
  return cone_width / sqrt(facing) * uv_per_world_unit * samples_per_pixel_scale;
}

fn int_build_shading_point(surface_hit: IntSurfaceHit, wo: vec3<f32>, ray_cone: vec2<f32>) -> ShadingPoint {
  let instance = instances[surface_hit.instance_index];
  let triangle = triangles[surface_hit.triangle_index];
  let bary_u = surface_hit.barycentrics.x;
  let bary_v = surface_hit.barycentrics.y;
  let bary_w = 1.0 - bary_u - bary_v;

  let pos_obj = triangle.p0 + triangle.edge1 * bary_u + triangle.edge2 * bary_v;
  let pos_world = int_transform_point(instance, pos_obj);
  let world_edge1 = int_transform_vector(instance, triangle.edge1);
  let world_edge2 = int_transform_vector(instance, triangle.edge2);
  var raw_ng = cross(world_edge1, world_edge2);
  if ((instance.visibility_flags & INSTANCE_FLAG_NEGATIVE_SCALE) != 0u) {
    raw_ng = -raw_ng;
  }
  let ng_len = length(raw_ng);
  let outward_ng = select(wo, raw_ng / ng_len, ng_len > 1.0e-16);
  let is_front = dot(outward_ng, wo) >= 0.0;
  let geometric_normal = select(-outward_ng, outward_ng, is_front);

  var shading_normal = geometric_normal;
  if ((triangle.flags & TRIANGLE_FLAG_SMOOTH_NORMALS) != 0u) {
    let interp_n = bary_w * triangle.n0 + bary_u * triangle.n1 + bary_v * triangle.n2;
    let outward_ns = int_transform_normal(instance, interp_n, outward_ng);
    let oriented_ns = select(-outward_ns, outward_ns, is_front);
    if (dot(oriented_ns, geometric_normal) > 0.0) {
      shading_normal = oriented_ns;
    }
  }

  let uv0_0 = vec2<f32>(triangle.uv0_u, triangle.uv0_v);
  let uv0_1 = vec2<f32>(triangle.uv1_u, triangle.uv1_v);
  let uv0_2 = vec2<f32>(triangle.uv2_u, triangle.uv2_v);
  let uv0 = bary_w * uv0_0 + bary_u * uv0_1 + bary_v * uv0_2;
  let uv1 = select(
    uv0,
    bary_w * triangle.uv_set1_0 + bary_u * triangle.uv_set1_1 + bary_v * triangle.uv_set1_2,
    (triangle.flags & TRIANGLE_FLAG_HAS_UV1) != 0u,
  );
  let vertex_color = select(
    vec3<f32>(1.0),
    bary_w * triangle.color0 + bary_u * triangle.color1 + bary_v * triangle.color2,
    (triangle.flags & TRIANGLE_FLAG_HAS_VERTEX_COLORS) != 0u,
  );

  var tangent = vec3<f32>(0.0);
  var bitangent = vec3<f32>(0.0);
  var built_frame = false;
  if ((triangle.flags & TRIANGLE_FLAG_HAS_TANGENTS) != 0u) {
    let interp_t = bary_w * triangle.tangent0 + bary_u * triangle.tangent1 + bary_v * triangle.tangent2;
    var world_t = int_transform_vector(instance, interp_t);
    world_t -= shading_normal * dot(world_t, shading_normal);
    let t_len = length(world_t);
    if (t_len > 1.0e-8) {
      tangent = world_t / t_len;
      let scale_sign = select(1.0, -1.0, (instance.visibility_flags & INSTANCE_FLAG_NEGATIVE_SCALE) != 0u);
      let hand_sign = select(1.0, -1.0, triangle.tangent_sign < 0.0) * scale_sign;
      bitangent = cross(shading_normal, tangent) * hand_sign;
      built_frame = true;
    }
  }
  if (!built_frame) {
    let duv1 = uv0_1 - uv0_0;
    let duv2 = uv0_2 - uv0_0;
    let det = duv1.x * duv2.y - duv2.x * duv1.y;
    if (abs(det) > 1.0e-12) {
      var grad_t = (world_edge1 * duv2.y - world_edge2 * duv1.y) / det;
      let grad_b = (world_edge2 * duv1.x - world_edge1 * duv2.x) / det;
      grad_t -= shading_normal * dot(grad_t, shading_normal);
      let t_len = length(grad_t);
      if (t_len > 1.0e-8) {
        tangent = grad_t / t_len;
        let raw_b = cross(shading_normal, tangent);
        let hand = select(1.0, -1.0, dot(raw_b, grad_b) < 0.0);
        bitangent = raw_b * hand;
        built_frame = true;
      }
    }
  }
  if (!built_frame) {
    lgt_make_orthonormal_basis(shading_normal, &tangent, &bitangent);
  }

  var emissive_index = INVALID_INDEX;
  if (instance.emissive_base_offset != INVALID_INDEX && triangle.local_emissive_offset != INVALID_INDEX) {
    emissive_index = instance.emissive_base_offset + triangle.local_emissive_offset;
  }

  var point: ShadingPoint;
  point.position = pos_world;
  point.ray_t = surface_hit.t;
  point.geometric_normal = geometric_normal;
  point.front_face = select(0u, 1u, is_front);
  point.shading_normal = shading_normal;
  point.material_index = int_resolve_material_index(instance, triangle);
  point.coat_normal = shading_normal;
  point.instance_index = surface_hit.instance_index;
  point.tangent = tangent;
  point.triangle_index = surface_hit.triangle_index;
  point.bitangent = bitangent;
  point.emissive_index = emissive_index;
  point.uv0 = uv0;
  point.uv1 = uv1;
  point.barycentrics = surface_hit.barycentrics;
  point.object_random = instance.object_random;
  point.light_group_mask_lo = instance.light_group_mask_lo;
  point.vertex_color = vertex_color;
  point.light_group_mask_hi = instance.light_group_mask_hi;
  point.uv_footprint = 0.0;
  if ((kernel_params.kernel_flags & KERNEL_FLAG_TEXTURE_MIPS) != 0u) {
    let uv_edge1 = uv0_1 - uv0_0;
    let uv_edge2 = uv0_2 - uv0_0;
    let twice_uv_area = abs(uv_edge1.x * uv_edge2.y - uv_edge2.x * uv_edge1.y);
    point.uv_footprint = int_uv_footprint(ray_cone, surface_hit.t, wo, geometric_normal, ng_len, twice_uv_area);
  }
  return point;
}

fn int_ray_offset_origin(point: ptr<function, ShadingPoint>, wi: vec3<f32>) -> vec3<f32> {
  let sign_ng = select(-1.0, 1.0, dot((*point).geometric_normal, wi) >= 0.0);
  let scale = max(kernel_params.ray_epsilon, 1.0e-5 * max(1.0, max(abs((*point).position.x), max(abs((*point).position.y), abs((*point).position.z)))));
  return (*point).position + (*point).geometric_normal * (sign_ng * scale);
}

fn int_apply_filter_glossy(closure: ptr<function, Closure>, inv_filter_glossy: f32, min_ray_pdf: f32) {
  if (inv_filter_glossy >= 1.0e29) {
    return;
  }
  let blur_pdf = inv_filter_glossy * min_ray_pdf;
  if (blur_pdf >= 1.0) {
    return;
  }
  let blur_roughness = sqrt(max(0.0, 1.0 - blur_pdf)) * 0.5;
  let count = min((*closure).lobe_count, MAX_CLOSURE_LOBES);
  for (var i = 0u; i < count; i += 1u) {
    let lobe_type = (*closure).lobes[i].lobe_type;
    if (lobe_type == LOBE_GLOSSY_GGX || lobe_type == LOBE_GLASS_GGX || lobe_type == LOBE_COAT_GGX) {
      (*closure).lobes[i].alpha_x = max(blur_roughness, (*closure).lobes[i].alpha_x);
      (*closure).lobes[i].alpha_y = max(blur_roughness, (*closure).lobes[i].alpha_y);
    }
  }
}

fn int_is_singular_bsdf_sample(closure: ptr<function, Closure>, point: ptr<function, ShadingPoint>, sample: ClosureSample) -> bool {
  if (sample.sampled_lobe_type == LOBE_DIFFUSE || sample.sampled_lobe_type == LOBE_SHEEN) {
    return false;
  }
  let wi_below = dot((*point).geometric_normal, sample.wi) < 0.0;
  let count = min((*closure).lobe_count, MAX_CLOSURE_LOBES);
  for (var i = 0u; i < count; i += 1u) {
    let lobe = (*closure).lobes[i];
    if (lobe.lobe_type != sample.sampled_lobe_type) {
      continue;
    }
    if (lobe.lobe_type == LOBE_GLOSSY_GGX) {
      let is_tw_trans = (lobe.flags & LOBE_FLAG_THIN_WALLED) != 0u;
      if (is_tw_trans != wi_below) {
        continue;
      }
    }
    if (bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y)) {
      return true;
    }
    if (lobe.lobe_type == LOBE_GLASS_GGX && wi_below && abs(lobe.ior - 1.0) < 1.0e-4) {
      return true;
    }
  }
  return false;
}

fn int_closure_has_transmission(closure: ptr<function, Closure>) -> bool {
  for (var lobe_index = 0u; lobe_index < (*closure).lobe_count; lobe_index += 1u) {
    if ((*closure).lobes[lobe_index].lobe_type == LOBE_GLASS_GGX) {
      return true;
    }
  }
  return false;
}

fn int_accumulate_direct_sample(
  sample: LgtDirectSample,
  closure: ptr<function, Closure>,
  point: ptr<function, ShadingPoint>,
  wo: vec3<f32>,
  throughput: vec3<f32>,
  medium_sigma: vec3<f32>,
  in_medium: bool,
  bounce: u32,
  transparent_bounces: u32,
  radiance: ptr<function, vec3<f32>>,
) {
  if (sample.valid == 0u || sample.pdf <= 0.0) {
    return;
  }
  let bsdf = closure_eval(closure, sample.wi, wo);
  if (bsdf.value.x <= 0.0 && bsdf.value.y <= 0.0 && bsdf.value.z <= 0.0) {
    return;
  }
  let nee_only = (kernel_params.kernel_flags & KERNEL_FLAG_TEST_NEE_ONLY) != 0u;
  let mis_weight = select(lgt_power_heuristic(sample.pdf, bsdf.pdf), 1.0, sample.is_delta != 0u || nee_only);
  if (mis_weight <= 0.0) {
    return;
  }
  var unshadowed = throughput * bsdf.value * sample.radiance * (mis_weight / sample.pdf);
  if (in_medium && sample.distance < 1.0e29) {
    unshadowed *= exp(-medium_sigma * sample.distance);
  }
  if (unshadowed.x <= 0.0 && unshadowed.y <= 0.0 && unshadowed.z <= 0.0) {
    return;
  }

  var visibility = vec3<f32>(1.0);
  if (sample.cast_shadow != 0u) {
    let shadow_origin = int_ray_offset_origin(point, sample.wi);
    visibility = int_trace_shadow(
      shadow_origin,
      sample.wi,
      sample.distance,
      (*point).instance_index,
      (*point).triangle_index,
      sample.target_instance,
      sample.target_triangle,
      transparent_bounces,
    );
  }
  if (visibility.x <= 0.0 && visibility.y <= 0.0 && visibility.z <= 0.0) {
    return;
  }
  *radiance += int_clamp_contribution(unshadowed * visibility, i32(bounce));
}

fn int_eval_henyey_greenstein(cos_theta: f32, g: f32) -> f32 {
  let g_clamped = clamp(g, -0.99, 0.99);
  let g2 = g_clamped * g_clamped;
  let denom = max(1.0 + g2 - 2.0 * g_clamped * cos_theta, 1.0e-8);
  return (0.25 * INV_PI) * (1.0 - g2) / (denom * sqrt(denom));
}

fn int_sample_henyey_greenstein(incident_dir: vec3<f32>, g: f32, rand_uv: vec2<f32>, pdf_out: ptr<function, f32>) -> vec3<f32> {
  let g_clamped = clamp(g, -0.99, 0.99);
  var cos_theta = 1.0 - 2.0 * rand_uv.x;
  if (abs(g_clamped) > 1.0e-4) {
    let g2 = g_clamped * g_clamped;
    let term = (1.0 - g2) / (1.0 - g_clamped + 2.0 * g_clamped * rand_uv.x);
    cos_theta = clamp((1.0 + g2 - term * term) / (2.0 * g_clamped), -1.0, 1.0);
  }
  let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
  let phi = TWO_PI * rand_uv.y;
  var axis_x: vec3<f32>;
  var axis_y: vec3<f32>;
  lgt_make_orthonormal_basis(incident_dir, &axis_x, &axis_y);
  *pdf_out = int_eval_henyey_greenstein(cos_theta, g_clamped);
  return normalize(axis_x * (sin_theta * cos(phi)) + axis_y * (sin_theta * sin(phi)) + incident_dir * cos_theta);
}

fn int_accumulate_volume_direct_sample(
  sample: LgtDirectSample,
  scatter_pos: vec3<f32>,
  incident_dir: vec3<f32>,
  throughput: vec3<f32>,
  bounce: u32,
  transparent_bounces: u32,
  radiance: ptr<function, vec3<f32>>,
) {
  if (sample.valid == 0u || sample.pdf <= 0.0) {
    return;
  }
  let phase = int_eval_henyey_greenstein(dot(incident_dir, sample.wi), kernel_params.volume_anisotropy);
  let mis_weight = select(lgt_power_heuristic(sample.pdf, phase), 1.0, sample.is_delta != 0u);
  let unshadowed = throughput * sample.radiance * (phase * mis_weight / sample.pdf);
  if (unshadowed.x <= 0.0 && unshadowed.y <= 0.0 && unshadowed.z <= 0.0) {
    return;
  }
  var visibility = vec3<f32>(1.0);
  if (sample.cast_shadow != 0u) {
    visibility = int_trace_shadow(
      scatter_pos,
      sample.wi,
      sample.distance,
      INVALID_INDEX,
      INVALID_INDEX,
      sample.target_instance,
      sample.target_triangle,
      transparent_bounces,
    );
  }
  *radiance += int_clamp_contribution(unshadowed * visibility, i32(bounce));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pixel_x = global_id.x;
  let pixel_y = global_id.y;
  if (pixel_x >= kernel_params.image_width || pixel_y >= kernel_params.image_height) {
    return;
  }

  let pixel_index = pixel_y * kernel_params.image_width + pixel_x;
  let pixel_count = kernel_params.image_width * kernel_params.image_height;
  var stats = film_accumulation[3u * pixel_count + pixel_index];
  if (int_pixel_has_converged(stats)) {
    stats.z = 1.0;
    film_accumulation[3u * pixel_count + pixel_index] = stats;
    return;
  }

  let limit_bounce = kernel_params.max_bounces + 1u;
  let limit_diffuse = kernel_params.max_diffuse_bounces + 1u;
  let limit_glossy = kernel_params.max_glossy_bounces + 1u;
  let limit_transmission = kernel_params.max_transmission_bounces + 1u;
  let limit_volume = kernel_params.max_volume_bounces + 1u;
  let sample_count = max(kernel_params.samples_per_dispatch, 1u);
  let exposure = select(1.0, kernel_params.film_exposure, kernel_params.film_exposure > 0.0);
  let has_world_volume = SCENE_HAS_VOLUME && (kernel_params.kernel_flags & KERNEL_FLAG_HAS_VOLUME) != 0u && kernel_params.volume_density > 0.0;
  let filter_glossy_enabled = kernel_params.filter_glossy > 0.0;
  let inv_filter_glossy = select(1.0e30, 1.0 / max(kernel_params.filter_glossy, 1.0e-8), filter_glossy_enabled);

  // The running sums start from what the film holds and take one sample at a time in sample order. That is the same
  // sequence of float additions as adding every sample straight to the film, so the image does not depend on where one
  // dispatch ends and the next begins (summing a batch from zero first would regroup the additions per split).
  let film_radiance_and_depth = film_accumulation[pixel_index];
  var batch_radiance = film_radiance_and_depth.xyz;
  var batch_depth = film_radiance_and_depth.w;
  let film_albedo_lane = film_accumulation[pixel_count + pixel_index];
  let film_normal_lane = film_accumulation[2u * pixel_count + pixel_index];
  var batch_albedo = film_albedo_lane.xyz;
  var batch_normal = film_normal_lane.xyz;
  var taken_in_batch = 0u;

  // Per-path state lives outside the loops so that, with KERNEL_FLAG_PATH_REGENERATION, a path that ends is replaced by the
  // pixel's next sample at once instead of idling until the longest path of the dispatch ends. Without the flag a whole path
  // runs inside one iteration of the outer loop, which is the order of work before regeneration existed.
  let steps_per_iteration = select(INT_MAX_PATH_STEPS, 1u, (kernel_params.kernel_flags & KERNEL_FLAG_PATH_REGENERATION) != 0u);
  var rng = smp_init(pixel_x, pixel_y, kernel_params.sample_offset, kernel_params.seed);
  var next_sample = 0u;
  var path_active = false;
  var path_step = 0u;

  var ray_origin = vec3<f32>(0.0);
  var ray_dir = vec3<f32>(0.0);
  var ray_t_min = 0.0;
  var ray_t_max = 0.0;
  var ray_visibility = INSTANCE_VISIBILITY_CAMERA;
  var self_instance = INVALID_INDEX;
  var self_triangle = INVALID_INDEX;
  var ray_cone = vec2<f32>(0.0);

  var throughput = vec3<f32>(1.0);
  var medium_sigma = vec3<f32>(0.0);
  var in_medium = false;
  var is_camera_ray = true;
  var is_transparent_bg_ray = false;
  var mis_skip = true;
  var prev_bsdf_pdf = 0.0;
  var min_ray_pdf = 1.0e30;
  var prev_recv_lo = 0xFFFFFFFFu;
  var prev_recv_hi = 0xFFFFFFFFu;
  var terminate_on_hit = false;
  var terminate_on_next_surface = false;

  var bounce = 0u;
  var diffuse_bounces = 0u;
  var glossy_bounces = 0u;
  var transmission_bounces = 0u;
  var volume_bounces = 0u;
  var transparent_bounces = 0u;

  var sample_radiance = vec3<f32>(0.0);
  var first_depth = 0.0;
  var first_albedo = vec3<f32>(0.0);
  var first_normal = vec3<f32>(0.0);
  var recorded_features = false;

  loop {
    if (!path_active) {
      if (next_sample >= sample_count) {
        break;
      }
      if (next_sample > 0u && int_pixel_has_converged(stats)) {
        stats.z = 1.0;
        break;
      }

      let sample_index = kernel_params.sample_offset + next_sample;
      next_sample += 1u;
      rng = smp_init(pixel_x, pixel_y, sample_index, kernel_params.seed);
      let filter_offset = flt_sample_offset(smp_next_2d(&rng));
      let lens_uv = smp_next_2d(&rng);
      let cam_ray = cam_generate_ray(pixel_x, pixel_y, filter_offset, lens_uv);

      ray_origin = cam_ray.origin;
      ray_dir = cam_ray.direction;
      ray_t_min = cam_ray.t_min;
      ray_t_max = cam_ray.t_max;
      ray_visibility = INSTANCE_VISIBILITY_CAMERA;
      self_instance = INVALID_INDEX;
      self_triangle = INVALID_INDEX;
      ray_cone = int_camera_ray_cone();

      throughput = vec3<f32>(1.0);
      medium_sigma = vec3<f32>(0.0);
      in_medium = false;
      is_camera_ray = true;
      is_transparent_bg_ray = (kernel_params.kernel_flags & KERNEL_FLAG_TRANSPARENT_BACKGROUND) != 0u;
      mis_skip = true;
      prev_bsdf_pdf = 0.0;
      min_ray_pdf = 1.0e30;
      prev_recv_lo = 0xFFFFFFFFu;
      prev_recv_hi = 0xFFFFFFFFu;
      terminate_on_hit = false;
      terminate_on_next_surface = false;

      bounce = 0u;
      diffuse_bounces = 0u;
      glossy_bounces = 0u;
      transmission_bounces = 0u;
      volume_bounces = 0u;
      transparent_bounces = 0u;

      sample_radiance = vec3<f32>(0.0);
      first_depth = 0.0;
      first_albedo = vec3<f32>(0.0);
      first_normal = vec3<f32>(0.0);
      recorded_features = false;
      path_step = 0u;
      path_active = true;
    }

    for (var iteration_step = 0u; iteration_step < steps_per_iteration; iteration_step += 1u) {
      // A `break` below ends the path. Only the places that go on to the next step set `path_active` again.
      path_active = false;
      if (path_step >= INT_MAX_PATH_STEPS) {
        break;
      }
      let step = path_step;
      path_step += 1u;
      let surface_hit = int_trace_closest_surface(
        ray_origin,
        ray_dir,
        ray_t_min,
        ray_t_max,
        ray_visibility,
        self_instance,
        self_triangle,
      );

      var volume_scattered = false;
      var volume_scatter_t = surface_hit.t;
      if (has_world_volume) {
        let overlap = int_volume_segment_overlap(ray_origin, ray_dir, ray_t_min, surface_hit.t);
        if (overlap.y > overlap.x) {
          smp_seek(&rng, step, SMP_SLOT_VOLUME_DISTANCE);
          let vol_u = smp_next_1d(&rng);
          let free_flight = -log(max(1.0 - vol_u, 1.0e-12)) / kernel_params.volume_density;
          let vol_len = overlap.y - overlap.x;
          if (free_flight < vol_len) {
            volume_scattered = true;
            volume_scatter_t = overlap.x + free_flight;
          }
        }
      }

      let segment_end_t = select(surface_hit.t, volume_scatter_t, volume_scattered);
      let analytic_emission = lgt_eval_analytic_lights_along_segment(
        ray_origin,
        ray_dir,
        ray_t_min,
        segment_end_t,
        is_camera_ray,
        mis_skip,
        prev_bsdf_pdf,
        prev_recv_lo,
        prev_recv_hi,
        in_medium,
        medium_sigma,
      );
      if (analytic_emission.x > 0.0 || analytic_emission.y > 0.0 || analytic_emission.z > 0.0) {
        sample_radiance += int_clamp_contribution(throughput * analytic_emission, i32(bounce) - 1);
      }

      if (volume_scattered) {
        if (terminate_on_hit || terminate_on_next_surface) {
          break;
        }
        if (in_medium) {
          throughput *= exp(-medium_sigma * max(volume_scatter_t - ray_t_min, 0.0));
        }
        throughput *= kernel_params.volume_albedo;
        let scatter_pos = ray_origin + ray_dir * volume_scatter_t;
        if (!recorded_features) {
          first_depth = volume_scatter_t;
          first_albedo = clamp(kernel_params.volume_albedo, vec3<f32>(0.0), vec3<f32>(1.0));
          first_normal = -ray_dir;
          recorded_features = true;
        }

        if (SCENE_HAS_ANALYTIC_LIGHTS && kernel_params.light_count > 0u) {
          smp_seek(&rng, step, SMP_SLOT_VOLUME_ANALYTIC_PICK);
          let light_samp = lgt_sample_analytic_light(scatter_pos, 0xFFFFFFFFu, 0xFFFFFFFFu, smp_next_1d(&rng), smp_next_2d(&rng));
          int_accumulate_volume_direct_sample(light_samp, scatter_pos, ray_dir, throughput, bounce, transparent_bounces, &sample_radiance);
        }
        if (SCENE_HAS_ENV_IMPORTANCE && kernel_params.env_width > 0u && kernel_params.env_height > 0u && kernel_params.background_mis_weight > 0.0) {
          smp_seek(&rng, step, SMP_SLOT_VOLUME_ENVIRONMENT);
          let env_samp = lgt_sample_environment(smp_next_4d(&rng));
          int_accumulate_volume_direct_sample(env_samp, scatter_pos, ray_dir, throughput, bounce, transparent_bounces, &sample_radiance);
        }

        var phase_pdf = 0.0;
        smp_seek(&rng, step, SMP_SLOT_VOLUME_PHASE);
        let next_dir = int_sample_henyey_greenstein(ray_dir, kernel_params.volume_anisotropy, smp_next_2d(&rng), &phase_pdf);
        bounce += 1u;
        volume_bounces += 1u;
        if (bounce >= limit_bounce || volume_bounces >= limit_volume) {
          terminate_on_hit = true;
        }
        if (!terminate_on_hit && bounce > kernel_params.min_bounce_rr) {
          let survival = int_russian_roulette_survival(throughput);
          if (survival < 1.0) {
            smp_seek(&rng, step, SMP_SLOT_TERMINATE);
            if (smp_next_1d(&rng) >= survival) {
              break;
            }
            throughput /= survival;
          }
        }
        ray_cone = vec2<f32>(ray_cone.x + ray_cone.y * volume_scatter_t, ray_cone.y + 1.0);
        ray_origin = scatter_pos;
        ray_dir = next_dir;
        ray_t_min = 0.0;
        ray_t_max = 1.0e30;
        ray_visibility = INSTANCE_VISIBILITY_VOLUME_SCATTER;
        self_instance = INVALID_INDEX;
        self_triangle = INVALID_INDEX;
        is_camera_ray = false;
        is_transparent_bg_ray = false;
        mis_skip = false;
        prev_bsdf_pdf = phase_pdf;
        min_ray_pdf = min(phase_pdf, min_ray_pdf);
        prev_recv_lo = 0xFFFFFFFFu;
        prev_recv_hi = 0xFFFFFFFFu;
        lgt_remember_mis_origin(scatter_pos, ray_dir, false, false);
        path_active = true;
        continue;
      }

      if (surface_hit.hit == 0u) {
        let escaped = lgt_eval_escaped_ray(
          ray_dir,
          is_camera_ray,
          is_transparent_bg_ray,
          mis_skip,
          prev_bsdf_pdf,
          prev_recv_lo,
          prev_recv_hi,
        );
        if (escaped.x > 0.0 || escaped.y > 0.0 || escaped.z > 0.0) {
          sample_radiance += int_clamp_contribution(throughput * escaped, i32(bounce) - 1);
        }
        if (!recorded_features) {
          first_albedo = clamp(escaped, vec3<f32>(0.0), vec3<f32>(1.0));
          recorded_features = true;
        }
        break;
      }

      if (in_medium) {
        throughput *= exp(-medium_sigma * max(surface_hit.t - ray_t_min, 0.0));
      }

      let wo = -ray_dir;
      var point = int_build_shading_point(surface_hit, wo, ray_cone);
      var closure = closure_build(&point, wo);
      let material = materials[point.material_index];
      let is_pure_transparent = closure.lobe_count == 1u && closure.lobes[0].lobe_type == LOBE_TRANSPARENT;

      if (!recorded_features && !is_pure_transparent) {
        first_depth = surface_hit.t;
        first_albedo = closure_eval_albedo(&closure, wo);
        first_normal = closure_eval_normal(&closure);
        recorded_features = true;
      }

      if (!is_pure_transparent) {
        int_apply_filter_glossy(&closure, inv_filter_glossy, min_ray_pdf);
      }

      if (closure.emission.x > 0.0 || closure.emission.y > 0.0 || closure.emission.z > 0.0) {
        let emission_weight = lgt_emissive_surface_weight(
          point.emissive_index,
          surface_hit.t,
          ray_dir,
          is_camera_ray,
          mis_skip,
          prev_bsdf_pdf,
          prev_recv_lo,
          prev_recv_hi,
        );
        if (emission_weight > 0.0) {
          sample_radiance += int_clamp_contribution(throughput * closure.emission * emission_weight, i32(bounce) - 1);
        }
      }

      if (terminate_on_next_surface) {
        break;
      }

      if (terminate_on_hit) {
        if (closure.lobe_count > 0u && closure.lobes[0].lobe_type == LOBE_TRANSPARENT && closure.total_sample_weight > 0.0) {
          // `path_state_next` (kernel/integrator/path_state.h) counts the transparent surface it passes and sets
          // PATH_RAY_TERMINATE_ON_NEXT_SURFACE once the count reaches transparent_max_bounce, so the first
          // surface is always passed, also with a limit of 0. The break on terminate_on_next_surface above ends
          // the path at the next surface and the count never exceeds the limit here.
          {
            let trans_prob = clamp(closure.lobes[0].sample_weight / closure.total_sample_weight, 0.0, 1.0);
            smp_seek(&rng, step, SMP_SLOT_TRANSPARENT);
            if (trans_prob > 0.0 && smp_next_1d(&rng) < trans_prob) {
              transparent_bounces += 1u;
              if (transparent_bounces >= kernel_params.max_transparent_bounces) {
                terminate_on_next_surface = true;
              }
              throughput *= closure.lobes[0].weight / trans_prob;
              ray_t_min = surface_hit.t + max(kernel_params.ray_epsilon, 1.0e-6);
              self_instance = point.instance_index;
              self_triangle = point.triangle_index;
              path_active = true;
              continue;
            }
          }
        }
        break;
      }

      if (closure.lobe_count == 0u || closure.total_sample_weight <= 0.0) {
        break;
      }

      let picks_through_tree = lgt_use_light_tree() && (kernel_params.light_count + kernel_params.emissive_triangle_count) > 0u;
      let closure_has_transmission = SCENE_HAS_GLASS && int_closure_has_transmission(&closure);
      for (var direct_source = 0u; direct_source < 3u; direct_source += 1u) {
        if ((kernel_params.kernel_flags & KERNEL_FLAG_TEST_BSDF_ONLY) != 0u) {
          break;
        }
        var direct_sample: LgtDirectSample;
        direct_sample.valid = 0u;
        direct_sample.pdf = 0.0;
        if (direct_source == 0u && picks_through_tree) {
          smp_seek(&rng, step, SMP_SLOT_ANALYTIC_PICK);
          let tree_pick_u = smp_next_1d(&rng);
          let tree_sample_uv = smp_next_2d(&rng);
          direct_sample = lgt_sample_tree_emitter(&point, point.shading_normal, closure_has_transmission, tree_pick_u, tree_sample_uv);
        } else if (direct_source == 1u && picks_through_tree) {
          continue;
        } else if (direct_source == 0u) {
          if (SCENE_HAS_ANALYTIC_LIGHTS && kernel_params.light_count > 0u) {
            smp_seek(&rng, step, SMP_SLOT_ANALYTIC_PICK);
            direct_sample = lgt_sample_analytic_light(
              point.position,
              point.light_group_mask_lo,
              point.light_group_mask_hi,
              smp_next_1d(&rng),
              smp_next_2d(&rng),
            );
          }
        } else if (direct_source == 1u) {
          if (SCENE_HAS_EMISSIVE_TRIANGLES && kernel_params.emissive_triangle_count > 0u) {
            smp_seek(&rng, step, SMP_SLOT_EMISSIVE_PICK);
            direct_sample = lgt_sample_emissive_triangle(&point, smp_next_1d(&rng), smp_next_2d(&rng));
          }
        } else {
          if (SCENE_HAS_ENV_IMPORTANCE && kernel_params.env_width > 0u && kernel_params.env_height > 0u && kernel_params.background_mis_weight > 0.0) {
            smp_seek(&rng, step, SMP_SLOT_ENVIRONMENT);
            direct_sample = lgt_sample_environment(smp_next_4d(&rng));
          }
        }
        int_accumulate_direct_sample(direct_sample, &closure, &point, wo, throughput, medium_sigma, in_medium, bounce, transparent_bounces, &sample_radiance);
      }

      smp_seek(&rng, step, SMP_SLOT_SURFACE_BSDF);
      let bsdf_sample = closure_sample(&closure, wo, smp_next_3d(&rng));
      if (bsdf_sample.pdf <= 0.0 || (bsdf_sample.eval.x <= 0.0 && bsdf_sample.eval.y <= 0.0 && bsdf_sample.eval.z <= 0.0)) {
        break;
      }

      if (bsdf_sample.sampled_lobe_type == LOBE_TRANSPARENT) {
        // As above: `path_state_next` passes the transparent surface and then terminates on the next surface
        // when the count reaches transparent_max_bounce, with a limit of 0 as well (its FIXME note).
        transparent_bounces += 1u;
        if (transparent_bounces >= kernel_params.max_transparent_bounces) {
          terminate_on_next_surface = true;
        }
        throughput *= bsdf_sample.eval / bsdf_sample.pdf;
        ray_t_min = surface_hit.t + max(kernel_params.ray_epsilon, 1.0e-6);
        self_instance = point.instance_index;
        self_triangle = point.triangle_index;
        path_active = true;
        continue;
      }

      let is_singular = int_is_singular_bsdf_sample(&closure, &point, bsdf_sample);
      throughput *= bsdf_sample.eval / bsdf_sample.pdf;

      bounce += 1u;
      let cos_ng_wi = dot(point.geometric_normal, bsdf_sample.wi);
      let is_transmission = (bsdf_sample.sampled_lobe_type == LOBE_GLASS_GGX || bsdf_sample.sampled_lobe_type == LOBE_GLOSSY_GGX) && cos_ng_wi < 0.0;

      if (is_transmission) {
        transmission_bounces += 1u;
        ray_visibility = INSTANCE_VISIBILITY_TRANSMISSION;
        if (transmission_bounces >= limit_transmission) {
          terminate_on_hit = true;
        }
        if ((material.flags & MATERIAL_FLAG_THIN_WALLED) == 0u) {
          if (point.front_face != 0u) {
            medium_sigma = max(closure.absorption_sigma, vec3<f32>(0.0));
            in_medium = medium_sigma.x > 0.0 || medium_sigma.y > 0.0 || medium_sigma.z > 0.0;
          } else {
            medium_sigma = vec3<f32>(0.0);
            in_medium = false;
          }
        }
      } else if (bsdf_sample.sampled_lobe_type == LOBE_DIFFUSE || bsdf_sample.sampled_lobe_type == LOBE_SHEEN) {
        diffuse_bounces += 1u;
        ray_visibility = INSTANCE_VISIBILITY_DIFFUSE;
        if (diffuse_bounces >= limit_diffuse) {
          terminate_on_hit = true;
        }
      } else {
        glossy_bounces += 1u;
        ray_visibility = INSTANCE_VISIBILITY_GLOSSY;
        if (glossy_bounces >= limit_glossy) {
          terminate_on_hit = true;
        }
      }

      if (bounce >= limit_bounce) {
        terminate_on_hit = true;
      }

      if (!terminate_on_hit && bounce > kernel_params.min_bounce_rr) {
        let survival = int_russian_roulette_survival(throughput);
        if (survival < 1.0) {
          smp_seek(&rng, step, SMP_SLOT_TERMINATE);
          if (smp_next_1d(&rng) >= survival) {
            break;
          }
          throughput /= survival;
        }
      }

      ray_cone = vec2<f32>(
        ray_cone.x + ray_cone.y * surface_hit.t,
        ray_cone.y + int_bounce_cone_spread(&closure, bsdf_sample.sampled_lobe_type),
      );
      ray_origin = int_ray_offset_origin(&point, bsdf_sample.wi);
      ray_dir = bsdf_sample.wi;
      ray_t_min = 0.0;
      ray_t_max = 1.0e30;
      self_instance = point.instance_index;
      self_triangle = point.triangle_index;
      is_camera_ray = false;
      is_transparent_bg_ray = false;
      mis_skip = is_singular;
      prev_bsdf_pdf = bsdf_sample.pdf;
      min_ray_pdf = min(bsdf_sample.pdf, min_ray_pdf);
      prev_recv_lo = point.light_group_mask_lo;
      prev_recv_hi = point.light_group_mask_hi;
      lgt_remember_mis_origin(point.position, point.shading_normal, closure_has_transmission, picks_through_tree);
      path_active = true;
    }

    if (!path_active) {
      let exposed = int_sanitize_radiance(sample_radiance * exposure);
      let lum = int_luminance(exposed);
      batch_radiance += exposed;
      batch_depth += select(0.0, first_depth, first_depth >= 0.0 && first_depth < 1.0e29);
      batch_albedo += int_sanitize_radiance(first_albedo);
      batch_normal += first_normal;
      stats.x += lum;
      stats.y += lum * lum;
      stats.w += 1.0;
      taken_in_batch += 1u;
    }
  }

  if (taken_in_batch > 0u) {
    film_accumulation[pixel_index] = vec4<f32>(batch_radiance, batch_depth);
    film_accumulation[pixel_count + pixel_index] = vec4<f32>(batch_albedo, film_albedo_lane.w);
    film_accumulation[2u * pixel_count + pixel_index] = vec4<f32>(batch_normal, film_normal_lane.w);
    film_accumulation[3u * pixel_count + pixel_index] = stats;
  }
}
