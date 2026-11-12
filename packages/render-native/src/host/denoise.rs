use std::time::Instant;

use napi::Result;
use wgpu::util::DeviceExt;

use crate::host::device::{failure, layout_entry, storage_entry};
use crate::host::film::{image_workgroups, read_accumulation};
use crate::host::session::compile_compute_pipeline;

const SHADER_SOURCE: &str = include_str!("../denoise_atrous.wgsl");
/// The distance between the taps of each pass; the five passes cover a 61 pixel radius.
const PASS_STEPS: [u32; 5] = [1, 2, 4, 8, 16];
const MAXIMUM_BUFFER_BYTES: u64 = 1 << 30;

/// The guide planes of one traced image, row by row from the top (the layout `ResolvedImage` has).
pub(crate) struct DenoiseInput<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: &'a [f32],
    pub(crate) albedo: &'a [f32],
    pub(crate) normal: &'a [f32],
    pub(crate) depth: &'a [f32],
    pub(crate) variance: &'a [f32],
}

pub(crate) struct DenoiseOutput {
    pub(crate) rgba: Vec<f32>,
    pub(crate) compile_seconds: f64,
    pub(crate) upload_seconds: f64,
    /// From the submit of the seven dispatches until the device reports them done.
    pub(crate) gpu_seconds: f64,
    pub(crate) readback_seconds: f64,
}

fn denoise_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let mut entries = vec![layout_entry(
        0,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
    )];
    entries.extend((1..=7).map(|binding| storage_entry(binding, false)));
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("a-trous filter"),
        entries: &entries,
    })
}

fn float_buffer(device: &wgpu::Device, label: &str, values: &[f32], extra_usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(values),
        usage: wgpu::BufferUsages::STORAGE | extra_usage,
    })
}

fn empty_light_buffer(device: &wgpu::Device, label: &str, pixel_count: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: pixel_count * 16,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    })
}

fn parameter_buffer(device: &wgpu::Device, width: u32, height: u32, pass_step: u32, read_from_b: u32) -> wgpu::Buffer {
    let words = [width, height, pass_step, read_from_b];
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("a-trous parameters"),
        contents: bytemuck::cast_slice(&words),
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

fn validate_input(input: &DenoiseInput) -> Result<()> {
    let pixel_count = input.width as usize * input.height as usize;
    if input.width == 0 || input.height == 0 {
        return Err(failure("The a-trous filter needs a width and a height of at least 1."));
    }
    if pixel_count as u64 * 16 > MAXIMUM_BUFFER_BYTES {
        return Err(failure("The image is too large for the a-trous filter's buffers."));
    }
    let planes = [
        ("rgba", input.rgba.len(), pixel_count * 4),
        ("albedo", input.albedo.len(), pixel_count * 3),
        ("normal", input.normal.len(), pixel_count * 3),
        ("depth", input.depth.len(), pixel_count),
        ("variance", input.variance.len(), pixel_count),
    ];
    for (name, actual, expected) in planes {
        if actual != expected {
            return Err(failure(format!(
                "The a-trous filter expects {expected} floats in `{name}` for a {}x{} image, got {actual}.",
                input.width, input.height
            )));
        }
    }
    Ok(())
}

/// Filters the traced colour with the a-trous wavelet filter and returns linear RGBA with alpha 1.
pub(crate) fn atrous_denoise(device: &wgpu::Device, queue: &wgpu::Queue, input: &DenoiseInput) -> Result<DenoiseOutput> {
    validate_input(input)?;
    let pixel_count = input.width as u64 * input.height as u64;

    let compile_started = Instant::now();
    let layout = denoise_layout(device);
    let prepare_pipeline = compile_compute_pipeline(device, SHADER_SOURCE.to_string(), "prepare", &layout)?;
    let atrous_pipeline = compile_compute_pipeline(device, SHADER_SOURCE.to_string(), "atrous", &layout)?;
    let finish_pipeline = compile_compute_pipeline(device, SHADER_SOURCE.to_string(), "finish", &layout)?;
    let compile_seconds = compile_started.elapsed().as_secs_f64();

    let upload_started = Instant::now();
    let color = float_buffer(device, "a-trous color", input.rgba, wgpu::BufferUsages::COPY_SRC);
    let albedo = float_buffer(device, "a-trous albedo", input.albedo, wgpu::BufferUsages::empty());
    let normal = float_buffer(device, "a-trous normal", input.normal, wgpu::BufferUsages::empty());
    let depth = float_buffer(device, "a-trous depth", input.depth, wgpu::BufferUsages::empty());
    let variance = float_buffer(device, "a-trous variance", input.variance, wgpu::BufferUsages::empty());
    let light_a = empty_light_buffer(device, "a-trous light a", pixel_count);
    let light_b = empty_light_buffer(device, "a-trous light b", pixel_count);
    let bind_groups: Vec<wgpu::BindGroup> = PASS_STEPS
        .iter()
        .enumerate()
        .map(|(pass_index, pass_step)| {
            let parameters = parameter_buffer(device, input.width, input.height, *pass_step, (pass_index % 2) as u32);
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("a-trous pass"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: parameters.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: color.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: albedo.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: normal.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: depth.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 5, resource: variance.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: light_a.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 7, resource: light_b.as_entire_binding() },
                ],
            })
        })
        .collect();
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let upload_seconds = upload_started.elapsed().as_secs_f64();

    let groups = image_workgroups(input.width, input.height);
    let gpu_started = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("a-trous filter"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&prepare_pipeline);
        pass.set_bind_group(0, &bind_groups[0], &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }
    for bind_group in &bind_groups {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&atrous_pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&finish_pipeline);
        pass.set_bind_group(0, &bind_groups[0], &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }
    queue.submit(Some(encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let gpu_seconds = gpu_started.elapsed().as_secs_f64();

    let readback_started = Instant::now();
    let rgba = read_accumulation(device, queue, &color, pixel_count * 16)?;
    let readback_seconds = readback_started.elapsed().as_secs_f64();
    Ok(DenoiseOutput {
        rgba,
        compile_seconds,
        upload_seconds,
        gpu_seconds,
        readback_seconds,
    })
}
