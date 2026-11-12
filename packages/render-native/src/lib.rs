//! Hardware ray traced stills for 67js (issue #626). The packed scene tables of the browser path tracer go in, the WGSL
//! kernel runs on wgpu with ray queries (Vulkan), and the averaged linear colour comes back.

mod cycles;
mod host;

use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
use napi::Result;
use napi_derive::napi;

use crate::host::denoise::{atrous_denoise, DenoiseInput};
use crate::host::device::failure;
use crate::host::film::{
    image_accumulation_bytes, image_workgroups, pad_texel_vectors, resolve_image, resolve_texels,
    texel_accumulation_bytes, texel_workgroups,
};
use crate::host::cycles_session::{
    CyclesRender, CyclesRenderReport, CyclesRenderRequest, CyclesSceneUpdate, CyclesSession,
};
use crate::host::cycles_update::UpdatableTable;
use crate::host::session::{
    get_cached_device, prepare_scene, run_cycles_lobe_probe, trace_samples, CyclesTrace, JobShape,
};

const KERNEL_SOURCE: &str = include_str!("kernel.wgsl");
/// The texel entry point of the light bake, appended to the kernel for a bake only.
const TEXEL_SOURCE: &str = include_str!("texel.wgsl");

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
    /// The 16 vec4 parameter block of `packages/render-native/pack-input.mjs`, as bytes.
    pub parameters: Uint8Array,
}

#[napi(object)]
pub struct NativeTraceInputV2 {
    pub schema_version: u32,
    pub kernel_params: Uint8Array,
    pub instances: Uint8Array,
    pub instance_count: u32,
    pub triangles: Uint8Array,
    pub triangle_count: u32,
    pub materials: Uint8Array,
    pub material_count: u32,
    pub emissive_triangles: Uint8Array,
    pub emissive_triangle_count: u32,
    pub lights: Uint8Array,
    pub light_count: u32,
    pub light_tree_nodes: Uint8Array,
    pub light_tree_node_count: u32,
    /// Emitters in tree order (FORMAT-v2 section 7b); absent in inputs packed before the light tree landed.
    pub light_tree_emitters: Option<Uint8Array>,
    pub light_tree_emitter_count: Option<u32>,
    /// Emitter slot of every unified emitter (analytic lights first, then emissive triangles).
    pub light_to_tree: Option<Uint32Array>,
    pub texture_descriptors: Uint8Array,
    pub texture_count: u32,
    pub texture_texels: Uint32Array,
    pub environment_texels: Float32Array,
}

#[napi(object)]
pub struct NativeTraceOptions {
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    /// Stop with an error once the trace has run this long (checked every few samples); absent means no limit.
    pub max_seconds: Option<f64>,
    /// Selects `"legacy"` (default) or `"cycles"`.
    pub kernel: Option<String>,
}

#[napi(object)]
pub struct NativeCyclesTraceOptions {
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub samples_per_dispatch: Option<u32>,
    pub max_seconds: Option<f64>,
    pub bootstrap_kernel: Option<bool>,
    /// `"none"` (default) or `"atrous"`: also filter the image with the edge-avoiding a-trous wavelet filter.
    pub denoise: Option<String>,
    /// A KernelParamsV2 block for this render (a session frame with another camera or render settings of the same scene);
    /// absent means the block of the input.
    pub kernel_params: Option<Uint8Array>,
    /// Session only: add this call's samples to the film instead of starting a new image.
    pub accumulate: Option<bool>,
    /// Session only: the sample count of the whole image a progressive film builds; the first accumulating call sets it.
    pub target_samples: Option<u32>,
}

#[napi(object)]
pub struct DenoiseAtrousOptions {
    pub width: u32,
    pub height: u32,
    /// Linear RGBA, four floats per pixel.
    pub rgba: Float32Array,
    pub albedo: Float32Array,
    /// Three floats per pixel; the filter normalises them.
    pub normal: Float32Array,
    pub depth: Float32Array,
    pub variance: Float32Array,
}

#[napi(object)]
pub struct DenoiseAtrousResult {
    pub rgba: Float32Array,
    pub compile_seconds: f64,
    pub upload_seconds: f64,
    pub gpu_seconds: f64,
    pub readback_seconds: f64,
}

