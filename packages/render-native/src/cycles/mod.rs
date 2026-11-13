mod filter_table;
mod luts;

pub(crate) use filter_table::unit_filter_table_words;
pub(crate) use luts::CYCLES_LUT_WORDS;

use napi::Result;

use crate::host::device::failure;
use crate::NativeTraceInputV2;

const KERNEL_MANIFEST_SOURCE: &str = include_str!("kernel-manifest.txt");
const BOOTSTRAP_MAIN_SOURCE: &str = include_str!("bootstrap_main.wgsl");

include!(concat!(env!("OUT_DIR"), "/cycles_manifest_files.rs"));

// ---- KernelParamsV2 byte offsets (verified against pack-input-v2.mjs and abi.wgsl) ----
const KERNEL_FLAG_LIGHT_TREE_PROBE: u32 = 128;
const KP_KERNEL_FLAGS_BYTE: usize = 32;    // u32[8]
const KP_ENV_WIDTH_BYTE: usize = 192;      // u32[48]
const KP_ENV_HEIGHT_BYTE: usize = 196;     // u32[49]
const KP_ENV_TOTAL_WEIGHT_BYTE: usize = 220; // f32[55]
const KP_VOLUME_DENSITY_BYTE: usize = 236;  // f32[59]
const KP_INSTANCE_COUNT_BYTE: usize = 84;   // u32[21]
const KP_TRIANGLE_COUNT_BYTE: usize = 88;   // u32[22]
const KP_MATERIAL_COUNT_BYTE: usize = 92;   // u32[23]
const KP_EMISSIVE_TRIANGLE_COUNT_BYTE: usize = 96; // u32[24]
const KP_LIGHT_COUNT_BYTE: usize = 100;     // u32[25]
const KP_LIGHT_TREE_NODE_COUNT_BYTE: usize = 104; // u32[26]
const KP_TEXTURE_COUNT_BYTE: usize = 108;   // u32[27]

// ---- MaterialRecord byte offsets (256-byte stride, verified against pack-input-v2.mjs) ----
const MAT_METALLIC_BYTE: usize = 12;           // f32[3]
const MAT_ANISOTROPY_BYTE: usize = 44;         // f32[11]
const MAT_TRANSMISSION_WEIGHT_BYTE: usize = 52; // f32[13]
const MAT_COAT_WEIGHT_BYTE: usize = 76;         // f32[19]
const MAT_THIN_FILM_THICKNESS_BYTE: usize = 88; // f32[22]
const MAT_SHEEN_WEIGHT_BYTE: usize = 108;       // f32[27]
const MAT_FLAGS_BYTE: usize = 192;             // u32[48]
const MAT_ALPHA_MODE_BYTE: usize = 196;        // u32[49]
const MAT_METALLIC_ROUGHNESS_TEX_BYTE: usize = 212; // i32[53]
const MAT_NORMAL_TEX_BYTE: usize = 216;        // i32[54]
const MAT_TRANSMISSION_TEX_BYTE: usize = 224;  // i32[56]
const MAT_COAT_ROUGHNESS_TEX_BYTE: usize = 228; // i32[57]
const MAT_COAT_NORMAL_TEX_BYTE: usize = 236;   // i32[59]
const MAT_SHEEN_TEX_BYTE: usize = 240;         // i32[60]
const MAT_ANISOTROPY_TEX_BYTE: usize = 244;    // i32[61]
const MAT_ALPHA_TEX_BYTE: usize = 248;         // i32[62]
const MAT_BUMP_TEX_BYTE: usize = 252;          // i32[63]
const MATERIAL_RECORD_STRIDE: usize = 256;

// MaterialRecord.flags bits
const MATERIAL_FLAG_THIN_WALLED: u32 = 2;
const MATERIAL_FLAG_TRANSPARENT_SHADOW: u32 = 4;
const MATERIAL_FLAG_F82_METALLIC: u32 = 32;

// ---- LightRecord byte offsets (128-byte stride, verified against pack-input-v2.mjs) ----
const LIGHT_TYPE_BYTE: usize = 12;            // u32[3]
const LIGHT_RADIUS_BYTE: usize = 44;          // f32[11]
const LIGHT_GROUP_MASK_LO_BYTE: usize = 120;  // u32[30]
const LIGHT_GROUP_MASK_HI_BYTE: usize = 124;  // u32[31]
const LIGHT_RECORD_STRIDE: usize = 128;

// ---- InstanceRecord byte offsets (160-byte stride) ----
const INSTANCE_LIGHT_GROUP_MASK_LO_BYTE: usize = 120; // u32[30]
const INSTANCE_LIGHT_GROUP_MASK_HI_BYTE: usize = 124; // u32[31]
const INSTANCE_RECORD_STRIDE: usize = 160;

// ---- Alpha modes ----
const ALPHA_MODE_MASK: u32 = 1;
const ALPHA_MODE_BLEND: u32 = 2;

// ---- Light types ----
const LIGHT_TYPE_AREA_RECT: u32 = 2;
const LIGHT_TYPE_AREA_DISK: u32 = 3;

fn read_u32_le(bytes: &[u8], byte_offset: usize) -> u32 {
    u32::from_le_bytes(bytes[byte_offset..byte_offset + 4].try_into().unwrap())
}

fn read_i32_le(bytes: &[u8], byte_offset: usize) -> i32 {
    i32::from_le_bytes(bytes[byte_offset..byte_offset + 4].try_into().unwrap())
}

fn read_f32_le(bytes: &[u8], byte_offset: usize) -> f32 {
    f32::from_le_bytes(bytes[byte_offset..byte_offset + 4].try_into().unwrap())
}

/// The weight below which `closure.wgsl` drops a layer (`CLOSURE_WEIGHT_CUTOFF`). The host bounds below use the
/// same value and the same f32 arithmetic, so a lobe the kernel can add is never left out of the bound.
const CLOSURE_WEIGHT_CUTOFF: f32 = 1.0e-5;

/// The material fields that decide how many metal, glass, specular and diffuse lobes the kernel can build.
struct BaseLayerInputs {
    metallic: f32,
    /// A metallic roughness texture multiplies metallic by a value in [0, 1], so metallic can be anything up to its record value.
    metallic_from_texture: bool,
    transmission_weight: f32,
    transmission_from_texture: bool,
    thin_walled: bool,
}

/// Upper bound on the lobes `closure_build` adds for the metal, glass, specular and diffuse layers of one material.
/// It follows the kernel: each layer is added only while its weight exceeds the cutoff and the weight left for the
/// layers below (never more than 1, shrinking by `1 - metallic` and `1 - transmission`) still exceeds it.
/// A texture can only lower a weight, so it keeps a layer possible and stops the host assuming the weight is spent.
fn base_layer_lobe_bound(inputs: &BaseLayerInputs) -> u32 {
    let metallic = inputs.metallic.clamp(0.0, 1.0);
    let transmission = inputs.transmission_weight.clamp(0.0, 1.0);
    let mut remaining_weight: f32 = 1.0;
    let mut lobes: u32 = 0;

    let metal_possible = inputs.metallic_from_texture || metallic > CLOSURE_WEIGHT_CUTOFF;
    if metal_possible {
        lobes += 1;
        if !inputs.metallic_from_texture {
            remaining_weight *= 1.0 - metallic;
        }
    }

    let glass_possible = (inputs.transmission_from_texture || transmission > CLOSURE_WEIGHT_CUTOFF)
        && remaining_weight > CLOSURE_WEIGHT_CUTOFF;
    if glass_possible {
        lobes += if inputs.thin_walled { 2 } else { 1 };
        if !inputs.transmission_from_texture {
            remaining_weight *= 1.0 - transmission;
        }
    }

    if remaining_weight > CLOSURE_WEIGHT_CUTOFF {
        // One dielectric specular lobe and one diffuse lobe.
        lobes += 2;
    }
    lobes
}

/// Checks that the counts the specializer reads from the napi input equal the counts the kernel reads from
/// `kernel_params`, so the specialized flags and lobe bounds describe the data the shader really walks.
pub(crate) fn check_counts_match_kernel_params(input: &NativeTraceInputV2) -> Result<()> {
    let kernel_params = &input.kernel_params;
    let counts = [
        ("instanceCount", input.instance_count, KP_INSTANCE_COUNT_BYTE),
        ("triangleCount", input.triangle_count, KP_TRIANGLE_COUNT_BYTE),
        ("materialCount", input.material_count, KP_MATERIAL_COUNT_BYTE),
        ("emissiveTriangleCount", input.emissive_triangle_count, KP_EMISSIVE_TRIANGLE_COUNT_BYTE),
        ("lightCount", input.light_count, KP_LIGHT_COUNT_BYTE),
        ("lightTreeNodeCount", input.light_tree_node_count, KP_LIGHT_TREE_NODE_COUNT_BYTE),
        ("textureCount", input.texture_count, KP_TEXTURE_COUNT_BYTE),
    ];
    for (name, input_count, byte_offset) in counts {
        if kernel_params.len() < byte_offset + 4 {
            return Err(failure(format!(
                "kernelParams holds {} bytes, too few to read {name} at byte {byte_offset}. Pass the 320 byte KernelParamsV2 block.",
                kernel_params.len()
            )));
        }
        let kernel_count = read_u32_le(kernel_params, byte_offset);
        if kernel_count != input_count {
            return Err(failure(format!(
                "{name} is {input_count} in the input but {kernel_count} in kernelParams (byte {byte_offset}). The two must match; pack both from the same scene."
            )));
        }
    }
    Ok(())
}

