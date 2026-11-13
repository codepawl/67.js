// What a render job will cost on this machine, and what it did cost. The estimate comes from the scene's size and the job's
// settings alone, so the same inputs give the same answer. A correction learned from the last few jobs on this machine
// (kept in the jobs folder, never sent anywhere) can move it, within a fixed bound.

const MIB = 1024 ** 2;

/** What scene_capabilities topic jobs says about the estimate and the report. The details are in docs/mcp.md. */
export const RENDER_ESTIMATE_NOTE = 'scene_render_submit returns estimate { seconds, peakMemoryMiB, basis } for this device before the job runs (from the scene size, the settings and the last 16 jobs here; about 2x either way). scene_render_result metrics.report holds measured time and peak memory, the ratio to the estimate, samplesDrawn for the path tracer, and fallbacks (what ran differently and why).';

/** Jobs kept in the history, newest last. Older ones are dropped. */
export const HISTORY_LIMIT = 16;
/** The history may scale the estimate by at most this factor either way, so one odd run cannot make it useless. */
export const CORRECTION_BOUND = 4;
/** The history needs this many runs of the same kind before it changes anything. */
const MINIMUM_HISTORY_RUNS = 2;

/**
 * Seconds and bytes per unit of work, fitted to jobs measured with scripts/measure-render-estimate.mjs. A frame costs a fixed
 * part, a part per pixel and a part per triangle; the scene is built once per job, which dominates large scenes. The path
 * tracer's trace cost is per pixel, sample and bounce, and its acceleration structure costs per triangle.
 */
export const COST_MODEL = Object.freeze({
  startupSeconds: 0.25,
  setupSecondsPerTriangle: 3.3e-6,
  // A placed asset is rebuilt from its glTF parts (skeleton, materials, textures) however few triangles it has.
  setupSecondsPerAssetPart: 1.2e-3,
  drawSecondsPerAssetPart: 3.5e-5,
  drawFrameSeconds: 0.004,
  drawSecondsPerPixel: 5e-8,
  drawSecondsPerTriangle: 1e-8,
  drawSecondsPerLight: 5e-4,
  passFactor: 0.6,
  imageCaptureSeconds: 0.02,
  videoEncodeSeconds: 0.005,
  pathTracerSecondsPerSampleBounce: Object.freeze({ cpu: 5e-7, gpu: 1e-7, native: 1e-7 }),
  // The first GPU path trace in a runtime compiles its kernel; measured at about 10 s, and later traces do not pay it.
  gpuTracerColdStartSeconds: 9.5,
  pathTracerBuildSecondsPerTriangle: 3.7e-6,
  pathTracerOutputSeconds: 0.03,
  nodeBaseMiB: 185,
  extraMiBPerPart: 1,
  extraMiBPerThousandTriangles: 0.3,
  maximumSceneExtraMiB: 250,
  pathTracerExtraMiB: 30,
  miBPerTexture: 4,
  nodeBytesPerPixel: 24,
});

function textureCount(recipe) {
  const text = JSON.stringify(recipe?.materials ?? []);
  return (text.match(/"(?:map|texture|image|[a-zA-Z]+Map)"s*:/g) ?? []).length;
}

/**
 * The numbers about the scene that the estimate uses, from the scene's inspection result (listing every node) and its recipe.
 * Triangles count each placed node, so ten spheres cost ten spheres even when they share one geometry.
 */