#[napi(object)]
pub struct ProbeCyclesLobeOptions {
    pub width: u32,
    pub height: u32,
    pub kernel_params: Uint8Array,
    pub materials: Uint8Array,
    pub texture_descriptors: Option<Uint8Array>,
    pub texture_texels: Option<Uint32Array>,
    pub max_seconds: Option<f64>,
    pub bootstrap_kernel: Option<bool>,
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
    /// The `rgba` image after the a-trous filter (biased: smoothed, not converged); present only when `denoise` was `"atrous"`.
    pub denoised_rgba: Option<Float32Array>,
    /// What the filter took in seconds, excluding its one-time pipeline compile: upload, the seven dispatches, readback.
    pub denoise_seconds: Option<f64>,
    /// Only the seven dispatches, from submit until the device finished them.
    pub denoise_gpu_seconds: Option<f64>,
    pub denoise_compile_seconds: Option<f64>,
    /// First-hit albedo and normal (three floats per pixel, averaged over the samples; normalise the normal), the first-hit
    /// depth and the variance of each pixel's mean luminance: the features the wavelet and OIDN denoisers read.
    pub albedo: Float32Array,
    pub normal: Float32Array,
    pub depth: Float32Array,
    pub variance: Float32Array,
    /// The mean number of samples a pixel drew: below the requested count when `noise_threshold` stopped converged pixels.
    pub average_samples: f64,
    /// The samples each dispatch drew, as given or as chosen automatically (Cycles kernel only; absent for the legacy kernel).
    pub samples_per_dispatch: Option<u32>,
    /// The longest single dispatch in seconds, measured when dispatches are sized by time (absent for a fixed batch).
    pub longest_dispatch_seconds: Option<f64>,
    pub adapter: String,
    pub backend: String,
    /// "EXPERIMENTAL_RAY_QUERY" when the device the trace ran on was opened with ray queries (the tracer needs them).
    pub features: String,
    pub setup_seconds: f64,
    pub compile_seconds: f64,
    pub upload_seconds: f64,
    pub acceleration_build_seconds: f64,
    pub traced_seconds: f64,
}

fn parse_denoise_option(requested: Option<&str>) -> Result<bool> {
    match requested {
        None | Some("none") => Ok(false),
        Some("atrous") => Ok(true),
        Some(other) => Err(failure(format!(
            "Invalid denoise option {other:?}: pass \"none\" (default) or \"atrous\"."
        ))),
    }
}

fn select_kernel_source(requested_kernel: Option<&str>) -> Result<(String, bool)> {
    let kernel_name = match requested_kernel {
        Some(name) => name,
        None => "legacy",
    };
    match kernel_name {
        "legacy" => Ok((KERNEL_SOURCE.to_string(), true)),
        "cycles" => {
            let _ = cycles::assemble_cycles_kernel()?;
            Err(failure(
                "traceScene requires FORMAT-v2 buffers when kernel is \"cycles\"; call traceNative or traceSceneCycles.",
            ))
        }
        other => Err(failure(format!(
            "Invalid native kernel {other:?}: pass \"legacy\" or \"cycles\" in options.kernel or JS67_NATIVE_KERNEL."
        ))),
    }
}

/// Traces the packed legacy v1 scene on the GPU with hardware ray queries.
#[napi]
pub fn trace_scene(input: NativeTraceInput, options: NativeTraceOptions) -> Result<NativeTraceResult> {
    let (source, rewrite_specialization_flags) = select_kernel_source(options.kernel.as_deref())?;
    let pixel_count = options.width as u64 * options.height as u64;
    let accumulation_bytes = image_accumulation_bytes(options.width, options.height);
    let prepared = prepare_scene(
        &input,
        JobShape {
            source,
            entry_point: "main",
            rewrite_specialization_flags,
            accumulation_bytes,
            extra_buffers: Vec::new(),
        },
    )?;
    let groups = image_workgroups(options.width, options.height);
    let (sums, traced_seconds) = trace_samples(&prepared, options.samples, groups, accumulation_bytes, options.max_seconds)?;
    let resolved = resolve_image(&sums, pixel_count);
    Ok(NativeTraceResult {
        rgba: Float32Array::new(resolved.rgba),
        denoised_rgba: None,
        denoise_seconds: None,
        denoise_gpu_seconds: None,
        denoise_compile_seconds: None,
        albedo: Float32Array::new(resolved.albedo),
        normal: Float32Array::new(resolved.normal),
        depth: Float32Array::new(resolved.depth),
        variance: Float32Array::new(resolved.variance),
        average_samples: resolved.average_samples,
        samples_per_dispatch: None,
        longest_dispatch_seconds: None,
        adapter: prepared.adapter_name,
        backend: prepared.backend_name,
        features: prepared.features,
        setup_seconds: prepared.setup_seconds,
        compile_seconds: prepared.compile_seconds,
        upload_seconds: prepared.upload_seconds,
        acceleration_build_seconds: prepared.acceleration_build_seconds,
        traced_seconds,
    })
}