/// The words of `KernelParamsV2` that describe scene data a session uploaded or compiled for once: the record counts that
/// size the buffers, the environment table (size, offset and total weight), the offsets into the texel pool and the light
/// selection weights. A frame may not change them; every other word (camera, lens, seed, bounces, clamps, filter, adaptive
/// sampling, exposure, fog, kernel flags) is a per-frame setting. Fog and the kernel flags select pipeline variants, which a
/// session recompiles on its own when they change.
const SCENE_BOUND_FIELDS: [(&str, usize); 16] = [
    ("instanceCount", KP_INSTANCE_COUNT_BYTE),
    ("triangleCount", KP_TRIANGLE_COUNT_BYTE),
    ("materialCount", KP_MATERIAL_COUNT_BYTE),
    ("emissiveTriangleCount", KP_EMISSIVE_TRIANGLE_COUNT_BYTE),
    ("lightCount", KP_LIGHT_COUNT_BYTE),
    ("lightTreeNodeCount", KP_LIGHT_TREE_NODE_COUNT_BYTE),
    ("textureCount", KP_TEXTURE_COUNT_BYTE),
    ("envWidth", KP_ENV_WIDTH_BYTE),
    ("envHeight", KP_ENV_HEIGHT_BYTE),
    ("envCdfOffset", 200),
    ("envTotalWeight", KP_ENV_TOTAL_WEIGHT_BYTE),
    ("emissiveTotalWeight", 268),
    ("analyticLightTotalWeight", 272),
    ("iesTableOffset", 284),
    ("backgroundMisWeight", 292),
    ("sobolTableOffset", 296),
];

/// Checks that a frame's kernel parameters describe the scene the session holds: every scene-bound word (see
/// `SCENE_BOUND_FIELDS`) must equal the one the session was created with.
pub(crate) fn check_frame_params_keep_scene_counts(session_kernel_params: &[u8], frame_kernel_params: &[u8]) -> Result<()> {
    for (name, byte_offset) in SCENE_BOUND_FIELDS {
        if session_kernel_params.len() < byte_offset + 4 || frame_kernel_params.len() < byte_offset + 4 {
            return Err(failure(format!(
                "kernelParams must hold the 320 byte KernelParamsV2 block to read {name} at byte {byte_offset}."
            )));
        }
        let session_word = read_u32_le(session_kernel_params, byte_offset);
        let frame_word = read_u32_le(frame_kernel_params, byte_offset);
        if session_word != frame_word {
            return Err(failure(format!(
                "The kernelParams of this frame change {name} (byte {byte_offset}) from {session_word} to {frame_word} (raw 32 bit words), but the session scene was uploaded with the first value. A session renders one scene; pack the frame from the same scene (only the camera and the render settings may differ) or create a new session."
            )));
        }
    }
    Ok(())
}

/// The scene-bound words an update of the light or emission tables may change: the selection weights are sums over the
/// tables the update replaces. Every other scene-bound word (counts, environment, texel pool offsets) must stay.
const UPDATABLE_SCENE_WORD_OFFSETS: [usize; 3] = [268, 272, 292];

/// Checks that the kernel parameters of a session update describe a scene of the same shape as the session's: the same
/// counts, environment and texel pool offsets. The light and emission selection weights may differ.
pub(crate) fn check_update_params_keep_scene_shape(session_kernel_params: &[u8], update_kernel_params: &[u8]) -> Result<()> {
    for (name, byte_offset) in SCENE_BOUND_FIELDS {
        if UPDATABLE_SCENE_WORD_OFFSETS.contains(&byte_offset) {
            continue;
        }
        if session_kernel_params.len() < byte_offset + 4 || update_kernel_params.len() < byte_offset + 4 {
            return Err(failure(format!(
                "kernelParams must hold the 320 byte KernelParamsV2 block to read {name} at byte {byte_offset}."
            )));
        }
        let session_word = read_u32_le(session_kernel_params, byte_offset);
        let update_word = read_u32_le(update_kernel_params, byte_offset);
        if session_word != update_word {
            return Err(failure(format!(
                "The update changes {name} (byte {byte_offset}) from {session_word} to {update_word} (raw 32 bit words). A session update keeps the shape of the scene it holds (the record counts, the environment and the textures); create a new session for this input."
            )));
        }
    }
    Ok(())
}

/// The compute entry point to run for a kernel parameter block: `main`, or `light_tree_probe` when it carries
/// `KERNEL_FLAG_LIGHT_TREE_PROBE` (tests).
pub(crate) fn trace_entry_point_for_params(kernel_params: &[u8]) -> &'static str {
    let kernel_flags = read_u32_le(kernel_params, KP_KERNEL_FLAGS_BYTE);
    if (kernel_flags & KERNEL_FLAG_LIGHT_TREE_PROBE) != 0 {
        "light_tree_probe"
    } else {
        "main"
    }
}

/// Specializes the assembled Cycles kernel source for the given scene input, replacing
/// `const SCENE_HAS_*: bool = true;` sentinel declarations with the actual scene-derived values.
/// The sentinel pattern is `true` (conservative default) so the kernel compiles and renders
/// correctly even without specialization; specialization disables dead branches for performance.
///
/// NOTE: Only replaces in `trace_scene_cycles` / `CyclesSession`. In `probe_cycles_lobe`
/// all flags stay `true` (which is the unspecialized default).
#[cfg(test)]
pub(crate) fn specialize_cycles_kernel(source: &str, input: &NativeTraceInputV2) -> String {
    specialize_kernel_source(source, &scan_scene_specialization(input), &input.kernel_params)
}

/// What the scene tables decide about the kernel's `SCENE_HAS_*` constants and lobe bounds. A session scans its scene once
/// and combines the result with each frame's kernel parameters, so a frame does not walk the tables again.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SceneSpecialization {
    has_alpha_mask: bool,
    has_transparent: bool,
    has_glass: bool,
    has_coat: bool,
    has_sheen: bool,
    has_anisotropy: bool,
    has_thin_film: bool,
    has_f82: bool,
    has_normal_map: bool,
    has_diffuse_transmission: bool,
    max_closure_lobes: u32,
    max_closure_candidates: u32,
    has_finite_lights: bool,
    has_light_linking: bool,
    has_emissive_triangles: bool,
    has_analytic_lights: bool,
    light_tree_node_count: u32,
}

