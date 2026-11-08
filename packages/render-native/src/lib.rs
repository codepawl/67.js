//! Hardware ray traced stills for 67js (issue #626). The packed scene tables of the browser path tracer go in, the WGSL
//! kernel of the #625 spike runs on wgpu with ray queries (Vulkan), and the averaged linear colour comes back.
//! The kernel keeps the random numbers, light sampling and shading of the browser kernel; only the BVH walk is hardware.

use std::time::Instant;

use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
use napi::{Error, Result};
use napi_derive::napi;
use wgpu::util::DeviceExt;

const KERNEL_SOURCE: &str = include_str!("kernel.wgsl");
/// The texel entry point of the light bake, appended to the kernel for a bake only.
const TEXEL_SOURCE: &str = include_str!("texel.wgsl");
const WORKGROUP_SIZE: u32 = 8;
const MATERIAL_TEXELS: usize = 10;
/// Must match `TEXEL_WORKGROUP_SIZE` in texel.wgsl.
const TEXEL_WORKGROUP_SIZE: u32 = 64;
/// A dispatch is at most 65535 workgroups wide; a larger bake wraps onto the second dimension.
const MAXIMUM_TEXEL_GROUPS_X: u32 = 4096;
const TRIANGLE_FLOATS: usize = 9 * 4;
/// Byte offset of the sample index inside the parameter block (`emittersFlagsSample.w`).
const SAMPLE_INDEX_BYTE_OFFSET: u64 = 43 * 4;
/// Samples submitted before the CPU waits, so a long trace never queues thousands of dispatches.
const SAMPLES_PER_WAIT: u32 = 4;

#[napi(object)]
pub struct NativeTraceInput {
    /// The 9 texel triangle table of `packTriangles`, in BVH order, as float32 data.
    pub triangles: Float32Array,
    /// How many triangles the table holds; the table itself is padded to whole texture rows.
    pub triangle_count: u32,
    pub materials: Float32Array,
    pub lights: Float32Array,
    /// The texture atlas as 32 bit words.
    pub atlas: Uint32Array,
    pub environment_colors: Float32Array,
    pub environment_tables: Float32Array,
    /// The 12 vec4 parameter block, exactly as the browser harness writes it, as bytes.
    pub parameters: Uint8Array,
}

#[napi(object)]
pub struct NativeTraceOptions {
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    /// Stop with an error once the trace has run this long (checked every few samples); absent means no limit.
    pub max_seconds: Option<f64>,
}

#[napi(object)]
pub struct NativeTexels {
    /// How many lightmap texels the two lists hold.
    pub count: u32,
    /// World positions, three floats per texel.
    pub points: Float32Array,
    /// Unit surface normals, three floats per texel.
    pub normals: Float32Array,
}

#[napi(object)]
pub struct NativeTexelOptions {
    pub samples: u32,
    /// As for `NativeTraceOptions`.
    pub max_seconds: Option<f64>,
}

#[napi(object)]
pub struct NativeTexelResult {
    /// The mean light that arrives at each texel, three floats per texel.
    pub radiance: Float32Array,
    /// The share of first rays that left the scene, per texel.
    pub escaped: Float32Array,
    pub adapter: String,
    pub backend: String,
    pub setup_seconds: f64,
    pub compile_seconds: f64,
    pub upload_seconds: f64,
    pub acceleration_build_seconds: f64,
    pub traced_seconds: f64,
}

#[napi(object)]
pub struct NativeTraceResult {
    /// Linear RGBA, averaged over the samples, row by row from the top.
    pub rgba: Float32Array,
    /// First-hit albedo and normal (three floats per pixel, averaged over the samples; normalise the normal), the first-hit
    /// depth and the variance of each pixel's mean luminance: the features the wavelet and OIDN denoisers read.
    pub albedo: Float32Array,
    pub normal: Float32Array,
    pub depth: Float32Array,
    pub variance: Float32Array,
    pub adapter: String,
    pub backend: String,
    pub setup_seconds: f64,
    pub compile_seconds: f64,
    pub upload_seconds: f64,
    pub acceleration_build_seconds: f64,
    pub traced_seconds: f64,
}

