// An edge-avoiding a-trous wavelet filter on the GPU, after Dammertz et al. 2010 (edge-avoiding a-trous wavelet transform)
// with the variance guided luminance weight of Schied et al. 2017 (SVGF), spatial part only. It is the WGSL form of
// src/path-tracer-denoise.js and keeps its constants. The result is a biased, smoothed estimate, not a converged image.
//
// Entry points, dispatched in this order: prepare, atrous five times (steps 1, 2, 4, 8, 16), finish.

struct Parameters {
  width: u32,
  height: u32,
  pass_step: u32,
  read_from_b: u32,
}

@group(0) @binding(0) var<uniform> parameters: Parameters;
// The traced colour in, the filtered colour out (linear RGBA, alpha 1).
@group(0) @binding(1) var<storage, read_write> color: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> albedo: array<f32>;
// Three floats per pixel; `prepare` turns each into a unit vector, or zero where the first ray escaped.
@group(0) @binding(3) var<storage, read_write> normal: array<f32>;
@group(0) @binding(4) var<storage, read_write> depth: array<f32>;
@group(0) @binding(5) var<storage, read_write> variance: array<f32>;
// Demodulated light in xyz and its noise variance in w; the passes ping-pong between the two.
@group(0) @binding(6) var<storage, read_write> light_a: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> light_b: array<vec4<f32>>;

const ALBEDO_FLOOR: f32 = 0.02;
const NORMAL_POWER: f32 = 64.0;
const LUMINANCE_SIGMA: f32 = 3.0;
const LUMINANCE_WEIGHTS: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

fn luminance_of(value: vec3<f32>) -> f32 {
  return dot(value, LUMINANCE_WEIGHTS);
}

fn albedo_at(pixel: u32) -> vec3<f32> {
  return vec3<f32>(albedo[pixel * 3u], albedo[pixel * 3u + 1u], albedo[pixel * 3u + 2u]);
}

fn normal_at(pixel: u32) -> vec3<f32> {
  return vec3<f32>(normal[pixel * 3u], normal[pixel * 3u + 1u], normal[pixel * 3u + 2u]);
}

fn kernel_weight(offset: i32) -> f32 {
  let magnitude = abs(offset);
  if (magnitude == 0) {
    return 0.375;
  }
  if (magnitude == 1) {
    return 0.25;
  }
  return 0.0625;
}

fn load_light(read_from_b: bool, pixel: u32) -> vec4<f32> {
  if (read_from_b) {
    return light_b[pixel];
  }
  return light_a[pixel];
}

fn store_light(write_to_b: bool, pixel: u32, value: vec4<f32>) {
  if (write_to_b) {
    light_b[pixel] = value;
  } else {
    light_a[pixel] = value;
  }
}

// The variance of the light (albedo divided out) at one pixel, smoothed over the 3 by 3 neighbourhood.
fn smoothed_noise(column: u32, row: u32) -> f32 {
  let width = i32(parameters.width);
  let height = i32(parameters.height);
  var sum = 0.0;
  var count = 0.0;
  for (var row_offset = -1; row_offset <= 1; row_offset++) {
    for (var column_offset = -1; column_offset <= 1; column_offset++) {
      let neighbor_row = i32(row) + row_offset;
      let neighbor_column = i32(column) + column_offset;
      if (neighbor_row < 0 || neighbor_row >= height || neighbor_column < 0 || neighbor_column >= width) {
        continue;
      }
      let neighbor = u32(neighbor_row * width + neighbor_column);
      let brightness = max(luminance_of(albedo_at(neighbor)), ALBEDO_FLOOR);
      sum += variance[neighbor] / (brightness * brightness);
      count += 1.0;
    }
  }
  return sum / count;
}

@compute @workgroup_size(8, 8, 1)
fn prepare(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) {
    return;
  }
  let pixel = id.y * parameters.width + id.x;
  let raw_normal = normal_at(pixel);
  var unit_normal = vec3<f32>(0.0);
  if (length(raw_normal) > 1e-6) {
    unit_normal = normalize(raw_normal);
  }
  normal[pixel * 3u] = unit_normal.x;
  normal[pixel * 3u + 1u] = unit_normal.y;
  normal[pixel * 3u + 2u] = unit_normal.z;
  let light = color[pixel].xyz / max(albedo_at(pixel), vec3<f32>(ALBEDO_FLOOR));
  light_a[pixel] = vec4<f32>(light, smoothed_noise(id.x, id.y));
}