/// Walks the materials, lights and instances of an input once.
pub(crate) fn scan_scene_specialization(input: &NativeTraceInputV2) -> SceneSpecialization {
    let mats = &input.materials;
    let lights = &input.lights;
    let instances = &input.instances;
    let has_emissive_triangles = input.emissive_triangle_count > 0;
    let has_analytic_lights = input.light_count > 0;

    // --- Per-material flags ---
    let mat_count = input.material_count as usize;
    let mut has_alpha_mask = false;
    let mut has_transparent = false;
    let mut has_glass = false;
    let mut has_coat = false;
    let mut has_sheen = false;
    let mut has_anisotropy = false;
    let mut has_thin_film = false;
    let mut has_f82 = false;
    let mut has_normal_map = false;
    // A material table that holds a second set of `material_count` records carries the extension records of diffuse
    // transmission (FORMAT-v2.md, "Material extension records"); each material then adds at most one lobe for the far side.
    let has_diffuse_transmission = mat_count > 0 && mats.len() >= 2 * mat_count * MATERIAL_RECORD_STRIDE;
    let diffuse_transmission_lobe = u32::from(has_diffuse_transmission);
    let mut max_closure_lobes: u32 = if mat_count > 0 { 1 } else { 4 };
    let mut max_closure_candidates: u32 = if mat_count > 0 { 1 } else { 7 };

    for m in 0..mat_count {
        let base = m * MATERIAL_RECORD_STRIDE;
        if base + MATERIAL_RECORD_STRIDE > mats.len() {
            break;
        }
        let mat = &mats[base..base + MATERIAL_RECORD_STRIDE];
        let metallic = read_f32_le(mat, MAT_METALLIC_BYTE);
        let metallic_roughness_tex = read_i32_le(mat, MAT_METALLIC_ROUGHNESS_TEX_BYTE);
        let flags = read_u32_le(mat, MAT_FLAGS_BYTE);
        let alpha_mode = read_u32_le(mat, MAT_ALPHA_MODE_BYTE);
        let alpha_tex = read_i32_le(mat, MAT_ALPHA_TEX_BYTE);
        let anisotropy = read_f32_le(mat, MAT_ANISOTROPY_BYTE);
        let anisotropy_tex = read_i32_le(mat, MAT_ANISOTROPY_TEX_BYTE);
        let transmission_weight = read_f32_le(mat, MAT_TRANSMISSION_WEIGHT_BYTE);
        let transmission_tex = read_i32_le(mat, MAT_TRANSMISSION_TEX_BYTE);
        let coat_weight = read_f32_le(mat, MAT_COAT_WEIGHT_BYTE);
        let coat_roughness_tex = read_i32_le(mat, MAT_COAT_ROUGHNESS_TEX_BYTE);
        let thin_film_thickness = read_f32_le(mat, MAT_THIN_FILM_THICKNESS_BYTE);
        let sheen_weight = read_f32_le(mat, MAT_SHEEN_WEIGHT_BYTE);
        let sheen_tex = read_i32_le(mat, MAT_SHEEN_TEX_BYTE);
        let normal_tex = read_i32_le(mat, MAT_NORMAL_TEX_BYTE);
        let coat_normal_tex = read_i32_le(mat, MAT_COAT_NORMAL_TEX_BYTE);
        let bump_tex = read_i32_le(mat, MAT_BUMP_TEX_BYTE);

        if alpha_mode == ALPHA_MODE_MASK || alpha_tex >= 0 {
            has_alpha_mask = true;
        }
        if alpha_mode == ALPHA_MODE_BLEND || (flags & MATERIAL_FLAG_TRANSPARENT_SHADOW) != 0 {
            has_transparent = true;
        }
        if transmission_weight > 0.0 || transmission_tex >= 0 {
            has_glass = true;
        }
        if coat_weight > 0.0 || coat_roughness_tex >= 0 {
            has_coat = true;
        }
        if sheen_weight > 0.0 || sheen_tex >= 0 {
            has_sheen = true;
        }
        if anisotropy > 0.0 || anisotropy_tex >= 0 {
            has_anisotropy = true;
        }
        if thin_film_thickness > 0.0 {
            has_thin_film = true;
        }
        if (flags & MATERIAL_FLAG_F82_METALLIC) != 0 {
            has_f82 = true;
        }
        if normal_tex >= 0 || coat_normal_tex >= 0 || bump_tex >= 0 {
            has_normal_map = true;
        }

        let trans_lobe = u32::from(
            alpha_mode == ALPHA_MODE_BLEND
                || alpha_mode == ALPHA_MODE_MASK
                || alpha_tex >= 0
                || (flags & MATERIAL_FLAG_TRANSPARENT_SHADOW) != 0,
        );
        let sheen_lobe = u32::from(sheen_weight > CLOSURE_WEIGHT_CUTOFF || sheen_tex >= 0);
        let coat_lobe = u32::from(coat_weight > CLOSURE_WEIGHT_CUTOFF || coat_roughness_tex >= 0);
        let base_lobes = base_layer_lobe_bound(&BaseLayerInputs {
            metallic,
            metallic_from_texture: metallic_roughness_tex >= 0,
            transmission_weight,
            transmission_from_texture: transmission_tex >= 0,
            thin_walled: (flags & MATERIAL_FLAG_THIN_WALLED) != 0,
        });
        let candidate_lobes = trans_lobe + sheen_lobe + coat_lobe + base_lobes + diffuse_transmission_lobe;
        max_closure_candidates = max_closure_candidates.max(candidate_lobes.clamp(1, 7));
        max_closure_lobes = max_closure_lobes.max(candidate_lobes.clamp(1, 4));
    }

    // --- Per-light flags ---
    let light_count = input.light_count as usize;
    let mut has_finite_lights = false;

    for l in 0..light_count {
        let base = l * LIGHT_RECORD_STRIDE;
        if base + LIGHT_RECORD_STRIDE > lights.len() {
            break;
        }
        let light = &lights[base..base + LIGHT_RECORD_STRIDE];
        let light_type = read_u32_le(light, LIGHT_TYPE_BYTE);
        let radius = read_f32_le(light, LIGHT_RADIUS_BYTE);

        let finite = light_type == LIGHT_TYPE_AREA_RECT
            || light_type == LIGHT_TYPE_AREA_DISK
            || ((light_type == 0 || light_type == 1) && radius > 0.0);
        if finite {
            has_finite_lights = true;
        }
    }

    // --- Per-instance and per-light light-linking flags ---
    let instance_count = input.instance_count as usize;
    let mut has_light_linking = false;

    for i in 0..instance_count {
        let base = i * INSTANCE_RECORD_STRIDE;
        if base + INSTANCE_RECORD_STRIDE > instances.len() {
            break;
        }
        let inst = &instances[base..base + INSTANCE_RECORD_STRIDE];
        let lo = read_u32_le(inst, INSTANCE_LIGHT_GROUP_MASK_LO_BYTE);
        let hi = read_u32_le(inst, INSTANCE_LIGHT_GROUP_MASK_HI_BYTE);
        if lo != 0xFFFFFFFF || hi != 0xFFFFFFFF {
            has_light_linking = true;
            break;
        }
    }
    if !has_light_linking {
        for l in 0..light_count {
            let base = l * LIGHT_RECORD_STRIDE;
            if base + LIGHT_RECORD_STRIDE > lights.len() {
                break;
            }
            let light = &lights[base..base + LIGHT_RECORD_STRIDE];
            let lo = read_u32_le(light, LIGHT_GROUP_MASK_LO_BYTE);
            let hi = read_u32_le(light, LIGHT_GROUP_MASK_HI_BYTE);
            if lo != 0xFFFFFFFF || hi != 0xFFFFFFFF {
                has_light_linking = true;
                break;
            }
        }
    }

    SceneSpecialization {
        has_alpha_mask,
        has_transparent,
        has_glass,
        has_coat,
        has_sheen,
        has_anisotropy,
        has_thin_film,
        has_f82,
        has_normal_map,
        has_diffuse_transmission,
        max_closure_lobes,
        max_closure_candidates,
        has_finite_lights,
        has_light_linking,
        has_emissive_triangles,
        has_analytic_lights,
        light_tree_node_count: input.light_tree_node_count,
    }
}

/// Replaces the `SCENE_HAS_*` sentinels of `source` with the scene scan and the frame's kernel parameters
/// (kernel flags, fog density and environment table size).
pub(crate) fn specialize_kernel_source(source: &str, scene: &SceneSpecialization, kp: &[u8]) -> String {
    let kernel_flags = read_u32_le(kp, KP_KERNEL_FLAGS_BYTE);
    let volume_density = read_f32_le(kp, KP_VOLUME_DENSITY_BYTE);
    let env_width = read_u32_le(kp, KP_ENV_WIDTH_BYTE);
    let env_height = read_u32_le(kp, KP_ENV_HEIGHT_BYTE);
    let env_total_weight = read_f32_le(kp, KP_ENV_TOTAL_WEIGHT_BYTE);

    let has_volume = (kernel_flags & 2) != 0 && volume_density > 0.0;
    let has_env_importance = env_width > 0 && env_height > 0 && env_total_weight > 0.0;
    let has_light_tree = (kernel_flags & 1) != 0 && scene.light_tree_node_count > 0;
    let SceneSpecialization {
        has_alpha_mask,
        has_transparent,
        has_glass,
        has_coat,
        has_sheen,
        has_anisotropy,
        has_thin_film,
        has_f82,
        has_normal_map,
        has_diffuse_transmission,
        max_closure_lobes,
        max_closure_candidates,
        has_finite_lights,
        has_light_linking,
        has_emissive_triangles,
        has_analytic_lights,
        ..
    } = *scene;

    // --- Apply replacements ---
    // The sentinel pattern `const SCENE_HAS_*: bool = true;` is replaced with the computed value.
    // If the pattern is absent (kernel not yet updated), the source is returned unchanged.
    let mut result = source.to_string();
    macro_rules! specialize {
        ($flag:ident, $value:expr) => {
            let marker = concat!("const SCENE_HAS_", stringify!($flag), ": bool = true;");
            if $value {
                // already `true` — no replacement needed
            } else {
                result = result.replace(marker, concat!("const SCENE_HAS_", stringify!($flag), ": bool = false;"));
            }
        };
    }
    specialize!(VOLUME, has_volume);
    specialize!(ALPHA_MASK, has_alpha_mask);
    specialize!(TRANSPARENT, has_transparent);
    specialize!(GLASS, has_glass);
    specialize!(COAT, has_coat);
    specialize!(SHEEN, has_sheen);
    specialize!(ANISOTROPY, has_anisotropy);
    specialize!(THIN_FILM, has_thin_film);
    specialize!(F82, has_f82);
    specialize!(NORMAL_MAP, has_normal_map);
    // Unlike the other sentinels this one defaults to `false`, so a kernel compiled without specialization reads no extension records.
    if has_diffuse_transmission {
        result = result.replace("const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = false;", "const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = true;");
    }
    specialize!(EMISSIVE_TRIANGLES, has_emissive_triangles);
    specialize!(ANALYTIC_LIGHTS, has_analytic_lights);
    specialize!(FINITE_LIGHTS, has_finite_lights);
    specialize!(ENV_IMPORTANCE, has_env_importance);
    specialize!(LIGHT_LINKING, has_light_linking);
    specialize!(LIGHT_TREE, has_light_tree);
    if max_closure_lobes < 4 {
        result = result.replace(
            "const MAX_CLOSURE_LOBES: u32 = 4u; // SPECIALIZE_LOBES",
            &format!("const MAX_CLOSURE_LOBES: u32 = {max_closure_lobes}u; // SPECIALIZE_LOBES"),
        );
    }
    if max_closure_candidates < 7 {
        result = result.replace(
            "const MAX_CLOSURE_CANDIDATES: u32 = 7u; // SPECIALIZE_CANDIDATES",
            &format!("const MAX_CLOSURE_CANDIDATES: u32 = {max_closure_candidates}u; // SPECIALIZE_CANDIDATES"),
        );
    }
    result
}

