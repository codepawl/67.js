// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Stochastic light tree traversal for next event estimation (`ltr_*`), ported from Cycles `kernel/light/tree.h` and the
// `*_light_tree_parameters` helpers of `point.h`, `spot.h`, `area.h`, `distant.cpp` and `triangle.h`. Surface shading points
// only: no volume segments, no instanced mesh subtrees and no light-link roots (FORMAT-v2.md sections 7 and 7b).
//
// `ltr_sample` walks from the root to a leaf with one random number that is rescaled at every choice, then picks an emitter
// inside the leaf with two reservoirs (one driven by the maximum importance, one by the minimum). `ltr_pdf` walks the same
// path for a known emitter, following the bit trail stored with it, and returns the probability that `ltr_sample` picks it.
// Emitters are addressed by their unified index: analytic lights first, then emissive triangles after `light_count`.

const LTR_EMITTER_KIND_TRIANGLE: u32 = 1u;
const LTR_NODE_KIND_DISTANT: u32 = 131072u;
const LTR_NODE_EMITTER_COUNT_MASK: u32 = 65535u;
const LTR_MAX_TREE_DEPTH: u32 = 64u;
const LTR_MAX_LEAF_EMITTERS: u32 = 32u;
const LTR_LARGE_COSINE: f32 = 1.0e30;

fn ltr_sin_from_cos(cosine: f32) -> f32 {
  return sqrt(max(0.0, 1.0 - cosine * cosine));
}

fn ltr_cos_from_sin(sine: f32) -> f32 {
  return sqrt(max(0.0, 1.0 - sine * sine));
}

fn ltr_normalize_with_length(vector: vec3<f32>, length_out: ptr<function, f32>) -> vec3<f32> {
  let vector_length = length(vector);
  *length_out = vector_length;
  if (vector_length == 0.0) {
    return vector;
  }
  return vector / vector_length;
}

fn ltr_safe_normalize(vector: vec3<f32>) -> vec3<f32> {
  var unused_length = 0.0;
  return ltr_normalize_with_length(vector, &unused_length);
}

// Cosine of the angle subtended by the sphere around the node box; -1 when the point is inside that sphere.
fn ltr_cos_bound_subtended_angle(bounds_max: vec3<f32>, centroid: vec3<f32>, point: vec3<f32>) -> f32 {
  let distance_to_center_sq = dot(point - centroid, point - centroid);
  let radius_sq = dot(bounds_max - centroid, bounds_max - centroid);
  if (distance_to_center_sq <= radius_sq) {
    return -1.0;
  }
  return sqrt(max(0.0, 1.0 - radius_sq / distance_to_center_sq));
}