/// The frame bookkeeping of a session render: what was reused instead of rebuilt.
#[napi(object)]
pub struct NativeSessionReport {
    /// The session already held the compiled pipeline this frame needed (no shader compile).
    pub pipeline_reused: bool,
    /// The acceleration structures were built by an earlier call (no build for this frame).
    pub acceleration_reused: bool,
    /// The film and its bind group were kept from the previous frame (same image size).
    pub film_reused: bool,
    /// How many frames the session finished before this one.
    pub frame_index: u32,
    /// The index of the first sample this call drew: 0, or where the progressive film left off.
    pub first_sample: u32,
    /// How many samples per pixel the film holds after this call.
    pub film_samples: u32,
    /// The sample count the progressive film was started for; absent for a plain frame.
    pub target_samples: Option<u32>,
}

#[napi(object)]
pub struct NativeSessionRenderResult {
    pub trace: NativeTraceResult,
    pub session: NativeSessionReport,
}

#[napi(object)]
pub struct NativeSessionResolveOptions {
    /// `"none"` (default) or `"atrous"`, as for a render.
    pub denoise: Option<String>,
}

/// The tables of a session update that changed, and the kernel parameters of the new input.
#[napi(object)]
pub struct NativeSessionUpdateOptions {
    pub kernel_params: Uint8Array,
    pub instances: Option<Uint8Array>,
    pub materials: Option<Uint8Array>,
    pub emissive_triangles: Option<Uint8Array>,
    pub lights: Option<Uint8Array>,
    pub light_tree_nodes: Option<Uint8Array>,
    pub light_tree_emitters: Option<Uint8Array>,
    pub light_to_tree: Option<Uint32Array>,
}

#[napi(object)]
pub struct NativeSessionUpdateReport {
    /// The tables whose buffers were replaced, by their input names.
    pub uploaded_tables: Vec<String>,
    /// The TLAS was rebuilt over the kept BLAS because a transform or a ray visibility changed. The pinned wgpu has no refit.
    pub acceleration_rebuilt: bool,
    /// How many instance records differ from the old table.
    pub changed_instances: u32,
    /// The new tables change what the kernel text is specialized for, so the next render compiles a new pipeline.
    pub kernel_respecialized: bool,
    pub upload_seconds: f64,
    pub acceleration_rebuild_seconds: f64,
    pub update_seconds: f64,
}

/// Renders one frame on a session and resolves the film into the result object.
fn render_session_frame(
    session: &mut CyclesSession,
    options: &NativeCyclesTraceOptions,
) -> Result<NativeSessionRenderResult> {
    let use_atrous_filter = parse_denoise_option(options.denoise.as_deref())?;
    let request = CyclesRenderRequest {
        width: options.width,
        height: options.height,
        samples: options.samples,
        samples_per_dispatch: options.samples_per_dispatch,
        max_seconds: options.max_seconds,
        bootstrap_kernel: options.bootstrap_kernel.unwrap_or(false),
        kernel_params: options.kernel_params.as_deref(),
        accumulate: options.accumulate.unwrap_or(false),
        target_samples: options.target_samples,
    };
    let render = session.render(&request)?;
    session_render_result(session, options.width, options.height, use_atrous_filter, render)
}