#[cfg(test)]
mod specialization_tests {
    use super::*;

    fn dummy_input(kp: &[u8], mats: &[u8], lights: &[u8], instances: &[u8]) -> NativeTraceInputV2 {
        use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
        NativeTraceInputV2 {
            schema_version: 2,
            kernel_params: Uint8Array::new(kp.to_vec()),
            instances: Uint8Array::new(instances.to_vec()),
            instance_count: (instances.len() / INSTANCE_RECORD_STRIDE) as u32,
            triangles: Uint8Array::new(vec![0u8; 224]),
            triangle_count: 1,
            materials: Uint8Array::new(mats.to_vec()),
            material_count: (mats.len() / MATERIAL_RECORD_STRIDE) as u32,
            emissive_triangles: Uint8Array::new(vec![0u8; 96]),
            emissive_triangle_count: 0,
            lights: Uint8Array::new(lights.to_vec()),
            light_count: (lights.len() / LIGHT_RECORD_STRIDE) as u32,
            light_tree_nodes: Uint8Array::new(vec![0u8; 64]),
            light_tree_node_count: 1,
            light_tree_emitters: None,
            light_tree_emitter_count: None,
            light_to_tree: None,
            texture_descriptors: Uint8Array::new(vec![0u8; 32]),
            texture_count: 1,
            texture_texels: Uint32Array::new(vec![0u32; 4]),
            environment_texels: Float32Array::new(vec![0f32; 4]),
        }
    }

    #[test]
    fn light_tree_flag_without_emitter_tables_is_rejected() {
        let flagged = dummy_input(&make_kp(1, 0.0, 0, 0, 0.0), &[], &[], &[]);
        let message = crate::host::session::validate_light_tree_tables(&flagged)
            .expect_err("a flagged input without emitter tables must fail")
            .to_string();
        assert!(message.contains("buildNativeInputV2"), "{message}");
        let unflagged = dummy_input(&make_kp(0, 0.0, 0, 0, 0.0), &[], &[], &[]);
        assert!(crate::host::session::validate_light_tree_tables(&unflagged).is_ok());
    }

    fn make_kp(kernel_flags: u32, volume_density: f32, env_width: u32, env_height: u32, env_total_weight: f32) -> Vec<u8> {
        let mut kp = vec![0u8; 320];
        // magic & version at bytes 0-7
        kp[0..4].copy_from_slice(&0x36375054u32.to_le_bytes());
        kp[4..8].copy_from_slice(&2u32.to_le_bytes());
        kp[KP_KERNEL_FLAGS_BYTE..KP_KERNEL_FLAGS_BYTE + 4].copy_from_slice(&kernel_flags.to_le_bytes());
        kp[KP_VOLUME_DENSITY_BYTE..KP_VOLUME_DENSITY_BYTE + 4].copy_from_slice(&volume_density.to_bits().to_le_bytes());
        kp[KP_ENV_WIDTH_BYTE..KP_ENV_WIDTH_BYTE + 4].copy_from_slice(&env_width.to_le_bytes());
        kp[KP_ENV_HEIGHT_BYTE..KP_ENV_HEIGHT_BYTE + 4].copy_from_slice(&env_height.to_le_bytes());
        kp[KP_ENV_TOTAL_WEIGHT_BYTE..KP_ENV_TOTAL_WEIGHT_BYTE + 4].copy_from_slice(&env_total_weight.to_bits().to_le_bytes());
        kp
    }

    fn make_mat(transmission_weight: f32, coat_weight: f32, sheen_weight: f32,
                anisotropy: f32, thin_film_thickness: f32, flags: u32,
                alpha_mode: u32, normal_tex: i32, alpha_tex: i32) -> Vec<u8> {
        let mut mat = vec![0u8; MATERIAL_RECORD_STRIDE];
        mat[MAT_TRANSMISSION_WEIGHT_BYTE..MAT_TRANSMISSION_WEIGHT_BYTE + 4].copy_from_slice(&transmission_weight.to_bits().to_le_bytes());
        mat[MAT_COAT_WEIGHT_BYTE..MAT_COAT_WEIGHT_BYTE + 4].copy_from_slice(&coat_weight.to_bits().to_le_bytes());
        mat[MAT_SHEEN_WEIGHT_BYTE..MAT_SHEEN_WEIGHT_BYTE + 4].copy_from_slice(&sheen_weight.to_bits().to_le_bytes());
        mat[MAT_ANISOTROPY_BYTE..MAT_ANISOTROPY_BYTE + 4].copy_from_slice(&anisotropy.to_bits().to_le_bytes());
        mat[MAT_THIN_FILM_THICKNESS_BYTE..MAT_THIN_FILM_THICKNESS_BYTE + 4].copy_from_slice(&thin_film_thickness.to_bits().to_le_bytes());
        mat[MAT_FLAGS_BYTE..MAT_FLAGS_BYTE + 4].copy_from_slice(&flags.to_le_bytes());
        mat[MAT_ALPHA_MODE_BYTE..MAT_ALPHA_MODE_BYTE + 4].copy_from_slice(&alpha_mode.to_le_bytes());
        mat[MAT_NORMAL_TEX_BYTE..MAT_NORMAL_TEX_BYTE + 4].copy_from_slice(&normal_tex.to_le_bytes());
        mat[MAT_ALPHA_TEX_BYTE..MAT_ALPHA_TEX_BYTE + 4].copy_from_slice(&alpha_tex.to_le_bytes());
        // All tex indices default to -1 (INVALID = 0xFFFFFFFF)
        for &offset in &[MAT_METALLIC_ROUGHNESS_TEX_BYTE, MAT_TRANSMISSION_TEX_BYTE,
                          MAT_COAT_ROUGHNESS_TEX_BYTE, MAT_COAT_NORMAL_TEX_BYTE,
                          MAT_SHEEN_TEX_BYTE, MAT_ANISOTROPY_TEX_BYTE, MAT_BUMP_TEX_BYTE] {
            if mat[offset..offset + 4] == [0u8; 4] {
                mat[offset..offset + 4].copy_from_slice(&(-1i32).to_le_bytes());
            }
        }
        mat
    }

    fn make_default_inst() -> Vec<u8> {
        let mut inst = vec![0u8; INSTANCE_RECORD_STRIDE];
        // Default all-ones light group mask (no linking)
        inst[INSTANCE_LIGHT_GROUP_MASK_LO_BYTE..INSTANCE_LIGHT_GROUP_MASK_LO_BYTE + 4].copy_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        inst[INSTANCE_LIGHT_GROUP_MASK_HI_BYTE..INSTANCE_LIGHT_GROUP_MASK_HI_BYTE + 4].copy_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        inst
    }

    fn make_default_light() -> Vec<u8> {
        let mut light = vec![0u8; LIGHT_RECORD_STRIDE];
        light[LIGHT_GROUP_MASK_LO_BYTE..LIGHT_GROUP_MASK_LO_BYTE + 4].copy_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        light[LIGHT_GROUP_MASK_HI_BYTE..LIGHT_GROUP_MASK_HI_BYTE + 4].copy_from_slice(&0xFFFFFFFFu32.to_le_bytes());
        light
    }

