use std::time::Instant;

use napi::Result;
use wgpu::util::DeviceExt;

use crate::host::accel::{
    build_acceleration_structure, build_cycles_acceleration_structure, build_empty_cycles_acceleration,
    create_vertex_buffer, unpack_triangles, CyclesAcceleration, INSTANCE_RECORD_BYTES, TRIANGLE_FLOATS,
    TRIANGLE_RECORD_BYTES,
};
use crate::host::device::{failure, layout_entry, open_device, storage_buffer, storage_entry};
use crate::host::film::{image_accumulation_bytes, read_accumulation};
use crate::host::textures::{upload_cycles_scene_buffers, upload_scene_buffers};
use crate::{NativeTraceInput, NativeTraceInputV2, ProbeCyclesLobeOptions};

const PARAMETER_BYTES: usize = 16 * 16;
const VOLUME_DENSITY_BYTE_OFFSET: usize = 51 * 4;
const SUBSURFACE_OFFSET_BYTE_OFFSET: usize = 60 * 4;
const SAMPLE_INDEX_BYTE_OFFSET: u64 = 43 * 4;
const SAMPLES_PER_WAIT: u32 = 4;

const KERNEL_PARAMS_V2_BYTES: usize = 320;
const FORMAT_V2_MAGIC: u32 = 0x36375054;
const FORMAT_V2_VERSION: u32 = 2;
const MATERIAL_RECORD_BYTES: usize = 256;
const EMISSIVE_TRIANGLE_RECORD_BYTES: usize = 96;
const LIGHT_RECORD_BYTES: usize = 128;
const LIGHT_TREE_NODE_BYTES: usize = 64;
const TEXTURE_DESCRIPTOR_BYTES: usize = 32;
const CYCLES_SAMPLE_OFFSET_BYTE_OFFSET: u64 = 16;
const LOBE_PROBE_WORKGROUP_SIZE: u32 = 64;
const MAX_COMPUTE_WORKGROUPS_PER_DIMENSION: u64 = 65_535;

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

pub(crate) struct PreparedCyclesScene {
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
    pub(crate) _buffers: Vec<wgpu::Buffer>,
    pub(crate) _acceleration: CyclesAcceleration,
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

fn create_cycles_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
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
    layout_entries.extend((2..=10).map(|binding| storage_entry(binding, true)));
    layout_entries.push(storage_entry(11, false));
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("cycles path tracer"),
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

fn create_cycles_bind_group(
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
    for (offset, buffer) in buffers.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: 2 + offset as u32,
            resource: buffer.as_entire_binding(),
        });
    }
    entries.push(wgpu::BindGroupEntry {
        binding: 11,
        resource: accumulation.as_entire_binding(),
    });
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("cycles path tracer"),
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

fn validate_kernel_params_v2(parameter_bytes: &[u8]) -> Result<()> {
    if parameter_bytes.len() != KERNEL_PARAMS_V2_BYTES {
        return Err(failure(format!(
            "KernelParamsV2 must be {KERNEL_PARAMS_V2_BYTES} bytes, got {}.",
            parameter_bytes.len()
        )));
    }
    let magic = u32::from_le_bytes(parameter_bytes[0..4].try_into().unwrap());
    if magic != FORMAT_V2_MAGIC {
        return Err(failure(format!(
            "Invalid KernelParamsV2 magic 0x{magic:08x}: expected 0x{FORMAT_V2_MAGIC:08x}."
        )));
    }
    let version = u32::from_le_bytes(parameter_bytes[4..8].try_into().unwrap());
    if version != FORMAT_V2_VERSION {
        return Err(failure(format!(
            "Unsupported KernelParamsV2 format_version {version}: expected {FORMAT_V2_VERSION}."
        )));
    }
    Ok(())
}

fn validate_record_buffer(label: &str, bytes: &[u8], count: u32, stride: usize) -> Result<()> {
    let minimum_bytes = (count.max(1) as usize) * stride;
    if bytes.len() < minimum_bytes || bytes.len() % stride != 0 {
        return Err(failure(format!(
            "FORMAT-v2 {label} buffer must be a multiple of {stride} bytes and at least {minimum_bytes} bytes for count {count}, got {} bytes.",
            bytes.len()
        )));
    }
    Ok(())
}

