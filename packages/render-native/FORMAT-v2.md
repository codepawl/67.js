# Native Scene Pack Format v2 (`FORMAT-v2`)

Frozen binary layout shared by the JavaScript v2 scene packer (`pack-input-v2.mjs`), the Rust Vulkan host (`src/host/`), and the Cycles-parity WGSL kernel (`src/cycles/`, starting with [src/cycles/abi.wgsl](./src/cycles/abi.wgsl)).

All integers and IEEE-754 `f32` values are **little-endian**. Every structured record has **16-byte alignment**, zero implicit WGSL padding, and a total byte stride that is an exact multiple of 16 bytes.

## `@group(0)` Binding Layout

| Binding | WGSL Identifier | Kind | Element Type | Stride (B) | Align (B) | Contents |
| ---: | :--- | :--- | :--- | ---: | ---: | :--- |
| `0` | `kernel_params` | `uniform` | `KernelParamsV2` | `320` | `16` | Header, version, camera, bounce limits, clamp, filter, world, volume |
| `1` | `scene_tlas` | `acceleration_structure` | Hardware TLAS | — | — | Top-level acceleration structure over per-mesh BLASes |
| `2` | `instances` | `storage, read` | `InstanceRecord` | `160` | `16` | Per-instance transforms, BLAS/triangle offsets, visibility, light mask |
| `3` | `triangles` | `storage, read` | `TriangleRecord` | `224` | `16` | Object-space mesh triangles (opaque first, then alpha-cutout per BLAS) |
| `4` | `materials` | `storage, read` | `MaterialRecord` | `256` | `16` | Principled BSDF v2 parameters, flags, absorption, texture indices; then, only for a scene with diffuse transmission, one extension record per material |
| `5` | `emissive_triangles` | `storage, read` | `EmissiveTriangleRecord` | `96` | `16` | World-space emissive triangle list for NEE and BSDF-hit MIS |
| `6` | `lights` | `storage, read` | `LightRecord` | `128` | `16` | Analytic lights (`point`, `spot`, `area_rect`, `area_disk`, `sun`) |
| `7` | `light_tree_nodes` | `storage, read` | `LightTreeNode` | `64` | `16` | Orientation-aware light BVH nodes over analytic + emissive emitters |
| `8` | `texture_descriptors` | `storage, read` | `TextureDescriptor` | `32` | `16` | Mipmapped 2D texture headers and UV transforms |
| `9` | `texture_texels` | `storage, read` | `u32` | `4` | `4` | Packed RGBA8 / RGBA32F / RG16F texel words, IES profiles, Sobol tables |
| `10` | `environment_texels` | `storage, read` | `vec4<f32>` | `16` | `16` | Linear HDRI texels followed by marginal/conditional CDF rows |
| `11` | `film_accumulation` | `storage, read_write` | `vec4<f32>` | `16` | `16` | 4 planes of `image_width * image_height` vec4s (radiance+Z, albedo, normal, moments+count) |
| `12` | `cycles_lut` | `storage, read` | `u32` | `4` | `4` | Static LUTs, then the two pixel filter tables |
| `13` | `light_tree_emitters` | `storage, read` | `LightTreeEmitter` | `32` | `16` | Emitters in tree order, leaf by leaf (light tree revision 1, section 7b) |
| `14` | `light_to_tree` | `storage, read` | `u32` | `4` | `4` | Emitter slot of every unified emitter (analytic lights, then emissive triangles) |

---

## 1. Header & Dispatch Uniform — `KernelParamsV2` (`@binding(0)`)