    #[test]
    fn specialize_all_false_on_empty_opaque_scene() {
        let kp = make_kp(0, 0.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let inst = make_default_inst();
        let lights = make_default_light();
        let input = dummy_input(&kp, &mat, &lights, &inst);
        // Build a source with every sentinel
        let source = "const SCENE_HAS_VOLUME: bool = true;\n\
                      const SCENE_HAS_GLASS: bool = true;\n\
                      const SCENE_HAS_COAT: bool = true;\n\
                      const SCENE_HAS_SHEEN: bool = true;\n\
                      const SCENE_HAS_ANISOTROPY: bool = true;\n\
                      const SCENE_HAS_THIN_FILM: bool = true;\n\
                      const SCENE_HAS_F82: bool = true;\n\
                      const SCENE_HAS_NORMAL_MAP: bool = true;\n\
                      const SCENE_HAS_ALPHA_MASK: bool = true;\n\
                      const SCENE_HAS_TRANSPARENT: bool = true;\n\
                      const SCENE_HAS_EMISSIVE_TRIANGLES: bool = true;\n\
                      const SCENE_HAS_ANALYTIC_LIGHTS: bool = true;\n\
                      const SCENE_HAS_FINITE_LIGHTS: bool = true;\n\
                      const SCENE_HAS_ENV_IMPORTANCE: bool = true;\n\
                      const SCENE_HAS_LIGHT_LINKING: bool = true;\n\
                      const SCENE_HAS_LIGHT_TREE: bool = true;\n\
                      const MAX_CLOSURE_LOBES: u32 = 4u; // SPECIALIZE_LOBES
                      const MAX_CLOSURE_CANDIDATES: u32 = 7u; // SPECIALIZE_CANDIDATES";
        let result = specialize_cycles_kernel(source, &input);
        assert!(result.contains("const SCENE_HAS_VOLUME: bool = false;"), "VOLUME should be false");
        assert!(result.contains("const SCENE_HAS_GLASS: bool = false;"), "GLASS should be false");
        assert!(result.contains("const SCENE_HAS_COAT: bool = false;"), "COAT should be false");
        assert!(result.contains("const SCENE_HAS_SHEEN: bool = false;"), "SHEEN should be false");
        assert!(result.contains("const SCENE_HAS_ANISOTROPY: bool = false;"), "ANISOTROPY should be false");
        assert!(result.contains("const SCENE_HAS_THIN_FILM: bool = false;"), "THIN_FILM should be false");
        assert!(result.contains("const SCENE_HAS_F82: bool = false;"), "F82 should be false");
        assert!(result.contains("const SCENE_HAS_NORMAL_MAP: bool = false;"), "NORMAL_MAP should be false");
        assert!(result.contains("const SCENE_HAS_ALPHA_MASK: bool = false;"), "ALPHA_MASK should be false");
        assert!(result.contains("const SCENE_HAS_TRANSPARENT: bool = false;"), "TRANSPARENT should be false");
        assert!(result.contains("const SCENE_HAS_EMISSIVE_TRIANGLES: bool = false;"), "EMISSIVE_TRIANGLES should be false");
        // light_count is 1 (lights has 128 bytes) so ANALYTIC_LIGHTS=true; but no finite lights
        assert!(result.contains("const SCENE_HAS_FINITE_LIGHTS: bool = false;"), "FINITE_LIGHTS should be false");
        assert!(result.contains("const SCENE_HAS_ENV_IMPORTANCE: bool = false;"), "ENV_IMPORTANCE should be false");
        assert!(result.contains("const SCENE_HAS_LIGHT_LINKING: bool = false;"), "LIGHT_LINKING should be false");
        assert!(result.contains("const SCENE_HAS_LIGHT_TREE: bool = false;"), "LIGHT_TREE should be false");
        assert!(result.contains("const MAX_CLOSURE_LOBES: u32 = 2u; // SPECIALIZE_LOBES"), "MAX_CLOSURE_LOBES should be 2u");
        assert!(
            result.contains("const MAX_CLOSURE_CANDIDATES: u32 = 2u; // SPECIALIZE_CANDIDATES"),
            "MAX_CLOSURE_CANDIDATES should be 2u"
        );
    }

    #[test]
    fn specialize_glass_and_volume_on_matching_scene() {
        let kp = make_kp(2, 1.0, 1920, 1080, 42.0); // KERNEL_FLAG_HAS_VOLUME=2, volume>0, env
        let mat = make_mat(0.5, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1); // transmission_weight > 0
        let inst = make_default_inst();
        let lights = vec![0u8; LIGHT_RECORD_STRIDE];
        let input = dummy_input(&kp, &mat, &lights, &inst);
        let source = "const SCENE_HAS_VOLUME: bool = true;\nconst SCENE_HAS_GLASS: bool = true;\nconst SCENE_HAS_ENV_IMPORTANCE: bool = true;";
        let result = specialize_cycles_kernel(source, &input);
        // These should stay true (not replaced)
        assert!(result.contains("const SCENE_HAS_VOLUME: bool = true;"), "VOLUME should stay true");
        assert!(result.contains("const SCENE_HAS_GLASS: bool = true;"), "GLASS should stay true");
        assert!(result.contains("const SCENE_HAS_ENV_IMPORTANCE: bool = true;"), "ENV_IMPORTANCE should stay true");
    }

    #[test]
    fn diffuse_transmission_follows_the_extension_records_of_the_material_table() {
        let kp = make_kp(0, 0.0, 0, 0, 0.0);
        let one_material = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let inst = make_default_inst();
        let lights = make_default_light();
        let source = "const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = false;";

        let without_extension = dummy_input(&kp, &one_material, &lights, &inst);
        let result = specialize_cycles_kernel(source, &without_extension);
        assert_eq!(result, source, "no extension records, no lobe: the default stays false");

        let mut with_extension_table = one_material.clone();
        with_extension_table.extend_from_slice(&vec![0u8; MATERIAL_RECORD_STRIDE]);
        let mut with_extension = dummy_input(&kp, &with_extension_table, &lights, &inst);
        with_extension.material_count = 1;
        let result = specialize_cycles_kernel(source, &with_extension);
        assert!(result.contains("const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = true;"), "one extension record per material");
        let scene = scan_scene_specialization(&with_extension);
        let plain_scene = scan_scene_specialization(&without_extension);
        assert_eq!(
            scene.max_closure_candidates,
            plain_scene.max_closure_candidates + 1,
            "the far side lobe is one more candidate"
        );
    }

    #[test]
    fn specialize_no_change_when_no_markers() {
        let kp = make_kp(0, 0.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let inst = make_default_inst();
        let lights = vec![0u8; LIGHT_RECORD_STRIDE];
        let input = dummy_input(&kp, &mat, &lights, &inst);
        let source = "fn main() { let x = 1; }";
        let result = specialize_cycles_kernel(source, &input);
        assert_eq!(result, source, "Source without markers should be unchanged");
    }

    const SESSION_TEST_SOURCE: &str = "const SCENE_HAS_VOLUME: bool = true;\nconst SCENE_HAS_GLASS: bool = true;\nconst SCENE_HAS_ENV_IMPORTANCE: bool = true;";

    #[test]
    fn a_scene_scan_combined_with_the_parameters_equals_the_one_step_specialization() {
        let kp = make_kp(2, 1.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let input = dummy_input(&kp, &mat, &make_default_light(), &make_default_inst());
        let scene = scan_scene_specialization(&input);
        assert_eq!(
            specialize_kernel_source(SESSION_TEST_SOURCE, &scene, &kp),
            specialize_cycles_kernel(SESSION_TEST_SOURCE, &input)
        );
    }

    #[test]
    fn a_frame_that_changes_only_the_camera_keeps_the_specialized_source() {
        let kp = make_kp(2, 1.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let input = dummy_input(&kp, &mat, &make_default_light(), &make_default_inst());
        let scene = scan_scene_specialization(&input);
        let mut moved_camera = kp.clone();
        moved_camera[120..124].copy_from_slice(&3.5f32.to_bits().to_le_bytes());
        assert_eq!(
            specialize_kernel_source(SESSION_TEST_SOURCE, &scene, &kp),
            specialize_kernel_source(SESSION_TEST_SOURCE, &scene, &moved_camera)
        );
    }

    #[test]
    fn a_frame_that_removes_the_fog_changes_the_specialized_source() {
        let kp = make_kp(2, 1.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let input = dummy_input(&kp, &mat, &make_default_light(), &make_default_inst());
        let scene = scan_scene_specialization(&input);
        let without_fog = make_kp(0, 0.0, 0, 0, 0.0);
        let fogged = specialize_kernel_source(SESSION_TEST_SOURCE, &scene, &kp);
        let clear = specialize_kernel_source(SESSION_TEST_SOURCE, &scene, &without_fog);
        assert!(fogged.contains("const SCENE_HAS_VOLUME: bool = true;"));
        assert!(clear.contains("const SCENE_HAS_VOLUME: bool = false;"));
    }

    #[test]
    fn a_frame_must_keep_the_scene_record_counts_of_the_session() {
        let session_params = make_kp(0, 0.0, 0, 0, 0.0);
        let mut moved_camera = session_params.clone();
        moved_camera[120..124].copy_from_slice(&1.0f32.to_bits().to_le_bytes());
        assert!(check_frame_params_keep_scene_counts(&session_params, &moved_camera).is_ok());

        let mut other_scene = session_params.clone();
        other_scene[KP_MATERIAL_COUNT_BYTE..KP_MATERIAL_COUNT_BYTE + 4].copy_from_slice(&9u32.to_le_bytes());
        let message = check_frame_params_keep_scene_counts(&session_params, &other_scene)
            .expect_err("a different material count must be refused")
            .to_string();
        assert!(message.contains("materialCount"), "{message}");
        assert!(message.contains("create a new session"), "{message}");

        let truncated = &session_params[..64];
        assert!(check_frame_params_keep_scene_counts(&session_params, truncated).is_err());
    }

    #[test]
    fn a_frame_may_not_change_any_scene_bound_word_and_the_error_names_it() {
        let session_params = make_kp(0, 0.0, 512, 256, 3.0);
        for (name, byte_offset) in SCENE_BOUND_FIELDS {
            let mut changed = session_params.clone();
            changed[byte_offset..byte_offset + 4].copy_from_slice(&0x1234_5678u32.to_le_bytes());
            let message = check_frame_params_keep_scene_counts(&session_params, &changed)
                .expect_err("a changed scene-bound word must be refused")
                .to_string();
            assert!(message.contains(name), "{name}: {message}");
            assert!(message.contains("create a new session"), "{name}: {message}");
        }
    }

    #[test]
    fn a_frame_with_another_hdri_or_an_environment_the_session_lacks_is_refused() {
        let with_environment = make_kp(0, 0.0, 512, 256, 3.0);
        let other_size = make_kp(0, 0.0, 1024, 512, 3.0);
        let no_environment = make_kp(0, 0.0, 0, 0, 0.0);
        let message = check_frame_params_keep_scene_counts(&with_environment, &other_size).unwrap_err().to_string();
        assert!(message.contains("envWidth"), "{message}");
        assert!(check_frame_params_keep_scene_counts(&no_environment, &with_environment).is_err());
        assert!(check_frame_params_keep_scene_counts(&with_environment, &no_environment).is_err());
    }

    #[test]
    fn an_update_may_change_the_selection_weights_but_not_the_shape_of_the_scene() {
        let session_params = make_kp(0, 0.0, 512, 256, 3.0);
        for byte_offset in UPDATABLE_SCENE_WORD_OFFSETS {
            let mut reweighted = session_params.clone();
            reweighted[byte_offset..byte_offset + 4].copy_from_slice(&0x4000_0000u32.to_le_bytes());
            assert!(check_update_params_keep_scene_shape(&session_params, &reweighted).is_ok(), "byte {byte_offset}");
        }
        for (name, byte_offset) in SCENE_BOUND_FIELDS {
            if UPDATABLE_SCENE_WORD_OFFSETS.contains(&byte_offset) {
                continue;
            }
            let mut reshaped = session_params.clone();
            reshaped[byte_offset..byte_offset + 4].copy_from_slice(&0x1234_5678u32.to_le_bytes());
            let message = check_update_params_keep_scene_shape(&session_params, &reshaped)
                .expect_err("a changed scene shape must be refused")
                .to_string();
            assert!(message.contains(name), "{name}: {message}");
            assert!(message.contains("create a new session"), "{name}: {message}");
        }
        assert!(check_update_params_keep_scene_shape(&session_params, &session_params[..64]).is_err());
    }

    #[test]
    fn per_frame_settings_may_change_freely() {
        let session_params = make_kp(0, 0.0, 512, 256, 3.0);
        let scene_bound: Vec<usize> = SCENE_BOUND_FIELDS.iter().map(|(_, offset)| *offset).collect();
        // Every 4 byte word after the header except the scene-bound ones (camera, lens, seed, bounces, clamps, filter,
        // fog, exposure, flags, adaptive sampling) is a setting of the frame.
        for byte_offset in (8..304).step_by(4).filter(|offset| !scene_bound.contains(offset)) {
            let mut changed = session_params.clone();
            changed[byte_offset..byte_offset + 4].copy_from_slice(&0x3f80_0000u32.to_le_bytes());
            assert!(
                check_frame_params_keep_scene_counts(&session_params, &changed).is_ok(),
                "byte {byte_offset} is a per-frame setting"
            );
        }
    }

    fn opaque_inputs(metallic: f32, transmission_weight: f32) -> BaseLayerInputs {
        BaseLayerInputs {
            metallic,
            metallic_from_texture: false,
            transmission_weight,
            transmission_from_texture: false,
            thin_walled: false,
        }
    }

    /// The lobes `closure_build` adds for the base layers of a white, opaque material, written from closure.wgsl.
    fn kernel_base_lobes(metallic: f32, transmission_weight: f32, thin_walled: bool) -> u32 {
        let metallic = metallic.clamp(0.0, 1.0);
        let transmission = transmission_weight.clamp(0.0, 1.0);
        let mut layer_weight: f32 = 1.0;
        let mut lobes = 0;
        if metallic > CLOSURE_WEIGHT_CUTOFF {
            lobes += 1;
            layer_weight *= 1.0 - metallic;
        }
        if transmission > CLOSURE_WEIGHT_CUTOFF && layer_weight > CLOSURE_WEIGHT_CUTOFF {
            lobes += if thin_walled { 2 } else { 1 };
            layer_weight *= 1.0 - transmission;
        }
        if layer_weight > CLOSURE_WEIGHT_CUTOFF {
            lobes += 2;
        }
        lobes
    }

    #[test]
    fn metallic_near_one_keeps_the_specular_and_diffuse_lobes_the_kernel_builds() {
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(1.0, 0.0)), 1);
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(0.999999, 0.0)), 1);
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(0.99999, 0.0)), 3);
    }

    #[test]
    fn transmission_near_one_keeps_the_specular_and_diffuse_lobes_the_kernel_builds() {
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(0.0, 1.0)), 1);
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(0.0, 0.999999)), 1);
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(0.0, 0.99999)), 3);
        let thin_walled = BaseLayerInputs { thin_walled: true, ..opaque_inputs(0.0, 1.0) };
        assert_eq!(base_layer_lobe_bound(&thin_walled), 2);
    }

    #[test]
    fn a_texture_keeps_every_layer_possible() {
        let metallic_texture = BaseLayerInputs { metallic_from_texture: true, ..opaque_inputs(1.0, 0.0) };
        assert_eq!(base_layer_lobe_bound(&metallic_texture), 3);
        let transmission_texture = BaseLayerInputs { transmission_from_texture: true, ..opaque_inputs(0.0, 1.0) };
        assert_eq!(base_layer_lobe_bound(&transmission_texture), 3);
        let both_textures = BaseLayerInputs {
            metallic_from_texture: true,
            transmission_from_texture: true,
            ..opaque_inputs(1.0, 1.0)
        };
        assert_eq!(base_layer_lobe_bound(&both_textures), 4);
    }

    #[test]
    fn fully_metal_material_ignores_glass_the_kernel_never_reaches() {
        assert_eq!(base_layer_lobe_bound(&opaque_inputs(1.0, 1.0)), 1);
    }

    #[test]
    fn lobe_bound_never_falls_below_what_the_kernel_builds() {
        let near_one = [
            0.0, 1.0e-6, 1.0e-5, 1.1e-5, 0.5, 0.99, 0.9999, 0.99998, 0.999985, 0.99999, 0.9999905, 0.999995, 0.999999, 1.0, 1.5,
        ];
        for &metallic in &near_one {
            for &transmission in &near_one {
                for thin_walled in [false, true] {
                    let inputs = BaseLayerInputs { thin_walled, ..opaque_inputs(metallic, transmission) };
                    let bound = base_layer_lobe_bound(&inputs);
                    let built = kernel_base_lobes(metallic, transmission, thin_walled);
                    assert!(
                        bound >= built,
                        "metallic {metallic} transmission {transmission} thin {thin_walled}: bound {bound} below kernel {built}"
                    );
                }
            }
        }
    }

    #[test]
    fn counts_check_accepts_matching_counts_and_names_a_mismatch() {
        let mut kernel_params = make_kp(0, 0.0, 0, 0, 0.0);
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let inst = make_default_inst();
        let lights = make_default_light();
        let mut input = dummy_input(&kernel_params, &mat, &lights, &inst);
        let counts = [
            (KP_INSTANCE_COUNT_BYTE, input.instance_count),
            (KP_TRIANGLE_COUNT_BYTE, input.triangle_count),
            (KP_MATERIAL_COUNT_BYTE, input.material_count),
            (KP_EMISSIVE_TRIANGLE_COUNT_BYTE, input.emissive_triangle_count),
            (KP_LIGHT_COUNT_BYTE, input.light_count),
            (KP_LIGHT_TREE_NODE_COUNT_BYTE, input.light_tree_node_count),
            (KP_TEXTURE_COUNT_BYTE, input.texture_count),
        ];
        for (byte_offset, count) in counts {
            kernel_params[byte_offset..byte_offset + 4].copy_from_slice(&count.to_le_bytes());
        }
        input = dummy_input(&kernel_params, &mat, &lights, &inst);
        assert!(check_counts_match_kernel_params(&input).is_ok());

        kernel_params[KP_MATERIAL_COUNT_BYTE..KP_MATERIAL_COUNT_BYTE + 4].copy_from_slice(&9u32.to_le_bytes());
        let mismatched = dummy_input(&kernel_params, &mat, &lights, &inst);
        let message = check_counts_match_kernel_params(&mismatched).unwrap_err().reason;
        assert!(message.contains("materialCount"), "{message}");
        assert!(message.contains('9'), "{message}");
    }

    #[test]
    fn counts_check_rejects_a_short_kernel_params_block() {
        let mat = make_mat(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, -1, -1);
        let inst = make_default_inst();
        let lights = make_default_light();
        let input = dummy_input(&[0u8; 16], &mat, &lights, &inst);
        let message = check_counts_match_kernel_params(&input).unwrap_err().reason;
        assert!(message.contains("320"), "{message}");
    }
}

