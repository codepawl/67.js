// SPDX-FileCopyrightText: 2011-2026 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Bootstrap entry points used only when `bootstrapKernel: true` is requested while `kernel-manifest.txt` has no
// compute entry point yet. Never listed in `kernel-manifest.txt`, so zero symbols collide with integrator or closure modules.

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x >= kernel_params.image_width || global_id.y >= kernel_params.image_height) {
    return;
  }
  let pixel_index = global_id.y * kernel_params.image_width + global_id.x;
  let pixel_count = kernel_params.image_width * kernel_params.image_height;

  let uv_x = (2.0 * ((f32(global_id.x) + 0.5) / f32(max(kernel_params.image_width, 1u))) - 1.0) + kernel_params.lens_shift.x * 2.0;
  let uv_y = (1.0 - 2.0 * ((f32(global_id.y) + 0.5) / f32(max(kernel_params.image_height, 1u)))) + kernel_params.lens_shift.y * 2.0;
  let ray_direction = normalize(
    kernel_params.camera_forward + uv_x * kernel_params.camera_right + uv_y * kernel_params.camera_up
  );
  let t_min = max(kernel_params.camera_near, kernel_params.ray_epsilon);
  let t_max = max(kernel_params.camera_far, t_min + 1.0);

  var rq: ray_query;
  rayQueryInitialize(&rq, scene_tlas, RayDesc(0u, 0x3Fu, t_min, t_max, kernel_params.camera_position, ray_direction));
  while (rayQueryProceed(&rq)) {
    let candidate = rayQueryGetCandidateIntersection(&rq);
    if (candidate.kind == RAY_QUERY_INTERSECTION_TRIANGLE) {
      let cand_inst = instances[candidate.instance_custom_data];
      let cand_local = select(0u, cand_inst.opaque_triangle_count, candidate.geometry_index > 0u) + candidate.primitive_index;
      let cand_tri = triangles[cand_inst.triangle_offset + cand_local];
      let cand_mat_idx = select(cand_inst.material_override, cand_tri.material_index, cand_inst.material_override == INVALID_INDEX);
      let cand_mat = materials[cand_mat_idx];
      var alpha = cand_mat.alpha;
      if (cand_mat.base_color_tex >= 0 && u32(cand_mat.base_color_tex) < kernel_params.texture_count) {
        let desc = texture_descriptors[u32(cand_mat.base_color_tex)];
        let bary_w = 1.0 - candidate.barycentrics.x - candidate.barycentrics.y;
        let hit_u = fract(bary_w * cand_tri.uv0_u + candidate.barycentrics.x * cand_tri.uv1_u + candidate.barycentrics.y * cand_tri.uv2_u);
        let hit_v = fract(bary_w * cand_tri.uv0_v + candidate.barycentrics.x * cand_tri.uv1_v + candidate.barycentrics.y * cand_tri.uv2_v);
        let tex_x = min(u32(max(hit_u, 0.0) * f32(desc.width)), max(desc.width, 1u) - 1u);
        let tex_y = min(u32(max(hit_v, 0.0) * f32(desc.height)), max(desc.height, 1u) - 1u);
        let packed_texel = unpack4x8unorm(texture_texels[desc.data_offset + tex_y * desc.width + tex_x]);
        alpha = alpha * packed_texel.a;
      }
      if (cand_mat.alpha_mode != ALPHA_MODE_MASK || alpha >= cand_mat.alpha_cutoff) {
        rayQueryConfirmIntersection(&rq);
      }
    }
  }

  var sample_radiance = kernel_params.env_color;
  if (kernel_params.env_width > 0u && kernel_params.env_height > 0u) {
    sample_radiance = environment_texels[0].rgb * kernel_params.env_color;
  }
  var hit_albedo = vec3<f32>(0.0);
  var hit_normal = vec3<f32>(0.0);
  var hit_depth = 0.0;

  let committed = rayQueryGetCommittedIntersection(&rq);
  if (committed.kind != RAY_QUERY_INTERSECTION_NONE) {
    let inst = instances[committed.instance_custom_data];
    let local_tri = select(0u, inst.opaque_triangle_count, committed.geometry_index > 0u) + committed.primitive_index;
    let tri = triangles[inst.triangle_offset + local_tri];
    let mat_idx = select(inst.material_override, tri.material_index, inst.material_override == INVALID_INDEX);
    let mat = materials[mat_idx];
    let bary_w = 1.0 - committed.barycentrics.x - committed.barycentrics.y;
    let obj_n = normalize(bary_w * tri.n0 + committed.barycentrics.x * tri.n1 + committed.barycentrics.y * tri.n2);
    var world_n = normalize(
      obj_n.x * inst.world_to_object_row0.xyz +
      obj_n.y * inst.world_to_object_row1.xyz +
      obj_n.z * inst.world_to_object_row2.xyz
    );
    if (!committed.front_face && (tri.flags & TRIANGLE_FLAG_DOUBLE_SIDED) != 0u) {
      world_n = -world_n;
    }
    hit_albedo = mat.base_color;
    hit_normal = world_n;
    hit_depth = committed.t;
    sample_radiance = mat.base_color * 0.5 + mat.emission_color * mat.emission_strength;
    if (kernel_params.light_count > 0u && (lights[0].light_group_mask_lo & inst.light_group_mask_lo) != 0u) {
      sample_radiance += hit_albedo * lights[0].radiance * 0.01;
    }
    if (kernel_params.emissive_triangle_count > 0u) {
      sample_radiance += emissive_triangles[0].radiance * 0.001;
    }
    if (kernel_params.light_tree_node_count > 0u && light_tree_nodes[0].energy < 0.0) {
      sample_radiance = vec3<f32>(0.0);
    }
  }

  let batch = max(kernel_params.samples_per_dispatch, 1u);
  let batch_f = f32(batch);
  let lum = dot(sample_radiance, vec3<f32>(0.2126, 0.7152, 0.0722));
  film_accumulation[pixel_index] += vec4<f32>(sample_radiance * kernel_params.film_exposure * batch_f, hit_depth * batch_f);
  film_accumulation[pixel_count + pixel_index] += vec4<f32>(hit_albedo * batch_f, 0.0);
  film_accumulation[2u * pixel_count + pixel_index] += vec4<f32>(hit_normal * batch_f, 0.0);
  film_accumulation[3u * pixel_count + pixel_index] += vec4<f32>(lum * batch_f, lum * lum * batch_f, 0.0, batch_f);
}

@compute @workgroup_size(64, 1, 1)
fn test_lobe_samples(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let total = kernel_params.image_width * kernel_params.image_height;
  let idx = global_id.x;
  if (idx >= total) {
    return;
  }
  let mat = materials[0];
  let wo = normalize(kernel_params.camera_forward);
  let front_face = select(0u, 1u, kernel_params.camera_near >= 0.0);
  let mode = kernel_params.kernel_flags;
  film_accumulation[idx] = vec4<f32>(mat.base_color, mat.roughness);
  film_accumulation[total + idx] = vec4<f32>(wo, f32(front_face));
  film_accumulation[2u * total + idx] = vec4<f32>(mat.f82_tint, f32(mode));
  film_accumulation[3u * total + idx] = vec4<f32>(f32(kernel_params.seed), mat.ior, mat.metallic, 1.0);
}
