// SPDX-FileCopyrightText: 2011-2026 Blender Foundation
// SPDX-License-Identifier: Apache-2.0

enable wgpu_ray_query;

// Cycles-parity native kernel ABI header (`FORMAT-v2.md`).
// Included first by `src/cycles/kernel-manifest.txt`. Later WGSL modules must not repeat `enable` directives.
// Contains constants, buffer record structs, shading/closure structs, `@group(0)` bindings, and comment-documented
// cross-lane function signatures (no `{ ... }` stub bodies).

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
const INV_PI: f32 = 0.3183098861837907;
const INV_TWO_PI: f32 = 0.15915494309189535;
const INVALID_INDEX: u32 = 0xFFFFFFFFu;

const FORMAT_V2_MAGIC: u32 = 0x36375054u;
const FORMAT_V2_VERSION: u32 = 2u;

// `@group(0)` binding indices matching `FORMAT-v2.md`.
const BINDING_KERNEL_PARAMS: u32 = 0u;
const BINDING_SCENE_TLAS: u32 = 1u;
const BINDING_INSTANCES: u32 = 2u;
const BINDING_TRIANGLES: u32 = 3u;
const BINDING_MATERIALS: u32 = 4u;
const BINDING_EMISSIVE_TRIANGLES: u32 = 5u;
const BINDING_LIGHTS: u32 = 6u;
const BINDING_LIGHT_TREE_NODES: u32 = 7u;
const BINDING_TEXTURE_DESCRIPTORS: u32 = 8u;
const BINDING_TEXTURE_TEXELS: u32 = 9u;
const BINDING_ENVIRONMENT_TEXELS: u32 = 10u;
const BINDING_FILM_ACCUMULATION: u32 = 11u;

// `KernelParamsV2.kernel_flags` bits.
const KERNEL_FLAG_USE_LIGHT_TREE: u32 = 1u;
const KERNEL_FLAG_HAS_VOLUME: u32 = 2u;
const KERNEL_FLAG_HAS_SUBSURFACE: u32 = 4u;
const KERNEL_FLAG_ORTHOGRAPHIC_CAMERA: u32 = 8u;
const KERNEL_FLAG_ADAPTIVE_SAMPLING: u32 = 16u;
const KERNEL_FLAG_TRANSPARENT_BACKGROUND: u32 = 32u;
// Set: unstratified PCG hash sampler. Clear (default): Cycles' Sobol-Burley blue-noise pattern.
const KERNEL_FLAG_WHITE_NOISE_SAMPLER: u32 = 64u;
// Tests only: every pixel writes the light tree pick probabilities of one random shading point instead of tracing paths.
const KERNEL_FLAG_LIGHT_TREE_PROBE: u32 = 128u;
// Tests only: direct light samples carry no MIS weight and emissive hits found by the BSDF count nothing (NEE only), or the
// reverse: no direct light samples and emissive hits count fully (BSDF only). Both clear is the normal MIS combination.
const KERNEL_FLAG_TEST_NEE_ONLY: u32 = 256u;
const KERNEL_FLAG_TEST_BSDF_ONLY: u32 = 512u;
// Set: a path that ends is replaced at once by the pixel's next sample (one bounce per loop iteration). Clear (default): each path
// runs to its end before the next one starts. The image is the same either way; only the time per sample differs.
const KERNEL_FLAG_PATH_REGENERATION: u32 = 1024u;
// Set: the integrator carries a ray cone along each path and a hit hands the texture sampler its footprint, so a texture that
// stores mip levels is read at the level the footprint asks for. Clear (default): every texture is read at level 0, as Blender
// Cycles does.
const KERNEL_FLAG_TEXTURE_MIPS: u32 = 2048u;

// `KernelParamsV2.filter_type` values.
const FILTER_BOX: u32 = 0u;
const FILTER_GAUSSIAN: u32 = 1u;
const FILTER_BLACKMAN_HARRIS: u32 = 2u;