/// Parses `kernel-manifest.txt`, stripping any UTF-8 BOM and ignoring blank lines and `#` comments, and returns relative WGSL paths in order.
pub(crate) fn parse_kernel_manifest(manifest_text: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let without_file_bom = manifest_text.trim_start_matches('\u{feff}');
    for raw_line in without_file_bom.lines() {
        let without_line_bom = raw_line.trim_start_matches('\u{feff}');
        let without_comment = without_line_bom.split('#').next().unwrap_or("");
        let trimmed = without_comment.trim();
        if !trimmed.is_empty() {
            entries.push(trimmed);
        }
    }
    entries
}

fn strip_wgsl_comments(source: &str) -> String {
    let mut cleaned = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut block_depth = 0usize;
    while index < bytes.len() {
        if block_depth > 0 {
            if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
                block_depth += 1;
                index += 2;
                continue;
            }
            if index + 1 < bytes.len() && bytes[index] == b'*' && bytes[index + 1] == b'/' {
                block_depth -= 1;
                index += 2;
                cleaned.push(' ');
                continue;
            }
            if bytes[index] == b'\n' {
                cleaned.push('\n');
            }
            index += 1;
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'/' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            block_depth = 1;
            index += 2;
            continue;
        }
        cleaned.push(bytes[index] as char);
        index += 1;
    }
    cleaned
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(crate) fn has_compute_entry_point(shader_source: &str, target_entry_point: &str) -> bool {
    let uncommented = strip_wgsl_comments(shader_source);
    let bytes = uncommented.as_bytes();
    let mut index = 0usize;
    let mut pending_compute = false;
    let mut awaiting_function_name = false;
    while index < bytes.len() {
        if bytes[index] == b'@' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && is_identifier_byte(bytes[end]) {
                end += 1;
            }
            if &uncommented[start..end] == "compute" {
                pending_compute = true;
            }
            index = end;
            continue;
        }
        if is_identifier_byte(bytes[index]) {
            let start = index;
            let mut end = start + 1;
            while end < bytes.len() && is_identifier_byte(bytes[end]) {
                end += 1;
            }
            let token = &uncommented[start..end];
            if awaiting_function_name {
                if pending_compute && token == target_entry_point {
                    return true;
                }
                awaiting_function_name = false;
                pending_compute = false;
            } else if token == "fn" {
                awaiting_function_name = true;
            }
            index = end;
            continue;
        }
        index += 1;
    }
    false
}

