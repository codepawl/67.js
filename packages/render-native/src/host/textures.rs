use wgpu::util::DeviceExt;

use crate::host::device::{failure, storage_buffer};
use crate::{NativeTraceInput, NativeTraceInputV2};

const MATERIAL_TEXELS: usize = 10;
const CUTOUT_START_WORD_INDEX: usize = 47;

pub(crate) struct UploadedSceneBuffers {
    pub(crate) buffers: Vec<wgpu::Buffer>,
    pub(crate) accumulation: wgpu::Buffer,
    pub(crate) parameters: wgpu::Buffer,
}

/// Whether a material takes its alpha from a colour map and cuts at a threshold. A material is `MATERIAL_TEXELS` vec4s: the cutoff
/// is the third float of texel 3 and the width of the colour map's atlas rectangle the third float of texel 6.
/// A shadow-only material (the second float of texel 5) also goes in the non-opaque geometry: hardware commits opaque
/// triangles without asking the shader, and a camera ray must be able to step through this one.
pub(crate) fn material_is_cutout(materials: &[f32], material: usize) -> bool {
    let base = material * MATERIAL_TEXELS * 4;
    if base + 7 * 4 > materials.len() {
        return false;
    }
    let is_shadow_only = materials[base + 5 * 4 + 1] > 0.0;
    is_shadow_only || (materials[base + 3 * 4 + 2] > 0.0 && materials[base + 6 * 4 + 2] > 0.0)
}

/// The texel pool is one storage binding, so it cannot outgrow `limit_bytes` (the device's storage binding size, at most 1 GiB).
/// Failing here names the size and the way out; the device would only report a validation error with no hint about textures.
pub(crate) fn check_texture_pool_budget(pool_bytes: u64, limit_bytes: u64) -> napi::Result<()> {
    if pool_bytes <= limit_bytes {
        return Ok(());
    }
    const MEBIBYTE: u64 = 1 << 20;
    Err(failure(format!(
        "The textures take {} MiB but one texture pool holds at most {} MiB on this device. Pass smaller textures: downscale the largest maps or drop the ones the look does not need.",
        pool_bytes.div_ceil(MEBIBYTE),
        limit_bytes / MEBIBYTE,
    )))
}

pub(crate) fn upload_scene_buffers(
    device: &wgpu::Device,
    input: &NativeTraceInput,
    triangle_data: &[f32],
    slot_map: &[u32],
    opaque_count: usize,
    accumulation_bytes: u64,
    extra_buffers: &[(&str, Vec<u8>)],
) -> UploadedSceneBuffers {
    // Word 47 of the parameter block tells the kernel where the cutout primitives start in `slot_map`.
    let mut parameter_bytes = input.parameters.to_vec();
    let cutout_offset_start = CUTOUT_START_WORD_INDEX * 4;
    parameter_bytes[cutout_offset_start..cutout_offset_start + 4]
        .copy_from_slice(&(opaque_count as u32).to_le_bytes());

    let mut buffers = vec![
        storage_buffer(device, "triangles", bytemuck::cast_slice(triangle_data)),
        storage_buffer(device, "materials", bytemuck::cast_slice(&input.materials)),
        storage_buffer(device, "lights", bytemuck::cast_slice(&input.lights)),
        storage_buffer(device, "atlas", bytemuck::cast_slice(&input.atlas)),
        storage_buffer(device, "environment colors", bytemuck::cast_slice(&input.environment_colors)),
        storage_buffer(device, "environment tables", bytemuck::cast_slice(&input.environment_tables)),
    ];
    buffers.push(storage_buffer(device, "primitive slots", bytemuck::cast_slice(slot_map)));

    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("accumulation"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    for (label, bytes) in extra_buffers {
        buffers.push(storage_buffer(device, label, bytes));
    }
    let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("parameters"),
        contents: &parameter_bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    UploadedSceneBuffers {
        buffers,
        accumulation,
        parameters,
    }
}

const EMPTY_LIGHT_TREE_EMITTER: [u8; 32] = [0u8; 32];
const EMPTY_LIGHT_TO_TREE: [u32; 1] = [0u32; 1];

/// The emitter table of an input, or one zeroed record for an input packed without a light tree.
fn light_tree_emitter_bytes(input: &NativeTraceInputV2) -> &[u8] {
    match &input.light_tree_emitters {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => &EMPTY_LIGHT_TREE_EMITTER,
    }
}

fn light_to_tree_words(input: &NativeTraceInputV2) -> &[u32] {
    match &input.light_to_tree {
        Some(words) if !words.is_empty() => words,
        _ => &EMPTY_LIGHT_TO_TREE,
    }
}

pub(crate) fn upload_cycles_scene_buffers(
    device: &wgpu::Device,
    input: &NativeTraceInputV2,
    width: u32,
    height: u32,
    total_samples: u32,
    accumulation_bytes: u64,
) -> UploadedSceneBuffers {
    let mut parameter_bytes = input.kernel_params.to_vec();
    parameter_bytes[8..12].copy_from_slice(&width.to_le_bytes());
    parameter_bytes[12..16].copy_from_slice(&height.to_le_bytes());
    parameter_bytes[24..28].copy_from_slice(&total_samples.to_le_bytes());

    // Bindings 2..=10 in FORMAT-v2 order, then the light tree tables for bindings 13 and 14.
    let buffers = vec![
        storage_buffer(device, "cycles instances", &input.instances),
        storage_buffer(device, "cycles triangles", &input.triangles),
        storage_buffer(device, "cycles materials", &input.materials),
        storage_buffer(device, "cycles emissive triangles", &input.emissive_triangles),
        storage_buffer(device, "cycles lights", &input.lights),
        storage_buffer(device, "cycles light tree nodes", &input.light_tree_nodes),
        storage_buffer(device, "cycles texture descriptors", &input.texture_descriptors),
        storage_buffer(device, "cycles texture texels", bytemuck::cast_slice(&input.texture_texels)),
        storage_buffer(device, "cycles environment texels", bytemuck::cast_slice(&input.environment_texels)),
        // Bound at 13 and 14 by `create_cycles_bind_group`: the light tree emitters and the emitter-to-slot table.
        storage_buffer(device, "cycles light tree emitters", light_tree_emitter_bytes(input)),
        storage_buffer(device, "cycles light to tree", bytemuck::cast_slice(light_to_tree_words(input))),
    ];
    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("cycles film accumulation"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("cycles kernel params"),
        contents: &parameter_bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    UploadedSceneBuffers {
        buffers,
        accumulation,
        parameters,
    }
}

#[cfg(test)]
mod tests {
    use super::check_texture_pool_budget;

    #[test]
    fn texture_pool_budget_accepts_a_pool_at_the_limit() {
        assert!(check_texture_pool_budget(1 << 30, 1 << 30).is_ok());
        assert!(check_texture_pool_budget(0, 1 << 20).is_ok());
    }

    #[test]
    fn texture_pool_budget_error_names_the_size_the_limit_and_the_fix() {
        let message = check_texture_pool_budget((1 << 30) + 1, 1 << 30).unwrap_err().reason;
        assert!(message.contains("1025 MiB"), "{message}");
        assert!(message.contains("1024 MiB"), "{message}");
        assert!(message.contains("Pass smaller textures"), "{message}");
    }
}
