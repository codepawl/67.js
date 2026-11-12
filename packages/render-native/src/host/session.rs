use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use napi::Result;
use wgpu::util::DeviceExt;

use crate::cycles::{check_counts_match_kernel_params, specialize_cycles_kernel, trace_entry_point, unit_filter_table_words, CYCLES_LUT_WORDS};
use crate::host::accel::{
    build_acceleration_structure, build_cycles_acceleration_structure, build_empty_cycles_acceleration,
    create_vertex_buffer, unpack_triangles, CyclesAcceleration, INSTANCE_RECORD_BYTES, TRIANGLE_FLOATS,
    TRIANGLE_RECORD_BYTES,
};
use crate::host::dispatch::{DispatchPlanner, DISPATCH_BUDGET_SECONDS};
use crate::host::device::{failure, layout_entry, open_device, storage_buffer, storage_entry};
use crate::host::film::{image_accumulation_bytes, read_accumulation};
use crate::host::textures::{check_texture_pool_budget, upload_cycles_scene_buffers, upload_scene_buffers};
use crate::{NativeTraceInput, NativeTraceInputV2, ProbeCyclesLobeOptions};

// ---- In-process device and pipeline cache ----
//
// Opening a Vulkan device and compiling SPIR-V pipelines dominates per-call latency.
// We cache both across back-to-back calls in the same Node process.
//
// wgpu 23+ backs Device and Queue with Arc, making them Clone.

/// Most compiled pipelines kept at once. Each scene shape compiles its own specialized kernel, so a long
/// lived process that renders many shapes would otherwise grow without bound.
const MAX_CACHED_PIPELINES: usize = 32;

/// A pipeline cache key: the entry point plus a 64 bit hash of the specialized source, so the cache never
/// holds a second copy of a kernel text that is hundreds of kilobytes long.
type PipelineKey = (String, u64);

fn pipeline_key(entry_point: &str, specialized_source: &str) -> PipelineKey {
    let mut hasher = DefaultHasher::new();
    specialized_source.hash(&mut hasher);
    (entry_point.to_string(), hasher.finish())
}

/// A map that holds at most `capacity` entries and starts over when a new key arrives at capacity.
struct BoundedCache<Value> {
    capacity: usize,
    entries: HashMap<PipelineKey, Value>,
}

impl<Value: Clone> BoundedCache<Value> {
    fn new(capacity: usize) -> Self {
        BoundedCache { capacity, entries: HashMap::new() }
    }

    fn get(&self, key: &PipelineKey) -> Option<Value> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: PipelineKey, value: Value) {
        if self.entries.len() >= self.capacity && !self.entries.contains_key(&key) {
            self.entries.clear();
        }
        self.entries.insert(key, value);
    }
}

struct CachedDevice {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_name: String,
    backend_name: String,
    features: String,
    /// Set by the device lost callback; the next call then opens a fresh device and drops everything below.
    device_lost: Arc<AtomicBool>,
    /// What wgpu reported when it lost the device or rejected work, for the error a failed render raises.
    device_error: Arc<Mutex<String>>,
    /// Static 118,848-byte LUT storage buffer for Cycles binding 12.
    lut_buffer: wgpu::Buffer,
    /// Bind group layout for the Cycles kernel (bindings 0..=12).
    cycles_bind_group_layout: wgpu::BindGroupLayout,
    /// Compiled Cycles compute pipelines keyed by entry point and specialized source hash.
    cycles_pipelines: BoundedCache<wgpu::ComputePipeline>,
}

static DEVICE_CACHE: OnceLock<Mutex<Option<CachedDevice>>> = OnceLock::new();

fn device_cache() -> &'static Mutex<Option<CachedDevice>> {
    DEVICE_CACHE.get_or_init(|| Mutex::new(None))
}

/// Locks a cache. A panic while the lock was held leaves half updated state, so a poisoned lock is
/// recovered by resetting the cache to empty instead of failing every later call.
fn lock_resetting_when_poisoned<Value>(cache: &Mutex<Option<Value>>) -> MutexGuard<'_, Option<Value>> {
    match cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            *guard = None;
            cache.clear_poison();
            guard
        }
    }
}

fn lock_device_cache() -> MutexGuard<'static, Option<CachedDevice>> {
    lock_resetting_when_poisoned(device_cache())
}

