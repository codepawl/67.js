//! A persistent Cycles render session (issue 896). It owns what a render needs that does not change from one frame to
//! the next: the device handle, the scene tables on the card, the acceleration structures, the compiled pipeline and the
//! film with its bind group. A frame then only writes the kernel parameters (camera, image size, sample count), clears the
//! film and dispatches. The one-shot `traceSceneCycles` is a session that renders once.

use std::sync::atomic::Ordering;
use std::time::Instant;

use napi::Result;

use crate::cycles::{
    assemble_cycles_kernel_entry, check_counts_match_kernel_params, check_frame_params_keep_scene_counts,
    scan_scene_specialization, specialize_kernel_source, trace_entry_point_for_params, SceneSpecialization,
};
use crate::host::accel::{build_cycles_acceleration_structure, CyclesAcceleration};
use crate::host::device::failure;
use crate::host::film::{image_accumulation_bytes, image_workgroups};
use crate::host::session::{
    create_cycles_bind_group, get_cycles_device_context, get_or_compile_cycles_pipeline_on, pipeline_key,
    trace_cycles_samples, validate_cycles_input, validate_kernel_params_v2, validate_light_tree_flag_has_tables,
    validate_render_extent, with_cycles_cache_on, CyclesDeviceContext, CyclesDispatchTarget, CyclesTrace, DispatchPlan,
    PipelineKey,
};
use crate::host::textures::{create_cycles_film, create_cycles_parameters, upload_cycles_scene_tables};
use crate::NativeTraceInputV2;

const KERNEL_PARAMS_WIDTH_BYTE: usize = 8;
const KERNEL_PARAMS_HEIGHT_BYTE: usize = 12;
const KERNEL_PARAMS_TOTAL_SAMPLES_BYTE: usize = 24;
/// A wall clock limit under this many seconds keeps one sample per dispatch so the limit is checked often.
const TIGHT_TIME_LIMIT_SECONDS: f64 = 2.0;

/// What one frame asks of a session.
pub(crate) struct CyclesRenderRequest<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) samples: u32,
    pub(crate) samples_per_dispatch: Option<u32>,
    pub(crate) max_seconds: Option<f64>,
    pub(crate) bootstrap_kernel: bool,
    /// A KernelParamsV2 block for this frame (another camera, seed or filter of the same scene); absent means the block
    /// the session was created with.
    pub(crate) kernel_params: Option<&'a [u8]>,
}

/// The per-phase seconds of one frame and what it reused. A frame that reuses something spends no time on it: the
/// first frame of a session carries the setup, upload and acceleration build seconds of the creation.
pub(crate) struct CyclesRenderReport {
    pub(crate) setup_seconds: f64,
    pub(crate) compile_seconds: f64,
    pub(crate) upload_seconds: f64,
    pub(crate) acceleration_build_seconds: f64,
    /// The session already held the compiled pipeline this frame needed.
    pub(crate) pipeline_reused: bool,
    /// The acceleration structures were built by an earlier call, not for this frame.
    pub(crate) acceleration_reused: bool,
    /// The film and its bind group were kept from the previous frame (same image size).
    pub(crate) film_reused: bool,
    /// How many frames this session finished before this one.
    pub(crate) frame_index: u32,
}

pub(crate) struct CyclesRender {
    pub(crate) trace: CyclesTrace,
    pub(crate) report: CyclesRenderReport,
}

/// What creating the session cost; the first frame reports it.
struct CreationCosts {
    setup_seconds: f64,
    upload_seconds: f64,
    acceleration_build_seconds: f64,
}

struct HeldPipeline {
    key: PipelineKey,
    pipeline: wgpu::ComputePipeline,
}

struct SessionFilm {
    width: u32,
    height: u32,
    accumulation: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

/// Everything on the card. Dropping it frees the card, which is what `close` does.
struct SessionGpuState {
    scene_tables: Vec<wgpu::Buffer>,
    acceleration: CyclesAcceleration,
    parameters: wgpu::Buffer,
    pipeline: Option<HeldPipeline>,
    film: Option<SessionFilm>,
}

impl SessionGpuState {
    fn film(&self) -> Result<&SessionFilm> {
        self.film.as_ref().ok_or_else(|| failure("The session film is missing; this is a bug in the session."))
    }