pub(crate) fn prepare_cycles_scene(
    input: &NativeTraceInputV2,
    shader_source: String,
    width: u32,
    height: u32,
    total_samples: u32,
    accumulation_bytes: u64,
) -> Result<PreparedCyclesScene> {
    let setup_started = Instant::now();
    if width == 0 || height == 0 {
        return Err(failure("Trace width and height must both be >= 1."));
    }
    if total_samples == 0 {
        return Err(failure("Trace samples must be >= 1."));
    }
    if input.schema_version != FORMAT_V2_VERSION {
        return Err(failure(format!(
            "Invalid FORMAT-v2 input schemaVersion {}: expected {FORMAT_V2_VERSION}.",
            input.schema_version
        )));
    }
    validate_kernel_params_v2(&input.kernel_params)?;
    validate_record_buffer("instances", &input.instances, input.instance_count, INSTANCE_RECORD_BYTES)?;
    validate_record_buffer("triangles", &input.triangles, input.triangle_count, TRIANGLE_RECORD_BYTES)?;
    validate_record_buffer("materials", &input.materials, input.material_count, MATERIAL_RECORD_BYTES)?;
    validate_record_buffer(
        "emissiveTriangles",
        &input.emissive_triangles,
        input.emissive_triangle_count,
        EMISSIVE_TRIANGLE_RECORD_BYTES,
    )?;
    validate_record_buffer("lights", &input.lights, input.light_count, LIGHT_RECORD_BYTES)?;
    validate_record_buffer(
        "lightTreeNodes",
        &input.light_tree_nodes,
        input.light_tree_node_count,
        LIGHT_TREE_NODE_BYTES,
    )?;
    validate_record_buffer(
        "textureDescriptors",
        &input.texture_descriptors,
        input.texture_count,
        TEXTURE_DESCRIPTOR_BYTES,
    )?;

    let (device, queue, adapter_info) = open_device()?;
    let setup_seconds = setup_started.elapsed().as_secs_f64();

    let compile_started = Instant::now();
    let bind_group_layout = create_cycles_bind_group_layout(&device);
    let pipeline = compile_compute_pipeline(&device, shader_source, "main", &bind_group_layout)?;
    let compile_seconds = compile_started.elapsed().as_secs_f64();

    let upload_started = Instant::now();
    let uploaded = upload_cycles_scene_buffers(&device, input, width, height, total_samples, accumulation_bytes);
    let upload_seconds = upload_started.elapsed().as_secs_f64();

    let build_started = Instant::now();
    let acceleration = build_cycles_acceleration_structure(
        &device,
        &queue,
        &input.instances,
        input.instance_count as usize,
        &input.triangles,
        input.triangle_count as usize,
    )?;
    let acceleration_build_seconds = build_started.elapsed().as_secs_f64();

    let bind_group = create_cycles_bind_group(
        &device,
        &bind_group_layout,
        &uploaded.parameters,
        &acceleration.tlas,
        &uploaded.buffers,
        &uploaded.accumulation,
    );
    let has_ray_query = device.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
    let features = if has_ray_query { "EXPERIMENTAL_RAY_QUERY" } else { "" };
    Ok(PreparedCyclesScene {
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
        _acceleration: acceleration,
    })
}

pub(crate) fn trace_cycles_samples(
    prepared: &PreparedCyclesScene,
    samples: u32,
    samples_per_dispatch: u32,
    groups: (u32, u32),
    accumulation_bytes: u64,
    max_seconds: Option<f64>,
) -> Result<(Vec<f32>, f64)> {
    let trace_started = Instant::now();
    let device = &prepared.device;
    let queue = &prepared.queue;
    let step = samples_per_dispatch.max(1);
    let mut sample_offset = 0u32;
    let mut dispatch_count = 0u32;

    while sample_offset < samples {
        let batch_samples = (samples - sample_offset).min(step);
        let mut dispatch_words = [0u8; 8];
        dispatch_words[0..4].copy_from_slice(&sample_offset.to_le_bytes());
        dispatch_words[4..8].copy_from_slice(&batch_samples.to_le_bytes());
        queue.write_buffer(&prepared.parameters, CYCLES_SAMPLE_OFFSET_BYTE_OFFSET, &dispatch_words);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("cycles sample batch"),
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

        sample_offset += batch_samples;
        dispatch_count += 1;
        if dispatch_count % SAMPLES_PER_WAIT == 0 || sample_offset >= samples {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            if let Some(limit) = max_seconds {
                if trace_started.elapsed().as_secs_f64() > limit {
                    return Err(failure(format!(
                        "The native trace passed its time limit of {limit} s after {sample_offset} of {samples} samples."
                    )));
                }
            }
        }
    }

    let sums = read_accumulation(device, queue, &prepared.accumulation, accumulation_bytes)?;
    Ok((sums, trace_started.elapsed().as_secs_f64()))
}

