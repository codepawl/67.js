//! A persistent Cycles render session (issue 896). It owns what a render needs that does not change from one frame to
//! the next: the device handle, the scene tables on the card, the acceleration structures, the compiled pipeline and the
//! film with its bind group. A frame then only writes the kernel parameters (camera, image size, sample count), clears the
//! film and dispatches. The one-shot `traceSceneCycles` is a session that renders once.

use std::sync::atomic::Ordering;
use std::time::Instant;

use napi::bindgen_prelude::{Float32Array, Uint32Array, Uint8Array};
use napi::Result;

use crate::cycles::{
    assemble_cycles_kernel_entry, check_counts_match_kernel_params, check_frame_params_keep_scene_counts,
    check_update_params_keep_scene_shape, scan_scene_specialization, specialize_kernel_source,
    trace_entry_point_for_params, SceneSpecialization,
};
use crate::host::accel::{build_cycles_acceleration_structure, rebuild_cycles_tlas, CyclesAcceleration};
use crate::host::cycles_update::{choose_film_use, plan_instance_update, FilmRequest, ProgressiveFilm, UpdatableTable};
use crate::host::device::{failure, storage_buffer};
use crate::host::film::{image_accumulation_bytes, image_workgroups, read_accumulation};
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
    /// Add this call's samples to the film instead of starting a new image (see `choose_film_use`).
    pub(crate) accumulate: bool,
    /// The sample count of the whole image; required by the first accumulating call, optional (and equal) after.
    pub(crate) target_samples: Option<u32>,
}

/// New values for the scene tables a session holds, with the kernel parameters that go with them. Only the tables that
/// changed are listed.
pub(crate) struct CyclesSceneUpdate<'a> {
    pub(crate) kernel_params: &'a [u8],
    pub(crate) tables: Vec<(UpdatableTable, &'a [u8])>,
}

/// What an update did, so a test or a caller can see it kept the pipeline and the BLAS instead of timing it.
pub(crate) struct CyclesUpdateReport {
    /// The tables whose buffers were replaced, by their input names.
    pub(crate) uploaded_tables: Vec<&'static str>,
    /// The TLAS was rebuilt over the kept BLAS (a transform or ray visibility changed).
    pub(crate) acceleration_rebuilt: bool,
    /// How many instance records differ from the old table.
    pub(crate) changed_instances: u32,
    /// The new tables change what the kernel text is specialized for, so the next render compiles it again.
    pub(crate) kernel_respecialized: bool,
    pub(crate) upload_seconds: f64,
    pub(crate) acceleration_rebuild_seconds: f64,
    pub(crate) update_seconds: f64,
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
    /// The index of the first sample this call drew (0 unless it continued a progressive film).
    pub(crate) first_sample: u32,
    /// How many samples the film holds after this call.
    pub(crate) film_samples: u32,
    /// The sample count the progressive film was started for; absent for a plain frame.
    pub(crate) target_samples: Option<u32>,
}

pub(crate) struct CyclesRender {
    pub(crate) trace: CyclesTrace,
    pub(crate) report: CyclesRenderReport,
}

/// What creating the session cost; the first frame reports it.
#[derive(Clone, Copy)]
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

/// The number of scene buffers `upload_cycles_scene_tables` makes.
const SCENE_BUFFER_COUNT: usize = 11;

/// Host copies of what the kernel specialization reads, so an update can scan the new tables without the whole input:
/// the record counts and the small tables the scan walks. The triangles, texels and emitters are not kept.
/// If `scan_scene_specialization` starts to read another table, keep it here too.
struct RetainedTables {
    instance_count: u32,
    material_count: u32,
    emissive_triangle_count: u32,
    light_count: u32,
    light_tree_node_count: u32,
    texture_count: u32,
    instances: Vec<u8>,
    materials: Vec<u8>,
    lights: Vec<u8>,
    texture_descriptors: Vec<u8>,
    /// The byte length of each scene buffer's source, by buffer index: an update must bring a table of the same size.
    table_lengths: [usize; SCENE_BUFFER_COUNT],
}