    fn pipeline(&self) -> Result<&HeldPipeline> {
        self.pipeline.as_ref().ok_or_else(|| failure("The session pipeline is missing; this is a bug in the session."))
    }
}

pub(crate) struct CyclesSession {
    context: CyclesDeviceContext,
    /// The kernel parameters the session was created with, the default for a frame that brings none.
    session_kernel_params: Vec<u8>,
    scene_specialization: SceneSpecialization,
    light_tree_node_count: u32,
    has_light_tree_tables: bool,
    creation_costs: Option<CreationCosts>,
    renders_completed: u32,
    /// `None` once the session is closed.
    gpu: Option<SessionGpuState>,
}

/// The kernel parameters of one render: the frame's block with the image size and the total sample count written in.
pub(crate) fn patch_render_parameters(kernel_params: &[u8], width: u32, height: u32, total_samples: u32) -> Vec<u8> {
    let mut patched = kernel_params.to_vec();
    patched[KERNEL_PARAMS_WIDTH_BYTE..KERNEL_PARAMS_WIDTH_BYTE + 4].copy_from_slice(&width.to_le_bytes());
    patched[KERNEL_PARAMS_HEIGHT_BYTE..KERNEL_PARAMS_HEIGHT_BYTE + 4].copy_from_slice(&height.to_le_bytes());
    patched[KERNEL_PARAMS_TOTAL_SAMPLES_BYTE..KERNEL_PARAMS_TOTAL_SAMPLES_BYTE + 4]
        .copy_from_slice(&total_samples.to_le_bytes());
    patched
}

/// Unless the caller fixes the batch, each dispatch is sized from the time of the last so none runs long enough for the
/// driver to reset the device. A wall-clock limit under 2 s keeps one sample per dispatch for tight responsiveness.
pub(crate) fn choose_dispatch_plan(samples: u32, samples_per_dispatch: Option<u32>, max_seconds: Option<f64>) -> DispatchPlan {
    match samples_per_dispatch {
        Some(samples_per_dispatch) => DispatchPlan::Fixed(samples_per_dispatch.max(1)),
        None => match max_seconds {
            Some(limit) if limit < TIGHT_TIME_LIMIT_SECONDS => DispatchPlan::Fixed(1),
            _ => DispatchPlan::TimeBudget { largest_batch: samples.max(1) },
        },
    }
}

fn session_closed_failure() -> napi::Error {
    failure("This native session is closed. Create a new one with createNativeSession(input) before rendering again.")
}

fn session_device_lost_failure(detail: &str) -> napi::Error {
    let reported = if detail.is_empty() { "no detail from the driver" } else { detail };
    failure(format!(
        "The GPU device this session was created on was lost ({reported}). The session cannot render any more: call close() and create a new one with createNativeSession(input)."
    ))
}

impl CyclesSession {
    /// Validates the input, opens (or reuses) the device, uploads the scene tables and builds the acceleration structures.
    pub(crate) fn create(input: &NativeTraceInputV2) -> Result<CyclesSession> {
        let setup_started = Instant::now();
        validate_cycles_input(input)?;
        check_counts_match_kernel_params(input)?;
        let context = get_cycles_device_context()?;
        let scene_specialization = scan_scene_specialization(input);
        let setup_seconds = setup_started.elapsed().as_secs_f64();

        let upload_started = Instant::now();
        let scene_tables = upload_cycles_scene_tables(&context.device, input);
        let parameters = create_cycles_parameters(&context.device, &input.kernel_params);
        let upload_seconds = upload_started.elapsed().as_secs_f64();

        let build_started = Instant::now();
        let acceleration = build_cycles_acceleration_structure(
            &context.device,
            &context.queue,
            &input.instances,
            input.instance_count as usize,
            &input.triangles,
            input.triangle_count as usize,
        )?;
        let acceleration_build_seconds = build_started.elapsed().as_secs_f64();

        Ok(CyclesSession {
            context,
            session_kernel_params: input.kernel_params.to_vec(),
            scene_specialization,
            light_tree_node_count: input.light_tree_node_count,
            has_light_tree_tables: input.light_tree_emitters.is_some(),
            creation_costs: Some(CreationCosts { setup_seconds, upload_seconds, acceleration_build_seconds }),
            renders_completed: 0,
            gpu: Some(SessionGpuState {
                scene_tables,
                acceleration,
                parameters,
                pipeline: None,
                film: None,
            }),
        })
    }

    pub(crate) fn device_context(&self) -> &CyclesDeviceContext {
        &self.context
    }