// `InstanceRecord.visibility_flags` bits.
const INSTANCE_VISIBILITY_CAMERA: u32 = 1u;
const INSTANCE_VISIBILITY_DIFFUSE: u32 = 2u;
const INSTANCE_VISIBILITY_GLOSSY: u32 = 4u;
const INSTANCE_VISIBILITY_TRANSMISSION: u32 = 8u;
const INSTANCE_VISIBILITY_SHADOW: u32 = 16u;
const INSTANCE_VISIBILITY_VOLUME_SCATTER: u32 = 32u;
const INSTANCE_FLAG_NEGATIVE_SCALE: u32 = 64u;

// `TriangleRecord.flags` bits.
const TRIANGLE_FLAG_SMOOTH_NORMALS: u32 = 1u;
const TRIANGLE_FLAG_HAS_VERTEX_COLORS: u32 = 2u;
const TRIANGLE_FLAG_HAS_UV1: u32 = 4u;
const TRIANGLE_FLAG_HAS_TANGENTS: u32 = 8u;
const TRIANGLE_FLAG_DOUBLE_SIDED: u32 = 16u;

// `LightRecord.light_type` values.
const LIGHT_TYPE_POINT: u32 = 0u;
const LIGHT_TYPE_SPOT: u32 = 1u;
const LIGHT_TYPE_AREA_RECT: u32 = 2u;
const LIGHT_TYPE_AREA_DISK: u32 = 3u;
const LIGHT_TYPE_SUN: u32 = 4u;

// `LightRecord.flags` bits.
const LIGHT_FLAG_CAST_SHADOW: u32 = 1u;
const LIGHT_FLAG_MULTIPLE_IMPORTANCE: u32 = 2u;
const LIGHT_FLAG_CAMERA_VISIBLE: u32 = 4u;
const LIGHT_FLAG_PORTAL: u32 = 8u;
const LIGHT_FLAG_NORMALIZE: u32 = 16u;
// A point or spot light with a radius is an oriented disk facing the shading point (Blender's `use_soft_falloff`), not a sphere.
const LIGHT_FLAG_SOFT_FALLOFF: u32 = 32u;

// `MaterialRecord.flags` bits.
const MATERIAL_FLAG_MULTISCATTER_GGX: u32 = 1u;
const MATERIAL_FLAG_THIN_WALLED: u32 = 2u;
const MATERIAL_FLAG_TRANSPARENT_SHADOW: u32 = 4u;
const MATERIAL_FLAG_DOUBLE_SIDED: u32 = 8u;
const MATERIAL_FLAG_EMISSIVE_MIS: u32 = 16u;
const MATERIAL_FLAG_F82_METALLIC: u32 = 32u;
const MATERIAL_FLAG_HAS_SHADER_GRAPH: u32 = 64u;
// `flags` of a material extension record: the diffuse transmission colour tints the base colour instead of replacing it.
const MATERIAL_EXTENSION_FLAG_TINTS_BASE_COLOR: u32 = 1u;

// `MaterialRecord.alpha_mode` values.
const ALPHA_MODE_OPAQUE: u32 = 0u;
const ALPHA_MODE_MASK: u32 = 1u;
const ALPHA_MODE_BLEND: u32 = 2u;

// Closure lobe capacity and `Lobe.lobe_type` discriminants.
const MAX_CLOSURE_LOBES: u32 = 4u; // SPECIALIZE_LOBES
const MAX_CLOSURE_CANDIDATES: u32 = 7u; // SPECIALIZE_CANDIDATES
const CLOSURE_PRUNES_CANDIDATES: bool = MAX_CLOSURE_CANDIDATES > MAX_CLOSURE_LOBES;
const CLOSURE_SCRATCH_LOBES: u32 = select(1u, MAX_CLOSURE_CANDIDATES, CLOSURE_PRUNES_CANDIDATES);
// How many lobes `closure_add_candidate` can take before the closure is built.
const CLOSURE_CANDIDATE_CAPACITY: u32 = select(MAX_CLOSURE_LOBES, MAX_CLOSURE_CANDIDATES, CLOSURE_PRUNES_CANDIDATES);