Total size: **320 bytes** (`20 × 16 B`), alignment: **16 bytes**.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `4` | `4` | `u32` | `magic` | Magic word `0x36375054` (`"TP76"` / `67PT` little-endian) |
| `4` | `4` | `4` | `u32` | `format_version` | Format version (`2` for `FORMAT-v2`) |
| `8` | `4` | `4` | `u32` | `image_width` | Film width in pixels |
| `12` | `4` | `4` | `u32` | `image_height` | Film height in pixels |
| `16` | `4` | `4` | `u32` | `sample_offset` | First sample index for the current dispatch |
| `20` | `4` | `4` | `u32` | `samples_per_dispatch` | Samples traced per pixel in one dispatch (`>= 1`) |
| `24` | `4` | `4` | `u32` | `total_samples` | Target total samples per pixel |
| `28` | `4` | `4` | `u32` | `seed` | Deterministic scramble seed |
| `32` | `4` | `4` | `u32` | `kernel_flags` | Bitmask: `1=USE_LIGHT_TREE`, `2=HAS_VOLUME`, `4=HAS_SUBSURFACE`, `8=ORTHOGRAPHIC_CAMERA`, `16=ADAPTIVE_SAMPLING`, `32=TRANSPARENT_BACKGROUND`, `64=WHITE_NOISE_SAMPLER` (bit clear: Cycles' Sobol-Burley blue-noise pattern, the default; bit set: the PCG hash sampler), `128=LIGHT_TREE_PROBE`, `256=TEST_NEE_ONLY`, `512=TEST_BSDF_ONLY` (the last three are for tests), `1024=PATH_REGENERATION`, `2048=TEXTURE_MIPS` (set by the packer when any texture stores mip levels: the kernel then carries a ray cone along each path and reads those levels, see section 8; clear, every texture is read at level 0). Bit `1` is set by the packer from `lightSampling` (`auto` default: tree from more than one emitter; `tree`; `uniform`) and compiles the traversal in or out (`SCENE_HAS_LIGHT_TREE`) |
| `36` | `4` | `4` | `f32` | `adaptive_threshold` | Adaptive stop threshold (`0.0` = disabled) |
| `40` | `4` | `4` | `f32` | `clamp_direct` | Effective direct radiance ceiling at bounce `0` (`0.0` or `>= 1e30` = unclamped; Cycles `sample_clamp_direct * 3.0`) |
| `44` | `4` | `4` | `f32` | `clamp_indirect` | Effective indirect radiance ceiling at bounce `> 0` (`0.0` or `>= 1e30` = unclamped; Cycles `sample_clamp_indirect * 3.0`) |
| `48` | `4` | `4` | `u32` | `max_bounces` | Maximum total path bounces |
| `52` | `4` | `4` | `u32` | `max_diffuse_bounces` | Maximum diffuse bounces |
| `56` | `4` | `4` | `u32` | `max_glossy_bounces` | Maximum glossy specular bounces |
| `60` | `4` | `4` | `u32` | `max_transmission_bounces` | Maximum refractive transmission bounces |
| `64` | `4` | `4` | `u32` | `max_volume_bounces` | Maximum volume scatter bounces |
| `68` | `4` | `4` | `u32` | `max_transparent_bounces` | Maximum straight-through alpha transparent steps |
| `72` | `4` | `4` | `u32` | `min_bounce_rr` | Minimum bounce index before Russian roulette termination |
| `76` | `4` | `4` | `u32` | `filter_type` | Pixel reconstruction filter (`0=box`, `1=gaussian`, `2=blackman_harris`) |
| `80` | `4` | `4` | `f32` | `filter_width` | Filter full width in pixels (`1.0` box, `1.5` Cycles default Blackman-Harris) |
| `84` | `4` | `4` | `u32` | `instance_count` | Number of entries in `instances` |
| `88` | `4` | `4` | `u32` | `triangle_count` | Number of entries in `triangles` |
| `92` | `4` | `4` | `u32` | `material_count` | Number of entries in `materials` |
| `96` | `4` | `4` | `u32` | `emissive_triangle_count` | Number of entries in `emissive_triangles` |
| `100` | `4` | `4` | `u32` | `light_count` | Number of entries in `lights` |
| `104` | `4` | `4` | `u32` | `light_tree_node_count` | Number of entries in `light_tree_nodes` |
| `108` | `4` | `4` | `u32` | `texture_count` | Number of entries in `texture_descriptors` |
| `112` | `12` | `16` | `vec3<f32>` | `camera_position` | World-space camera origin |
| `124` | `4` | `4` | `f32` | `camera_near` | Near clip distance in metres |
| `128` | `12` | `16` | `vec3<f32>` | `camera_forward` | Unit world-space forward direction |
| `140` | `4` | `4` | `f32` | `camera_far` | Far clip distance in metres |
| `144` | `12` | `16` | `vec3<f32>` | `camera_right` | Scaled horizontal sensor half-extent vector in world space |
| `156` | `4` | `4` | `f32` | `aperture_radius` | Thin-lens aperture radius in metres (`0.0` = pinhole) |
| `160` | `12` | `16` | `vec3<f32>` | `camera_up` | Scaled vertical sensor half-extent vector in world space |
| `172` | `4` | `4` | `f32` | `focal_distance` | Thin-lens focus distance in metres along `camera_forward` |
| `176` | `8` | `8` | `vec2<f32>` | `lens_shift` | Sensor shift `(shift_x, shift_y)` in normalized sensor units |
| `184` | `4` | `4` | `u32` | `aperture_blades` | Polygonal bokeh blade count (`0` = circular disk, `>= 3` = polygon) |
| `188` | `4` | `4` | `f32` | `aperture_rotation` | Bokeh diaphragm rotation in radians |
| `192` | `4` | `4` | `u32` | `env_width` | Equirectangular HDRI width (`0` = constant `env_color` only) |
| `196` | `4` | `4` | `u32` | `env_height` | Equirectangular HDRI height |
| `200` | `4` | `4` | `u32` | `env_cdf_offset` | `vec4<f32>` index in `environment_texels` where CDF tables start |
| `204` | `4` | `4` | `f32` | `env_rotation` | HDRI azimuth rotation in radians |
| `208` | `12` | `16` | `vec3<f32>` | `env_color` | Background linear RGB radiance / HDRI multiplier |
| `220` | `4` | `4` | `f32` | `env_total_weight` | Total integrated HDRI weight (`luminance * sin(theta) * d_omega`) |
| `224` | `12` | `16` | `vec3<f32>` | `volume_bounds_min` | World AABB minimum of homogeneous fog volume |
| `236` | `4` | `4` | `f32` | `volume_density` | Extinction density `sigma_t` (`0.0` = no world volume) |
| `240` | `12` | `16` | `vec3<f32>` | `volume_bounds_max` | World AABB maximum of homogeneous fog volume |
| `252` | `4` | `4` | `f32` | `volume_anisotropy` | Henyey-Greenstein phase `g` in `[-0.99, 0.99]` |
| `256` | `12` | `16` | `vec3<f32>` | `volume_albedo` | Single-scatter RGB albedo of homogeneous fog |
| `268` | `4` | `4` | `f32` | `emissive_total_weight` | Sum of `EmissiveTriangleRecord.selection_weight` |
| `272` | `4` | `4` | `f32` | `analytic_light_total_weight` | Sum of analytic light selection weights |
| `276` | `4` | `4` | `f32` | `ray_epsilon` | Ray origin offset scale (default `1e-4`) |
| `280` | `4` | `4` | `u32` | `adaptive_min_samples` | Minimum samples before adaptive convergence checks |
| `284` | `4` | `4` | `u32` | `ies_table_offset` | Word offset into `texture_texels` for packed IES profiles |
| `288` | `4` | `4` | `f32` | `film_exposure` | Linear exposure multiplier applied on film accumulation (default `1.0`) |
| `292` | `4` | `4` | `f32` | `background_mis_weight` | `1.0` when environment MIS is active, `0.0` otherwise |
| `296` | `4` | `4` | `u32` | `sobol_table_offset` | Word offset into `texture_texels` for Sobol / blue-noise tables |
| `300` | `4` | `4` | `f32` | `filter_glossy` | Cycles Filter Glossy (`blur_glossy`) factor (`0.0` = off, default `1.0`) |
| `304` | `16` | `16` | `vec4<u32>` | `reserved_tail` | Reserved (`[0, 0, 0, 0]`) |

The four thin-lens words (`aperture_radius`, `focal_distance`, `aperture_blades`, `aperture_rotation`, bytes 156, 172, 184 and 188) are set by `resolveThinLensParameters` in `pack-input-v2.mjs`, from the camera object that `createCamera` returns for a camera with an `fStop` (or from `options.apertureRadius`, `focalDistance`, `apertureBlades`, `apertureRotation`). A pinhole writes `0`, `10`, `0` and `0`, as before, so its params bytes do not change. Cycles' model: the aperture radius is `focal length (mm) / 1000 / (2 * f-stop)`, a point on the lens (a disk, or a regular polygon of `aperture_blades` corners turned by `aperture_rotation`) is the ray origin, and the ray goes through the point that lies `focal_distance` along `camera_forward` from the pinhole ray (the focus distance is measured on the view axis, not along the ray). The lens sample is the kernel's existing `lens_uv` draw, taken for every sample whether or not the aperture is 0, so depth of field does not move any other random number. A FORMAT-v1 input carries the same four values in the unused fourth float of the eye, forward, right and above vectors (floats 3, 7, 11 and 15 of the 64-float block); the legacy kernel ignores them and `upgradeNativeInputV1ToV2` reads them back.

---

## 2. Instance Table — `InstanceRecord` (`@binding(2)`)

Total stride: **160 bytes** (`10 × 16 B`), alignment: **16 bytes**. Indexed by `ray_query` `intersection.instance_custom_data` (or `instance_index`).

Both 3×4 affine transforms are stored as three row vectors `row0..row2`: transforming an object-space point `p` computes `vec3(dot(row0.xyz, p) + row0.w, dot(row1.xyz, p) + row1.w, dot(row2.xyz, p) + row2.w)`. Object-space normals transform by the transpose of the upper-left 3×3 of `world_to_object` (`n_world = normalize(n.x * w2o_row0.xyz + n.y * w2o_row1.xyz + n.z * w2o_row2.xyz)`).

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `16` | `16` | `vec4<f32>` | `object_to_world_row0` | Affine row 0 `[m00, m01, m02, tx]` (matches `wgpu::TlasInstance` row 0) |
| `16` | `16` | `16` | `vec4<f32>` | `object_to_world_row1` | Affine row 1 `[m10, m11, m12, ty]` |
| `32` | `16` | `16` | `vec4<f32>` | `object_to_world_row2` | Affine row 2 `[m20, m21, m22, tz]` |
| `48` | `16` | `16` | `vec4<f32>` | `world_to_object_row0` | Inverse affine row 0 `[im00, im01, im02, itx]` |
| `64` | `16` | `16` | `vec4<f32>` | `world_to_object_row1` | Inverse affine row 1 `[im10, im11, im12, ity]` |
| `80` | `16` | `16` | `vec4<f32>` | `world_to_object_row2` | Inverse affine row 2 `[im20, im21, im22, itz]` |
| `96` | `4` | `4` | `u32` | `blas_index` | Mesh BLAS index in the host acceleration pool |
| `100` | `4` | `4` | `u32` | `triangle_offset` | Base index into `triangles` for this mesh's primitives |
| `104` | `4` | `4` | `u32` | `opaque_triangle_count` | Count of opaque primitives in BLAS geometry `0`; cutout geometry `1` starts at `triangle_offset + opaque_triangle_count` |
| `108` | `4` | `4` | `u32` | `total_triangle_count` | Total primitives (`opaque + cutout`) in this mesh BLAS |
| `112` | `4` | `4` | `u32` | `material_override` | Override material index (e.g. clay pass), or `0xFFFFFFFF` to use `TriangleRecord.material_index` |
| `116` | `4` | `4` | `u32` | `visibility_flags` | Bitmask: `1=CAMERA`, `2=DIFFUSE`, `4=GLOSSY`, `8=TRANSMISSION`, `16=SHADOW`, `32=VOLUME_SCATTER`, `64=NEGATIVE_SCALE` (`det(M) < 0`) |
| `120` | `4` | `4` | `u32` | `light_group_mask_lo` | Low 32 bits of 64-bit receiver light-linking mask (default `0xFFFFFFFF`) |
| `124` | `4` | `4` | `u32` | `light_group_mask_hi` | High 32 bits of 64-bit receiver light-linking mask (default `0xFFFFFFFF`) |
| `128` | `4` | `4` | `u32` | `emissive_base_offset` | Base index in `emissive_triangles` for this instance, or `0xFFFFFFFF` if non-emissive |
| `132` | `4` | `4` | `u32` | `object_id` | Cycles Object Info `Object Index` |
| `136` | `4` | `4` | `f32` | `object_random` | Deterministic `[0, 1)` per-instance Object Info `Random` hash |
| `140` | `4` | `4` | `f32` | `shadow_terminator_offset` | Cycles shadow terminator normal shift in `[0, 1)` |
| `144` | `16` | `16` | `vec4<f32>` | `object_color` | Cycles Object Info linear RGBA colour |

---

## 3. Object-Space Mesh Triangles — `TriangleRecord` (`@binding(3)`)

Total stride: **224 bytes** (`14 × 16 B`), alignment: **16 bytes**. Within each mesh BLAS slice (`triangle_offset .. triangle_offset + total_triangle_count`), opaque triangles occupy `[0 .. opaque_triangle_count)` (BLAS geometry `0`) and alpha-cutout triangles occupy `[opaque_triangle_count .. total_triangle_count)` (BLAS geometry `1`, when `opaque_triangle_count > 0`; otherwise geometry `0`).

When `InstanceRecord.emissive_base_offset != 0xFFFFFFFF` and `TriangleRecord.local_emissive_offset != 0xFFFFFFFF`, the world-space `EmissiveTriangleRecord` for MIS is at `emissive_base_offset + local_emissive_offset`.

**Sharing rules.** Instances that share a mesh share one slice of `triangles` (one BLAS, one `triangle_offset`), so everything in a `TriangleRecord` is the same for every copy. What can differ per copy lives in the `InstanceRecord`: the transform, `material_override`, `visibility_flags`, the light masks, the object id, random and colour, and `emissive_base_offset`. The packer applies these rules:

- Parts whose `MaterialRecord` bytes are equal (and that derive the same emission) share one record: `material_count` counts distinct records, a copy needs a `material_override` only when its record differs from the first copy's, and every `material_index` (triangle, override, emissive entry) names the shared record. A session update that makes shared parts differ changes `material_count` and is refused.
- A mesh with per-triangle materials is not shared; its triangles are baked into world space and traced with an identity transform.
- `local_emissive_offset` counts the triangles that keep an area after an instance's transform, in triangle order, and is the same for every copy. A copy that would emit a different set of triangles is refused. A copy whose resolved material is not emissive gets `emissive_base_offset = 0xFFFFFFFF`, so its triangles never index the emissive list.
- A shadow-only copy clears the camera bit of `visibility_flags` and keeps the others. A mirrored copy (negative determinant) sets the negative-scale bit.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `12` | `16` | `vec3<f32>` | `p0` | Object-space vertex 0 position |
| `12` | `4` | `4` | `u32` | `material_index` | Default `MaterialRecord` index |
| `16` | `12` | `16` | `vec3<f32>` | `edge1` | Object-space `p1 - p0` |
| `28` | `4` | `4` | `u32` | `local_emissive_offset` | Offset from `InstanceRecord.emissive_base_offset`, or `0xFFFFFFFF` |
| `32` | `12` | `16` | `vec3<f32>` | `edge2` | Object-space `p2 - p0` |
| `44` | `4` | `4` | `u32` | `flags` | Bitmask: `1=SMOOTH_NORMALS`, `2=HAS_VERTEX_COLORS`, `4=HAS_UV1`, `8=HAS_TANGENTS`, `16=DOUBLE_SIDED` |
| `48` | `12` | `16` | `vec3<f32>` | `n0` | Object-space vertex 0 normal |
| `60` | `4` | `4` | `f32` | `uv0_u` | Primary UV0 `u` at vertex 0 |
| `64` | `12` | `16` | `vec3<f32>` | `n1` | Object-space vertex 1 normal |
| `76` | `4` | `4` | `f32` | `uv0_v` | Primary UV0 `v` at vertex 0 |
| `80` | `12` | `16` | `vec3<f32>` | `n2` | Object-space vertex 2 normal |
| `92` | `4` | `4` | `f32` | `uv1_u` | Primary UV0 `u` at vertex 1 |
| `96` | `12` | `16` | `vec3<f32>` | `tangent0` | Object-space vertex 0 tangent |
| `108` | `4` | `4` | `f32` | `uv1_v` | Primary UV0 `v` at vertex 1 |
| `112` | `12` | `16` | `vec3<f32>` | `tangent1` | Object-space vertex 1 tangent |
| `124` | `4` | `4` | `f32` | `uv2_u` | Primary UV0 `u` at vertex 2 |
| `128` | `12` | `16` | `vec3<f32>` | `tangent2` | Object-space vertex 2 tangent |
| `140` | `4` | `4` | `f32` | `uv2_v` | Primary UV0 `v` at vertex 2 |
| `144` | `12` | `16` | `vec3<f32>` | `color0` | Linear RGB vertex colour at vertex 0 |
| `156` | `4` | `4` | `f32` | `tangent_sign` | Bitangent handedness (`+1.0` or `-1.0`) |
| `160` | `12` | `16` | `vec3<f32>` | `color1` | Linear RGB vertex colour at vertex 1 |
| `172` | `4` | `4` | `u32` | `mesh_id` | Mesh identifier |
| `176` | `12` | `16` | `vec3<f32>` | `color2` | Linear RGB vertex colour at vertex 2 |
| `188` | `4` | `4` | `u32` | `primitive_id` | Original mesh primitive index |
| `192` | `8` | `8` | `vec2<f32>` | `uv_set1_0` | Secondary UV1 (`UV2`) at vertex 0 |
| `200` | `8` | `8` | `vec2<f32>` | `uv_set1_1` | Secondary UV1 (`UV2`) at vertex 1 |
| `208` | `8` | `8` | `vec2<f32>` | `uv_set1_2` | Secondary UV1 (`UV2`) at vertex 2 |
| `216` | `4` | `4` | `u32` | `attribute_offset` | Optional custom attribute word offset in `texture_texels`, or `0xFFFFFFFF` |
| `220` | `4` | `4` | `u32` | `reserved_u0` | Reserved (`0`) |

---

## 4. Material Table (Principled BSDF v2) — `MaterialRecord` (`@binding(4)`)

Total stride: **256 bytes** (`16 × 16 B`), alignment: **16 bytes**.

Includes all Principled BSDF v2 fields needed for Cycles parity:
- **Multiscatter GGX**: bit `0` (`MATERIAL_FLAG_MULTISCATTER_GGX = 1`) in `flags` (offset `192`).
- **Conductor F82-tint & dielectric specular tint**: `f82_tint` (`vec3<f32>` at offset `32`) plus `MATERIAL_FLAG_F82_METALLIC` (`32`).
- **Surface anisotropy**: `anisotropy` (`f32` at offset `44`), `anisotropy_rotation` (`f32` at offset `48`), `anisotropy_tex` (`i32` at offset `244`).
- **Clearcoat with tint**: `coat_tint` (`vec3<f32>` at offset `64`), `coat_weight` (`f32` at offset `76`), `coat_roughness` (`f32` at offset `80`), `coat_ior` (`f32` at offset `84`).
- **Thin-film iridescence**: `thin_film_thickness` (`f32` nm at offset `88`), `thin_film_ior` (`f32` at offset `92`).
- **Microfiber sheen**: `sheen_tint` (`vec3<f32>` at offset `96`), `sheen_weight` (`f32` at offset `108`), `sheen_roughness` (`f32` at offset `176`).
- **Beer-Lambert volume absorption**: `absorption_color` (`vec3<f32>` at offset `112`) and `absorption_distance` (`f32` metres at offset `124`; when `> 0`, `sigma_a = -ln(max(absorption_color, vec3(1e-6))) / absorption_distance`).

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `12` | `16` | `vec3<f32>` | `base_color` | Linear RGB base albedo `[0, 1]` |
| `12` | `4` | `4` | `f32` | `metallic` | Metallic weight `[0, 1]` |
| `16` | `4` | `4` | `f32` | `roughness` | Perceptual specular roughness `[0, 1]` |
| `20` | `4` | `4` | `f32` | `ior` | Base dielectric index of refraction (default `1.5`) |
| `24` | `4` | `4` | `f32` | `specular_ior_level` | Cycles Specular IOR Level (`0.5` = unscaled dielectric Fresnel) |
| `28` | `4` | `4` | `f32` | `diffuse_roughness` | Oren-Nayar / Principled v2 diffuse roughness `[0, 1]` |
| `32` | `12` | `16` | `vec3<f32>` | `f82_tint` | Conductor F82 grazing tint / dielectric specular tint RGB (default `[1, 1, 1]`) |
| `44` | `4` | `4` | `f32` | `anisotropy` | Microfacet aspect anisotropy `[0, 1]` |
| `48` | `4` | `4` | `f32` | `anisotropy_rotation` | Tangent rotation in `[0, 1)` turns (`* 2 * pi` radians) |
| `52` | `4` | `4` | `f32` | `transmission_weight` | Dielectric refractive transmission weight `[0, 1]` |
| `56` | `4` | `4` | `f32` | `alpha` | Base opacity `[0, 1]` (default `1.0`) |
| `60` | `4` | `4` | `f32` | `alpha_cutoff` | Alpha-mask threshold `[0, 1]` (`0.0` if `alpha_mode != MASK`) |
| `64` | `12` | `16` | `vec3<f32>` | `coat_tint` | Clearcoat transmission tint RGB (default `[1, 1, 1]`) |
| `76` | `4` | `4` | `f32` | `coat_weight` | Clearcoat layer weight `[0, 1]` |
| `80` | `4` | `4` | `f32` | `coat_roughness` | Clearcoat perceptual roughness `[0, 1]` |
| `84` | `4` | `4` | `f32` | `coat_ior` | Clearcoat IOR (default `1.5`) |
| `88` | `4` | `4` | `f32` | `thin_film_thickness` | Thin-film thickness in nanometres (`0.0` = disabled) |
| `92` | `4` | `4` | `f32` | `thin_film_ior` | Thin-film refractive index (default `1.33`) |
| `96` | `12` | `16` | `vec3<f32>` | `sheen_tint` | Principled v2 sheen RGB tint (default `[1, 1, 1]`) |
| `108` | `4` | `4` | `f32` | `sheen_weight` | Sheen layer weight `[0, 1]` |
| `112` | `12` | `16` | `vec3<f32>` | `absorption_color` | Beer-Lambert transmitted RGB colour at `absorption_distance` |
| `124` | `4` | `4` | `f32` | `absorption_distance` | Beer-Lambert reference distance in metres (`0.0` = no interior absorption) |
| `128` | `12` | `16` | `vec3<f32>` | `emission_color` | Linear RGB emission colour |
| `140` | `4` | `4` | `f32` | `emission_strength` | Emission radiance multiplier in `W/(sr·m²)` |
| `144` | `12` | `16` | `vec3<f32>` | `subsurface_radius` | Scaled RGB subsurface mean free path in metres |
| `156` | `4` | `4` | `f32` | `subsurface_weight` | Subsurface scattering blend weight `[0, 1]` |
| `160` | `12` | `16` | `vec3<f32>` | `subsurface_color` | Subsurface scattering RGB albedo |
| `172` | `4` | `4` | `f32` | `subsurface_anisotropy` | Subsurface phase anisotropy `[-0.9, 0.9]` |
| `176` | `4` | `4` | `f32` | `sheen_roughness` | Principled v2 microfiber sheen roughness `[0, 1]` |
| `180` | `4` | `4` | `f32` | `subsurface_ior` | Subsurface boundary IOR (default `1.4`) |
| `184` | `4` | `4` | `f32` | `normal_scale` | Base normal map strength (default `1.0`) |
| `188` | `4` | `4` | `f32` | `coat_normal_scale` | Clearcoat normal map strength (default `1.0`) |
| `192` | `4` | `4` | `u32` | `flags` | Bitmask: `1=MULTISCATTER_GGX`, `2=THIN_WALLED`, `4=TRANSPARENT_SHADOW`, `8=DOUBLE_SIDED`, `16=EMISSIVE_MIS`, `32=F82_METALLIC`, `64=HAS_SHADER_GRAPH` |
| `196` | `4` | `4` | `u32` | `alpha_mode` | `0=OPAQUE`, `1=MASK`, `2=BLEND` |
| `200` | `4` | `4` | `f32` | `bump_distance` | Height-map bump world scale in metres (`0.0` = disabled) |
| `204` | `4` | `4` | `u32` | `svm_node_offset` | Shader graph bytecode word offset, or `0xFFFFFFFF` |
| `208` | `4` | `4` | `i32` | `base_color_tex` | `TextureDescriptor` index, or `-1` |
| `212` | `4` | `4` | `i32` | `metallic_roughness_tex` | `TextureDescriptor` index (G = roughness, B = metallic), or `-1` |
| `216` | `4` | `4` | `i32` | `normal_tex` | `TextureDescriptor` index, or `-1` |
| `220` | `4` | `4` | `i32` | `emission_tex` | `TextureDescriptor` index, or `-1` |
| `224` | `4` | `4` | `i32` | `transmission_tex` | `TextureDescriptor` index, or `-1` |
| `228` | `4` | `4` | `i32` | `coat_weight_roughness_tex` | `TextureDescriptor` index, or `-1` |
| `232` | `4` | `4` | `i32` | `coat_tint_tex` | `TextureDescriptor` index, or `-1` |
| `236` | `4` | `4` | `i32` | `coat_normal_tex` | `TextureDescriptor` index, or `-1` |
| `240` | `4` | `4` | `i32` | `sheen_color_roughness_tex` | `TextureDescriptor` index, or `-1` |
| `244` | `4` | `4` | `i32` | `anisotropy_tex` | `TextureDescriptor` index, or `-1` |
| `248` | `4` | `4` | `i32` | `alpha_tex` | `TextureDescriptor` index, or `-1` |
| `252` | `4` | `4` | `i32` | `bump_tex` | `TextureDescriptor` index, or `-1` |

### Material extension records (diffuse transmission)

The record above has no free word, so a field added later does not change its stride. A scene whose materials use **diffuse transmission** (a thin sheet that lets diffuse light through, such as a curtain, a leaf or a lampshade) appends a second run of `material_count` records of the same 256 bytes to the `materials` buffer: extension record `m` sits at record index `material_count + m`, and `material_count` in the header still counts the first run only. A scene without it sends the buffer it always did (`material_count` records), so its tables are byte-identical to a build without the feature. The host tells the two apart by the buffer length (`>= 2 * material_count * 256`), and the kernel's `SCENE_HAS_DIFFUSE_TRANSMISSION` constant is rewritten to `false` for the rest, so their pipelines contain none of the code.

Only three words of an extension record are read; the others are `0`:

| Byte Offset | WGSL Type | Field (name of the word it reuses) | Description |
| ---: | :--- | :--- | :--- |
| `0` | `vec3<f32>` | `base_color` | Linear RGB colour of the light that leaves through the far side |
| `12` | `f32` | `metallic` | Diffuse transmission weight `[0, 1]`: the share of the diffuse layer that goes to the far side |
| `192` | `u32` | `flags` | `1=TINTS_BASE_COLOR`: the colour multiplies the base colour of the shading point (a map or a vertex colour included) instead of replacing it; the packer sets it when the material gives no `diffuseTransmissionColor` |

The kernel splits the diffuse layer at the weight `w`: the reflecting diffuse lobe keeps `(1 - w)` of its weight and a `LOBE_DIFFUSE_TRANSMISSION` lobe takes `w * colour` times the same layer weight, so the specular layers above the diffuse keep their strength. The lobe is a cosine lobe on the side of the shading normal away from the viewer, with value and pdf `cos / pi` (Cycles' Translucent BSDF); a sample must also leave through the far side of the geometric normal. A sample of it counts as a transmission bounce and leaves the medium of the path alone, and the light tree and the MIS pdf of the previous bounce treat the shading point as transmissive. The weight is read as `diffuseTransmission` and the colour as `diffuseTransmissionColor` on a part's material (`job-input.mjs` checks the ranges: a number from `0` to `1`, three numbers from `0` to `1`).

---

## 5. Emissive Triangle List — `EmissiveTriangleRecord` (`@binding(5)`)

Total stride: **96 bytes** (`6 × 16 B`), alignment: **16 bytes**.

Stored in **world space** (one entry per emissive `(instance, triangle)` pair) so NEE area/solid-angle sampling, light-tree bounds, and BSDF-hit MIS PDF evaluation require no per-sample matrix transforms.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `12` | `16` | `vec3<f32>` | `p0` | World-space vertex 0 |
| `12` | `4` | `4` | `f32` | `area` | World-space surface area `0.5 * length(cross(edge1, edge2))` in `m²` (`> 0`) |
| `16` | `12` | `16` | `vec3<f32>` | `edge1` | World-space `p1 - p0` |
| `28` | `4` | `4` | `u32` | `instance_index` | Owning `InstanceRecord` index |
| `32` | `12` | `16` | `vec3<f32>` | `edge2` | World-space `p2 - p0` |
| `44` | `4` | `4` | `u32` | `triangle_index` | Owning `TriangleRecord` index |
| `48` | `12` | `16` | `vec3<f32>` | `geometric_normal` | Unit world-space outward geometric normal (flipped when `NEGATIVE_SCALE` is set) |
| `60` | `4` | `4` | `u32` | `material_index` | Resolved `MaterialRecord` index |
| `64` | `12` | `16` | `vec3<f32>` | `radiance` | Emitted linear RGB radiance in `W/(sr·m²)` (mean radiance if textured) |
| `76` | `4` | `4` | `f32` | `selection_weight` | Unnormalized importance weight (`luminance(radiance) * area`) |
| `80` | `4` | `4` | `f32` | `selection_pdf` | Discrete flat-table selection probability in `(0, 1]` |
| `84` | `4` | `4` | `f32` | `cdf_upper` | Inclusive cumulative probability in `(0, 1]` for binary search |
| `88` | `4` | `4` | `u32` | `light_group_mask_lo` | Low 32 bits of 64-bit emitter light-linking mask |
| `92` | `4` | `4` | `u32` | `light_group_mask_hi` | High 32 bits of 64-bit emitter light-linking mask |

---

## 6. Analytic Light Table — `LightRecord` (`@binding(6)`)

Total stride: **128 bytes** (`8 × 16 B`), alignment: **16 bytes**.

Convention: `direction` is always the **unit emission direction pointing from the emitter into the scene** (spot cone axis, area light front normal, and sun ray travel direction; rays toward the sun trace along `-direction`).

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `12` | `16` | `vec3<f32>` | `position` | World-space centre (`point`, `spot`, `area_rect`, `area_disk`; unused for `sun`) |
| `12` | `4` | `4` | `u32` | `light_type` | `0=point`, `1=spot`, `2=area_rect`, `3=area_disk`, `4=sun` |
| `16` | `12` | `16` | `vec3<f32>` | `radiance` | Emitted linear RGB radiance (`W/(sr·m²)` for finite-area/sun, intensity `W/sr` when `radius == 0`) |
| `28` | `4` | `4` | `u32` | `flags` | Bitmask: `1=CAST_SHADOW`, `2=MULTIPLE_IMPORTANCE`, `4=CAMERA_VISIBLE`, `8=PORTAL`, `16=NORMALIZE` |
| `32` | `12` | `16` | `vec3<f32>` | `direction` | Unit world-space emission direction |
| `44` | `4` | `4` | `f32` | `radius` | Sphere radius in metres for `point` / `spot` (`0.0` = delta emitter) |
| `48` | `12` | `16` | `vec3<f32>` | `axis_u` | Unit tangent axis U for area / IES orientation |
| `60` | `4` | `4` | `f32` | `size_u` | Full width in metres (`area_rect`) or major diameter (`area_disk`) |
| `64` | `12` | `16` | `vec3<f32>` | `axis_v` | Unit bitangent axis V (`cross(direction, axis_u)`) |
| `76` | `4` | `4` | `f32` | `size_v` | Full height in metres (`area_rect`) or minor diameter (`area_disk`) |
| `80` | `4` | `4` | `f32` | `cos_half_angle` | `cos(spot_size * 0.5)` for `spot`; `cos(sun_angle * 0.5)` for `sun` |
| `84` | `4` | `4` | `f32` | `spot_blend` | Cycles spot softness blend `[0, 1]` |
| `88` | `4` | `4` | `f32` | `tan_half_spread` | `tan(spread * 0.5)` for Cycles area beam spread |
| `92` | `4` | `4` | `f32` | `spread_normalization` | Cycles area beam spread normalization multiplier |
| `96` | `4` | `4` | `f32` | `area_or_solid_angle` | Emitter surface area (`m²`) or sun solid angle `2 * pi * (1 - cos_half_angle)` (`sr`) |
| `100` | `4` | `4` | `f32` | `max_distance` | Maximum influence distance in metres (`>= 1e30` = infinite) |
| `104` | `4` | `4` | `i32` | `ies_profile_index` | IES photometric profile index, or `-1` |
| `108` | `4` | `4` | `u32` | `tree_leaf_index` | Owning `LightTreeNode` leaf index, or `0xFFFFFFFF` |
| `112` | `4` | `4` | `f32` | `selection_pdf` | Discrete flat-table selection probability in `(0, 1]` |
| `116` | `4` | `4` | `f32` | `cdf_upper` | Inclusive cumulative probability in `(0, 1]` |
| `120` | `4` | `4` | `u32` | `light_group_mask_lo` | Low 32 bits of 64-bit emitter light-linking mask |
| `124` | `4` | `4` | `u32` | `light_group_mask_hi` | High 32 bits of 64-bit emitter light-linking mask |

---

## 7. Light Tree Nodes — `LightTreeNode` (`@binding(7)`)

Total stride: **64 bytes** (`4 × 16 B`), alignment: **16 bytes**.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `12` | `16` | `vec3<f32>` | `bounds_min` | World AABB minimum of emitters in subtree |
| `12` | `4` | `4` | `f32` | `energy` | Total radiant flux proxy of subtree |
| `16` | `12` | `16` | `vec3<f32>` | `bounds_max` | World AABB maximum of emitters in subtree |
| `28` | `4` | `4` | `f32` | `theta_o` | Orientation cone axis half-angle `[0, pi]` |
| `32` | `12` | `16` | `vec3<f32>` | `cone_axis` | Unit orientation cone axis |
| `44` | `4` | `4` | `f32` | `theta_e` | Emission spread half-angle `[0, pi]` |
| `48` | `4` | `4` | `i32` | `left_child` | Left child index when `>= 0`; `< 0` marks a leaf node |
| `52` | `4` | `4` | `u32` | `right_or_first_emitter` | Right child index (internal) or first emitter index (leaf) |
| `56` | `4` | `4` | `u32` | `emitter_count_and_kind` | Bits `0..15`: leaf count; bit `16`: `0=LightRecord`, `1=EmissiveTriangleRecord`; bit `17`: distant subtree |
| `60` | `4` | `4` | `u32` | `light_group_mask_or` | Bitwise OR of subtree low-32 light-linking masks |

Light tree revision 1 (`LIGHT_TREE_REVISION` in `light-tree-v2.mjs`; `schemaVersion` stays `2` because the tables only add data) fills this table from `buildLightTree`, a translation of the build half of Cycles 5.3 `scene/light_tree.cpp`:

- **Shape.** Node 0 is the root and children are written in pre-order, so a left child is its parent index plus 1. With sun lights and local emitters (analytic lights other than the sun, plus emissive triangles) the root is an inner node: left child the local tree, right child one distant leaf holding every sun light, as Cycles does. With only one kind the root is that tree or that leaf. The environment is not an emitter of this tree. With no emitters `light_tree_node_count` is `0` and the buffer holds one zeroed node.
- **Split.** Top-down surface area orientation heuristic: 12 centroid buckets per axis, cost `energy * box area * cone measure` (`area == 0` uses the box diagonal), regularized by `max_extent / extent`. A node splits while a split is cheaper than a leaf or while it holds more than 8 emitters; a split with no cheaper cut falls back to the middle of the list. From depth 24 on nodes split by count, which bounds the depth at 46 so a 64-bit trail always fits. Leaves list their emitters in unified-index order. Emitters are sorted by centroid with the unified index as tie break, so the output is deterministic.
- **Counts.** At most `4194304` emitters (`LIGHT_TREE_MAX_EMITTERS`) and `32` emitters per leaf (`LIGHT_TREE_KERNEL_MAX_LEAF_EMITTERS`, the most the kernel reads from one leaf; only the distant leaf can hold more than `8`, so `buildLightTree` throws for more than `32` sun or distant lights).
- **Node fields.** `energy` is the sum of the children's energies (leaf: the sum of its emitters). `bounds_*` is the union of the emitters' boxes with energy above zero; a distant leaf and a zero-energy node store `0`. `theta_o`, `cone_axis`, `theta_e` are the merged bounding cone (Cycles `merge`). Internal node: `left_child >= 0`, `right_or_first_emitter` is the right child. Leaf: `left_child == -1`, `right_or_first_emitter` is the first slot in `light_tree_emitters` and bits `0..15` of `emitter_count_and_kind` are the emitter count. Higher bits of that word: bit `16` the subtree has an emissive triangle, bit `17` it is the distant leaf, bit `18` it has an analytic light (internal nodes OR their children's bits, so a mixed leaf sets both 16 and 18; the per-emitter kind in section 7b is authoritative).
- **Emitter energy.** Emissive triangle `area * mean(|radiance|)`. Area light `mean(|radiance|) * area`. Point and spot `mean(|radiance|)` for a delta light, `mean(|radiance|) * pi * radius^2` otherwise. Sun `mean(|radiance|) * solid_angle`.
- **Emitter cone.** Point `axis = direction, theta_o = pi, theta_e = pi/2`. Spot `theta_o = 0, theta_e = min(pi/2, acos(cos_half_angle))`. Area `theta_o = 0, theta_e = atan(tan_half_spread)` (`pi/2` for the default spread). Sun `theta_o = 0, theta_e = acos(cos_half_angle)`. Emissive triangle: the kernel emits from both sides, so the double-sided cone of Cycles, an in-plane axis with `theta_o = theta_e = pi/2`.
- **Boxes.** Point and spot: position plus or minus the radius. Area: the four corners of the rectangle (also for disks, as Cycles does). Triangle: its three vertices.
- Each `LightRecord.tree_leaf_index` (section 6) holds the node index of the leaf that owns the light.

## 7b. Light Tree Emitters — `LightTreeEmitter` (`@binding(13)`) and `light_to_tree` (`@binding(14)`)

`LightTreeEmitter` stride: **32 bytes**, alignment 16 bytes. Slots are in tree order, so the emitters of a leaf are contiguous. Unified emitter index `i` is an analytic light for `i < light_count` and emissive triangle `i - light_count` otherwise; `light_to_tree[i]` is its slot. Both tables are optional in the napi input (`lightTreeEmitters`, `lightTreeEmitterCount`, `lightToTree` come together or not at all); without them the host binds a zeroed record. With `USE_LIGHT_TREE` set the kernel (`light_tree.wgsl`, a translation of Cycles `kernel/light/tree.h`) picks one emitter per surface bounce by walking the nodes from the root with one random number, and finds the probability of a given emitter with `bit_trail_low/high` and `kind_and_depth` for the MIS weight of a BSDF-sampled hit. The environment map keeps its own importance sample and is not part of the tree.

| Byte Offset | Size (B) | WGSL Type | Field | Description |
| ---: | ---: | :--- | :--- | :--- |
| `0` | `4` | `f32` | `energy` | Emitter energy as above |
| `4` | `4` | `f32` | `theta_o` | Emitter cone `theta_o` |
| `8` | `4` | `f32` | `theta_e` | Emitter cone `theta_e` |
| `12` | `4` | `u32` | `kind_and_depth` | Bit `0` emissive triangle, bit `1` distant, bits `8..15` leaf depth (number of valid trail bits) |
| `16` | `4` | `u32` | `record_index` | Index into `lights` or `emissive_triangles` |
| `20` | `4` | `u32` | `leaf_node_index` | Owning leaf node |
| `24` | `4` | `u32` | `bit_trail_low` | Trail bits `0..31`: bit `d` is set where the path from the root goes right at depth `d` |
| `28` | `4` | `u32` | `bit_trail_high` | Trail bits `32..63` |

The emitter cone axis is not stored: it is the `direction` of the light, or the in-plane axis `-normalize(edge1)` of a triangle.

---

## 8. Texture Descriptors — `TextureDescriptor` (`@binding(8)`)

Total stride: **32 bytes** (`2 × 16 B`), alignment: **16 bytes**.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `4` | `16` | `u32` | `data_offset` | Base `u32` word offset in `texture_texels` (`@binding(9)`, `@align(16)`) |
| `4` | `4` | `4` | `u32` | `width` | Mip `0` width in texels |
| `8` | `4` | `4` | `u32` | `height` | Mip `0` height in texels |
| `12` | `4` | `4` | `u32` | `format_and_sampler` | Bits `0..7`: `0=RGBA8_UNORM`, `1=RGBA8_SRGB`, `2=RGBA32_FLOAT`, `3=RG16_FLOAT`; bits `8..15`: mip count (levels stored, level `0` included; `1` means level `0` only); bits `16..17`: wrap U; bits `18..19`: wrap V; bit `20`: nearest; bit `21`: use `UV1` |
| `16` | `8` | `8` | `vec2<f32>` | `uv_scale` | UV scale `(su, sv)` |
| `24` | `8` | `8` | `vec2<f32>` | `uv_offset` | UV offset `(ou, ov)` |

One sampler reads every descriptor: `texture_sample` in `src/cycles/closure.wgsl`. Shading, bump, normal maps and the alpha tests of the integrator (the opacity of a cutout or blended surface, for camera, bounce and shadow rays) all go through it, so a surface is seen and shaded with the same wrap, filter and format. Wrap `0` repeats, `1` clamps and `2` mirrors in float UV space before the texel lookup; `nearest` picks the texel the wrapped UV falls in, otherwise the four neighbours are blended. `texture_texels` is one storage binding, so the pool of all textures (each texture padded to 16 bytes) must fit the device's storage binding size, at most 1 GiB. `buildNativeInputV2` refuses a pool past 1 GiB and the host refuses one past the device's binding size, each with an error that names the size and the limit. The struct sizes above do not change.

**Mip levels (opt in).** Level `0` is the texture as given. When the mip count is above `1`, the levels follow level `0` in the same run of words, with no padding between them: level `k` has `max(1, width >> k)` by `max(1, height >> k)` texels, each level stored as level `0` is (`1` word per texel for `RGBA8_*` and `RG16_FLOAT`, `4` for `RGBA32_FLOAT`), and the whole run is padded to 16 bytes once. The kernel finds level `k` by walking from `data_offset` (`texture_level_descriptor`). The packer builds the chain in `texture-mips.mjs`. Level `1` is the integral of the level `0` reconstruction: each level `1` texel supersamples its footprint with up to 8 x 8 positions (fewer for a very large texture) (respecting the wrap mode of the texture), at each position reads level `0` exactly as the kernel does (bilinear on the stored values, texel centres at `+0.5`, then the sRGB decode) and averages in linear light; an sRGB map is encoded back to bytes, float maps keep their floats unclamped, alpha is averaged on its stored value like any channel (not weighted). Levels `2` and up are a 2 x 2 box average of the level before, in linear light for an sRGB map and on the stored values for every other format (an odd last row or column is read twice).

A texture stores levels only when `textureMips: true` is passed to the packer (or `mips: true` on that texture; `mips: false` overrides the option). The default is level `0` only, which is what Blender Cycles reads. A nearest-filtered texture or one of a single texel never stores levels. The dedupe key holds the mip count, so one image packed with and without levels is two descriptors. With `kernel_flags` bit `2048` set, the integrator keeps a ray cone per path (width at the ray origin, spread), and a hit passes the sampler the width of the ray footprint in UV units; the sampler turns it into `log2` of the footprint in texels (the larger of the two axes after `uv_scale`), reads level `0` while that is not above `0`, otherwise blends the two levels around it (trilinear) and stops at the last level. Level `0` is filtered on its stored values and decoded after, the order of #1030 (Blender Cycles); a level `1` and up holds the mean light of a footprint, so the kernel decodes each of its four taps before the bilinear blend, and the two levels of the trilinear blend in linear light. Blending two stored sRGB values and decoding the result would darken what the level holds. The alpha tests of the integrator and the bump taps always read level `0`.


---

## 9. Film Accumulation Buffer (`@binding(11)`)

`film_accumulation` holds `4 * image_width * image_height` elements of `vec4<f32>` (`64 bytes` per pixel across 4 contiguous planes of length `pixel_count = image_width * image_height`):

1. **Plane 0 (`0 .. pixel_count`)**: `[sum_r, sum_g, sum_b, sum_depth]`
2. **Plane 1 (`pixel_count .. 2 * pixel_count`)**: `[sum_albedo_r, sum_albedo_g, sum_albedo_b, 0.0]`
3. **Plane 2 (`2 * pixel_count .. 3 * pixel_count`)**: `[sum_normal_x, sum_normal_y, sum_normal_z, 0.0]`
4. **Plane 3 (`3 * pixel_count .. 4 * pixel_count`)**: `[sum_luminance, sum_luminance_sq, converged_flag, sample_count]`