// Cycles `light_tree_importance` for a surface point. Returns (maximum importance, minimum importance).
fn ltr_importance(
  normal: vec3<f32>,
  has_transmission: bool,
  point_to_centroid: vec3<f32>,
  cos_theta_u: f32,
  cone_axis: vec3<f32>,
  cone_theta_o: f32,
  cone_theta_e: f32,
  max_distance: f32,
  min_distance: f32,
  energy: f32,
) -> vec2<f32> {
  let sin_theta_u = ltr_sin_from_cos(cos_theta_u);

  let raw_cos_theta_i = dot(point_to_centroid, normal);
  let cos_theta_i = select(raw_cos_theta_i, abs(raw_cos_theta_i), has_transmission);
  let sin_theta_i = ltr_sin_from_cos(cos_theta_i);

  var cos_min_incidence_angle = 1.0;
  if (cos_theta_i < cos_theta_u) {
    cos_min_incidence_angle = cos_theta_i * cos_theta_u + sin_theta_i * sin_theta_u;
  }
  if (!has_transmission && cos_min_incidence_angle < 0.0) {
    return vec2<f32>(0.0);
  }
  let cos_max_incidence_angle = max(cos_theta_i * cos_theta_u - sin_theta_i * sin_theta_u, 0.0);

  var cos_theta = 1.0;
  var sin_theta = 0.0;
  if (!all(cone_axis == -point_to_centroid)) {
    cos_theta = dot(cone_axis, -point_to_centroid);
    sin_theta = ltr_sin_from_cos(cos_theta);
  }

  let cos_theta_minus_theta_u = cos_theta * cos_theta_u + sin_theta * sin_theta_u;
  let sin_theta_o = sin(cone_theta_o);
  let cos_theta_o = cos(cone_theta_o);

  var cos_min_outgoing_angle = 1.0;
  if (cos_theta >= cos_theta_u || cos_theta_minus_theta_u >= cos_theta_o) {
    cos_min_outgoing_angle = 1.0;
  } else if (cone_theta_o + cone_theta_e > PI || cos_theta_minus_theta_u > cos(cone_theta_o + cone_theta_e)) {
    let sin_theta_minus_theta_u = ltr_sin_from_cos(cos_theta_minus_theta_u);
    cos_min_outgoing_angle = cos_theta_minus_theta_u * cos_theta_o + sin_theta_minus_theta_u * sin_theta_o;
  } else {
    return vec2<f32>(0.0);
  }

  let safe_max_distance = max(max_distance, 1.0e-6);
  let maximum_importance = abs(cos_min_incidence_angle * energy * cos_min_outgoing_angle / (safe_max_distance * safe_max_distance));

  let cos_theta_plus_theta_u = cos_theta * cos_theta_u - sin_theta * sin_theta_u;
  if (cone_theta_e - cone_theta_o < 0.0 || cos_theta < 0.0 || cos_theta_u < 0.0 || cos_theta_plus_theta_u < cos(cone_theta_e - cone_theta_o)) {
    return vec2<f32>(maximum_importance, 0.0);
  }
  let sin_theta_plus_theta_u = ltr_sin_from_cos(cos_theta_plus_theta_u);
  let cos_max_outgoing_angle = cos_theta_plus_theta_u * cos_theta_o - sin_theta_plus_theta_u * sin_theta_o;
  let safe_min_distance = max(min_distance, 1.0e-6);
  let minimum_importance = abs(cos_max_incidence_angle * energy * cos_max_outgoing_angle / (safe_min_distance * safe_min_distance));
  return vec2<f32>(maximum_importance, minimum_importance);
}

// What `ltr_importance` needs about a node or an emitter. The builders below only gather these numbers; every importance
// goes through one `ltr_importance` call so the compiled kernel keeps a single copy of the cone arithmetic per call site.
struct LtrProfile {
  point_to_centroid: vec3<f32>,
  cos_theta_u: f32,
  cone_axis: vec3<f32>,
  theta_o: f32,
  theta_e: f32,
  max_distance: f32,
  min_distance: f32,
  energy: f32,
  visible: bool,
}

fn ltr_invisible_profile() -> LtrProfile {
  var profile: LtrProfile;
  profile.point_to_centroid = vec3<f32>(0.0, 0.0, 1.0);
  profile.cos_theta_u = 1.0;
  profile.cone_axis = vec3<f32>(0.0, 0.0, 1.0);
  profile.theta_o = 0.0;
  profile.theta_e = 0.0;
  profile.max_distance = 1.0;
  profile.min_distance = 1.0;
  profile.energy = 0.0;
  profile.visible = false;
  return profile;
}