fn failure(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

fn storage_buffer(device: &wgpu::Device, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    let mut padded = bytes.to_vec();
    padded.resize(padded.len().next_multiple_of(4).max(16), 0);
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: &padded,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

fn layout_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty,
        count: None,
    }
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    layout_entry(
        binding,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
    )
}

/// A device with the scene's acceleration structure built and one compute pipeline bound to it.
struct PreparedScene {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    accumulation: wgpu::Buffer,
    parameters: wgpu::Buffer,
    adapter_name: String,
    backend_name: String,
    setup_seconds: f64,
    compile_seconds: f64,
    upload_seconds: f64,
    acceleration_build_seconds: f64,
    // The bind group keeps the buffers and the structure alive; holding them here makes that visible.
    _buffers: Vec<wgpu::Buffer>,
    _tlas: wgpu::Tlas,
}

/// What one kind of job adds to the shared scene setup: the kernel text, its entry point, the accumulation size and the
/// extra read only buffers bound after the accumulation (bindings 9 and up).
struct JobShape<'a> {
    source: String,
    entry_point: &'a str,
    accumulation_bytes: u64,
    extra_buffers: Vec<(&'a str, Vec<u8>)>,
}

fn open_device() -> Result<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| failure(format!("No Vulkan adapter: {error}")))?;
    if !adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        return Err(failure("The Vulkan adapter does not support ray queries."));
    }
    let adapter_limits = adapter.limits();
    let required_limits = wgpu::Limits {
        max_storage_buffer_binding_size: adapter_limits.max_storage_buffer_binding_size.min(1 << 30),
        max_buffer_size: adapter_limits.max_buffer_size.min(1 << 30),
        // The light bake binds nine storage buffers (the scene, the accumulation and the texels); the default allows eight.
        max_storage_buffers_per_shader_stage: adapter_limits.max_storage_buffers_per_shader_stage.min(16),
        ..wgpu::Limits::default()
    }
    .using_minimum_supported_acceleration_structure_values();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("render-native"),
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits,
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))
    .map_err(|error| failure(format!("Could not open the device: {error}")))?;
    Ok((device, queue, adapter.get_info()))
}

/// Whether a material takes its alpha from a colour map and cuts at a threshold. A material is `MATERIAL_TEXELS` vec4s: the cutoff
/// is the third float of texel 3 and the width of the colour map's atlas rectangle the third float of texel 6.
fn material_is_cutout(materials: &[f32], material: usize) -> bool {
    let base = material * MATERIAL_TEXELS * 4;
    if base + 7 * 4 > materials.len() {
        return false;
    }
    materials[base + 3 * 4 + 2] > 0.0 && materials[base + 6 * 4 + 2] > 0.0
}