/// Returns cloned device/queue/metadata from the cache, opening once per process.
/// When the device was lost the cache is dropped and a fresh device is opened.
pub(crate) fn get_cached_device() -> Result<(wgpu::Device, wgpu::Queue, String, String, String)> {
    let mut guard = lock_device_cache();
    let was_lost = guard.as_ref().is_some_and(|cached| cached.device_lost.load(Ordering::SeqCst));
    if was_lost {
        *guard = None;
    }
    if guard.is_none() {
        let (device, queue, adapter_info) = open_device()?;
        let device_lost = Arc::new(AtomicBool::new(false));
        let lost_flag = Arc::clone(&device_lost);
        let device_error = Arc::new(Mutex::new(String::new()));
        let lost_message = Arc::clone(&device_error);
        device.set_device_lost_callback(move |reason, message| {
            if let Ok(mut stored) = lost_message.lock() {
                *stored = format!("{reason:?}: {message}");
            }
            lost_flag.store(true, Ordering::SeqCst);
        });
        // The default handler panics on a lost device; record the report so the render can raise a readable error.
        let error_flag = Arc::clone(&device_lost);
        let error_message = Arc::clone(&device_error);
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            if let Ok(mut stored) = error_message.lock() {
                stored.push_str(&error.to_string());
            }
            error_flag.store(true, Ordering::SeqCst);
        }));
        let mut lut_words: Vec<u32> = CYCLES_LUT_WORDS.to_vec();
        lut_words.extend(unit_filter_table_words());
        let lut_bytes: &[u8] = bytemuck::cast_slice(&lut_words);
        let lut_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("cycles LUT binding 12"),
            contents: lut_bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let cycles_bind_group_layout = create_cycles_bind_group_layout(&device);
        let has_ray_query = device.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
        *guard = Some(CachedDevice {
            device,
            queue,
            adapter_name: adapter_info.name,
            backend_name: format!("{:?}", adapter_info.backend),
            features: if has_ray_query { "EXPERIMENTAL_RAY_QUERY".to_string() } else { String::new() },
            device_lost,
            device_error,
            lut_buffer,
            cycles_bind_group_layout,
            cycles_pipelines: BoundedCache::new(MAX_CACHED_PIPELINES),
        });
    }
    let cached = guard.as_ref().unwrap();
    Ok((
        cached.device.clone(),
        cached.queue.clone(),
        cached.adapter_name.clone(),
        cached.backend_name.clone(),
        cached.features.clone(),
    ))
}

/// The flag and message the device callbacks fill in when the cached device is lost.
fn cached_device_loss_state() -> Result<(Arc<AtomicBool>, Arc<Mutex<String>>)> {
    let guard = lock_device_cache();
    match guard.as_ref() {
        Some(cached) => Ok((Arc::clone(&cached.device_lost), Arc::clone(&cached.device_error))),
        None => Err(cache_was_reset_failure()),
    }
}

fn cache_was_reset_failure() -> napi::Error {
    failure("The GPU device was reset while the scene was being prepared. Run the render again.")
}

/// Looks up or compiles and caches a Cycles `ComputePipeline` for `(entry_point, specialized_source)`.
fn get_or_compile_cycles_pipeline(entry_point: &str, specialized_source: String) -> Result<wgpu::ComputePipeline> {
    let key = pipeline_key(entry_point, &specialized_source);
    {
        let guard = lock_device_cache();
        let cached = guard.as_ref().ok_or_else(cache_was_reset_failure)?;
        if let Some(existing) = cached.cycles_pipelines.get(&key) {
            return Ok(existing);
        }
    }
    let compiled = with_cycles_cache(|device, _queue, layout, _lut| {
        compile_compute_pipeline(device, specialized_source, entry_point, layout)
    })??;
    let mut guard = lock_device_cache();
    if let Some(ref mut cached) = *guard {
        cached.cycles_pipelines.insert(key, compiled.clone());
    }
    Ok(compiled)
}