    /// Frees the scene, the acceleration structures, the pipeline and the film. A closed session refuses to render.
    pub(crate) fn close(&mut self) {
        self.gpu = None;
    }

    fn fail_if_unusable(&self) -> Result<()> {
        if self.gpu.is_none() {
            return Err(session_closed_failure());
        }
        if self.context.device_lost.load(Ordering::SeqCst) {
            let detail = self.context.device_error.lock().map(|stored| stored.clone()).unwrap_or_default();
            return Err(session_device_lost_failure(&detail));
        }
        Ok(())
    }

    /// The kernel parameters of a frame: the ones it brings after checking they describe this scene, else the session's own.
    fn frame_kernel_params(&self, requested: Option<&[u8]>) -> Result<Vec<u8>> {
        let Some(requested_bytes) = requested else {
            return Ok(self.session_kernel_params.clone());
        };
        validate_kernel_params_v2(requested_bytes)?;
        check_frame_params_keep_scene_counts(&self.session_kernel_params, requested_bytes)?;
        validate_light_tree_flag_has_tables(requested_bytes, self.light_tree_node_count, self.has_light_tree_tables)?;
        Ok(requested_bytes.to_vec())
    }

    /// Renders one frame. The scene, the acceleration structures and (while the specialized kernel text and the image size
    /// stay the same) the pipeline and the film are reused; the film is cleared, so a frame starts from zero as a one-shot does.
    pub(crate) fn render(&mut self, request: &CyclesRenderRequest<'_>) -> Result<CyclesRender> {
        self.fail_if_unusable()?;
        validate_render_extent(request.width, request.height, request.samples)?;
        let frame_kernel_params = self.frame_kernel_params(request.kernel_params)?;

        let frame_index = self.renders_completed;
        let creation_costs = self.creation_costs.take();
        let acceleration_reused = creation_costs.is_none();
        let context = &self.context;
        let gpu = self.gpu.as_mut().ok_or_else(session_closed_failure)?;

        let compile_started = Instant::now();
        let pipeline_reused = ensure_pipeline(
            context,
            gpu,
            &self.scene_specialization,
            &frame_kernel_params,
            request.bootstrap_kernel,
        )?;
        let compile_seconds = compile_started.elapsed().as_secs_f64();

        let upload_started = Instant::now();
        let film_reused = ensure_film(context, gpu, request.width, request.height)?;
        let render_parameters =
            patch_render_parameters(&frame_kernel_params, request.width, request.height, request.samples);
        context.queue.write_buffer(&gpu.parameters, 0, &render_parameters);
        if film_reused {
            clear_film(context, gpu.film()?);
        }
        let upload_seconds = upload_started.elapsed().as_secs_f64();

        let film = gpu.film()?;
        let target = CyclesDispatchTarget {
            device: &context.device,
            queue: &context.queue,
            pipeline: &gpu.pipeline()?.pipeline,
            bind_group: &film.bind_group,
            parameters: &gpu.parameters,
            accumulation: &film.accumulation,
            device_lost: &context.device_lost,
            device_error: &context.device_error,
        };
        let plan = choose_dispatch_plan(request.samples, request.samples_per_dispatch, request.max_seconds);
        let trace = trace_cycles_samples(
            &target,
            request.samples,
            plan,
            image_workgroups(request.width, request.height),
            image_accumulation_bytes(request.width, request.height),
            request.max_seconds,
        )?;
        self.renders_completed = frame_index + 1;

        let report = CyclesRenderReport {
            setup_seconds: creation_costs.as_ref().map_or(0.0, |costs| costs.setup_seconds),
            compile_seconds,
            upload_seconds: upload_seconds + creation_costs.as_ref().map_or(0.0, |costs| costs.upload_seconds),
            acceleration_build_seconds: creation_costs.as_ref().map_or(0.0, |costs| costs.acceleration_build_seconds),
            pipeline_reused,
            acceleration_reused,
            film_reused,
            frame_index,
        };
        Ok(CyclesRender { trace, report })
    }
}

/// Makes `gpu.pipeline` the pipeline for this frame's specialized kernel text; true when it already was.
fn ensure_pipeline(
    context: &CyclesDeviceContext,
    gpu: &mut SessionGpuState,
    scene: &SceneSpecialization,
    frame_kernel_params: &[u8],
    bootstrap_kernel: bool,
) -> Result<bool> {
    let assembled_source = assemble_cycles_kernel_entry("main", bootstrap_kernel)?;
    let entry_point = trace_entry_point_for_params(frame_kernel_params);
    let specialized_source = specialize_kernel_source(&assembled_source, scene, frame_kernel_params);
    let key = pipeline_key(entry_point, &specialized_source);
    if gpu.pipeline.as_ref().is_some_and(|held| held.key == key) {
        return Ok(true);
    }
    let pipeline = get_or_compile_cycles_pipeline_on(Some(&context.device_lost), entry_point, specialized_source)?;
    gpu.pipeline = Some(HeldPipeline { key, pipeline });
    Ok(false)
}

/// Makes `gpu.film` a film of this size with a bind group over it; true when the previous frame's film was kept.
fn ensure_film(context: &CyclesDeviceContext, gpu: &mut SessionGpuState, width: u32, height: u32) -> Result<bool> {
    if gpu.film.as_ref().is_some_and(|film| film.width == width && film.height == height) {
        return Ok(true);
    }
    let accumulation = create_cycles_film(&context.device, image_accumulation_bytes(width, height));
    let bind_group = with_cycles_cache_on(Some(&context.device_lost), |device, _queue, layout, lut| {
        create_cycles_bind_group(
            device,
            layout,
            &gpu.parameters,
            &gpu.acceleration.tlas,
            &gpu.scene_tables,
            &accumulation,
            lut,
        )
    })?;
    gpu.film = Some(SessionFilm { width, height, accumulation, bind_group });
    Ok(false)
}

fn clear_film(context: &CyclesDeviceContext, film: &SessionFilm) {
    let mut encoder = context.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("cycles film clear"),
    });
    encoder.clear_buffer(&film.accumulation, 0, None);
    context.queue.submit(Some(encoder.finish()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_parameters_carry_the_image_size_and_the_sample_count_and_nothing_else() {
        let mut frame = vec![0xABu8; 320];
        frame[0..4].copy_from_slice(&0x36375054u32.to_le_bytes());
        let patched = patch_render_parameters(&frame, 1920, 1080, 64);
        assert_eq!(patched.len(), 320);
        assert_eq!(&patched[8..12], &1920u32.to_le_bytes());
        assert_eq!(&patched[12..16], &1080u32.to_le_bytes());
        assert_eq!(&patched[24..28], &64u32.to_le_bytes());
        let untouched = |index: &usize| !(8..16).contains(index) && !(24..28).contains(index);
        assert!((0..320).filter(untouched).all(|index| patched[index] == frame[index]));
    }

    #[test]
    fn a_fixed_batch_is_kept_and_never_zero() {
        assert!(matches!(choose_dispatch_plan(64, Some(8), None), DispatchPlan::Fixed(8)));
        assert!(matches!(choose_dispatch_plan(64, Some(0), None), DispatchPlan::Fixed(1)));
        assert!(matches!(choose_dispatch_plan(64, Some(16), Some(0.5)), DispatchPlan::Fixed(16)));
    }

    #[test]
    fn a_tight_time_limit_draws_one_sample_per_dispatch() {
        assert!(matches!(choose_dispatch_plan(64, None, Some(1.5)), DispatchPlan::Fixed(1)));
        assert!(matches!(choose_dispatch_plan(64, None, Some(2.0)), DispatchPlan::TimeBudget { largest_batch: 64 }));
    }

    #[test]
    fn without_a_batch_or_limit_the_dispatches_are_sized_by_time() {
        assert!(matches!(choose_dispatch_plan(256, None, None), DispatchPlan::TimeBudget { largest_batch: 256 }));
        assert!(matches!(choose_dispatch_plan(0, None, None), DispatchPlan::TimeBudget { largest_batch: 1 }));
    }

    #[test]
    fn a_closed_session_error_says_how_to_continue() {
        let message = session_closed_failure().to_string();
        assert!(message.contains("closed"), "{message}");
        assert!(message.contains("createNativeSession"), "{message}");
    }

    #[test]
    fn a_lost_device_error_names_the_driver_report_and_the_way_out() {
        let with_detail = session_device_lost_failure("Unknown: TDR").to_string();
        assert!(with_detail.contains("TDR"), "{with_detail}");
        assert!(with_detail.contains("createNativeSession"), "{with_detail}");
        let without_detail = session_device_lost_failure("").to_string();
        assert!(without_detail.contains("no detail from the driver"), "{without_detail}");
    }
}