fn prepare_scene(input: &NativeTraceInput, shape: JobShape) -> Result<PreparedScene> {
    let setup_started = Instant::now();
    let triangle_count = input.triangle_count as usize;
    if triangle_count == 0 || input.triangles.len() < triangle_count * TRIANGLE_FLOATS {
        return Err(failure("The triangle table must hold triangle_count triangles of 9 texels."));
    }
    let triangle_data: &[f32] = &input.triangles[..triangle_count * TRIANGLE_FLOATS];
    if input.parameters.len() != 12 * 16 {
        return Err(failure("The parameter block must be 192 bytes."));
    }
    let (device, queue, adapter_info) = open_device()?;
    let setup_seconds = setup_started.elapsed().as_secs_f64();

    let compile_started = Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("path tracer"),
        source: wgpu::ShaderSource::Wgsl(shape.source.into()),
    });
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
    layout_entries.extend((0..shape.extra_buffers.len() + 1).map(|offset| storage_entry(9 + offset as u32, true)));
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("path tracer"),
        entries: &layout_entries,
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("path tracer"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("path tracer"),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(shape.entry_point),
        compilation_options: Default::default(),
        cache: None,
    });
    let compile_seconds = compile_started.elapsed().as_secs_f64();

    let upload_started = Instant::now();
    // The corners of every triangle: the table stores a corner and two edges in its first three texels. Opaque triangles come
    // first and alpha cutout triangles after them, because the hardware takes its opaque flag per geometry; `slot_map`
    // gives the table slot of each hardware primitive (the opaque ones, then the cutouts).
    let mut opaque_vertices: Vec<f32> = Vec::with_capacity(triangle_count * 9);
    let mut cutout_vertices: Vec<f32> = Vec::new();
    let mut slot_map: Vec<u32> = Vec::with_capacity(triangle_count);
    let mut cutout_slots: Vec<u32> = Vec::new();
    for (slot, triangle) in triangle_data.chunks_exact(TRIANGLE_FLOATS).enumerate() {
        let corner = [triangle[0], triangle[1], triangle[2]];
        let edge_first = [triangle[4], triangle[5], triangle[6]];
        let edge_second = [triangle[8], triangle[9], triangle[10]];
        let is_cutout = material_is_cutout(&input.materials, triangle[3] as usize);
        let vertices = if is_cutout { &mut cutout_vertices } else { &mut opaque_vertices };
        vertices.extend_from_slice(&corner);
        vertices.extend((0..3).map(|axis| corner[axis] + edge_first[axis]));
        vertices.extend((0..3).map(|axis| corner[axis] + edge_second[axis]));
        if is_cutout {
            cutout_slots.push(slot as u32);
        } else {
            slot_map.push(slot as u32);
        }
    }
    let opaque_count = slot_map.len();
    slot_map.extend(cutout_slots);
    let mut vertices = opaque_vertices;
    vertices.extend(cutout_vertices);
    // Word 47 of the parameter block tells the kernel where the cutout primitives start in `slot_map`.
    let mut parameter_bytes = input.parameters.to_vec();
    parameter_bytes[47 * 4..48 * 4].copy_from_slice(&(opaque_count as u32).to_le_bytes());
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("triangle corners"),
        contents: bytemuck::cast_slice(&vertices),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let mut buffers = vec![
        storage_buffer(&device, "triangles", bytemuck::cast_slice(triangle_data)),
        storage_buffer(&device, "materials", bytemuck::cast_slice(&input.materials)),
        storage_buffer(&device, "lights", bytemuck::cast_slice(&input.lights)),
        storage_buffer(&device, "atlas", bytemuck::cast_slice(&input.atlas)),
        storage_buffer(&device, "environment colors", bytemuck::cast_slice(&input.environment_colors)),
        storage_buffer(&device, "environment tables", bytemuck::cast_slice(&input.environment_tables)),
    ];
    buffers.push(storage_buffer(&device, "primitive slots", bytemuck::cast_slice(&slot_map)));
    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("accumulation"),
        size: shape.accumulation_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    for (label, bytes) in &shape.extra_buffers {
        buffers.push(storage_buffer(&device, label, bytes));
    }
    let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("parameters"),
        contents: &parameter_bytes,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let upload_seconds = upload_started.elapsed().as_secs_f64();

    let build_started = Instant::now();
    // Opaque triangles never reach the any-hit loop of the kernel; cutout triangles are candidates it confirms when the alpha
    // of their colour map reaches the material's cutoff (see `traceRay`).
    let mut geometry_sizes: Vec<wgpu::BlasTriangleGeometrySizeDescriptor> = Vec::new();
    let mut geometry_vertex_starts: Vec<u32> = Vec::new();
    for (first_triangle, triangles_in_geometry, flags) in [
        (0, opaque_count, wgpu::AccelerationStructureGeometryFlags::OPAQUE),
        (opaque_count, triangle_count - opaque_count, wgpu::AccelerationStructureGeometryFlags::empty()),
    ] {
        if triangles_in_geometry == 0 {
            continue;
        }
        geometry_vertex_starts.push((first_triangle * 3) as u32);
        geometry_sizes.push(wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: (triangles_in_geometry * 3) as u32,
            index_format: None,
            index_count: None,
            flags,
        });
    }
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("scene"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: geometry_sizes.clone(),
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("scene"),
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        max_instances: 1,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(
        &blas,
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        0,
        0xFF,
    ));
    let triangle_geometries: Vec<wgpu::BlasTriangleGeometry> = geometry_sizes
        .iter()
        .zip(&geometry_vertex_starts)
        .map(|(size, first_vertex)| wgpu::BlasTriangleGeometry {
            size,
            vertex_buffer: &vertex_buffer,
            first_vertex: *first_vertex,
            vertex_stride: 12,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        })
        .collect();
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("build") });
    build_encoder.build_acceleration_structures(
        std::iter::once(&wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(triangle_geometries),
        }),
        std::iter::once(&tlas),
    );
    queue.submit(Some(build_encoder.finish()));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let acceleration_build_seconds = build_started.elapsed().as_secs_f64();

    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: parameters.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: tlas.as_binding() },
    ];
    for (offset, buffer) in buffers[..6].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry { binding: 2 + offset as u32, resource: buffer.as_entire_binding() });
    }
    entries.push(wgpu::BindGroupEntry { binding: 8, resource: accumulation.as_entire_binding() });
    for (offset, buffer) in buffers[6..].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry { binding: 9 + offset as u32, resource: buffer.as_entire_binding() });
    }
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("path tracer"),
        layout: &bind_group_layout,
        entries: &entries,
    });
    Ok(PreparedScene {
        device,
        queue,
        pipeline,
        bind_group,
        accumulation,
        parameters,
        adapter_name: adapter_info.name,
        backend_name: format!("{:?}", adapter_info.backend),
        setup_seconds,
        compile_seconds,
        upload_seconds,
        acceleration_build_seconds,
        _buffers: buffers,
        _tlas: tlas,
    })
}