impl RetainedTables {
    fn of_input(input: &NativeTraceInputV2) -> RetainedTables {
        let mut table_lengths = [0usize; SCENE_BUFFER_COUNT];
        table_lengths[UpdatableTable::Instances.buffer_index()] = input.instances.len();
        table_lengths[UpdatableTable::Materials.buffer_index()] = input.materials.len();
        table_lengths[UpdatableTable::EmissiveTriangles.buffer_index()] = input.emissive_triangles.len();
        table_lengths[UpdatableTable::Lights.buffer_index()] = input.lights.len();
        table_lengths[UpdatableTable::LightTreeNodes.buffer_index()] = input.light_tree_nodes.len();
        table_lengths[UpdatableTable::LightTreeEmitters.buffer_index()] =
            input.light_tree_emitters.as_ref().map_or(0, |emitters| emitters.len());
        table_lengths[UpdatableTable::LightToTree.buffer_index()] =
            input.light_to_tree.as_ref().map_or(0, |words| words.len() * 4);
        RetainedTables {
            instance_count: input.instance_count,
            material_count: input.material_count,
            emissive_triangle_count: input.emissive_triangle_count,
            light_count: input.light_count,
            light_tree_node_count: input.light_tree_node_count,
            texture_count: input.texture_count,
            instances: input.instances.to_vec(),
            materials: input.materials.to_vec(),
            lights: input.lights.to_vec(),
            texture_descriptors: input.texture_descriptors.to_vec(),
            table_lengths,
        }
    }

    /// The specialization of these tables; equal to `scan_scene_specialization` of the whole input they came from.
    fn specialization(&self) -> SceneSpecialization {
        let scan_input = NativeTraceInputV2 {
            schema_version: 2,
            kernel_params: Uint8Array::new(Vec::new()),
            instances: Uint8Array::new(self.instances.clone()),
            instance_count: self.instance_count,
            triangles: Uint8Array::new(Vec::new()),
            triangle_count: 0,
            materials: Uint8Array::new(self.materials.clone()),
            material_count: self.material_count,
            emissive_triangles: Uint8Array::new(Vec::new()),
            emissive_triangle_count: self.emissive_triangle_count,
            lights: Uint8Array::new(self.lights.clone()),
            light_count: self.light_count,
            light_tree_nodes: Uint8Array::new(Vec::new()),
            light_tree_node_count: self.light_tree_node_count,
            light_tree_emitters: None,
            light_tree_emitter_count: None,
            light_to_tree: None,
            texture_descriptors: Uint8Array::new(self.texture_descriptors.clone()),
            texture_count: self.texture_count,
            texture_texels: Uint32Array::new(Vec::new()),
            environment_texels: Float32Array::new(Vec::new()),
        };
        scan_scene_specialization(&scan_input)
    }

    fn keep_table(&mut self, table: UpdatableTable, bytes: &[u8]) {
        match table {
            UpdatableTable::Instances => self.instances = bytes.to_vec(),
            UpdatableTable::Materials => self.materials = bytes.to_vec(),
            UpdatableTable::Lights => self.lights = bytes.to_vec(),
            _ => {}
        }
    }
}

