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

/// The compute entry point to run: `main`, or `light_tree_probe` when the input carries `KERNEL_FLAG_LIGHT_TREE_PROBE` (tests).
pub(crate) fn trace_entry_point(input: &NativeTraceInputV2) -> &'static str {
    let kernel_flags = read_u32_le(&input.kernel_params, KP_KERNEL_FLAGS_BYTE);
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
/// NOTE: Only replaces in `trace_scene_cycles` / `prepare_cycles_scene`. In `probe_cycles_lobe`
/// all flags stay `true` (which is the unspecialized default).
pub(crate) fn specialize_cycles_kernel(source: &str, input: &NativeTraceInputV2) -> String {
    let kp = &input.kernel_params;
    let mats = &input.materials;
    let lights = &input.lights;
    let instances = &input.instances;

    // --- KernelParamsV2 fields ---
    let kernel_flags = read_u32_le(kp, KP_KERNEL_FLAGS_BYTE);
    let volume_density = read_f32_le(kp, KP_VOLUME_DENSITY_BYTE);
    let env_width = read_u32_le(kp, KP_ENV_WIDTH_BYTE);
    let env_height = read_u32_le(kp, KP_ENV_HEIGHT_BYTE);
    let env_total_weight = read_f32_le(kp, KP_ENV_TOTAL_WEIGHT_BYTE);

    let has_volume = (kernel_flags & 2) != 0 && volume_density > 0.0;
    let has_env_importance = env_width > 0 && env_height > 0 && env_total_weight > 0.0;
    let has_light_tree = (kernel_flags & 1) != 0 && input.light_tree_node_count > 0;
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
        let candidate_lobes = trans_lobe + sheen_lobe + coat_lobe + base_lobes;
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

    #[test]
    fn the_bootstrap_entry_samples_alpha_through_the_shared_sampler() {
        let bootstrap = include_str!("bootstrap_main.wgsl");
        assert!(!bootstrap.contains("texture_texels["));
        assert!(bootstrap.contains("texture_sample("));
    }
}