/// Concatenates the WGSL modules listed in `src/cycles/kernel-manifest.txt` in order and verifies a runnable `@compute`
/// `target_entry_point` exists (appending `bootstrap_main.wgsl` only when `allow_bootstrap` is true and the manifest lacks it).
pub(crate) fn assemble_cycles_kernel_entry(target_entry_point: &str, allow_bootstrap: bool) -> Result<String> {
    let entries = parse_kernel_manifest(KERNEL_MANIFEST_SOURCE);
    if entries.is_empty() {
        return Err(failure(
            "The Cycles native kernel cannot run: src/cycles/kernel-manifest.txt lists no WGSL files.",
        ));
    }
    let mut assembled = String::new();
    for entry in &entries {
        let (_, raw_bytes) = CYCLES_MANIFEST_FILES
            .iter()
            .find(|(name, _)| name == entry)
            .ok_or_else(|| failure(format!("Cycles kernel manifest entry is not embedded: {entry}")))?;
        let module_source = std::str::from_utf8(raw_bytes)
            .map_err(|error| failure(format!("Cycles kernel module {entry} is not valid UTF-8: {error}")))?
            .trim_start_matches('\u{feff}');
        if !assembled.is_empty() && !assembled.ends_with('\n') {
            assembled.push('\n');
        }
        assembled.push_str(module_source);
    }
    if !has_compute_entry_point(&assembled, target_entry_point) {
        if allow_bootstrap {
            if !assembled.ends_with('\n') {
                assembled.push('\n');
            }
            assembled.push_str(BOOTSTRAP_MAIN_SOURCE.trim_start_matches('\u{feff}'));
        }
        if !has_compute_entry_point(&assembled, target_entry_point) {
            return Err(failure(format!(
                "The Cycles native kernel cannot run yet: src/cycles/kernel-manifest.txt defines no @compute {target_entry_point} entry point (assembled modules: {}).",
                entries.join(", ")
            )));
        }
    }
    Ok(assembled)
}

pub(crate) fn assemble_cycles_kernel() -> Result<String> {
    assemble_cycles_kernel_entry("main", false)
}

#[cfg(test)]
mod tests {
    use super::{assemble_cycles_kernel, has_compute_entry_point, parse_kernel_manifest};

    #[test]
    fn parses_manifest_with_utf8_bom_and_comments() {
        let text = "\u{feff}# header\r\n\u{feff}abi.wgsl # inline comment\r\n  closure.wgsl \n\n";
        assert_eq!(parse_kernel_manifest(text), vec!["abi.wgsl", "closure.wgsl"]);
    }

    #[test]
    fn detects_named_compute_entry_points_independently() {
        let source = r#"
            // @compute fn main() {}
            fn helper() {}
            @compute @workgroup_size(64, 1, 1)
            fn test_lobe_samples() {}
            fn not_compute_main() {}
        "#;
        assert!(has_compute_entry_point(source, "test_lobe_samples"));
        assert!(!has_compute_entry_point(source, "main"));
        assert!(!has_compute_entry_point(source, "helper"));
    }