pub(crate) struct CyclesSession {
    context: CyclesDeviceContext,
    /// The kernel parameters the session was created with (or last updated to), the default for a frame that brings none.
    session_kernel_params: Vec<u8>,
    scene_specialization: SceneSpecialization,
    retained: RetainedTables,
    light_tree_node_count: u32,
    has_light_tree_tables: bool,
    creation_costs: Option<CreationCosts>,
    renders_completed: u32,
    /// The image being built over several calls; `None` after a plain frame, a reset, an update or a failed call.
    progressive: Option<ProgressiveFilm>,
    /// The film holds the samples of the last successful render, so `resolve` has something to read.
    film_holds_samples: bool,
    /// How many samples per pixel the film holds; meaningful while `film_holds_samples`.
    film_sample_count: u32,
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
            retained: RetainedTables::of_input(input),
            light_tree_node_count: input.light_tree_node_count,
            has_light_tree_tables: input.light_tree_emitters.is_some(),
            creation_costs: Some(CreationCosts { setup_seconds, upload_seconds, acceleration_build_seconds }),
            renders_completed: 0,
            progressive: None,
            film_holds_samples: false,
            film_sample_count: 0,
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
    /// stay the same) the pipeline and the film are reused. A plain frame clears the film and starts from sample 0, as a
    /// one-shot does. An accumulating call adds its samples to the film and continues the sample sequence (see `choose_film_use`).
    pub(crate) fn render(&mut self, request: &CyclesRenderRequest<'_>) -> Result<CyclesRender> {
        self.fail_if_unusable()?;
        validate_render_extent(request.width, request.height, request.samples)?;
        let frame_kernel_params = self.frame_kernel_params(request.kernel_params)?;
        let film_use = choose_film_use(
            self.progressive.as_ref(),
            &FilmRequest {
                width: request.width,
                height: request.height,
                samples: request.samples,
                accumulate: request.accumulate,
                target_samples: request.target_samples,
                frame_kernel_params: &frame_kernel_params,
            },
        )?;

        let frame_index = self.renders_completed;
        let creation_costs = self.creation_costs;
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
            patch_render_parameters(&frame_kernel_params, request.width, request.height, film_use.total_samples);
        context.queue.write_buffer(&gpu.parameters, 0, &render_parameters);
        if film_reused && film_use.starts_new_image {
            clear_film(context, gpu.film()?);
        }
        let upload_seconds = upload_started.elapsed().as_secs_f64();

        // From here the film changes: a call that fails leaves it unusable, so nothing may claim it holds an image.
        self.progressive = None;
        self.film_holds_samples = false;

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
            film_use.first_sample,
            request.samples,
            plan,
            image_workgroups(request.width, request.height),
            image_accumulation_bytes(request.width, request.height),
            request.max_seconds,
        )?;
        self.renders_completed = frame_index + 1;
        self.creation_costs = None;
        self.film_holds_samples = true;