// Rays that escaped carry no normal: two such pixels agree fully, one such pixel agrees with nothing.
fn normal_agreement(center_normal: vec3<f32>, neighbor_normal: vec3<f32>) -> f32 {
  let center_present = dot(center_normal, center_normal) > 0.5;
  let neighbor_present = dot(neighbor_normal, neighbor_normal) > 0.5;
  if (!center_present && !neighbor_present) {
    return 1.0;
  }
  if (center_present != neighbor_present) {
    return 0.0;
  }
  let cosine = dot(center_normal, neighbor_normal);
  if (cosine <= 0.0) {
    return 0.0;
  }
  return pow(cosine, NORMAL_POWER);
}

fn clamped_depth(column: i32, row: i32) -> f32 {
  let clamped_column = clamp(column, 0, i32(parameters.width) - 1);
  let clamped_row = clamp(row, 0, i32(parameters.height) - 1);
  return depth[u32(clamped_row) * parameters.width + u32(clamped_column)];
}

@compute @workgroup_size(8, 8, 1)
fn atrous(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) {
    return;
  }
  let width = i32(parameters.width);
  let height = i32(parameters.height);
  let column = i32(id.x);
  let row = i32(id.y);
  let pass_step = i32(parameters.pass_step);
  let read_from_b = parameters.read_from_b == 1u;
  let center = id.y * parameters.width + id.x;
  let center_light = load_light(read_from_b, center);
  let center_luminance = luminance_of(center_light.xyz);
  let center_normal = normal_at(center);
  let center_depth = depth[center];
  let gradient_x = (clamped_depth(column + 1, row) - clamped_depth(column - 1, row)) * 0.5;
  let gradient_y = (clamped_depth(column, row + 1) - clamped_depth(column, row - 1)) * 0.5;
  let luminance_scale = LUMINANCE_SIGMA * sqrt(max(center_light.w, 0.0)) + 1e-4;
  var weight_sum = 0.0;
  var variance_sum = 0.0;
  var light_sum = vec3<f32>(0.0);
  for (var kernel_row = -2; kernel_row <= 2; kernel_row++) {
    let neighbor_row = row + kernel_row * pass_step;
    if (neighbor_row < 0 || neighbor_row >= height) {
      continue;
    }
    for (var kernel_column = -2; kernel_column <= 2; kernel_column++) {
      let neighbor_column = column + kernel_column * pass_step;
      if (neighbor_column < 0 || neighbor_column >= width) {
        continue;
      }
      let neighbor = u32(neighbor_row * width + neighbor_column);
      let neighbor_light = load_light(read_from_b, neighbor);
      let depth_tolerance = abs(gradient_x * f32(kernel_column * pass_step))
        + abs(gradient_y * f32(kernel_row * pass_step))
        + 1e-3 * abs(center_depth) + 1e-5;
      let depth_weight = exp(-abs(center_depth - depth[neighbor]) / depth_tolerance);
      let luminance_weight = exp(-abs(center_luminance - luminance_of(neighbor_light.xyz)) / luminance_scale);
      let weight = kernel_weight(kernel_row) * kernel_weight(kernel_column)
        * normal_agreement(center_normal, normal_at(neighbor)) * depth_weight * luminance_weight;
      weight_sum += weight;
      variance_sum += weight * weight * neighbor_light.w;
      light_sum += weight * neighbor_light.xyz;
    }
  }
  let filtered = vec4<f32>(light_sum / weight_sum, variance_sum / (weight_sum * weight_sum));
  store_light(!read_from_b, center, filtered);
}

// The five passes end in light_b; the albedo goes back on.
@compute @workgroup_size(8, 8, 1)
fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= parameters.width || id.y >= parameters.height) {
    return;
  }
  let pixel = id.y * parameters.width + id.x;
  let restored = light_b[pixel].xyz * max(albedo_at(pixel), vec3<f32>(ALBEDO_FLOOR));
  color[pixel] = vec4<f32>(restored, 1.0);
}