export function sceneSizeFrom(inspection, recipe) {
  const look = inspection?.look ?? {};
  const listed = inspection?.nodes ?? [];
  const listedTriangles = listed.reduce((total, node) => total + (node.triangles ?? 0), 0);
  const scale = inspection?.truncated && listed.length ? (inspection.counts?.parts ?? listed.length) / listed.length : 1;
  // The node list leaves out the parts of placed assets, and generated geometry (vegetation, crowds, arrays) has no node of its own;
  // the resident vertex count covers both, so the larger of the two counts stands.
  // Copies of one placed asset share its geometry in that count, so the part of it that no node lists is counted once per copy.
  const residentTriangles = Math.round((inspection?.counts?.vertices ?? 0) / 2);
  const listedScaled = Math.round(listedTriangles * scale);
  const placements = (inspection?.assets ?? []).filter(placement => typeof placement.assetId === 'string');
  const copiesPerAsset = placements.length / Math.max(1, new Set(placements.map(placement => placement.assetId)).size);
  const generatedTriangles = Math.max(0, residentTriangles - listedScaled) * Math.max(1, copiesPerAsset);
  return {
    parts: inspection?.counts?.parts ?? 0,
    assetParts: placements.reduce((total, placement) => total + (placement.parts ?? 0), 0),
    triangles: listedScaled + generatedTriangles,
    materials: inspection?.counts?.materials ?? 0,
    textures: textureCount(recipe),
    lights: (look.pointLights ?? 0) + (look.spotLights ?? 0) + (look.areaLights ?? 0) + 1,
  };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pathTracerFrameSeconds({ size, settings, backend }) {
  const renderer = settings.renderer;
  const secondsPerSampleBounce = COST_MODEL.pathTracerSecondsPerSampleBounce[renderer.backend ?? backend] ?? COST_MODEL.pathTracerSecondsPerSampleBounce.cpu;
  const traceSeconds = settings.width * settings.height * renderer.samples * renderer.bounces * secondsPerSampleBounce;
  return Math.min(renderer.maxSeconds, traceSeconds) + size.triangles * COST_MODEL.pathTracerBuildSecondsPerTriangle + COST_MODEL.pathTracerOutputSeconds;
}

function rasterFrameSeconds({ size, settings }) {
  const drawSeconds = COST_MODEL.drawFrameSeconds + settings.width * settings.height * COST_MODEL.drawSecondsPerPixel
    + size.triangles * COST_MODEL.drawSecondsPerTriangle + size.assetParts * COST_MODEL.drawSecondsPerAssetPart + size.lights * COST_MODEL.drawSecondsPerLight;
  const outputSeconds = settings.kind === 'video' ? COST_MODEL.videoEncodeSeconds : COST_MODEL.imageCaptureSeconds;
  return drawSeconds * (1 + (settings.passes?.length ?? 0) * COST_MODEL.passFactor) + outputSeconds;
}

function peakMemoryMiB({ size, settings }) {
  const sceneMiB = Math.min(COST_MODEL.maximumSceneExtraMiB, size.parts * COST_MODEL.extraMiBPerPart + (size.triangles / 1000) * COST_MODEL.extraMiBPerThousandTriangles);
  return COST_MODEL.nodeBaseMiB + sceneMiB + size.textures * COST_MODEL.miBPerTexture
    + (settings.renderer ? COST_MODEL.pathTracerExtraMiB : 0) + (settings.width * settings.height * COST_MODEL.nodeBytesPerPixel) / MIB;
}

/** The kind of job a history entry and a new job share: same output kind and same way of rendering. */
export function jobKind(settings, backend) {
  return `${settings.renderer ? `pathTracer-${settings.renderer.backend ?? backend}` : 'raster'}-${settings.kind === 'video' ? 'video' : 'image'}-${backend}`;
}

function medianOf(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boundedRatio(ratio) {
  return Math.min(CORRECTION_BOUND, Math.max(1 / CORRECTION_BOUND, ratio));
}

/** Median of measured over estimated, from the last runs of the same kind; 1 when there are too few. */
export function correctionFromHistory(history, kind) {
  const runs = (history ?? []).filter(entry => entry.kind === kind && entry.estimatedSeconds > 0 && entry.measuredSeconds > 0);
  if (runs.length < MINIMUM_HISTORY_RUNS) return { seconds: 1, memory: 1, runs: runs.length, secondsClamped: false, memoryFromHistory: false };
  const rawSeconds = medianOf(runs.map(entry => entry.measuredSeconds / entry.estimatedSeconds));
  const seconds = boundedRatio(rawSeconds);
  const memoryRuns = runs.filter(entry => entry.estimatedPeakMemoryMiB > 0 && entry.measuredPeakMemoryMiB > 0);
  const memory = memoryRuns.length >= MINIMUM_HISTORY_RUNS ? boundedRatio(medianOf(memoryRuns.map(entry => entry.measuredPeakMemoryMiB / entry.estimatedPeakMemoryMiB))) : 1;
  return { seconds, memory, runs: runs.length, secondsClamped: seconds !== rawSeconds, memoryFromHistory: memoryRuns.length >= MINIMUM_HISTORY_RUNS };
}

/** Says where the numbers came from: the history is whatever sits in this jobs folder, not a named machine. */
function basisOf(correction, kind) {
  if (correction.runs < MINIMUM_HISTORY_RUNS) return 'scene size';
  const notes = [];
  if (correction.secondsClamped) notes.push(`time factor limited to ${CORRECTION_BOUND}x`);
  if (!correction.memoryFromHistory) notes.push('memory from scene size only');
  return `scene size and the last ${correction.runs} ${kind} jobs in this jobs folder${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * Expected time and peak memory of a job. `settings` is the normalized job settings (width, height, kind, frameCount, passes,
 * renderer). The raw size-only numbers are `modelSeconds` and `modelPeakMemoryMiB`; the headline numbers apply the history.
 */
export function estimateRenderJob({ size, settings, backend, memoryBudgetMiB, history = [], gpuTracerWarm = true }) {
  const frameSeconds = settings.renderer ? pathTracerFrameSeconds({ size, settings, backend }) : rasterFrameSeconds({ size, settings });
  const coldStartSeconds = settings.renderer?.backend === 'gpu' && !gpuTracerWarm ? COST_MODEL.gpuTracerColdStartSeconds : 0;
  const modelSeconds = COST_MODEL.startupSeconds + coldStartSeconds + size.triangles * COST_MODEL.setupSecondsPerTriangle + size.assetParts * COST_MODEL.setupSecondsPerAssetPart + frameSeconds * settings.frameCount;
  const modelPeakMemoryMiB = peakMemoryMiB({ size, settings });
  const correction = correctionFromHistory(history, jobKind(settings, backend));
  const estimate = {
    seconds: round(modelSeconds * correction.seconds, 1),
    peakMemoryMiB: Math.round(modelPeakMemoryMiB * correction.memory),
    framesPerSecond: round(settings.frameCount / Math.max(0.001, modelSeconds * correction.seconds), 2),
    frameSeconds: round(frameSeconds * correction.seconds, 4),
    fixedSeconds: round((modelSeconds - frameSeconds * settings.frameCount) * correction.seconds, 2),
    basis: basisOf(correction, jobKind(settings, backend)),
    modelSeconds: round(modelSeconds, 1),
    modelPeakMemoryMiB: Math.round(modelPeakMemoryMiB),
    scene: size,
  };
  if (memoryBudgetMiB !== undefined) estimate.renderTargetBudgetMiB = memoryBudgetMiB;
  return estimate;
}

/** Facts about what did not run as asked: a budget that shrank the frame, a backend that fell back, a denoiser that was swapped. */
function frameWasReduced(metrics) {
  return Boolean(metrics.width && metrics.requestedWidth && (metrics.width < metrics.requestedWidth || metrics.height < metrics.requestedHeight));
}

function fallbacksFrom(settings, metrics) {
  const fallbacks = [];
  if (frameWasReduced(metrics)) {
    fallbacks.push(`The memory budget reduced the frame from ${metrics.requestedWidth}x${metrics.requestedHeight} to ${metrics.width}x${metrics.height}.`);
  }
  if (metrics.pathTracer?.backendNote) fallbacks.push(metrics.pathTracer.backendNote);
  if (metrics.pathTracer?.denoiserNote) fallbacks.push(metrics.pathTracer.denoiserNote);
  return fallbacks;
}

/** The one record of a finished job: estimate beside what was measured, the samples drawn and what fell back. */
export function renderReport({ estimate, settings, metrics }) {
  const measuredSeconds = metrics.elapsedSeconds;
  const measuredPeakMemoryMiB = Math.round(((metrics.peakNodeBytes ?? 0) + (metrics.peakBrowserHeap ?? 0)) / MIB);
  const report = {
    measured: { seconds: round(measuredSeconds, 2), peakMemoryMiB: measuredPeakMemoryMiB, frames: settings.frameCount, secondsPerFrame: round(measuredSeconds / settings.frameCount, 3) },
    fallbacks: fallbacksFrom(settings, metrics),
  };
  if (estimate) {
    report.estimate = { seconds: estimate.seconds, peakMemoryMiB: estimate.peakMemoryMiB, basis: estimate.basis };
    report.secondsRatio = round(measuredSeconds / estimate.seconds, 2);
  }
  if (frameWasReduced(metrics)) report.frameReduced = true;
  const traced = metrics.pathTracer;
  if (traced) {
    // The path tracer's report describes the last frame; the samples asked for are in the job's settings.
    if (traced.averageSamples !== undefined) report.samplesDrawn = traced.averageSamples;
    if (settings.renderer) report.samplesRequested = settings.renderer.samples;
  }
  return report;
}

/** The history with this job added, trimmed to the newest HISTORY_LIMIT entries. */
export function historyWithJob(history, { settings, backend, estimate, report }) {
  // The estimate was for the requested size, so a job that ran smaller says nothing about it.
  if (!estimate || !report.measured.seconds || report.frameReduced) return history;
  const entry = {
    kind: jobKind(settings, backend),
    estimatedSeconds: estimate.modelSeconds,
    measuredSeconds: report.measured.seconds,
    estimatedPeakMemoryMiB: estimate.modelPeakMemoryMiB,
    measuredPeakMemoryMiB: report.measured.peakMemoryMiB,
  };
  return [...history, entry].slice(-HISTORY_LIMIT);
}

/** Accepts only a plain list of well-formed entries from the history file; anything else is treated as no history. */
export function parseHistory(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const numeric = ['estimatedSeconds', 'measuredSeconds', 'estimatedPeakMemoryMiB', 'measuredPeakMemoryMiB'];
    return parsed.filter(entry => entry && typeof entry.kind === 'string' && numeric.every(field => Number.isFinite(entry[field]))).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}
