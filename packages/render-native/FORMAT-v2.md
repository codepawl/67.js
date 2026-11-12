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
| `4` | `materials` | `storage, read` | `MaterialRecord` | `256` | `16` | Principled BSDF v2 parameters, flags, absorption, texture indices |
| `5` | `emissive_triangles` | `storage, read` | `EmissiveTriangleRecord` | `96` | `16` | World-space emissive triangle list for NEE and BSDF-hit MIS |
| `6` | `lights` | `storage, read` | `LightRecord` | `128` | `16` | Analytic lights (`point`, `spot`, `area_rect`, `area_disk`, `sun`) |
| `7` | `light_tree_nodes` | `storage, read` | `LightTreeNode` | `64` | `16` | Orientation-aware light BVH nodes over analytic + emissive emitters |
| `8` | `texture_descriptors` | `storage, read` | `TextureDescriptor` | `32` | `16` | Mipmapped 2D texture headers and UV transforms |
| `9` | `texture_texels` | `storage, read` | `u32` | `4` | `4` | Packed RGBA8 / RGBA32F / RG16F texel words, IES profiles, Sobol tables |
| `10` | `environment_texels` | `storage, read` | `vec4<f32>` | `16` | `16` | Linear HDRI texels followed by marginal/conditional CDF rows |
| `11` | `film_accumulation` | `storage, read_write` | `vec4<f32>` | `16` | `16` | 4 planes of `image_width * image_height` vec4s (radiance+Z, albedo, normal, moments+count) |

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
| `32` | `4` | `4` | `u32` | `kernel_flags` | Bitmask: `1=USE_LIGHT_TREE`, `2=HAS_VOLUME`, `4=HAS_SUBSURFACE`, `8=ORTHOGRAPHIC_CAMERA`, `16=ADAPTIVE_SAMPLING`, `32=TRANSPARENT_BACKGROUND` |
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

---

## 8. Texture Descriptors — `TextureDescriptor` (`@binding(8)`)

Total stride: **32 bytes** (`2 × 16 B`), alignment: **16 bytes**.

| Byte Offset | Size (B) | Alignment (B) | WGSL Type | Field | Description |
| ---: | ---: | ---: | :--- | :--- | :--- |
| `0` | `4` | `16` | `u32` | `data_offset` | Base `u32` word offset in `texture_texels` (`@binding(9)`, `@align(16)`) |
| `4` | `4` | `4` | `u32` | `width` | Mip `0` width in texels |
| `8` | `4` | `4` | `u32` | `height` | Mip `0` height in texels |
| `12` | `4` | `4` | `u32` | `format_and_sampler` | Bits `0..7`: `0=RGBA8_UNORM`, `1=RGBA8_SRGB`, `2=RGBA32_FLOAT`, `3=RG16_FLOAT`; bits `8..15`: mip count; bits `16..17`: wrap U; bits `18..19`: wrap V; bit `20`: nearest; bit `21`: use `UV1` |
| `16` | `8` | `8` | `vec2<f32>` | `uv_scale` | UV scale `(su, sv)` |
| `24` | `8` | `8` | `vec2<f32>` | `uv_offset` | UV offset `(ou, ov)` |

---

## 9. Film Accumulation Buffer (`@binding(11)`)

`film_accumulation` holds `4 * image_width * image_height` elements of `vec4<f32>` (`64 bytes` per pixel across 4 contiguous planes of length `pixel_count = image_width * image_height`):

1. **Plane 0 (`0 .. pixel_count`)**: `[sum_r, sum_g, sum_b, sum_depth]`
2. **Plane 1 (`pixel_count .. 2 * pixel_count`)**: `[sum_albedo_r, sum_albedo_g, sum_albedo_b, 0.0]`
3. **Plane 2 (`2 * pixel_count .. 3 * pixel_count`)**: `[sum_normal_x, sum_normal_y, sum_normal_z, 0.0]`
4. **Plane 3 (`3 * pixel_count .. 4 * pixel_count`)**: `[sum_luminance, sum_luminance_sq, converged_flag, sample_count]`