fn ltr_profile_importance(profile: LtrProfile, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {
  if (!profile.visible) {
    return vec2<f32>(0.0);
  }
  return ltr_importance(
    normal,
    has_transmission,
    profile.point_to_centroid,
    profile.cos_theta_u,
    profile.cone_axis,
    profile.theta_o,
    profile.theta_e,
    profile.max_distance,
    profile.min_distance,
    profile.energy,
  );
}

// A node is described by its box, cone and energy. The distant leaf covers a cone of directions instead.
fn ltr_node_profile(node_index: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {
  let node = light_tree_nodes[node_index];
  var profile = ltr_invisible_profile();
  if (node.energy <= 0.0) {
    return profile;
  }
  profile.cone_axis = node.cone_axis;
  profile.theta_o = node.theta_o;
  profile.theta_e = node.theta_e;
  profile.energy = node.energy;
  profile.visible = true;

  if ((node.emitter_count_and_kind & LTR_NODE_KIND_DISTANT) != 0u) {
    profile.point_to_centroid = -node.cone_axis;
    profile.cos_theta_u = cos(node.theta_o + node.theta_e);
    return profile;
  }

  let centroid = 0.5 * (node.bounds_min + node.bounds_max);
  let box_extent = node.bounds_max - centroid;
  let box_is_visible = has_transmission || (dot(normal, centroid - position) + dot(abs(normal), abs(box_extent)) > 0.0);
  if (!box_is_visible) {
    profile.visible = false;
    return profile;
  }
  var distance = 0.0;
  profile.point_to_centroid = ltr_normalize_with_length(centroid - position, &distance);
  profile.cos_theta_u = ltr_cos_bound_subtended_angle(node.bounds_max, centroid, position);
  distance = max(0.5 * length(centroid - node.bounds_max), distance);
  profile.max_distance = distance;
  profile.min_distance = distance;
  return profile;
}

fn ltr_triangle_profile(emitter: LightTreeEmitter, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {
  let triangle = emissive_triangles[emitter.record_index];
  let vertex_zero = triangle.p0;
  let vertex_one = triangle.p0 + triangle.edge1;
  let vertex_two = triangle.p0 + triangle.edge2;
  let centroid = (vertex_zero + vertex_one + vertex_two) / 3.0;

  var profile = ltr_invisible_profile();
  profile.cone_axis = ltr_safe_normalize(vertex_zero - vertex_one);
  profile.theta_o = emitter.theta_o;
  profile.theta_e = emitter.theta_e;
  profile.energy = emitter.energy;

  var min_distance = 0.0;
  profile.point_to_centroid = ltr_normalize_with_length(centroid - position, &min_distance);
  profile.min_distance = min_distance;
  profile.max_distance = min_distance;
  profile.cos_theta_u = LTR_LARGE_COSINE;
  var shape_above_surface = false;
  for (var corner_index = 0u; corner_index < 3u; corner_index += 1u) {
    var corner = vertex_zero;
    if (corner_index == 1u) {
      corner = vertex_one;
    } else if (corner_index == 2u) {
      corner = vertex_two;
    }
    var corner_distance = 0.0;
    let point_to_corner = ltr_normalize_with_length(corner - position, &corner_distance);
    profile.cos_theta_u = min(profile.cos_theta_u, dot(profile.point_to_centroid, point_to_corner));
    shape_above_surface = shape_above_surface || dot(point_to_corner, normal) > 0.0;
    profile.max_distance = max(profile.max_distance, corner_distance);
  }

  let front_facing = emitter.theta_o != 0.0 || dot(profile.cone_axis, profile.point_to_centroid) < 0.0;
  profile.visible = (front_facing && shape_above_surface) || has_transmission;
  return profile;
}

fn ltr_sphere_light_profile(light: LightRecord, emitter: LightTreeEmitter, position: vec3<f32>) -> LtrProfile {
  var profile = ltr_invisible_profile();
  var min_distance = 0.0;
  profile.point_to_centroid = ltr_normalize_with_length(light.position - position, &min_distance);
  profile.theta_e = emitter.theta_e;
  profile.energy = emitter.energy;
  profile.visible = true;
  profile.cone_axis = ltr_safe_normalize(position - light.position);
  if (min_distance > light.radius) {
    profile.cos_theta_u = ltr_cos_from_sin(light.radius / min_distance);
    profile.max_distance = min_distance / profile.cos_theta_u;
    profile.min_distance = min_distance;
  } else {
    profile.cos_theta_u = -1.0;
    profile.max_distance = light.radius / sqrt(2.0);
    profile.min_distance = profile.max_distance;
  }

  if (light.light_type == LIGHT_TYPE_SPOT) {
    profile.cone_axis = light.direction;
    profile.theta_o = emitter.theta_o;
    let cos_min_outgoing_angle = cos(max(0.0, acos(clamp(dot(profile.cone_axis, -profile.point_to_centroid), -1.0, 1.0)) - acos(clamp(profile.cos_theta_u, -1.0, 1.0))));
    let blend_offset = cos_min_outgoing_angle - cos(emitter.theta_e);
    var blend_weight = select(0.0, 1.0, blend_offset > 0.0);
    if (light.spot_blend > 0.0) {
      let blend_span = max((1.0 - light.cos_half_angle) * light.spot_blend, 1.0e-8);
      let blend_t = clamp(blend_offset / blend_span, 0.0, 1.0);
      blend_weight = blend_t * blend_t * (3.0 - 2.0 * blend_t);
    }
    profile.energy = profile.energy * blend_weight;
  }
  return profile;
}

fn ltr_area_light_profile(light: LightRecord, emitter: LightTreeEmitter, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {
  let centroid = light.position;
  var profile = ltr_invisible_profile();
  var min_distance = 0.0;
  profile.point_to_centroid = ltr_normalize_with_length(centroid - position, &min_distance);
  profile.min_distance = min_distance;
  profile.max_distance = min_distance;
  profile.cos_theta_u = LTR_LARGE_COSINE;
  profile.cone_axis = light.direction;
  profile.theta_o = emitter.theta_o;
  profile.theta_e = emitter.theta_e;
  profile.energy = emitter.energy;
  let extent_u = light.axis_u * light.size_u;
  let extent_v = light.axis_v * light.size_v;
  for (var corner_index = 0u; corner_index < 4u; corner_index += 1u) {
    let sign_u = select(-0.5, 0.5, (corner_index & 1u) != 0u);
    let sign_v = select(-0.5, 0.5, (corner_index & 2u) != 0u);
    let corner = centroid + extent_u * sign_u + extent_v * sign_v;
    var corner_distance = 0.0;
    let point_to_corner = ltr_normalize_with_length(corner - position, &corner_distance);
    profile.cos_theta_u = min(profile.cos_theta_u, dot(profile.point_to_centroid, point_to_corner));
    profile.max_distance = max(profile.max_distance, corner_distance);
  }
  let front_facing = dot(light.direction, profile.point_to_centroid) < 0.0;
  let shape_above_surface = dot(normal, centroid - position) + abs(dot(normal, extent_u)) + abs(dot(normal, extent_v)) > 0.0;
  profile.visible = (front_facing && shape_above_surface) || has_transmission;
  return profile;
}

fn ltr_sun_light_profile(light: LightRecord, emitter: LightTreeEmitter) -> LtrProfile {
  var profile = ltr_invisible_profile();
  profile.point_to_centroid = -light.direction;
  profile.cos_theta_u = cos(emitter.theta_e);
  profile.cone_axis = light.direction;
  profile.theta_o = emitter.theta_o;
  profile.theta_e = emitter.theta_e;
  profile.energy = emitter.energy;
  profile.visible = true;
  return profile;
}

fn ltr_emitter_profile(emitter_slot: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {
  let emitter = light_tree_emitters[emitter_slot];
  if ((emitter.kind_and_depth & LTR_EMITTER_KIND_TRIANGLE) != 0u) {
    return ltr_triangle_profile(emitter, position, normal, has_transmission);
  }
  let light = lights[emitter.record_index];
  if (light.light_type == LIGHT_TYPE_POINT || light.light_type == LIGHT_TYPE_SPOT) {
    return ltr_sphere_light_profile(light, emitter, position);
  }
  if (light.light_type == LIGHT_TYPE_AREA_RECT || light.light_type == LIGHT_TYPE_AREA_DISK) {
    return ltr_area_light_profile(light, emitter, position, normal, has_transmission);
  }
  if (light.light_type == LIGHT_TYPE_SUN) {
    return ltr_sun_light_profile(light, emitter);
  }
  return ltr_invisible_profile();
}

fn ltr_emitter_importance(emitter_slot: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {
  return ltr_profile_importance(ltr_emitter_profile(emitter_slot, position, normal, has_transmission), normal, has_transmission);
}

// A leaf with one emitter is scored by that emitter, any other node by its box, cone and energy.
fn ltr_child_importance(child_index: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {
  let child = light_tree_nodes[child_index];
  let emitter_count = child.emitter_count_and_kind & LTR_NODE_EMITTER_COUNT_MASK;
  let is_leaf = child.left_child < 0;
  if (is_leaf && emitter_count == 0u) {
    return vec2<f32>(0.0);
  }
  var profile: LtrProfile;
  if (is_leaf && emitter_count == 1u) {
    profile = ltr_emitter_profile(child.right_or_first_emitter, position, normal, has_transmission);
  } else {
    profile = ltr_node_profile(child_index, position, normal, has_transmission);
  }
  return ltr_profile_importance(profile, normal, has_transmission);
}

// False when neither child can contribute. Otherwise the probability of going left, averaged over both bounds.
fn ltr_left_probability(
  left_index: u32,
  right_index: u32,
  position: vec3<f32>,
  normal: vec3<f32>,
  has_transmission: bool,
  left_probability_out: ptr<function, f32>,
) -> bool {
  let left = ltr_child_importance(left_index, position, normal, has_transmission);
  let right = ltr_child_importance(right_index, position, normal, has_transmission);
  let total_maximum = left.x + right.x;
  if (!(total_maximum > 0.0)) {
    return false;
  }
  let total_minimum = left.y + right.y;
  let probability_maximum = left.x / total_maximum;
  var probability_minimum = 0.5 * (select(0.0, 1.0, left.x > 0.0) + select(0.0, 1.0, right.x == 0.0));
  if (total_minimum > 0.0) {
    probability_minimum = left.y / total_minimum;
  }
  *left_probability_out = 0.5 * (probability_maximum + probability_minimum);
  return true;
}

// Cycles `sample_reservoir`: keeps the candidate with probability proportional to its weight and rescales the random number.
fn ltr_sample_reservoir(
  current_slot: i32,
  current_weight: f32,
  selected_slot: ptr<function, i32>,
  selected_weight: ptr<function, f32>,
  total_weight: ptr<function, f32>,
  random_number: ptr<function, f32>,
) {
  if (!(current_weight > 0.0)) {
    return;
  }
  *total_weight += current_weight;
  if (*selected_slot == -1) {
    *selected_slot = current_slot;
    *selected_weight = current_weight;
    return;
  }
  let threshold = current_weight / *total_weight;
  if (*random_number <= threshold) {
    *selected_slot = current_slot;
    *selected_weight = current_weight;
    *random_number = *random_number / threshold;
  } else {
    *random_number = (*random_number - threshold) / (1.0 - threshold);
  }
  *random_number = clamp(*random_number, 0.0, 1.0);
}

// Picks one emitter of a leaf. Half of the random numbers sample by maximum importance, half by minimum importance.
fn ltr_select_in_leaf(
  leaf_index: u32,
  position: vec3<f32>,
  normal: vec3<f32>,
  has_transmission: bool,
  random_number: ptr<function, f32>,
  pdf_factor: ptr<function, f32>,
) -> i32 {
  let leaf = light_tree_nodes[leaf_index];
  let emitter_count = min(leaf.emitter_count_and_kind & LTR_NODE_EMITTER_COUNT_MASK, LTR_MAX_LEAF_EMITTERS);
  let first_slot = leaf.right_or_first_emitter;

  let sample_maximum = *random_number > 0.5;
  if (emitter_count > 1u) {
    *random_number = *random_number * 2.0 - select(0.0, 1.0, sample_maximum);
  }

  var selected_slot = -1;
  var reservoir_selected = 0.0;
  var reservoir_total = 0.0;
  var other_selected = 0.0;
  var other_total = 0.0;
  var has_importance = 0u;
  for (var emitter_index = 0u; emitter_index < emitter_count; emitter_index += 1u) {
    let slot = first_slot + emitter_index;
    let importance = ltr_emitter_importance(slot, position, normal, has_transmission);
    let reservoir_weight = select(importance.y, importance.x, sample_maximum);
    let other_weight = select(importance.x, importance.y, sample_maximum);
    ltr_sample_reservoir(i32(slot), reservoir_weight, &selected_slot, &reservoir_selected, &reservoir_total, random_number);
    if (selected_slot == i32(slot)) {
      other_selected = other_weight;
    }
    other_total += other_weight;
    if (importance.x > 0.0) {
      has_importance = has_importance | (1u << emitter_index);
    }
  }
  if (has_importance == 0u) {
    return -1;
  }

  if (sample_maximum && other_total == 0.0) {
    other_selected = 1.0;
    other_total = f32(countOneBits(has_importance));
  } else if (!sample_maximum && reservoir_total == 0.0) {
    selected_slot = -1;
    for (var emitter_index = 0u; emitter_index < emitter_count; emitter_index += 1u) {
      let uniform_weight = select(0.0, 1.0, ((has_importance >> emitter_index) & 1u) != 0u);
      ltr_sample_reservoir(i32(first_slot + emitter_index), uniform_weight, &selected_slot, &reservoir_selected, &reservoir_total, random_number);
    }
    other_selected = ltr_emitter_importance(u32(selected_slot), position, normal, has_transmission).x;
  }

  *pdf_factor *= 0.5 * (reservoir_selected / reservoir_total + other_selected / other_total);
  return selected_slot;
}

// Picks an emitter for the shading point and writes the probability of that pick. Returns the emitter slot, or -1 when no
// emitter can contribute. `random_number` is in [0, 1).
fn ltr_sample(position: vec3<f32>, normal: vec3<f32>, has_transmission: bool, random_number: f32, pick_probability_out: ptr<function, f32>) -> i32 {
  // A path from the root cannot be longer than the node count; a runtime bound keeps the driver from unrolling the walk.
  let max_level = min(kernel_params.light_tree_node_count, LTR_MAX_TREE_DEPTH + 2u);
  var remaining_random = random_number;
  var pick_probability = 1.0;
  var node_index = 0u;
  for (var level = 0u; level < max_level; level += 1u) {
    let node = light_tree_nodes[node_index];
    if (node.left_child < 0) {
      let slot = ltr_select_in_leaf(node_index, position, normal, has_transmission, &remaining_random, &pick_probability);
      *pick_probability_out = pick_probability;
      return slot;
    }

    let left_index = u32(node.left_child);
    let right_index = node.right_or_first_emitter;
    var left_probability = 0.0;
    if (!ltr_left_probability(left_index, right_index, position, normal, has_transmission, &left_probability)) {
      return -1;
    }
    let right_probability = 1.0 - left_probability;
    var goes_right = false;
    if (right_probability > 0.0) {
      let threshold = right_probability / (left_probability + right_probability);
      if (remaining_random <= threshold) {
        goes_right = true;
        remaining_random = remaining_random / threshold;
      } else {
        remaining_random = (remaining_random - threshold) / (1.0 - threshold);
      }
      remaining_random = clamp(remaining_random, 0.0, 1.0);
    }
    pick_probability *= select(left_probability, right_probability, goes_right);
    node_index = select(left_index, right_index, goes_right);
  }
  return -1;
}

// Probability that `ltr_sample` picks the emitter with this unified index from this shading point.
fn ltr_pdf(position: vec3<f32>, normal: vec3<f32>, has_transmission: bool, unified_index: u32) -> f32 {
  if (kernel_params.light_tree_node_count == 0u) {
    return 0.0;
  }
  let max_level = min(kernel_params.light_tree_node_count, LTR_MAX_TREE_DEPTH + 2u);
  let target_slot = light_to_tree[unified_index];
  let target_emitter = light_tree_emitters[target_slot];
  var pdf = 1.0;
  var node_index = 0u;
  for (var level = 0u; level < max_level; level += 1u) {
    let node = light_tree_nodes[node_index];
    if (node.left_child < 0) {
      let emitter_count = min(node.emitter_count_and_kind & LTR_NODE_EMITTER_COUNT_MASK, LTR_MAX_LEAF_EMITTERS);
      var target_importance = vec2<f32>(0.0);
      var total_importance = vec2<f32>(0.0);
      var emitters_with_importance = 0u;
      for (var emitter_index = 0u; emitter_index < emitter_count; emitter_index += 1u) {
        let slot = node.right_or_first_emitter + emitter_index;
        let importance = ltr_emitter_importance(slot, position, normal, has_transmission);
        if (importance.x > 0.0) {
          emitters_with_importance += 1u;
        }
        if (slot == target_slot) {
          target_importance = importance;
        }
        total_importance += importance;
      }
      if (!(target_importance.x > 0.0)) {
        return 0.0;
      }
      var minimum_term = 1.0 / f32(emitters_with_importance);
      if (total_importance.y > 0.0) {
        minimum_term = target_importance.y / total_importance.y;
      }
      return pdf * 0.5 * (target_importance.x / total_importance.x + minimum_term);
    }

    let left_index = u32(node.left_child);
    let right_index = node.right_or_first_emitter;
    var left_probability = 0.0;
    if (!ltr_left_probability(left_index, right_index, position, normal, has_transmission, &left_probability)) {
      return 0.0;
    }
    let trail_word = select(target_emitter.bit_trail_low, target_emitter.bit_trail_high, level >= 32u);
    let goes_right = ((trail_word >> (level & 31u)) & 1u) != 0u;
    pdf *= select(left_probability, 1.0 - left_probability, goes_right);
    if (pdf == 0.0) {
      return 0.0;
    }
    node_index = select(left_index, right_index, goes_right);
  }
  return 0.0;
}

// ---- Test probe (`KERNEL_FLAG_LIGHT_TREE_PROBE`) ------------------------------------------------------------------------------
// One pseudo random shading point per pixel, inside the root box grown by a quarter on every side, with a random normal and a
// transmission flag that alternates with the pixel index. Writes (sum of `ltr_pdf` over every emitter, fraction of
// `samples_per_dispatch` stratified `ltr_sample` picks that found an emitter, largest gap between the probability `ltr_sample`
// returned and `ltr_pdf` of the emitter it picked, number of emitters with a positive pick probability). The host divides the
// film by the sample count, so a test passes `samples == samples_per_dispatch` and multiplies the result back.

@compute @workgroup_size(8, 8, 1)
fn light_tree_probe(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x >= kernel_params.image_width || global_id.y >= kernel_params.image_height) {
    return;
  }
  let pixel_index = global_id.y * kernel_params.image_width + global_id.x;
  film_accumulation[pixel_index] = ltr_probe_pick_probabilities(pixel_index);
}

fn ltr_probe_random(pixel_index: u32, stream: u32) -> f32 {
  return f32(smp_hash_uint(pixel_index * 8u + stream) >> 8u) / 16777216.0;
}

fn ltr_probe_pick_probabilities(pixel_index: u32) -> vec4<f32> {
  let root = light_tree_nodes[0];
  var box_min = root.bounds_min;
  var box_max = root.bounds_max;
  if (all(box_max <= box_min)) {
    box_min = vec3<f32>(-1.0);
    box_max = vec3<f32>(1.0);
  }
  let margin = 0.25 * (box_max - box_min);
  let corner_min = box_min - margin;
  let corner_max = box_max + margin;
  let position = corner_min + (corner_max - corner_min) * vec3<f32>(
    ltr_probe_random(pixel_index, 0u),
    ltr_probe_random(pixel_index, 1u),
    ltr_probe_random(pixel_index, 2u),
  );
  let normal = lgt_sample_uniform_sphere(vec2<f32>(ltr_probe_random(pixel_index, 3u), ltr_probe_random(pixel_index, 4u)));
  let has_transmission = (pixel_index & 1u) != 0u;

  let emitter_total = kernel_params.light_count + kernel_params.emissive_triangle_count;
  var probability_sum = 0.0;
  var reachable_emitters = 0.0;
  for (var unified_index = 0u; unified_index < emitter_total; unified_index += 1u) {
    let probability = ltr_pdf(position, normal, has_transmission, unified_index);
    probability_sum += probability;
    if (probability > 0.0) {
      reachable_emitters += 1.0;
    }
  }

  var found_picks = 0.0;
  var largest_gap = 0.0;
  let pick_count = max(kernel_params.samples_per_dispatch, 1u);
  for (var pick_index = 0u; pick_index < pick_count; pick_index += 1u) {
    let random_number = (f32(pick_index) + 0.5) / f32(pick_count);
    var pick_probability = 0.0;
    let slot = ltr_sample(position, normal, has_transmission, random_number, &pick_probability);
    if (slot >= 0) {
      found_picks += 1.0;
      let emitter = light_tree_emitters[u32(slot)];
      var unified_index = emitter.record_index;
      if ((emitter.kind_and_depth & LTR_EMITTER_KIND_TRIANGLE) != 0u) {
        unified_index += kernel_params.light_count;
      }
      largest_gap = max(largest_gap, abs(pick_probability - ltr_pdf(position, normal, has_transmission, unified_index)));
    }
  }
  return vec4<f32>(probability_sum, found_picks / f32(pick_count), largest_gap, reachable_emitters);
}