        let film_after = film_use.film_after.as_ref();
        let report = CyclesRenderReport {
            setup_seconds: creation_costs.as_ref().map_or(0.0, |costs| costs.setup_seconds),
            compile_seconds,
            upload_seconds: upload_seconds + creation_costs.as_ref().map_or(0.0, |costs| costs.upload_seconds),
            acceleration_build_seconds: creation_costs.as_ref().map_or(0.0, |costs| costs.acceleration_build_seconds),
            pipeline_reused,
            acceleration_reused,
            film_reused,
            frame_index,
            first_sample: film_use.first_sample,
            film_samples: film_after.map_or(request.samples, |film| film.samples_drawn),
            target_samples: film_after.map(|film| film.target_samples),
        };
        self.film_sample_count = report.film_samples;
        self.progressive = film_use.film_after;
        Ok(CyclesRender { trace, report })
    }

    /// Starts the progressive image over: the film is cleared and the next accumulating call begins at sample 0, with a
    /// `targetSamples` of its choosing. The scene, the pipeline and the film's memory stay.
    pub(crate) fn reset(&mut self) -> Result<()> {
        self.fail_if_unusable()?;
        self.clear_progressive_film();
        Ok(())
    }

    fn clear_progressive_film(&mut self) {
        self.progressive = None;
        self.film_holds_samples = false;
        if let Some(film) = self.gpu.as_ref().and_then(|gpu| gpu.film.as_ref()) {
            clear_film(&self.context, film);
        }
    }

    /// The film as it stands, read back without tracing: the sums of every sample drawn since the image began.
    pub(crate) fn read_film(&mut self) -> Result<CyclesFilmRead> {
        self.fail_if_unusable()?;
        let held_film = self.gpu.as_ref().and_then(|gpu| gpu.film.as_ref());
        let film = match (held_film, self.film_holds_samples) {
            (Some(film), true) => film,
            _ => {
                return Err(failure(
                    "The session film holds no samples to resolve: render first (with accumulate: true to build an image over several calls). reset() and update() clear the film.",
                ))
            }
        };
        let sums = read_accumulation(
            &self.context.device,
            &self.context.queue,
            &film.accumulation,
            image_accumulation_bytes(film.width, film.height),
        )?;
        Ok(CyclesFilmRead {
            sums,
            width: film.width,
            height: film.height,
            film_samples: self.film_sample_count,
            target_samples: self.progressive.as_ref().map(|held| held.target_samples),
            frame_index: self.renders_completed,
        })
    }

    /// Replaces the values of scene tables without rebuilding the pipeline or the BLAS. The tables keep their size and the
    /// instances their meshes (see `plan_instance_update`); the TLAS is rebuilt only when a transform or a ray visibility
    /// changed. The film is cleared, since the image it holds no longer shows the scene. Everything is checked before
    /// anything on the card changes, so a refused update leaves the session as it was.
    pub(crate) fn update(&mut self, update: &CyclesSceneUpdate<'_>) -> Result<CyclesUpdateReport> {
        self.fail_if_unusable()?;
        let update_started = Instant::now();
        validate_kernel_params_v2(update.kernel_params)?;
        check_update_params_keep_scene_shape(&self.session_kernel_params, update.kernel_params)?;
        validate_light_tree_flag_has_tables(update.kernel_params, self.light_tree_node_count, self.has_light_tree_tables)?;
        for (table, bytes) in &update.tables {
            let held_length = self.retained.table_lengths[table.buffer_index()];
            if bytes.len() != held_length {
                return Err(failure(format!(
                    "The new {} table holds {} bytes but the session holds {held_length}. An update keeps the record counts; create a new session for this input.",
                    table.input_name(),
                    bytes.len()
                )));
            }
        }
        let new_instances =
            update.tables.iter().find(|(table, _)| *table == UpdatableTable::Instances).map(|(_, bytes)| *bytes);
        let instance_plan = match new_instances {
            Some(bytes) => Some(plan_instance_update(&self.retained.instances, bytes)?),
            None => None,
        };

        let upload_started = Instant::now();
        let context = &self.context;
        let gpu = self.gpu.as_mut().ok_or_else(session_closed_failure)?;
        for (table, bytes) in &update.tables {
            let label = format!("cycles {} (updated)", table.input_name());
            gpu.scene_tables[table.buffer_index()] = storage_buffer(&context.device, &label, bytes);
            self.retained.keep_table(*table, bytes);
        }
        let upload_seconds = upload_started.elapsed().as_secs_f64();

        let rebuild_started = Instant::now();
        let acceleration_rebuilt = instance_plan.as_ref().is_some_and(|plan| plan.tlas_dirty);
        if let (true, Some(bytes)) = (acceleration_rebuilt, new_instances) {
            rebuild_cycles_tlas(&context.device, &context.queue, &mut gpu.acceleration, bytes)?;
        }
        let acceleration_rebuild_seconds = rebuild_started.elapsed().as_secs_f64();

        if !update.tables.is_empty() {
            rebind_film(context, gpu)?;
        }
        self.session_kernel_params = update.kernel_params.to_vec();
        let respecialized = self.retained.specialization();
        let kernel_respecialized = respecialized != self.scene_specialization;
        self.scene_specialization = respecialized;
        self.clear_progressive_film();

        Ok(CyclesUpdateReport {
            uploaded_tables: update.tables.iter().map(|(table, _)| table.input_name()).collect(),
            acceleration_rebuilt,
            changed_instances: instance_plan.map_or(0, |plan| plan.changed_instances as u32),
            kernel_respecialized,
            upload_seconds,
            acceleration_rebuild_seconds,
            update_seconds: update_started.elapsed().as_secs_f64(),
        })
    }
}