/// Resolves the sums of a session render (or of the film as it stands) into the result object.
fn session_render_result(
    session: &CyclesSession,
    width: u32,
    height: u32,
    use_atrous_filter: bool,
    render: CyclesRender,
) -> Result<NativeSessionRenderResult> {
    let pixel_count = width as u64 * height as u64;
    let resolved = resolve_image(&render.trace.sums, pixel_count);
    let context = session.device_context();
    let filtered = if use_atrous_filter {
        Some(atrous_denoise(
            &context.device,
            &context.queue,
            &DenoiseInput {
                width,
                height,
                rgba: &resolved.rgba,
                albedo: &resolved.albedo,
                normal: &resolved.normal,
                depth: &resolved.depth,
                variance: &resolved.variance,
            },
        )?)
    } else {
        None
    };
    let denoise_seconds = filtered.as_ref().map(|output| output.upload_seconds + output.gpu_seconds + output.readback_seconds);
    let denoise_gpu_seconds = filtered.as_ref().map(|output| output.gpu_seconds);
    let denoise_compile_seconds = filtered.as_ref().map(|output| output.compile_seconds);
    let trace = NativeTraceResult {
        rgba: Float32Array::new(resolved.rgba),
        denoised_rgba: filtered.map(|output| Float32Array::new(output.rgba)),
        denoise_seconds,
        denoise_gpu_seconds,
        denoise_compile_seconds,
        albedo: Float32Array::new(resolved.albedo),
        normal: Float32Array::new(resolved.normal),
        depth: Float32Array::new(resolved.depth),
        variance: Float32Array::new(resolved.variance),
        average_samples: resolved.average_samples,
        samples_per_dispatch: (render.trace.largest_batch > 0).then_some(render.trace.largest_batch),
        longest_dispatch_seconds: render.trace.longest_dispatch_seconds,
        adapter: context.adapter_name.clone(),
        backend: context.backend_name.clone(),
        features: context.features.clone(),
        setup_seconds: render.report.setup_seconds,
        compile_seconds: render.report.compile_seconds,
        upload_seconds: render.report.upload_seconds,
        acceleration_build_seconds: render.report.acceleration_build_seconds,
        traced_seconds: render.trace.traced_seconds,
    };
    let session_report = NativeSessionReport {
        pipeline_reused: render.report.pipeline_reused,
        acceleration_reused: render.report.acceleration_reused,
        film_reused: render.report.film_reused,
        frame_index: render.report.frame_index,
        first_sample: render.report.first_sample,
        film_samples: render.report.film_samples,
        target_samples: render.report.target_samples,
    };
    Ok(NativeSessionRenderResult { trace, session: session_report })
}

/// The film of a session as it stands, resolved without tracing: the report says nothing was compiled, built or drawn.
fn resolve_session_film(session: &mut CyclesSession, options: &NativeSessionResolveOptions) -> Result<NativeSessionRenderResult> {
    let use_atrous_filter = parse_denoise_option(options.denoise.as_deref())?;
    let film = session.read_film()?;
    let film_samples = film.film_samples;
    let render = CyclesRender {
        trace: CyclesTrace { sums: film.sums, traced_seconds: 0.0, largest_batch: 0, longest_dispatch_seconds: None },
        report: CyclesRenderReport {
            setup_seconds: 0.0,
            compile_seconds: 0.0,
            upload_seconds: 0.0,
            acceleration_build_seconds: 0.0,
            pipeline_reused: true,
            acceleration_reused: true,
            film_reused: true,
            frame_index: film.frame_index,
            first_sample: film_samples,
            film_samples,
            target_samples: film.target_samples,
        },
    };
    session_render_result(session, film.width, film.height, use_atrous_filter, render)
}

