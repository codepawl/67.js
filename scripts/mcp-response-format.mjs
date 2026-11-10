// response_format on the review, render-job and capability tools: "concise" leaves out what an agent rarely acts on, and
// "detailed" is the full answer. The server picks the default per tool (RESPONSE_FORMAT_DEFAULTS).
import * as z from 'zod/v4';

export const RESPONSE_FORMATS = ['concise', 'detailed'];

/** The same bare enum on every tool that takes the choice: a description would repeat on each tool, and the defaults are in the docs. */
export const responseFormatField = z.enum(RESPONSE_FORMATS).optional();

// Review and job answers are polled, so they default to the short form. A capability topic exists to be read in full.
export const RESPONSE_FORMAT_DEFAULTS = {
  scene_review: 'concise',
  scene_render_status: 'concise',
  scene_render_result: 'concise',
  scene_capabilities: 'detailed',
};

export function chosenFormat(toolName, requested) {
  return requested ?? RESPONSE_FORMAT_DEFAULTS[toolName];
}

function without(record, names) {
  const kept = { ...record };
  for (const name of names) delete kept[name];
  return kept;
}

// Per-shot render diagnostics: the camera, label positions and branch stay, the resource counters go.
const SHOT_DIAGNOSTICS = [
  'graphics', 'estimatedBytes', 'samples', 'hdr', 'depth', 'geometryBuffers', 'materialTextures', 'skinTextures',
  'morphTextures', 'gpuBuffers', 'drawBatches', 'requestedWidth', 'requestedHeight', 'width', 'height',
];
const REVIEW_DIAGNOSTICS = ['backend', 'peakNodeBytes', 'peakBrowserHeap', 'maximumPendingFrames', 'elapsedSeconds'];

function conciseShot(shot) {
  const kept = without(shot, SHOT_DIAGNOSTICS);
  // An unset clock is the default; only a sampled one tells the agent something.
  if (kept.animation === null) delete kept.animation;
  if (kept.motionTime === null) delete kept.motionTime;
  if (kept.rendererTime === 0) delete kept.rendererTime;
  return kept;
}

export function conciseReview(metadata) {
  return { ...without(metadata, REVIEW_DIAGNOSTICS), shots: metadata.shots.map(conciseShot) };
}

/** State and progress; the settings the agent submitted are not echoed back. */
export function conciseJobStatus(record) {
  const concise = { jobId: record.jobId, state: record.state, frames: record.progress?.frames };
  if (record.settings?.frameCount !== undefined) concise.frameCount = record.settings.frameCount;
  if (record.reason !== undefined) concise.reason = record.reason;
  if (record.artifacts?.length) concise.artifacts = record.artifacts.map(artifact => artifact.filename);
  return concise;
}

// Resource counters of the render itself. Every other metric (passes, depth range, object names, sync, path tracer) answers
// something the agent asked for, so it stays.
const METRIC_DIAGNOSTICS = [
  'graphics', 'estimatedBytes', 'peakNodeBytes', 'peakBrowserHeap', 'maximumPendingFrames', 'requestedWidth',
  'requestedHeight', 'elapsedSeconds', 'captureSeconds',
];

/** Files with their paths and sizes; digests and the render's resource counters stay in the detailed answer. */
export function conciseJobResult(result) {
  const concise = {
    jobId: result.jobId,
    sourceRevision: result.sourceRevision,
    artifacts: result.artifacts.map(artifact => without(artifact, ['sha256'])),
  };
  if (result.metrics !== undefined) concise.metrics = without(result.metrics, METRIC_DIAGNOSTICS);
  return concise;
}

const NOTE_SEPARATOR = ' // ';
const NOTE_KEY = '_';

/** An outline without its one-line notes: field names, types, ranges and enums only. */
export function withoutNotes(outline) {
  if (typeof outline === 'string') return outline.split(NOTE_SEPARATOR)[0];
  if (Array.isArray(outline)) return outline.map(withoutNotes);
  if (outline && typeof outline === 'object') {
    const kept = {};
    for (const [name, value] of Object.entries(outline)) {
      if (name !== NOTE_KEY) kept[name] = withoutNotes(value);
    }
    return kept;
  }
  return outline;
}
