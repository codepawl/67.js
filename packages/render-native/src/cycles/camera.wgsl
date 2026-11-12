// SPDX-FileCopyrightText: 2011-2022 Blender Foundation
// SPDX-License-Identifier: Apache-2.0
//
// Perspective, orthographic, and thin-lens primary camera ray generation (`cam_*`),
// ported from Cycles `kernel/camera/camera.h` and `kernel/sample/mapping.h`.

struct CamRay {
  origin: vec3<f32>,
  direction: vec3<f32>,
  t_min: f32,
  t_max: f32,
}

fn cam_sample_uniform_disk(rand_uv: vec2<f32>) -> vec2<f32> {
  let offset = 2.0 * rand_uv - vec2<f32>(1.0, 1.0);
  if (offset.x == 0.0 && offset.y == 0.0) {
    return vec2<f32>(0.0, 0.0);
  }
  var radius = 0.0;
  var phi = 0.0;
  if (abs(offset.x) > abs(offset.y)) {
    radius = offset.x;
    phi = (0.25 * PI) * (offset.y / offset.x);
  } else {
    radius = offset.y;
    phi = (0.5 * PI) - (0.25 * PI) * (offset.x / offset.y);
  }
  return vec2<f32>(radius * cos(phi), radius * sin(phi));
}

fn cam_sample_regular_polygon(blades: u32, rotation: f32, rand_uv: vec2<f32>) -> vec2<f32> {
  let corners = f32(blades);
  let corner_index = floor(rand_uv.x * corners);
  let u_remapped = rand_uv.x * corners - corner_index;
  let su = sqrt(u_remapped);
  let weight_a = 1.0 - su;
  let weight_b = rand_uv.y * su;
  let step_angle = TWO_PI / corners;
  let angle_0 = rotation + corner_index * step_angle;
  let angle_1 = angle_0 + step_angle;
  let vertex_0 = vec2<f32>(cos(angle_0), sin(angle_0));
  let vertex_1 = vec2<f32>(cos(angle_1), sin(angle_1));
  return weight_a * vertex_0 + weight_b * vertex_1;
}

fn cam_sample_aperture(rand_uv: vec2<f32>) -> vec2<f32> {
  if (kernel_params.aperture_blades >= 3u) {
    return cam_sample_regular_polygon(kernel_params.aperture_blades, kernel_params.aperture_rotation, rand_uv);
  }
  return cam_sample_uniform_disk(rand_uv);
}

fn cam_safe_unit_axis(axis: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let len = length(axis);
  if (len > 1e-12) {
    return axis / len;
  }
  return fallback;
}

fn cam_generate_ray(pixel_x: u32, pixel_y: u32, filter_offset: vec2<f32>, lens_uv: vec2<f32>) -> CamRay {
  let raster_x = f32(pixel_x) + 0.5 + filter_offset.x;
  let raster_y = f32(pixel_y) + 0.5 + filter_offset.y;
  let inv_width = 1.0 / f32(max(kernel_params.image_width, 1u));
  let inv_height = 1.0 / f32(max(kernel_params.image_height, 1u));
  let sensor_x = raster_x * inv_width * 2.0 - 1.0 + 2.0 * kernel_params.lens_shift.x;
  let sensor_y = 1.0 - raster_y * inv_height * 2.0 + 2.0 * kernel_params.lens_shift.y;

  let forward = cam_safe_unit_axis(kernel_params.camera_forward, vec3<f32>(0.0, 0.0, -1.0));
  let unit_right = cam_safe_unit_axis(kernel_params.camera_right, vec3<f32>(1.0, 0.0, 0.0));
  let unit_up = cam_safe_unit_axis(kernel_params.camera_up, vec3<f32>(0.0, 1.0, 0.0));

  let is_ortho = (kernel_params.kernel_flags & KERNEL_FLAG_ORTHOGRAPHIC_CAMERA) != 0u;
  let far_plane = select(1.0e30, kernel_params.camera_far, kernel_params.camera_far > kernel_params.camera_near);
  let near_plane = max(kernel_params.camera_near, 0.0);

  var ray: CamRay;
  if (is_ortho) {
    var origin = kernel_params.camera_position
      + kernel_params.camera_right * sensor_x
      + kernel_params.camera_up * sensor_y;
    var direction = forward;
    if (kernel_params.aperture_radius > 0.0 && kernel_params.focal_distance > 0.0) {
      let bokeh = cam_sample_aperture(lens_uv) * kernel_params.aperture_radius;
      let lens_offset = unit_right * bokeh.x + unit_up * bokeh.y;
      origin += lens_offset;
      direction = normalize(forward * kernel_params.focal_distance - lens_offset);
    }
    let cos_forward = max(dot(direction, forward), 1e-6);
    ray.origin = origin;
    ray.direction = direction;
    ray.t_min = near_plane / cos_forward;
    ray.t_max = select(1.0e30, far_plane / cos_forward, far_plane < 1.0e29);
    return ray;
  }

  let unnormalized_dir = forward
    + kernel_params.camera_right * sensor_x
    + kernel_params.camera_up * sensor_y;
  let center_dir = normalize(unnormalized_dir);
  var origin = kernel_params.camera_position;
  var direction = center_dir;

  if (kernel_params.aperture_radius > 0.0 && kernel_params.focal_distance > 0.0) {
    let bokeh = cam_sample_aperture(lens_uv) * kernel_params.aperture_radius;
    let lens_offset = unit_right * bokeh.x + unit_up * bokeh.y;
    let focus_offset = unnormalized_dir * kernel_params.focal_distance;
    origin += lens_offset;
    direction = normalize(focus_offset - lens_offset);
  }

  let cos_forward = max(dot(center_dir, forward), 1e-6);
  ray.origin = origin;
  ray.direction = direction;
  ray.t_min = near_plane / cos_forward;
  ray.t_max = select(1.0e30, far_plane / cos_forward, far_plane < 1.0e29);
  return ray;
}