pub(crate) fn run_cycles_lobe_probe(options: &ProbeCyclesLobeOptions, shader_source: String) -> Result<Vec<f32>> {
    if options.width == 0 || options.height == 0 {
        return Err(failure("probeCyclesLobe width and height must both be >= 1."));
    }
    let total_invocations = (options.width as u64) * (options.height as u64);
    let groups_x = total_invocations.div_ceil(LOBE_PROBE_WORKGROUP_SIZE as u64);
    if groups_x > MAX_COMPUTE_WORKGROUPS_PER_DIMENSION {
        return Err(failure(format!(
            "probeCyclesLobe dispatch requires {groups_x} workgroups in X, exceeding WebGPU/Vulkan limit {MAX_COMPUTE_WORKGROUPS_PER_DIMENSION}."
        )));
    }
    validate_kernel_params_v2(&options.kernel_params)?;
    if options.materials.len() < MATERIAL_RECORD_BYTES || options.materials.len() % MATERIAL_RECORD_BYTES != 0 {
        return Err(failure(format!(
            "probeCyclesLobe materials buffer must be a positive multiple of {MATERIAL_RECORD_BYTES} bytes, got {} bytes.",
            options.materials.len()
        )));
    }
    if let Some(ref descriptors) = options.texture_descriptors {
        if descriptors.is_empty() || descriptors.len() % TEXTURE_DESCRIPTOR_BYTES != 0 {
            return Err(failure(format!(
                "probeCyclesLobe textureDescriptors must be a positive multiple of {TEXTURE_DESCRIPTOR_BYTES} bytes, got {} bytes.",
                descriptors.len()
            )));
        }
    }

    let (device, queue, _) = open_device()?;
    let bind_group_layout = create_cycles_bind_group_layout(&device);
    let pipeline = compile_compute_pipeline(&device, shader_source, "test_lobe_samples", &bind_group_layout)?;
    let acceleration = build_empty_cycles_acceleration(&device, &queue);
    let accumulation_bytes = image_accumulation_bytes(options.width, options.height);

    let mut parameter_bytes = options.kernel_params.to_vec();
    parameter_bytes[8..12].copy_from_slice(&options.width.to_le_bytes());
    parameter_bytes[12..16].copy_from_slice(&options.height.to_le_bytes());

    let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("lobe probe params"),
        contents: &parameter_bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let default_descriptors = [0u8; TEXTURE_DESCRIPTOR_BYTES];
    let descriptor_slice: &[u8] = match options.texture_descriptors {
        Some(ref bytes) => bytes,
        None => &default_descriptors,
    };
    let default_texels = [0u32; 4];
    let texel_slice: &[u32] = match options.texture_texels {
        Some(ref words) if !words.is_empty() => words,
        _ => &default_texels,
    };
    let buffers = vec![
        storage_buffer(&device, "dummy instances", &[0u8; INSTANCE_RECORD_BYTES]),
        storage_buffer(&device, "dummy triangles", &[0u8; TRIANGLE_RECORD_BYTES]),
        storage_buffer(&device, "probe materials", &options.materials),
        storage_buffer(&device, "dummy emissive triangles", &[0u8; EMISSIVE_TRIANGLE_RECORD_BYTES]),
        storage_buffer(&device, "dummy lights", &[0u8; LIGHT_RECORD_BYTES]),
        storage_buffer(&device, "dummy light tree", &[0u8; LIGHT_TREE_NODE_BYTES]),
        storage_buffer(&device, "probe texture descriptors", descriptor_slice),
        storage_buffer(&device, "probe texture texels", bytemuck::cast_slice(texel_slice)),
        storage_buffer(&device, "dummy environment texels", &[0u8; 16]),
    ];
    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lobe probe accumulation"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let bind_group = create_cycles_bind_group(
        &device,
        &bind_group_layout,
        &parameters,
        &acceleration.tlas,
        &buffers,
        &accumulation,
    );

    let started = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("lobe probe dispatch"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(groups_x as u32, 1, 1);
    }
    queue.submit(Some(encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    if let Some(limit) = options.max_seconds {
        if started.elapsed().as_secs_f64() > limit {
            return Err(failure(format!(
                "probeCyclesLobe passed its time limit of {limit} s."
            )));
        }
    }
    read_accumulation(&device, &queue, &accumulation, accumulation_bytes)
}