// Scene feature flags. The host rewrites `true` to `false` for features the packed scene never uses,
// so the guarded code is dead in that pipeline. `true` is the safe default.
const SCENE_HAS_VOLUME: bool = true;
const SCENE_HAS_ALPHA_MASK: bool = true;
const SCENE_HAS_TRANSPARENT: bool = true;
const SCENE_HAS_GLASS: bool = true;
const SCENE_HAS_COAT: bool = true;
const SCENE_HAS_SHEEN: bool = true;
const SCENE_HAS_ANISOTROPY: bool = true;
const SCENE_HAS_THIN_FILM: bool = true;
const SCENE_HAS_F82: bool = true;
// The material table holds an extension record per material after its `material_count` records (FORMAT-v2.md). Unlike the
// flags above, `false` is the safe default: only the host's specialization turns it on, for a table that carries them.
const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = false;
const SCENE_HAS_NORMAL_MAP: bool = true;
const SCENE_HAS_EMISSIVE_TRIANGLES: bool = true;
const SCENE_HAS_ANALYTIC_LIGHTS: bool = true;
const SCENE_HAS_FINITE_LIGHTS: bool = true;
const SCENE_HAS_ENV_IMPORTANCE: bool = true;
const SCENE_HAS_LIGHT_LINKING: bool = true;
const SCENE_HAS_LIGHT_TREE: bool = true;
const LOBE_NONE: u32 = 0u;
const LOBE_DIFFUSE: u32 = 1u;
const LOBE_GLOSSY_GGX: u32 = 2u;
const LOBE_GLASS_GGX: u32 = 3u;
const LOBE_COAT_GGX: u32 = 4u;
const LOBE_SHEEN: u32 = 5u;
const LOBE_TRANSPARENT: u32 = 6u;
const LOBE_DIFFUSE_TRANSMISSION: u32 = 7u;

// `Lobe.flags` bits.
const LOBE_FLAG_MULTISCATTER: u32 = 1u;
const LOBE_FLAG_F82_TINT: u32 = 2u;
const LOBE_FLAG_THIN_FILM: u32 = 4u;
const LOBE_FLAG_THIN_WALLED: u32 = 8u;

// 320 bytes (20 x 16 B), alignment 16 B.
struct KernelParamsV2 {
  magic: u32,
  format_version: u32,
  image_width: u32,
  image_height: u32,

  sample_offset: u32,
  samples_per_dispatch: u32,
  total_samples: u32,
  seed: u32,

  kernel_flags: u32,
  adaptive_threshold: f32,
  clamp_direct: f32,
  clamp_indirect: f32,

  max_bounces: u32,
  max_diffuse_bounces: u32,
  max_glossy_bounces: u32,
  max_transmission_bounces: u32,

  max_volume_bounces: u32,
  max_transparent_bounces: u32,
  min_bounce_rr: u32,
  filter_type: u32,

  filter_width: f32,
  instance_count: u32,
  triangle_count: u32,
  material_count: u32,

  emissive_triangle_count: u32,
  light_count: u32,
  light_tree_node_count: u32,
  texture_count: u32,

  camera_position: vec3<f32>,
  camera_near: f32,

  camera_forward: vec3<f32>,
  camera_far: f32,

  camera_right: vec3<f32>,
  aperture_radius: f32,

  camera_up: vec3<f32>,
  focal_distance: f32,

  lens_shift: vec2<f32>,
  aperture_blades: u32,
  aperture_rotation: f32,

  env_width: u32,
  env_height: u32,
  env_cdf_offset: u32,
  env_rotation: f32,

  env_color: vec3<f32>,
  env_total_weight: f32,

  volume_bounds_min: vec3<f32>,
  volume_density: f32,

  volume_bounds_max: vec3<f32>,
  volume_anisotropy: f32,

  volume_albedo: vec3<f32>,
  emissive_total_weight: f32,

  analytic_light_total_weight: f32,
  ray_epsilon: f32,
  adaptive_min_samples: u32,
  ies_table_offset: u32,

  film_exposure: f32,
  background_mis_weight: f32,
  sobol_table_offset: u32,
  filter_glossy: f32,

