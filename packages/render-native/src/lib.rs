//! Hardware ray traced stills for 67js (issue #626). The packed scene tables of the browser path tracer go in, the WGSL
//! kernel runs on wgpu with ray queries (Vulkan), and the averaged linear colour comes back.

mod cycles;
mod host;

use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
use napi::Result;
use napi_derive::napi;

use crate::host::device::failure;
use crate::host::film::{
    image_accumulation_bytes, image_workgroups, pad_texel_vectors, resolve_image, resolve_texels,
    texel_accumulation_bytes, texel_workgroups,
};
use crate::host::session::{prepare_scene, trace_samples, JobShape};

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
    /// The mean number of samples a pixel drew: below the requested count when `noise_threshold` stopped converged pixels.
    pub average_samples: f64,
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

fn select_kernel_source(requested_kernel: Option<&str>) -> Result<(String, bool)> {
    let kernel_name = match requested_kernel {
        Some(name) => name,
        None => "legacy",
    };
    match kernel_name {
        "legacy" => Ok((KERNEL_SOURCE.to_string(), true)),
        "cycles" => {
            let source = cycles::assemble_cycles_kernel()?;
            Ok((source, false))
        }
        other => Err(failure(format!(
            "Invalid native kernel {other:?}: pass \"legacy\" or \"cycles\" in options.kernel or JS67_NATIVE_KERNEL."
        ))),
    }
}

/// Traces the packed scene on the GPU with hardware ray queries.
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
        albedo: Float32Array::new(resolved.albedo),
        normal: Float32Array::new(resolved.normal),
        depth: Float32Array::new(resolved.depth),
        variance: Float32Array::new(resolved.variance),
        average_samples: resolved.average_samples,
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
