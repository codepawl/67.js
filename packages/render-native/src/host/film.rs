use napi::Result;

use crate::host::device::failure;

const WORKGROUP_SIZE: u32 = 8;
/// Must match `TEXEL_WORKGROUP_SIZE` in texel.wgsl.
const TEXEL_WORKGROUP_SIZE: u32 = 64;
/// A dispatch is at most 65535 workgroups wide; a larger bake wraps onto the second dimension.
const MAXIMUM_TEXEL_GROUPS_X: u32 = 4096;

pub(crate) struct ResolvedImage {
    pub(crate) rgba: Vec<f32>,
    pub(crate) albedo: Vec<f32>,
    pub(crate) normal: Vec<f32>,
    pub(crate) depth: Vec<f32>,
    pub(crate) variance: Vec<f32>,
    pub(crate) average_samples: f64,
}

pub(crate) struct ResolvedTexels {
    pub(crate) radiance: Vec<f32>,
    pub(crate) escaped: Vec<f32>,
}

pub(crate) fn image_accumulation_bytes(width: u32, height: u32) -> u64 {
    let pixel_count = width as u64 * height as u64;
    pixel_count * 4 * 16
}

pub(crate) fn image_workgroups(width: u32, height: u32) -> (u32, u32) {
    let groups_x = width.div_ceil(WORKGROUP_SIZE);
    let groups_y = height.div_ceil(WORKGROUP_SIZE);
    (groups_x, groups_y)
}

pub(crate) fn texel_accumulation_bytes(count: usize) -> u64 {
    count as u64 * 2 * 16
}

pub(crate) fn texel_workgroups(count: u32) -> (u32, u32) {
    let workgroups = count.div_ceil(TEXEL_WORKGROUP_SIZE);
    let groups_x = workgroups.min(MAXIMUM_TEXEL_GROUPS_X);
    let groups_y = workgroups.div_ceil(groups_x);
    (groups_x, groups_y)
}

pub(crate) fn read_accumulation(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    accumulation: &wgpu::Buffer,
    accumulation_bytes: u64,
) -> Result<Vec<f32>> {
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("readback"),
    });
    copy_encoder.copy_buffer_to_buffer(accumulation, 0, &readback, 0, accumulation_bytes);
    queue.submit(Some(copy_encoder.finish()));
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .map_err(|error| failure(format!("Could not read the result back: {error}")))?;
    let sums: Vec<f32> = bytemuck::cast_slice::<u8, f32>(&mapped).to_vec();
    drop(mapped);
    Ok(sums)
}

pub(crate) fn resolve_image(sums: &[f32], pixel_count: u64) -> ResolvedImage {
    let pixel_total = pixel_count as usize;
    let plane_length = pixel_total * 4;
    let mut taken_total = 0.0f64;
    let mut rgba = Vec::with_capacity(pixel_total * 4);
    let mut albedo = Vec::with_capacity(pixel_total * 3);
    let mut normal = Vec::with_capacity(pixel_total * 3);
    let mut depth = Vec::with_capacity(pixel_total);
    let mut variance = Vec::with_capacity(pixel_total);
    for pixel in 0..pixel_total {
        let radiance = &sums[pixel * 4..pixel * 4 + 4];
        let albedo_sum = &sums[plane_length + pixel * 4..plane_length + pixel * 4 + 3];
        let normal_sum = &sums[2 * plane_length + pixel * 4..2 * plane_length + pixel * 4 + 3];
        let statistics = &sums[3 * plane_length + pixel * 4..3 * plane_length + pixel * 4 + 4];
        // A pixel that converged early drew fewer samples; its sums are divided by its own count.
        let taken = statistics[3].max(1.0);
        taken_total += taken as f64;
        let sample_scale = 1.0 / taken;
        let variance_divisor = (taken - 1.0).max(1.0);
        rgba.extend_from_slice(&[
            radiance[0] * sample_scale,
            radiance[1] * sample_scale,
            radiance[2] * sample_scale,
            1.0,
        ]);
        depth.push(radiance[3] * sample_scale);
        albedo.extend(albedo_sum.iter().map(|value| value * sample_scale));
        normal.extend(normal_sum.iter().map(|value| value * sample_scale));
        let mean_luminance = statistics[0] * sample_scale;
        let luminance_variance = (statistics[1] * sample_scale - mean_luminance * mean_luminance).max(0.0);
        variance.push(luminance_variance / variance_divisor);
    }
    let average_samples = taken_total / pixel_count.max(1) as f64;
    ResolvedImage {
        rgba,
        albedo,
        normal,
        depth,
        variance,
        average_samples,
    }
}

/// Three floats per texel, padded to the four the kernel's vec4 arrays read.
pub(crate) fn pad_texel_vectors(vectors: &[f32], count: usize) -> Vec<u8> {
    let mut padded: Vec<f32> = Vec::with_capacity(count * 4);
    for texel in 0..count {
        padded.extend_from_slice(&vectors[texel * 3..texel * 3 + 3]);
        padded.push(0.0);
    }
    bytemuck::cast_slice(&padded).to_vec()
}

pub(crate) fn resolve_texels(sums: &[f32], count: usize, samples: u32) -> ResolvedTexels {
    let sample_scale = 1.0 / samples.max(1) as f32;
    let mut radiance = Vec::with_capacity(count * 3);
    let mut escaped = Vec::with_capacity(count);
    for texel in 0..count {
        radiance.extend(sums[texel * 4..texel * 4 + 3].iter().map(|value| value * sample_scale));
        escaped.push(sums[(count + texel) * 4] * sample_scale);
    }
    ResolvedTexels { radiance, escaped }
}