/// Runs every sample over `groups` workgroups and copies the accumulation back. `max_seconds` bounds the run: past it the
/// trace stops with an error instead of finishing, checked each time the CPU waits for the card. Returns the sums and the
/// seconds it took.
fn trace_samples(prepared: &PreparedScene, samples: u32, groups: (u32, u32), accumulation_bytes: u64, max_seconds: Option<f64>) -> Result<(Vec<f32>, f64)> {
    let trace_started = Instant::now();
    let device = &prepared.device;
    let queue = &prepared.queue;
    for sample_index in 0..samples {
        queue.write_buffer(&prepared.parameters, SAMPLE_INDEX_BYTE_OFFSET, &sample_index.to_le_bytes());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sample") });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
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
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
    copy_encoder.copy_buffer_to_buffer(&prepared.accumulation, 0, &readback, 0, accumulation_bytes);
    queue.submit(Some(copy_encoder.finish()));
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback.slice(..).get_mapped_range().map_err(|error| failure(format!("Could not read the result back: {error}")))?;
    let sums: Vec<f32> = bytemuck::cast_slice::<u8, f32>(&mapped).to_vec();
    drop(mapped);
    Ok((sums, trace_started.elapsed().as_secs_f64()))
}

/// Traces the packed scene on the GPU with hardware ray queries.
#[napi]
pub fn trace_scene(input: NativeTraceInput, options: NativeTraceOptions) -> Result<NativeTraceResult> {
    let pixel_count = options.width as u64 * options.height as u64;
    let accumulation_bytes = pixel_count * 4 * 16;
    let prepared = prepare_scene(
        &input,
        JobShape { source: KERNEL_SOURCE.to_string(), entry_point: "main", accumulation_bytes, extra_buffers: Vec::new() },
    )?;
    let groups = (options.width.div_ceil(WORKGROUP_SIZE), options.height.div_ceil(WORKGROUP_SIZE));
    let (sums, traced_seconds) = trace_samples(&prepared, options.samples, groups, accumulation_bytes, options.max_seconds)?;
    let plane_length = pixel_count as usize * 4;
    let sample_scale = 1.0 / options.samples.max(1) as f32;
    let variance_divisor = options.samples.saturating_sub(1).max(1) as f32;
    let mut rgba = Vec::with_capacity(pixel_count as usize * 4);
    let mut albedo = Vec::with_capacity(pixel_count as usize * 3);
    let mut normal = Vec::with_capacity(pixel_count as usize * 3);
    let mut depth = Vec::with_capacity(pixel_count as usize);
    let mut variance = Vec::with_capacity(pixel_count as usize);
    for pixel in 0..pixel_count as usize {
        let radiance = &sums[pixel * 4..pixel * 4 + 4];
        let albedo_sum = &sums[plane_length + pixel * 4..plane_length + pixel * 4 + 3];
        let normal_sum = &sums[2 * plane_length + pixel * 4..2 * plane_length + pixel * 4 + 3];
        let statistics = &sums[3 * plane_length + pixel * 4..3 * plane_length + pixel * 4 + 2];
        rgba.extend_from_slice(&[radiance[0] * sample_scale, radiance[1] * sample_scale, radiance[2] * sample_scale, 1.0]);
        depth.push(radiance[3] * sample_scale);
        albedo.extend(albedo_sum.iter().map(|value| value * sample_scale));
        normal.extend(normal_sum.iter().map(|value| value * sample_scale));
        let mean_luminance = statistics[0] * sample_scale;
        variance.push((statistics[1] * sample_scale - mean_luminance * mean_luminance).max(0.0) / variance_divisor);
    }
    Ok(NativeTraceResult {
        rgba: Float32Array::new(rgba),
        albedo: Float32Array::new(albedo),
        normal: Float32Array::new(normal),
        depth: Float32Array::new(depth),
        variance: Float32Array::new(variance),
        adapter: prepared.adapter_name,
        backend: prepared.backend_name,
        setup_seconds: prepared.setup_seconds,
        compile_seconds: prepared.compile_seconds,
        upload_seconds: prepared.upload_seconds,
        acceleration_build_seconds: prepared.acceleration_build_seconds,
        traced_seconds,
    })
}

/// Three floats per texel, padded to the four the kernel's vec4 arrays read.
fn pad_vectors(vectors: &[f32], count: usize) -> Vec<u8> {
    let mut padded: Vec<f32> = Vec::with_capacity(count * 4);
    for texel in 0..count {
        padded.extend_from_slice(&vectors[texel * 3..texel * 3 + 3]);
        padded.push(0.0);
    }
    bytemuck::cast_slice(&padded).to_vec()
}

/// The light that reaches each lightmap texel: `options.samples` cosine weighted paths from every texel, traced with the
/// scene's ray queries. The parameter block of `input` carries the lights, the bounces and the seed; its texel count and
/// sample count words are the ones `buildNativeTexelInput` writes.
#[napi]
pub fn trace_texels(input: NativeTraceInput, texels: NativeTexels, options: NativeTexelOptions) -> Result<NativeTexelResult> {
    let count = texels.count as usize;
    if count == 0 || texels.points.len() < count * 3 || texels.normals.len() < count * 3 {
        return Err(failure("The texel points and normals must hold three floats for each of `count` texels."));
    }
    let accumulation_bytes = count as u64 * 2 * 16;
    let prepared = prepare_scene(
        &input,
        JobShape {
            source: format!("{KERNEL_SOURCE}\n{TEXEL_SOURCE}"),
            entry_point: "bakeTexels",
            accumulation_bytes,
            extra_buffers: vec![
                ("texel points", pad_vectors(&texels.points, count)),
                ("texel normals", pad_vectors(&texels.normals, count)),
            ],
        },
    )?;
    let workgroups = (count as u32).div_ceil(TEXEL_WORKGROUP_SIZE);
    let groups_x = workgroups.min(MAXIMUM_TEXEL_GROUPS_X);
    let groups = (groups_x, workgroups.div_ceil(groups_x));
    let (sums, traced_seconds) = trace_samples(&prepared, options.samples, groups, accumulation_bytes, options.max_seconds)?;
    let sample_scale = 1.0 / options.samples.max(1) as f32;
    let mut radiance = Vec::with_capacity(count * 3);
    let mut escaped = Vec::with_capacity(count);
    for texel in 0..count {
        radiance.extend(sums[texel * 4..texel * 4 + 3].iter().map(|value| value * sample_scale));
        escaped.push(sums[(count + texel) * 4] * sample_scale);
    }
    Ok(NativeTexelResult {
        radiance: Float32Array::new(radiance),
        escaped: Float32Array::new(escaped),
        adapter: prepared.adapter_name,
        backend: prepared.backend_name,
        setup_seconds: prepared.setup_seconds,
        compile_seconds: prepared.compile_seconds,
        upload_seconds: prepared.upload_seconds,
        acceleration_build_seconds: prepared.acceleration_build_seconds,
        traced_seconds,
    })
}