  camera_env_scale: f32,
  // Light portals packed after the `light_count` emitters in the light table (FORMAT-v2.md).
  portal_count: u32,
  // Pixel origin of the tile this dispatch covers; the host writes it for every dispatch, `[0, 0]` for a whole-image dispatch.
  tile_origin: vec2<u32>,
}

// 160 bytes (10 x 16 B), alignment 16 B.
struct InstanceRecord {
  object_to_world_row0: vec4<f32>,
  object_to_world_row1: vec4<f32>,
  object_to_world_row2: vec4<f32>,

  world_to_object_row0: vec4<f32>,
  world_to_object_row1: vec4<f32>,
  world_to_object_row2: vec4<f32>,

  blas_index: u32,
  triangle_offset: u32,
  opaque_triangle_count: u32,
  total_triangle_count: u32,

  material_override: u32,
  visibility_flags: u32,
  light_group_mask_lo: u32,
  light_group_mask_hi: u32,

  emissive_base_offset: u32,
  object_id: u32,
  object_random: f32,
  shadow_terminator_offset: f32,

  object_color: vec4<f32>,
}

// 224 bytes (14 x 16 B), alignment 16 B.
struct TriangleRecord {
  p0: vec3<f32>,
  material_index: u32,

  edge1: vec3<f32>,
  local_emissive_offset: u32,

  edge2: vec3<f32>,
  flags: u32,

  n0: vec3<f32>,
  uv0_u: f32,

  n1: vec3<f32>,
  uv0_v: f32,

  n2: vec3<f32>,
  uv1_u: f32,

  tangent0: vec3<f32>,
  uv1_v: f32,

  tangent1: vec3<f32>,
  uv2_u: f32,

  tangent2: vec3<f32>,
  uv2_v: f32,

  color0: vec3<f32>,
  tangent_sign: f32,

  color1: vec3<f32>,
  mesh_id: u32,

  color2: vec3<f32>,
  primitive_id: u32,

  uv_set1_0: vec2<f32>,
  uv_set1_1: vec2<f32>,

  uv_set1_2: vec2<f32>,
  attribute_offset: u32,
  reserved_u0: u32,
}

// 96 bytes (6 x 16 B), alignment 16 B.
struct EmissiveTriangleRecord {
  p0: vec3<f32>,
  area: f32,

  edge1: vec3<f32>,
  instance_index: u32,

  edge2: vec3<f32>,
  triangle_index: u32,

  geometric_normal: vec3<f32>,
  material_index: u32,

  radiance: vec3<f32>,
  selection_weight: f32,

  selection_pdf: f32,
  cdf_upper: f32,
  light_group_mask_lo: u32,
  light_group_mask_hi: u32,
}

// 128 bytes (8 x 16 B), alignment 16 B.
struct LightRecord {
  position: vec3<f32>,
  light_type: u32,

  radiance: vec3<f32>,
  flags: u32,

  direction: vec3<f32>,
  radius: f32,

  axis_u: vec3<f32>,
  size_u: f32,

  axis_v: vec3<f32>,
  size_v: f32,

  cos_half_angle: f32,
  spot_blend: f32,
  tan_half_spread: f32,
  spread_normalization: f32,

  area_or_solid_angle: f32,
  max_distance: f32,
  ies_profile_index: i32,
  tree_leaf_index: u32,

  selection_pdf: f32,
  cdf_upper: f32,
  light_group_mask_lo: u32,
  light_group_mask_hi: u32,
}

// 64 bytes (4 x 16 B), alignment 16 B.
struct LightTreeNode {
  bounds_min: vec3<f32>,
  energy: f32,

  bounds_max: vec3<f32>,
  theta_o: f32,

  cone_axis: vec3<f32>,
  theta_e: f32,

  left_child: i32,
  right_or_first_emitter: u32,
  emitter_count_and_kind: u32,
  light_group_mask_or: u32,
}