/// The film of a session read back without tracing.
pub(crate) struct CyclesFilmRead {
    pub(crate) sums: Vec<f32>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// The samples per pixel the film holds.
    pub(crate) film_samples: u32,
    pub(crate) target_samples: Option<u32>,
    pub(crate) frame_index: u32,
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

/// Builds a new bind group over the current scene buffers and the film that exists, after an update replaced buffers.
fn rebind_film(context: &CyclesDeviceContext, gpu: &mut SessionGpuState) -> Result<()> {
    let Some(film) = gpu.film.as_ref() else {
        return Ok(());
    };
    let bind_group = with_cycles_cache_on(Some(&context.device_lost), |device, _queue, layout, lut| {
        create_cycles_bind_group(
            device,
            layout,
            &gpu.parameters,
            &gpu.acceleration.tlas,
            &gpu.scene_tables,
            &film.accumulation,
            lut,
        )
    })?;
    if let Some(film) = gpu.film.as_mut() {
        film.bind_group = bind_group;
    }
    Ok(())
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

    /// One opaque material record with no texture on any slot (a texture index of -1 means none) and the given transmission.
    fn plain_material(transmission_weight: f32) -> Vec<u8> {
        let mut material = vec![0u8; 256];
        material[52..56].copy_from_slice(&transmission_weight.to_le_bytes());
        for texture_slot_byte in [212usize, 216, 224, 228, 236, 240, 244, 248, 252] {
            material[texture_slot_byte..texture_slot_byte + 4].copy_from_slice(&(-1i32).to_le_bytes());
        }
        material
    }

    fn scan_test_input(transmission_weight: f32, light_group_mask_lo: u32) -> NativeTraceInputV2 {
        let materials = plain_material(transmission_weight);
        let mut lights = vec![0u8; 128];
        lights[12..16].copy_from_slice(&2u32.to_le_bytes());
        lights[120..124].copy_from_slice(&light_group_mask_lo.to_le_bytes());
        lights[124..128].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        NativeTraceInputV2 {
            schema_version: 2,
            kernel_params: Uint8Array::new(vec![0u8; 320]),
            instances: Uint8Array::new(vec![0u8; 160]),
            instance_count: 1,
            triangles: Uint8Array::new(vec![0u8; 224]),
            triangle_count: 1,
            materials: Uint8Array::new(materials),
            material_count: 1,
            emissive_triangles: Uint8Array::new(vec![0u8; 96]),
            emissive_triangle_count: 0,
            lights: Uint8Array::new(lights),
            light_count: 1,
            light_tree_nodes: Uint8Array::new(vec![0u8; 64]),
            light_tree_node_count: 1,
            light_tree_emitters: None,
            light_tree_emitter_count: None,
            light_to_tree: None,
            texture_descriptors: Uint8Array::new(vec![0u8; 32]),
            texture_count: 1,
            texture_texels: Uint32Array::new(vec![0u32; 4]),
            environment_texels: Float32Array::new(vec![0f32; 4]),
        }
    }

    #[test]
    fn the_retained_tables_specialize_the_kernel_like_the_whole_input() {
        for (transmission_weight, light_group_mask_lo) in [(0.0, 0xFFFF_FFFF), (0.7, 0xFFFF_FFFF), (0.0, 0x0F)] {
            let input = scan_test_input(transmission_weight, light_group_mask_lo);
            let retained = RetainedTables::of_input(&input);
            assert_eq!(retained.specialization(), scan_scene_specialization(&input));
        }
        let glass = RetainedTables::of_input(&scan_test_input(0.7, 0xFFFF_FFFF));
        let clear = RetainedTables::of_input(&scan_test_input(0.0, 0xFFFF_FFFF));
        assert_ne!(glass.specialization(), clear.specialization(), "a transmissive material changes the specialization");
    }

    #[test]
    fn keeping_an_updated_table_changes_what_the_specialization_reads() {
        let mut retained = RetainedTables::of_input(&scan_test_input(0.0, 0xFFFF_FFFF));
        let before = retained.specialization();
        retained.keep_table(UpdatableTable::Materials, &plain_material(0.7));
        assert_ne!(retained.specialization(), before);
        assert_eq!(retained.table_lengths[UpdatableTable::Materials.buffer_index()], 256);
        assert_eq!(retained.table_lengths[UpdatableTable::Lights.buffer_index()], 128);
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