/// Returns the cached Cycles bind group layout and LUT buffer, with cloned device/queue.
/// Fails when the cache was reset since `get_cached_device` succeeded (device loss or a poisoned lock).
fn with_cycles_cache<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&wgpu::Device, &wgpu::Queue, &wgpu::BindGroupLayout, &wgpu::Buffer) -> T,
{
    let guard = lock_device_cache();
    let cached = guard.as_ref().ok_or_else(cache_was_reset_failure)?;
    Ok(f(&cached.device, &cached.queue, &cached.cycles_bind_group_layout, &cached.lut_buffer))
}

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
const LIGHT_TREE_EMITTER_BYTES: usize = 32;
/// Buffers bound at 2..=10; the light tree emitter and light-to-tree buffers follow them for bindings 13 and 14.
const CYCLES_SCENE_BUFFER_COUNT: usize = 9;
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
    pub(crate) device_lost: Arc<AtomicBool>,
    pub(crate) device_error: Arc<Mutex<String>>,
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
    layout_entries.push(storage_entry(11, false)); // film_accumulation (read_write)
    layout_entries.push(storage_entry(12, true));  // cycles_lut (read-only: static LUTs, then the two pixel filter tables)
    layout_entries.push(storage_entry(13, true));  // light_tree_emitters
    layout_entries.push(storage_entry(14, true));  // light_to_tree
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("cycles path tracer"),
        entries: &layout_entries,
    })
}

pub(crate) fn compile_compute_pipeline(
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
    lut_buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: parameters.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: tlas.as_binding() },
    ];
    for (offset, buffer) in buffers[..CYCLES_SCENE_BUFFER_COUNT].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: 2 + offset as u32,
            resource: buffer.as_entire_binding(),
        });
    }
    entries.push(wgpu::BindGroupEntry {
        binding: 11,
        resource: accumulation.as_entire_binding(),
    });
    entries.push(wgpu::BindGroupEntry {
        binding: 12,
        resource: lut_buffer.as_entire_binding(),
    });
    for (offset, buffer) in buffers[CYCLES_SCENE_BUFFER_COUNT..].iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: 13 + offset as u32,
            resource: buffer.as_entire_binding(),
        });
    }
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

/// Byte offset of `kernel_flags` in `KernelParamsV2` and its light-tree bit (`KERNEL_FLAG_USE_LIGHT_TREE` in pack-input-v2.mjs).
const KERNEL_PARAMS_KERNEL_FLAGS_BYTE: usize = 32;
const KERNEL_FLAG_USE_LIGHT_TREE: u32 = 1;