fn update_tables<'a>(options: &'a NativeSessionUpdateOptions) -> Vec<(UpdatableTable, &'a [u8])> {
    let mut tables: Vec<(UpdatableTable, &'a [u8])> = Vec::new();
    let byte_tables = [
        (UpdatableTable::Instances, &options.instances),
        (UpdatableTable::Materials, &options.materials),
        (UpdatableTable::EmissiveTriangles, &options.emissive_triangles),
        (UpdatableTable::Lights, &options.lights),
        (UpdatableTable::LightTreeNodes, &options.light_tree_nodes),
        (UpdatableTable::LightTreeEmitters, &options.light_tree_emitters),
    ];
    for (table, bytes) in byte_tables {
        if let Some(bytes) = bytes {
            tables.push((table, &bytes[..]));
        }
    }
    if let Some(words) = &options.light_to_tree {
        tables.push((UpdatableTable::LightToTree, bytemuck::cast_slice::<u32, u8>(words)));
    }
    tables
}

/// Traces a packed `FORMAT-v2` scene on the GPU using the assembled Cycles-parity WGSL kernel: a session that renders once.
#[napi]
pub fn trace_scene_cycles(input: NativeTraceInputV2, options: NativeCyclesTraceOptions) -> Result<NativeTraceResult> {
    parse_denoise_option(options.denoise.as_deref())?;
    let mut session = CyclesSession::create(&input)?;
    let rendered = render_session_frame(&mut session, &options)?;
    Ok(rendered.trace)
}

/// A scene kept on the GPU between frames (issue 896): the device handle, the scene tables, the acceleration structures,
/// the compiled pipeline and the film. `createNativeSession` in index.mjs is the way to make one.
#[napi]
pub struct NativeCyclesSession {
    session: CyclesSession,
}

#[napi]
impl NativeCyclesSession {
    #[napi(constructor)]
    pub fn new(input: NativeTraceInputV2) -> Result<Self> {
        Ok(NativeCyclesSession { session: CyclesSession::create(&input)? })
    }

    /// Renders one frame of the session's scene. `options.kernelParams` may bring another camera or render settings of the same scene.
    #[napi]
    pub fn render(&mut self, options: NativeCyclesTraceOptions) -> Result<NativeSessionRenderResult> {
        render_session_frame(&mut self.session, &options)
    }

    /// Starts the progressive image over: clears the film, keeps the scene and the pipeline.
    #[napi]
    pub fn reset(&mut self) -> Result<()> {
        self.session.reset()
    }

    /// The film as it stands (the average of every sample drawn so far), without tracing.
    #[napi]
    pub fn resolve(&mut self, options: NativeSessionResolveOptions) -> Result<NativeSessionRenderResult> {
        resolve_session_film(&mut self.session, &options)
    }

    /// Replaces the values of scene tables (materials, lights, emission, instance transforms) without rebuilding the
    /// pipeline or the BLAS. Clears the film.
    #[napi]
    pub fn update(&mut self, options: NativeSessionUpdateOptions) -> Result<NativeSessionUpdateReport> {
        let update = CyclesSceneUpdate { kernel_params: &options.kernel_params, tables: update_tables(&options) };
        let report = self.session.update(&update)?;
        Ok(NativeSessionUpdateReport {
            uploaded_tables: report.uploaded_tables.iter().map(|name| name.to_string()).collect(),
            acceleration_rebuilt: report.acceleration_rebuilt,
            changed_instances: report.changed_instances,
            kernel_respecialized: report.kernel_respecialized,
            upload_seconds: report.upload_seconds,
            acceleration_rebuild_seconds: report.acceleration_rebuild_seconds,
            update_seconds: report.update_seconds,
        })
    }

    /// Frees the card; every later `render` fails.
    #[napi]
    pub fn close(&mut self) {
        self.session.close();
    }
}

/// Filters a traced image with the edge-avoiding a-trous wavelet filter on the GPU (spatial only; the result is biased).
#[napi]
pub fn denoise_atrous(options: DenoiseAtrousOptions) -> Result<DenoiseAtrousResult> {
    let (device, queue, _adapter, _backend, _features) = get_cached_device()?;
    let output = atrous_denoise(
        &device,
        &queue,
        &DenoiseInput {
            width: options.width,
            height: options.height,
            rgba: &options.rgba,
            albedo: &options.albedo,
            normal: &options.normal,
            depth: &options.depth,
            variance: &options.variance,
        },
    )?;
    Ok(DenoiseAtrousResult {
        rgba: Float32Array::new(output.rgba),
        compile_seconds: output.compile_seconds,
        upload_seconds: output.upload_seconds,
        gpu_seconds: output.gpu_seconds,
        readback_seconds: output.readback_seconds,
    })
}

/// Dispatches `"test_lobe_samples"` on the assembled Cycles WGSL shader and returns all 4 raw `film_accumulation` planes.
#[napi]
pub fn probe_cycles_lobe(options: ProbeCyclesLobeOptions) -> Result<Float32Array> {
    let source = cycles::assemble_cycles_kernel_entry(
        "test_lobe_samples",
        options.bootstrap_kernel.unwrap_or(false),
    )?;
    let raw_planes = run_cycles_lobe_probe(&options, source)?;
    Ok(Float32Array::new(raw_planes))
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
    let accumulation_bytes = texel_accumulation_bytes(count);
    let prepared = prepare_scene(
        &input,
        JobShape {
            source: format!("{KERNEL_SOURCE}\n{TEXEL_SOURCE}"),
            entry_point: "bakeTexels",
            rewrite_specialization_flags: true,
            accumulation_bytes,
            extra_buffers: vec![
                ("texel points", pad_texel_vectors(&texels.points, count)),
                ("texel normals", pad_texel_vectors(&texels.normals, count)),
            ],
        },
    )?;
    let groups = texel_workgroups(count as u32);
    let (sums, traced_seconds) = trace_samples(&prepared, options.samples, groups, accumulation_bytes, options.max_seconds)?;
    let resolved = resolve_texels(&sums, count, options.samples);
    Ok(NativeTexelResult {
        radiance: Float32Array::new(resolved.radiance),
        escaped: Float32Array::new(resolved.escaped),
        adapter: prepared.adapter_name,
        backend: prepared.backend_name,
        setup_seconds: prepared.setup_seconds,
        compile_seconds: prepared.compile_seconds,
        upload_seconds: prepared.upload_seconds,
        acceleration_build_seconds: prepared.acceleration_build_seconds,
        traced_seconds,
    })
}