    /// The texel pool is read in one function. A second reader would sample with its own wrap and filter, and a cutout
    /// would then be seen through different texels than it is shaded with.
    #[test]
    fn the_kernel_reads_the_texel_pool_in_one_shared_sampler_only() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        let fetch_start = kernel.find("fn texture_fetch_texel(").expect("the shared texel fetch exists");
        let fetch_end = fetch_start + kernel[fetch_start..].find("\n}").expect("the fetch function ends");
        let reads_inside_fetch = kernel[fetch_start..fetch_end].matches("texture_texels[").count();
        assert_eq!(kernel.matches("texture_texels[").count(), reads_inside_fetch);
        assert!(reads_inside_fetch > 0);
        assert!(!kernel.contains("fn int_sample_texture_channel"));
        assert!(!kernel.contains("fn int_wrap_coord"));
        assert!(kernel.contains("texture_sample(material.base_color_tex, uv0, uv1).a"));
        assert!(kernel.contains("texture_sample(material.alpha_tex, uv0, uv1).r"));
    }

    /// Blender Cycles filters the stored values of an 8-bit sRGB image and decodes the blend. Decoding each texel before the
    /// blend reads 2 to 5 percent too bright on a checker map (#1030).
    #[test]
    fn an_srgb_map_is_decoded_after_the_filter_and_not_per_texel() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        let fetch_start = kernel.find("fn texture_fetch_texel(").expect("the shared texel fetch exists");
        let fetch_end = fetch_start + kernel[fetch_start..].find("\n}").expect("the fetch function ends");
        assert!(!kernel[fetch_start..fetch_end].contains("closure_srgb_to_linear"));
        assert!(kernel.contains("texture_decode_filtered(mix(mix(c00, c10, tx), mix(c01, c11, tx), ty), format)"));
        assert!(kernel.contains("texture_decode_filtered(texture_fetch_texel(desc, ix, iy, format), format)"));
    }

    /// Mip levels are opt in. The shared sampler without a footprint, which the alpha tests and the bump taps use, must read
    /// level 0 only, and a hit hands a footprint to the sampler only when the kernel flag is set.
    #[test]
    fn mip_levels_are_read_only_for_a_footprint_and_only_with_the_kernel_flag() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        assert!(kernel.contains("const KERNEL_FLAG_TEXTURE_MIPS: u32 = 2048u;"));
        assert!(kernel.contains("return texture_sample_footprint(tex_index, raw_uv0, raw_uv1, 0.0);"));
        assert!(kernel.contains("texture_sample_footprint(tex_index, (*point).uv0, (*point).uv1, (*point).uv_footprint)"));
        assert!(kernel.contains("if (uv_footprint > 0.0 && mip_count > 1u && !is_nearest)"));
        let build_start = kernel.find("fn int_build_shading_point(").expect("the shading point builder exists");
        let build_body = &kernel[build_start..];
        let flag_test = build_body.find("(kernel_params.kernel_flags & KERNEL_FLAG_TEXTURE_MIPS) != 0u").expect("the footprint is gated by the flag");
        let footprint_call = build_body.find("point.uv_footprint = int_uv_footprint(").expect("the footprint is computed");
        assert!(flag_test < footprint_call);
        assert!(build_body.contains("point.uv_footprint = 0.0;"));
    }

    /// The thin-sheet lobe is a cosine lobe on the far side of the shading normal that the closure builds only from the
    /// material extension record, splits off the diffuse layer, and that the integrator treats as a transmission bounce
    /// which leaves the medium alone.
    #[test]
    fn the_diffuse_transmission_lobe_splits_the_diffuse_layer_and_samples_the_far_side() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        assert!(
            kernel.contains("const SCENE_HAS_DIFFUSE_TRANSMISSION: bool = false;"),
            "an unspecialized kernel (a probe, a test) must not read extension records"
        );
        assert!(
            kernel.contains("SCENE_HAS_DIFFUSE_TRANSMISSION && arrayLength(&materials) >= 2u * kernel_params.material_count"),
            "the read of an extension record is guarded by the table length"
        );
        assert!(kernel.contains("const LOBE_DIFFUSE_TRANSMISSION: u32 = 7u;"));

        let build_start = kernel.find("fn closure_build(").expect("the closure builder exists");
        let build_body = &kernel[build_start..];
        let extension_read = build_body
            .find("materials[kernel_params.material_count + (*point).material_index]")
            .expect("the extension record follows the material records");
        let diffuse_split = build_body
            .find("let diffuse_weight = base_color * layer_weight * (1.0 - diffuse_transmission_weight);")
            .expect("the weight splits the diffuse layer");
        let far_side_lobe = build_body
            .find("closure_diffuse_transmission_setup_lobe(shading_n, diffuse_transmission_lobe_weight)")
            .expect("the far side lobe is built from the same layer weight");
        assert!(extension_read < diffuse_split && diffuse_split < far_side_lobe);
        assert!(build_body.contains("SCENE_HAS_DIFFUSE_TRANSMISSION
    && closure.lobe_count < CLOSURE_CANDIDATE_CAPACITY"));

        let eval_start = kernel.find("fn bsdf_diffuse_transmission_eval(").expect("the lobe is evaluated");
        let eval_end = eval_start + kernel[eval_start..].find("
}").expect("the evaluation ends");
        let eval_body = &kernel[eval_start..eval_end];
        assert!(eval_body.contains("let cos_far_side = -dot((*lobe).normal, wi);"));
        assert!(eval_body.contains("(*lobe).weight * pdf"));
        let sample_start = kernel.find("fn bsdf_diffuse_transmission_sample(").expect("the lobe is sampled");
        let sample_end = sample_start + kernel[sample_start..].find("
}").expect("the sampler ends");
        let sample_body = &kernel[sample_start..sample_end];
        assert!(sample_body.contains("bsdf_diffuse_sample_cos_hemisphere(-(*lobe).normal, rand)"));
        assert!(sample_body.contains("dot(geometric_normal, wi) >= 0.0"), "a sample must leave through the far side");

        let integrator_start = kernel.find("fn int_closure_has_transmission(").expect("the transmission test exists");
        let integrator_end = integrator_start + kernel[integrator_start..].find("
}").expect("the test ends");
        assert!(kernel[integrator_start..integrator_end].contains("LOBE_DIFFUSE_TRANSMISSION"));
        assert!(kernel.contains("(SCENE_HAS_GLASS || SCENE_HAS_DIFFUSE_TRANSMISSION) && int_closure_has_transmission(&closure)"));
        assert!(kernel.contains("&& !is_diffuse_transmission"), "a sheet is not a medium boundary");
    }

    /// The mip levels sit after level 0 in one run of words (`texture_fetch_texel` stays the only reader of the pool).
    #[test]
    fn a_mip_level_is_found_by_walking_the_halving_chain_from_level_0() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        let walk_start = kernel.find("fn texture_level_descriptor(").expect("the level descriptor walk exists");
        let walk_end = walk_start + kernel[walk_start..].find("\n}").expect("the walk ends");
        let walk = &kernel[walk_start..walk_end];
        assert!(walk.contains("select(1u, 4u, format == 2u)"));
        assert!(walk.contains("level_desc.width * level_desc.height * words_per_texel"));
        assert!(walk.contains("max(level_desc.width >> 1u, 1u)"));
        assert!(walk.contains("max(level_desc.height >> 1u, 1u)"));
        assert!(kernel.contains("return mix(lower, upper, blend);"), "two decoded levels blend in linear light");
        let level_start = kernel.find("fn texture_filter_level(").expect("the level filter exists");
        let level_end = level_start + kernel[level_start..].find("\n}").expect("the level filter ends");
        let level_filter = &kernel[level_start..level_end];
        let level_zero_branch = level_filter.find("if (level == 0u) {").expect("level 0 has its own branch");
        let first_decode = level_filter.find("let decoded_c00").expect("later levels decode their taps");
        let level_zero_return = "return texture_decode_filtered(mix(mix(level_c00, level_c10, level_tx), mix(level_c01, level_c11, level_tx), level_ty), format);";
        let return_position = level_filter.find(level_zero_return).expect("level 0 stays filter then decode (#1030)");
        assert!(level_zero_branch < return_position && return_position < first_decode);
        for tap in ["c00", "c10", "c01", "c11"] {
            assert!(
                level_filter.contains(&format!("let decoded_{tap} = texture_decode_filtered(level_{tap}, format);")),
                "a level after 0 decodes tap {tap} before the blend"
            );
        }
    }

    /// A point or spot light with a radius is a sphere (Blender's `use_soft_falloff` off, #1040): outside it Cook samples the cone
    /// of the sphere and a path that hits it uses the same cone pdf, inside it samples the surface, and the packed radiance is
    /// intensity over pi r^2 so the power does not change with the radius. The Cycles reference script switches
    /// `use_soft_falloff` off to render the same light; a light with the `SOFT_FALLOFF` flag is the oriented disk of Cycles (below).
    #[test]
    fn a_light_with_a_radius_is_a_sphere_with_one_pdf_for_sampling_and_hits() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        let sampler_start = kernel.find("fn lgt_sample_point_or_spot_light(").expect("the point and spot sampler exists");
        let sampler_end = sampler_start + kernel[sampler_start..].find("\nfn lgt_sample_area_light(").expect("the sampler ends");
        let sampler = &kernel[sampler_start..sampler_end];
        assert!(sampler.contains("lgt_sample_uniform_cone(center_dir, one_minus_cos_sphere, rand_uv, &cos_theta)"));
        assert!(sampler.contains("pdf_solid_angle = 1.0 / max(TWO_PI * one_minus_cos_sphere, 1.0e-30)"));
        assert!(sampler.contains("lgt_sample_uniform_sphere(rand_uv)"));
        assert!(kernel.contains("lgt_sphere_solid_angle_pdf(dist_sq, light.radius, hit_t, ray_origin, ray_dir, light.position)"));
        assert!(kernel.contains("if (hit_t <= t_min || hit_t >= t_max) {"));
        assert!(!kernel.contains("disk_light_sample"));
    }

    /// A light with `LIGHT_FLAG_SOFT_FALLOFF` (Blender's `use_soft_falloff`, #1060) is an oriented disk through its centre facing the
    /// shading point: sampling, the pdf of a path that reaches the disk and the light tree profile all read the same flag, the radiance
    /// is the sphere's, and a light without the flag takes the sphere branch untouched.
    #[test]
    fn a_soft_falloff_light_is_an_oriented_disk_for_sampling_hits_and_the_light_tree() {
        let kernel = assemble_cycles_kernel().expect("the kernel assembles");
        assert!(kernel.contains("const LIGHT_FLAG_SOFT_FALLOFF: u32 = 32u;"));

        let sampler_start = kernel.find("fn lgt_sample_point_or_spot_light(").expect("the point and spot sampler exists");
        let sampler_end = sampler_start + kernel[sampler_start..].find("
fn lgt_sample_area_light(").expect("the sampler ends");
        let sampler = &kernel[sampler_start..sampler_end];
        let flag_test = sampler.find("(light.flags & LIGHT_FLAG_SOFT_FALLOFF) != 0u").expect("the sampler tests the flag");
        let sphere_branch = sampler.find("lgt_sample_uniform_cone(center_dir").expect("the sphere branch exists");
        assert!(flag_test < sphere_branch, "the flag is tested before the sphere branch");
        assert!(sampler.contains("return lgt_sample_soft_falloff_light(light, shading_pos, rand_uv);"));

        let disk_start = kernel.find("fn lgt_sample_soft_falloff_light(").expect("the disk sampler exists");
        let disk_end = disk_start + kernel[disk_start..].find("
}
").expect("the disk sampler ends");
        let disk_sampler = &kernel[disk_start..disk_end];
        assert!(disk_sampler.contains("let disk_normal = from_light / center_distance;"));
        assert!(disk_sampler.contains("lgt_sample_unit_disk(rand_uv)"));
        assert!(disk_sampler.contains("lgt_soft_falloff_solid_angle_pdf(light.radius, disk_normal, -wi, distance)"));
        assert!(disk_sampler.contains("lgt_spot_attenuation(light, -wi)"));
        assert!(disk_sampler.contains("light.radiance * (spot_weight * falloff)"));

        let pdf_start = kernel.find("fn lgt_soft_falloff_solid_angle_pdf(").expect("the disk pdf exists");
        let pdf_end = pdf_start + kernel[pdf_start..].find("
}
").expect("the disk pdf ends");
        assert!(kernel[pdf_start..pdf_end].contains("(distance * distance) / (cos_light * PI * radius * radius)"));

        assert!(kernel.contains("lgt_ray_soft_falloff_intersect(ray_origin, ray_dir, light, t_min, t_max, &disk_hit_t, &disk_pdf_solid_angle)"));
        assert!(kernel.contains("let candidate_t = origin_distance / cos_angle;"));

        let profile_start = kernel.find("fn ltr_sphere_light_profile(").expect("the point and spot tree profile exists");
        let profile = &kernel[profile_start..profile_start + 900];
        assert!(profile.contains("(light.flags & LIGHT_FLAG_SOFT_FALLOFF) != 0u"));
        assert!(profile.contains("profile.cos_theta_u = min_distance / hypotenuse;"));
        assert!(profile.contains("profile.max_distance = hypotenuse;"));
    }

    #[test]
    fn the_bootstrap_entry_samples_alpha_through_the_shared_sampler() {
        let bootstrap = include_str!("bootstrap_main.wgsl");
        assert!(!bootstrap.contains("texture_texels["));
        assert!(bootstrap.contains("texture_sample("));
    }
}
