use std::time::Instant;

use napi::Result;

use crate::host::accel::{
    build_acceleration_structure, create_vertex_buffer, unpack_triangles, TRIANGLE_FLOATS,
};
use crate::host::device::{failure, layout_entry, open_device, storage_entry};
use crate::host::film::read_accumulation;
use crate::host::textures::upload_scene_buffers;
use crate::NativeTraceInput;

const PARAMETER_BYTES: usize = 16 * 16;
const VOLUME_DENSITY_BYTE_OFFSET: usize = 51 * 4;
const SUBSURFACE_OFFSET_BYTE_OFFSET: usize = 60 * 4;
const SAMPLE_INDEX_BYTE_OFFSET: u64 = 43 * 4;
const SAMPLES_PER_WAIT: u32 = 4;

/// A device with the scene's acceleration structure built and one compute pipeline bound to it.
pub(crate) struct PreparedScene {
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    pub(crate) pipeline: wgpu::ComputePipeline,
    pub(crate) bind_group: wgpu::BindGroup,
    pub(crate) accumulation: wgpu::Buffer,
    pub(crate) parameters: wgpu::Buffer,
    pub(crate) adapter_name: String,
    pub(crate) backend_name: String,
    pub(crate) features: String,
    pub(crate) setup_seconds: f64,
    pub(crate) compile_seconds: f64,
    pub(crate) upload_seconds: f64,
    pub(crate) acceleration_build_seconds: f64,
    // The bind group keeps the buffers and the structure alive; holding them here makes that visible.
    pub(crate) _buffers: Vec<wgpu::Buffer>,
    pub(crate) _tlas: wgpu::Tlas,
}

/// What one kind of job adds to the shared scene setup: the kernel text, its entry point, the accumulation size and the
/// extra read only buffers bound after the accumulation (bindings 9 and up).
pub(crate) struct JobShape<'a> {
    pub(crate) source: String,
    pub(crate) entry_point: &'a str,
    pub(crate) rewrite_specialization_flags: bool,
    pub(crate) accumulation_bytes: u64,
    pub(crate) extra_buffers: Vec<(&'a str, Vec<u8>)>,
}

fn specialize_legacy_kernel(source: &str, parameter_bytes: &[u8]) -> String {
    // Fog and subsurface scattering compile in only for a scene that uses them: the legacy kernel declares both as false constants.
    let fog_density_bytes: [u8; 4] = parameter_bytes[VOLUME_DENSITY_BYTE_OFFSET..VOLUME_DENSITY_BYTE_OFFSET + 4]
        .try_into()
        .unwrap();
    let subsurface_offset_bytes: [u8; 4] = parameter_bytes[SUBSURFACE_OFFSET_BYTE_OFFSET..SUBSURFACE_OFFSET_BYTE_OFFSET + 4]
        .try_into()
        .unwrap();
    let fog_density = f32::from_le_bytes(fog_density_bytes);
    let subsurface_offset = u32::from_le_bytes(subsurface_offset_bytes);
    source
        .replace("const HAS_VOLUME: bool = false;", &format!("const HAS_VOLUME: bool = {};", fog_density > 0.0))
        .replace("const HAS_SUBSURFACE: bool = false;", &format!("const HAS_SUBSURFACE: bool = {};", subsurface_offset > 0))
}

fn create_bind_group_layout(device: &wgpu::Device, extra_buffer_count: usize) -> wgpu::BindGroupLayout {
    let mut layout_entries = vec![
        layout_entry(
            0,
            wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
        ),
        layout_entry(1, wgpu::BindingType::AccelerationStructure { vertex_return: false }),
    ];
    layout_entries.extend((2..=7).map(|binding| storage_entry(binding, true)));
    layout_entries.push(storage_entry(8, false));
    layout_entries.extend((0..extra_buffer_count + 1).map(|offset| storage_entry(9 + offset as u32, true)));
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("path tracer"),
        entries: &layout_entries,
    })
}

fn compile_compute_pipeline(
    device: &wgpu::Device,
    shader_source: String,
    entry_point: &str,
    bind_group_layout: &wgpu::BindGroupLayout,
) -> Result<wgpu::ComputePipeline> {
    let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("path tracer"),
        source: wgpu::ShaderSource::Wgsl(shader_source.into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("path tracer"),
        bind_group_layouts: &[Some(bind_group_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("path tracer"),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    });
    if let Some(validation_error) = pollster::block_on(error_scope.pop()) {
        return Err(failure(format!("Could not compile the native kernel: {validation_error}")));
    }
    Ok(pipeline)
}

fn create_scene_bind_group(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    parameters: &wgpu::Buffer,
    tlas: &wgpu::Tlas,
    buffers: &[wgpu::Buffer],
    accumulation: &wgpu::Buffer,
) -> wgpu::BindGroup {
    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: parameters.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: tlas.as_binding() },
    ];
    for (offset, buffer) in buffers[..6].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: 2 + offset as u32,
            resource: buffer.as_entire_binding(),
        });
    }
    entries.push(wgpu::BindGroupEntry {
        binding: 8,
        resource: accumulation.as_entire_binding(),
    });
    for (offset, buffer) in buffers[6..].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: 9 + offset as u32,
            resource: buffer.as_entire_binding(),
        });
    }
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("path tracer"),
        layout: bind_group_layout,
        entries: &entries,
    })
}