// 32 bytes (2 x 16 B), alignment 16 B. One emitter of the light tree, in tree order (FORMAT-v2 section 7b).
// `kind_and_depth`: bit 0 emissive triangle, bit 1 distant, bits 8..15 depth. `record_index` indexes `lights` or
// `emissive_triangles`. `bit_trail_low` / `bit_trail_high` hold one bit per tree level, set where the path to the
// emitter goes right.
struct LightTreeEmitter {
  energy: f32,
  theta_o: f32,
  theta_e: f32,
  kind_and_depth: u32,
  record_index: u32,
  leaf_node_index: u32,
  bit_trail_low: u32,
  bit_trail_high: u32,
}

// 32 bytes (2 x 16 B), alignment 16 B.
struct TextureDescriptor {
  @align(16) data_offset: u32,
  width: u32,
  height: u32,
  format_and_sampler: u32,

  uv_scale: vec2<f32>,
  uv_offset: vec2<f32>,
}

// 256 bytes (16 x 16 B), alignment 16 B.
struct MaterialRecord {
  base_color: vec3<f32>,
  metallic: f32,

  roughness: f32,
  ior: f32,
  specular_ior_level: f32,
  diffuse_roughness: f32,

  f82_tint: vec3<f32>,
  anisotropy: f32,

  anisotropy_rotation: f32,
  transmission_weight: f32,
  alpha: f32,
  alpha_cutoff: f32,

  coat_tint: vec3<f32>,
  coat_weight: f32,

  coat_roughness: f32,
  coat_ior: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,

  sheen_tint: vec3<f32>,
  sheen_weight: f32,

  absorption_color: vec3<f32>,
  absorption_distance: f32,

  emission_color: vec3<f32>,
  emission_strength: f32,

  subsurface_radius: vec3<f32>,
  subsurface_weight: f32,

  subsurface_color: vec3<f32>,
  subsurface_anisotropy: f32,

  sheen_roughness: f32,
  subsurface_ior: f32,
  normal_scale: f32,
  coat_normal_scale: f32,

  flags: u32,
  alpha_mode: u32,
  bump_distance: f32,
  svm_node_offset: u32,

  base_color_tex: i32,
  metallic_roughness_tex: i32,
  normal_tex: i32,
  emission_tex: i32,

  transmission_tex: i32,
  coat_weight_roughness_tex: i32,
  coat_tint_tex: i32,
  coat_normal_tex: i32,

  sheen_color_roughness_tex: i32,
  anisotropy_tex: i32,
  alpha_tex: i32,
  bump_tex: i32,
}

// Shader-side surface hit differential & frame passed from L3 integrator to L4 closure setup.
struct ShadingPoint {
  position: vec3<f32>,
  ray_t: f32,

  geometric_normal: vec3<f32>,
  front_face: u32,

  shading_normal: vec3<f32>,
  material_index: u32,

  coat_normal: vec3<f32>,
  instance_index: u32,

  tangent: vec3<f32>,
  triangle_index: u32,

  bitangent: vec3<f32>,
  emissive_index: u32,

  uv0: vec2<f32>,
  uv1: vec2<f32>,

  barycentrics: vec2<f32>,
  object_random: f32,
  light_group_mask_lo: u32,

  vertex_color: vec3<f32>,
  light_group_mask_hi: u32,

  // Width of the ray footprint on the surface in `uv0` units; 0 reads every texture at level 0.
  uv_footprint: f32,
}

// Single BSDF lobe parameterized by L4 closure setup.
struct Lobe {
  weight: vec3<f32>,
  sample_weight: f32,

  normal: vec3<f32>,
  lobe_type: u32,

  tangent: vec3<f32>,
  flags: u32,

  f0: vec3<f32>,
  ior: f32,

  f82_or_tint: vec3<f32>,
  diffuse_roughness: f32,

  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
}

// Stacked multi-lobe surface closure evaluated/sampled at `ShadingPoint`.
struct Closure {
  lobes: array<Lobe, MAX_CLOSURE_LOBES>,

  emission: vec3<f32>,
  lobe_count: u32,

  absorption_sigma: vec3<f32>,
  total_sample_weight: f32,