/// The emitter table and the emitter-to-slot table come together or not at all, and the slot table must cover
/// every analytic light and emissive triangle of the input.
pub(crate) fn validate_light_tree_tables(input: &NativeTraceInputV2) -> Result<()> {
    let (emitters, emitter_count, light_to_tree) = match (
        &input.light_tree_emitters,
        input.light_tree_emitter_count,
        &input.light_to_tree,
    ) {
        (None, None, None) => {
            let tree_flag_set = input
                .kernel_params
                .get(KERNEL_PARAMS_KERNEL_FLAGS_BYTE..KERNEL_PARAMS_KERNEL_FLAGS_BYTE + 4)
                .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & KERNEL_FLAG_USE_LIGHT_TREE != 0)
                .unwrap_or(false);
            if tree_flag_set && input.light_tree_node_count > 0 {
                return Err(failure(
                    "The light-tree kernel flag is set and the input has light tree nodes, but lightTreeEmitters, lightTreeEmitterCount and lightToTree are missing. Repack the scene with buildNativeInputV2.",
                ));
            }
            return Ok(());
        }
        (Some(emitters), Some(emitter_count), Some(light_to_tree)) => (emitters, emitter_count, light_to_tree),
        _ => {
            return Err(failure(
                "lightTreeEmitters, lightTreeEmitterCount and lightToTree must all be present or all absent. Pack them together with buildNativeInputV2.",
            ))
        }
    };
    validate_record_buffer("lightTreeEmitters", emitters, emitter_count, LIGHT_TREE_EMITTER_BYTES)?;
    let unified_count = input.light_count as u64 + input.emissive_triangle_count as u64;
    if emitter_count as u64 != unified_count {
        return Err(failure(format!(
            "lightTreeEmitterCount is {emitter_count} but the input has {unified_count} lights and emissive triangles. The tree must hold every emitter once."
        )));
    }
    if (light_to_tree.len() as u64) < unified_count.max(1) {
        return Err(failure(format!(
            "lightToTree holds {} entries, fewer than the {unified_count} emitters of the input.",
            light_to_tree.len()
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
    validate_light_tree_tables(input)?;

    // Use cached device; open once per process.
    let (device, queue, adapter_name, backend_name, features) = get_cached_device()?;
    let pool_limit_bytes = u64::from(device.limits().max_storage_buffer_binding_size);
    check_texture_pool_budget(input.texture_texels.len() as u64 * 4, pool_limit_bytes)?;
    let (device_lost, device_error) = cached_device_loss_state()?;
    let setup_seconds = setup_started.elapsed().as_secs_f64();

    let compile_started = Instant::now();
    // Specialise the kernel source for this scene (replaces SCENE_HAS_* sentinels).
    check_counts_match_kernel_params(input)?;
    let specialized_source = specialize_cycles_kernel(&shader_source, input);
    let pipeline = get_or_compile_cycles_pipeline(trace_entry_point(input), specialized_source)?;
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

    // Bind group: take layout and LUT reference under a brief lock, build the group, then release.
    let bind_group = with_cycles_cache(|device, _queue, layout, lut| {
        create_cycles_bind_group(
            device,
            layout,
            &uploaded.parameters,
            &acceleration.tlas,
            &uploaded.buffers,
            &uploaded.accumulation,
            lut,
        )
    })?;
    Ok(PreparedCyclesScene {
        device,
        queue,
        pipeline,
        bind_group,
        accumulation: uploaded.accumulation,
        parameters: uploaded.parameters,
        adapter_name,
        backend_name,
        features,
        device_lost,
        device_error,
        setup_seconds,
        compile_seconds,
        upload_seconds,
        acceleration_build_seconds,
        _buffers: uploaded.buffers,
        _acceleration: acceleration,
    })
}

/// How `trace_cycles_samples` splits the samples into dispatches.
#[derive(Clone, Copy)]
pub(crate) enum DispatchPlan {
    /// Every dispatch draws this many samples, as the caller asked.
    Fixed(u32),
    /// Each dispatch is sized from the time of the last so none runs past the time budget; no batch is larger than `largest_batch`.
    TimeBudget { largest_batch: u32 },
}

pub(crate) struct CyclesTrace {
    pub(crate) sums: Vec<f32>,
    pub(crate) traced_seconds: f64,
    /// The most samples one dispatch drew.
    pub(crate) largest_batch: u32,
    /// The longest single dispatch; only measured when the dispatches are sized by time.
    pub(crate) longest_dispatch_seconds: Option<f64>,
}

/// Raises the error for a lost device, naming the dispatch that was running and how to lower the work per dispatch.
fn fail_if_device_lost(
    prepared: &PreparedCyclesScene,
    sample_offset: u32,
    batch_samples: u32,
    samples: u32,
) -> Result<()> {
    if !prepared.device_lost.load(Ordering::SeqCst) {
        return Ok(());
    }
    let detail = prepared.device_error.lock().map(|stored| stored.clone()).unwrap_or_default();
    let smaller_batch = (batch_samples / 2).max(1);
    Err(failure(format!(
        "The GPU device was lost during the render, while drawing samples {sample_offset} to {} of {samples} in one dispatch of \
         {batch_samples} samples ({}). The driver resets a GPU when a single dispatch runs too long. Lower the work per dispatch: \
         pass samplesPerDispatch {smaller_batch} or less, or leave it unset so the render splits itself into dispatches of \
         about {DISPATCH_BUDGET_SECONDS} s, or lower the samples or the resolution. Then run the render again.",
        sample_offset + batch_samples,
        if detail.is_empty() { "no detail from the driver".to_string() } else { detail },
    )))
}

pub(crate) fn trace_cycles_samples(
    prepared: &PreparedCyclesScene,
    samples: u32,
    plan: DispatchPlan,
    groups: (u32, u32),
    accumulation_bytes: u64,
    max_seconds: Option<f64>,
) -> Result<CyclesTrace> {
    let trace_started = Instant::now();
    let device = &prepared.device;
    let queue = &prepared.queue;
    let mut planner = match plan {
        DispatchPlan::TimeBudget { largest_batch } => Some(DispatchPlanner::new(DISPATCH_BUDGET_SECONDS, largest_batch)),
        DispatchPlan::Fixed(_) => None,
    };
    let mut sample_offset = 0u32;
    let mut dispatch_count = 0u32;
    let mut largest_batch = 0u32;
    let mut longest_dispatch_seconds: Option<f64> = None;

    while sample_offset < samples {
        let remaining_samples = samples - sample_offset;
        let batch_samples = match (&planner, plan) {
            (Some(planner), _) => planner.next_batch(remaining_samples),
            (None, DispatchPlan::Fixed(step)) => remaining_samples.min(step.max(1)),
            (None, DispatchPlan::TimeBudget { .. }) => unreachable!("a time budget always has a planner"),
        };
        largest_batch = largest_batch.max(batch_samples);
        let dispatch_started = Instant::now();
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

        let dispatch_offset = sample_offset;
        sample_offset += batch_samples;
        dispatch_count += 1;
        // A planned render waits for every dispatch to time it. A fixed one, when no time limit is set, polls every 4
        // dispatches (excluding the final batch, which `read_accumulation` waits on directly) to drain staging belts
        // without stalling each batch.
        let should_poll = if planner.is_some() {
            true
        } else if max_seconds.is_some() {
            dispatch_count % SAMPLES_PER_WAIT == 0 || sample_offset >= samples
        } else {
            sample_offset < samples && dispatch_count % SAMPLES_PER_WAIT == 0
        };
        if should_poll {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            fail_if_device_lost(prepared, dispatch_offset, batch_samples, samples)?;
            if let Some(planner) = planner.as_mut() {
                let dispatch_seconds = dispatch_started.elapsed().as_secs_f64();
                planner.record(batch_samples, dispatch_seconds);
                longest_dispatch_seconds = Some(longest_dispatch_seconds.map_or(dispatch_seconds, |longest| longest.max(dispatch_seconds)));
            }
            if let Some(limit) = max_seconds {
                if trace_started.elapsed().as_secs_f64() > limit {
                    return Err(failure(format!(
                        "The native trace passed its time limit of {limit} s after {sample_offset} of {samples} samples."
                    )));
                }
            }
        }
    }

    let sums = read_accumulation(device, queue, &prepared.accumulation, accumulation_bytes);
    fail_if_device_lost(prepared, samples.saturating_sub(largest_batch), largest_batch, samples)?;
    Ok(CyclesTrace {
        sums: sums?,
        traced_seconds: trace_started.elapsed().as_secs_f64(),
        largest_batch,
        longest_dispatch_seconds,
    })
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

    let (device, queue, _, _, _) = get_cached_device()?;
    let pipeline = get_or_compile_cycles_pipeline("test_lobe_samples", shader_source)?;
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
        storage_buffer(&device, "dummy light tree emitters", &[0u8; LIGHT_TREE_EMITTER_BYTES]),
        storage_buffer(&device, "dummy light to tree", &[0u8; 4]),
    ];
    let accumulation = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lobe probe accumulation"),
        size: accumulation_bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let bind_group = with_cycles_cache(|_device, _queue, layout, lut| {
        create_cycles_bind_group(
            &device,
            layout,
            &parameters,
            &acceleration.tlas,
            &buffers,
            &accumulation,
            lut,
        )
    })?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_key_separates_entry_points_and_sources() {
        assert_eq!(pipeline_key("main", "source a"), pipeline_key("main", "source a"));
        assert_ne!(pipeline_key("main", "source a"), pipeline_key("main", "source b"));
        assert_ne!(pipeline_key("main", "source a"), pipeline_key("other", "source a"));
    }

    #[test]
    fn bounded_cache_never_exceeds_capacity() {
        let mut cache: BoundedCache<u32> = BoundedCache::new(3);
        for index in 0..10u32 {
            cache.insert(pipeline_key("main", &index.to_string()), index);
            assert!(cache.entries.len() <= 3);
        }
        assert_eq!(cache.get(&pipeline_key("main", "9")), Some(9));
    }

    #[test]
    fn bounded_cache_keeps_entries_when_a_known_key_is_replaced() {
        let mut cache: BoundedCache<u32> = BoundedCache::new(2);
        cache.insert(pipeline_key("main", "a"), 1);
        cache.insert(pipeline_key("main", "b"), 2);
        cache.insert(pipeline_key("main", "a"), 3);
        assert_eq!(cache.get(&pipeline_key("main", "a")), Some(3));
        assert_eq!(cache.get(&pipeline_key("main", "b")), Some(2));
    }

    #[test]
    fn poisoned_lock_is_reset_instead_of_failing_later_calls() {
        let cache = Arc::new(Mutex::new(Some(7u32)));
        let panicking = Arc::clone(&cache);
        let outcome = std::thread::spawn(move || {
            let _guard = panicking.lock().unwrap();
            panic!("panic while the cache lock is held");
        })
        .join();
        assert!(outcome.is_err());
        assert!(cache.is_poisoned());
        {
            let guard = lock_resetting_when_poisoned(&cache);
            assert!(guard.is_none());
        }
        assert!(!cache.is_poisoned());
        *lock_resetting_when_poisoned(&cache) = Some(9);
        assert_eq!(*lock_resetting_when_poisoned(&cache), Some(9));
    }
}