pub(crate) fn prepare_scene(input: &NativeTraceInput, shape: JobShape) -> Result<PreparedScene> {
    let setup_started = Instant::now();
    let triangle_count = input.triangle_count as usize;
    if triangle_count == 0 || input.triangles.len() < triangle_count * TRIANGLE_FLOATS {
        return Err(failure("The triangle table must hold triangle_count triangles of 9 texels."));
    }
    let triangle_data: &[f32] = &input.triangles[..triangle_count * TRIANGLE_FLOATS];
    if input.parameters.len() != PARAMETER_BYTES {
        return Err(failure("The parameter block must be 256 bytes."));
    }
    let (device, queue, adapter_info) = open_device()?;
    let setup_seconds = setup_started.elapsed().as_secs_f64();

    let compile_started = Instant::now();
    let shader_source = if shape.rewrite_specialization_flags {
        specialize_legacy_kernel(&shape.source, &input.parameters)
    } else {
        shape.source
    };
    let bind_group_layout = create_bind_group_layout(&device, shape.extra_buffers.len());
    let pipeline = compile_compute_pipeline(&device, shader_source, shape.entry_point, &bind_group_layout)?;
    let compile_seconds = compile_started.elapsed().as_secs_f64();

    let upload_started = Instant::now();
    let unpacked = unpack_triangles(triangle_data, &input.materials, triangle_count);
    let vertex_buffer = create_vertex_buffer(&device, &unpacked.vertices);
    let uploaded = upload_scene_buffers(
        &device,
        input,
        triangle_data,
        &unpacked.slot_map,
        unpacked.opaque_count,
        shape.accumulation_bytes,
        &shape.extra_buffers,
    );
    let upload_seconds = upload_started.elapsed().as_secs_f64();

    let build_started = Instant::now();
    let tlas = build_acceleration_structure(&device, &queue, &vertex_buffer, triangle_count, unpacked.opaque_count);
    let acceleration_build_seconds = build_started.elapsed().as_secs_f64();

    let bind_group = create_scene_bind_group(
        &device,
        &bind_group_layout,
        &uploaded.parameters,
        &tlas,
        &uploaded.buffers,
        &uploaded.accumulation,
    );
    let has_ray_query = device.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
    let features = if has_ray_query { "EXPERIMENTAL_RAY_QUERY" } else { "" };
    Ok(PreparedScene {
        device,
        queue,
        pipeline,
        bind_group,
        accumulation: uploaded.accumulation,
        parameters: uploaded.parameters,
        adapter_name: adapter_info.name,
        backend_name: format!("{:?}", adapter_info.backend),
        features: features.to_string(),
        setup_seconds,
        compile_seconds,
        upload_seconds,
        acceleration_build_seconds,
        _buffers: uploaded.buffers,
        _tlas: tlas,
    })
}

/// Runs every sample over `groups` workgroups and copies the accumulation back. `max_seconds` bounds the run: past it the
/// trace stops with an error instead of finishing, checked each time the CPU waits for the card.
pub(crate) fn trace_samples(
    prepared: &PreparedScene,
    samples: u32,
    groups: (u32, u32),
    accumulation_bytes: u64,
    max_seconds: Option<f64>,
) -> Result<(Vec<f32>, f64)> {
    let trace_started = Instant::now();
    let device = &prepared.device;
    let queue = &prepared.queue;
    for sample_index in 0..samples {
        queue.write_buffer(&prepared.parameters, SAMPLE_INDEX_BYTE_OFFSET, &sample_index.to_le_bytes());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("sample"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(&prepared.pipeline);
            pass.set_bind_group(0, &prepared.bind_group, &[]);
            pass.dispatch_workgroups(groups.0, groups.1, 1);
        }
        queue.submit(Some(encoder.finish()));
        if (sample_index + 1) % SAMPLES_PER_WAIT == 0 {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            if let Some(limit) = max_seconds {
                if trace_started.elapsed().as_secs_f64() > limit {
                    return Err(failure(format!(
                        "The native trace passed its time limit of {limit} s after {} of {samples} samples.",
                        sample_index + 1
                    )));
                }
            }
        }
    }
    let sums = read_accumulation(device, queue, &prepared.accumulation, accumulation_bytes)?;
    Ok((sums, trace_started.elapsed().as_secs_f64()))
}
