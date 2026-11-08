//! Hardware ray traced stills for 67js (issue #626). The packed scene tables of the browser path tracer go in, the WGSL
//! kernel of the #625 spike runs on wgpu with ray queries (Vulkan), and the averaged linear colour comes back.
//! The kernel keeps the random numbers, light sampling and shading of the browser kernel; only the BVH walk is hardware.

use std::time::Instant;

use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
use napi::{Error, Result};
use napi_derive::napi;
use wgpu::util::DeviceExt;

const KERNEL_SOURCE: &str = include_str!("kernel.wgsl");
const WORKGROUP_SIZE: u32 = 8;
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
}

#[napi(object)]
pub struct NativeTraceResult {
    /// Linear RGBA, averaged over the samples, row by row from the top.
    pub rgba: Float32Array,
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

/// Traces the packed scene on the GPU with hardware ray queries.
#[napi]
pub fn trace_scene(input: NativeTraceInput, options: NativeTraceOptions) -> Result<NativeTraceResult> {
    let setup_started = Instant::now();
    let triangle_count = input.triangle_count as usize;
    if triangle_count == 0 || input.triangles.len() < triangle_count * TRIANGLE_FLOATS {
        return Err(failure("The triangle table must hold triangle_count triangles of 9 texels."));
    }
    let triangle_data: &[f32] = &input.triangles[..triangle_count * TRIANGLE_FLOATS];
    if input.parameters.len() != 12 * 16 {
        return Err(failure("The parameter block must be 192 bytes."));
    }
    let pixel_count = options.width as u64 * options.height as u64;

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
    let adapter_info = adapter.get_info();
    let adapter_limits = adapter.limits();
    let required_limits = wgpu::Limits {
        max_storage_buffer_binding_size: adapter_limits.max_storage_buffer_binding_size.min(1 << 30),
        max_buffer_size: adapter_limits.max_buffer_size.min(1 << 30),
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
    let setup_seconds = setup_started.elapsed().as_secs_f64();

    let compile_started = Instant::now();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("path tracer"),
        source: wgpu::ShaderSource::Wgsl(KERNEL_SOURCE.into()),
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
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let compile_seconds = compile_started.elapsed().as_secs_f64();

    let upload_started = Instant::now();
    // The corners of every triangle: the table stores a corner and two edges in its first three texels.
    let mut vertices: Vec<f32> = Vec::with_capacity(triangle_count * 9);
    for triangle in triangle_data.chunks_exact(TRIANGLE_FLOATS) {
        let corner = [triangle[0], triangle[1], triangle[2]];
        let edge_first = [triangle[4], triangle[5], triangle[6]];
        let edge_second = [triangle[8], triangle[9], triangle[10]];
        vertices.extend_from_slice(&corner);
        vertices.extend((0..3).map(|axis| corner[axis] + edge_first[axis]));
        vertices.extend((0..3).map(|axis| corner[axis] + edge_second[axis]));
    }
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("triangle corners"),
        contents: bytemuck::cast_slice(&vertices),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let buffers = [
        storage_buffer(&device, "triangles", bytemuck::cast_slice(triangle_data)),
        storage_buffer(&device, "materials", bytemuck::cast_slice(&input.materials)),
        storage_buffer(&device, "lights", bytemuck::cast_slice(&input.lights)),
        storage_buffer(&device, "atlas", bytemuck::cast_slice(&input.atlas)),
        storage_buffer(&device, "environment colors", bytemuck::cast_slice(&input.environment_colors)),
        storage_buffer(&device, "environment tables", bytemuck::cast_slice(&input.environment_tables)),
    ];
    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("accumulation"),
        size: pixel_count * 4 * 16,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let parameters = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("parameters"),
        contents: &input.parameters[..],
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let upload_seconds = upload_started.elapsed().as_secs_f64();

    let build_started = Instant::now();
    let geometry_size = wgpu::BlasTriangleGeometrySizeDescriptor {
        vertex_format: wgpu::VertexFormat::Float32x3,
        vertex_count: (triangle_count * 3) as u32,
        index_format: None,
        index_count: None,
        flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("scene"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: vec![geometry_size.clone()],
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
    let mut build_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("build") });
    build_encoder.build_acceleration_structures(
        std::iter::once(&wgpu::BlasBuildEntry {
            blas: &blas,
            geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &geometry_size,
                vertex_buffer: &vertex_buffer,
                first_vertex: 0,
                vertex_stride: 12,
                index_buffer: None,
                first_index: None,
                transform_buffer: None,
                transform_buffer_offset: None,
            }]),
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
    for (offset, buffer) in buffers.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry { binding: 2 + offset as u32, resource: buffer.as_entire_binding() });
    }
    entries.push(wgpu::BindGroupEntry { binding: 8, resource: accumulation.as_entire_binding() });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("path tracer"),
        layout: &bind_group_layout,
        entries: &entries,
    });

    let trace_started = Instant::now();
    for sample_index in 0..options.samples {
        queue.write_buffer(&parameters, SAMPLE_INDEX_BYTE_OFFSET, &sample_index.to_le_bytes());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sample") });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(options.width.div_ceil(WORKGROUP_SIZE), options.height.div_ceil(WORKGROUP_SIZE), 1);
        }
        queue.submit(Some(encoder.finish()));
        if (sample_index + 1) % SAMPLES_PER_WAIT == 0 {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
        }
    }
    let readback_size = pixel_count * 16;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: readback_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
    copy_encoder.copy_buffer_to_buffer(&accumulation, 0, &readback, 0, readback_size);
    queue.submit(Some(copy_encoder.finish()));
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let mapped = readback.slice(..).get_mapped_range().map_err(|error| failure(format!("Could not read the image back: {error}")))?;
    let sums: &[f32] = bytemuck::cast_slice(&mapped);
    let sample_scale = 1.0 / options.samples.max(1) as f32;
    let mut rgba = Vec::with_capacity(pixel_count as usize * 4);
    for pixel in sums.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[0] * sample_scale, pixel[1] * sample_scale, pixel[2] * sample_scale, 1.0]);
    }
    drop(mapped);
    let traced_seconds = trace_started.elapsed().as_secs_f64();

    Ok(NativeTraceResult {
        rgba: Float32Array::new(rgba),
        adapter: adapter_info.name,
        backend: format!("{:?}", adapter_info.backend),
        setup_seconds,
        compile_seconds,
        upload_seconds,
        acceleration_build_seconds,
        traced_seconds,
    })
}