  geometric_normal: vec3<f32>,
  front_face: u32,
}

// Return value of `closure_eval`: cosine-foreshortened BSDF value `f(wo, wi) * |dot(N, wi)|` and solid-angle mixture PDF.
struct ClosureEval {
  value: vec3<f32>,
  pdf: f32,
}

// Return value of `closure_sample`: sampled direction `wi`, solid-angle mixture PDF, cosine-foreshortened `eval`, and lobe type.
struct ClosureSample {
  wi: vec3<f32>,
  pdf: f32,
  eval: vec3<f32>,
  sampled_lobe_type: u32,
}

@group(0) @binding(0) var<uniform> kernel_params: KernelParamsV2;
@group(0) @binding(1) var scene_tlas: acceleration_structure;
@group(0) @binding(2) var<storage, read> instances: array<InstanceRecord>;
@group(0) @binding(3) var<storage, read> triangles: array<TriangleRecord>;
@group(0) @binding(4) var<storage, read> materials: array<MaterialRecord>;
@group(0) @binding(5) var<storage, read> emissive_triangles: array<EmissiveTriangleRecord>;
@group(0) @binding(6) var<storage, read> lights: array<LightRecord>;
@group(0) @binding(7) var<storage, read> light_tree_nodes: array<LightTreeNode>;
@group(0) @binding(8) var<storage, read> texture_descriptors: array<TextureDescriptor>;
@group(0) @binding(9) var<storage, read> texture_texels: array<u32>;
@group(0) @binding(10) var<storage, read> environment_texels: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read_write> film_accumulation: array<vec4<f32>>;
@group(0) @binding(12) var<storage, read> cycles_lut: array<u32>;
@group(0) @binding(13) var<storage, read> light_tree_emitters: array<LightTreeEmitter>;
@group(0) @binding(14) var<storage, read> light_to_tree: array<u32>;

// ---------------------------------------------------------------------------------------------------------------------
// Cross-lane closure interface contract (defined in Lane L4 `src/cycles/closure.wgsl`, called by Lane L3 integrator)
//
// No WGSL stub bodies appear in this header because WGSL forbids bodyless forward declarations and stub implementations
// would collide with Lane L4's definitions when `kernel-manifest.txt` concatenates all modules.
//
// Direction and cosine conventions (matching Cycles `intern/cycles/kernel/closure/bsdf.h`):
// - `wo`: unit vector in world space pointing from `ShadingPoint.position` toward the previous path vertex (`-ray_dir`).
// - `wi`: unit vector in world space pointing from `ShadingPoint.position` toward the light source / next path vertex.
// - `ClosureEval.value` and `ClosureSample.eval` ALREADY include the foreshortening cosine `|dot(N, wi)|`
//   (for example, unit-albedo Lambertian returns `value = vec3<f32>(max(dot(N, wi), 0.0) * INV_PI)` and
//   `pdf = max(dot(N, wi), 0.0) * INV_PI`, so the throughput multiplier on a sampled bounce is `sample.eval / sample.pdf`).
// - `u`: three independent uniform `[0, 1)` random numbers: `u.x` selects the lobe from `closure.lobes[0..closure.lobe_count]`
//   proportional to `Lobe.sample_weight` (and rescales within the selected interval), while `(u.y, u.z)` sample the lobe.
// - When `closure.lobe_count == 0u`, `closure.total_sample_weight <= 0.0`, or the sampled direction is absorbed / invalid,
//   `closure_sample` returns `pdf = 0.0` and `eval = vec3<f32>(0.0)`.
//
// Exact WGSL signatures to be defined by Lane L4 (`src/cycles/closure.wgsl`):
//
//   fn closure_build(point: ptr<function, ShadingPoint>, wo: vec3<f32>) -> Closure
//   fn closure_eval(closure: ptr<function, Closure>, wi: vec3<f32>, wo: vec3<f32>) -> ClosureEval
//   fn closure_sample(closure: ptr<function, Closure>, wo: vec3<f32>, u: vec3<f32>) -> ClosureSample
// ---------------------------------------------------------------------------------------------------------------------
