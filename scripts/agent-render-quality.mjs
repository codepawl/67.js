// One `quality` setting for render jobs: four tiers named by what the render is for, mapped onto the renderers that exist. Nothing
// here renders. The raster options are plain data the preview page reads; the rest decides, from the device and the job, which tier
// can run and what a tier asks of the job.

/** Worst to best. */
export const QUALITY_TIERS = Object.freeze(['draft', 'realtime', 'realtime-high', 'final']);

/** What scene_capabilities topic jobs says about quality. The details are in docs/render-quality.md. */
export const RENDER_QUALITY_NOTE = 'settings.quality names what the render is for: draft (Glaze, light shading, no multisampling, coarse detail), realtime (Glaze defaults), realtime-high (Glaze with 8 samples and finer detail; needs a hardware GPU) or final (the path tracer at 256 samples, denoised; needs a lit PNG with no passes, transparency, region, multilayer or EXR). The same scene renders in any tier from a call that differs only in quality. A tier this device or job cannot run falls back one tier at a time, and submit returns quality { requested, picked, steps } with the missing capability of each step. quality is for choosing; settings.budget is for limits and picks the tier itself, so give one of them. tiers below lists which tiers this device can run.';

/** Glaze (CrucibleRenderer) options per raster tier. realtime keeps the preview's own defaults. */
export const RASTER_TIER_OPTIONS = Object.freeze({
  draft: Object.freeze({ samples: 1, shading: 'light', lodPixelError: 4 }),
  realtime: Object.freeze({}),
  'realtime-high': Object.freeze({ samples: 8, lodPixelError: 0.5 }),
});

/** The path tracer settings of the final tier; the backend is chosen per device. */
export const FINAL_TIER_RENDERER = Object.freeze({ type: 'pathTracer', samples: 256, denoise: 'wavelet' });

import { PATH_TRACER_JOB_LIMITS } from '../src/path-tracer-capabilities.js';

const PATH_TRACER_ONLY_LIT_PNG = ['passes', 'transparent', 'region', 'multilayer'];

export function parseQuality(value) {
  if (!QUALITY_TIERS.includes(value)) throw new TypeError(`quality must be one of ${QUALITY_TIERS.join(', ')}.`);
  return value;
}

/**
 * The raster options for a tier on a runtime backend. SwiftShader draws one sample whatever is asked, so a software runtime never
 * asks for more.
 */
export function rasterOptionsFor(tier, backend) {
  const options = RASTER_TIER_OPTIONS[tier] ?? RASTER_TIER_OPTIONS.realtime;
  return { ...options, samples: backend === 'cpu' ? 1 : options.samples ?? 4 };
}

/** Why a job cannot be traced, or undefined when it can. Matches the settings the path tracer refuses. */
export function pathTracerBlocker(settings) {
  const blocked = PATH_TRACER_ONLY_LIT_PNG.filter(name => settings[name]);
  if (settings.format && settings.format !== 'png') blocked.push(`format ${settings.format}`);
  if (!blocked.length) return undefined;
  return `a job the path tracer can draw (it writes only the lit PNG image, and this job asks for ${blocked.join(', ')})`;
}

/**
 * What stops a tier on this device, or undefined when it can run. `nativeTracer` is the locator's answer, `jobSettings` the job
 * when the check is for one job (a device report passes none).
 */
export function missingCapability(tier, { backend, jobSettings }) {
  if (tier === 'realtime-high' && backend === 'cpu') {
    return 'a hardware GPU (this runtime runs on SwiftShader, which draws one sample per pixel)';
  }
  if (tier === 'final' && jobSettings) return pathTracerBlocker(jobSettings);
  return undefined;
}

/** Which tiers this device can run, each with the backend that runs it or the capability it lacks. */
export function tierReport({ backend, nativeTracer }) {
  const tracerBackend = nativeTracer ? 'native' : backend === 'cpu' ? 'cpu' : 'gpu';
  return QUALITY_TIERS.map(tier => {
    const missing = missingCapability(tier, { backend });
    const runs = tier === 'final' ? `path tracer, ${tracerBackend} backend` : `Glaze raster${tier === 'draft' ? ', light shading' : ''}${backend === 'cpu' ? ', SwiftShader' : ''}`;
    return missing ? { tier, available: false, missing, fallsBackTo: QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) - 1] } : { tier, available: true, runs };
  });
}

function finalSettings(base, backend, nativeTracer) {
  const tracerBackend = nativeTracer ? 'native' : backend === 'cpu' ? 'cpu' : 'gpu';
  return { ...base, quality: 'final', renderer: { ...FINAL_TIER_RENDERER, backend: tracerBackend } };
}

/** The final tier's trace is stopped at renderer.maxSeconds a frame; a frame estimated past it would fail, so the tier is not offered. */
function traceTooLong(settings, estimateOf) {
  if (!estimateOf) return undefined;
  const limit = settings.renderer.maxSeconds ?? PATH_TRACER_JOB_LIMITS.maxSeconds.default;
  const frameSeconds = estimateOf(settings).frameSeconds;
  if (frameSeconds <= limit) return undefined;
  return `a trace that fits the ${limit} s limit on one frame (this job is estimated at ${Math.round(frameSeconds)} s a frame: ${settings.width}x${settings.height}, ${settings.renderer.samples} samples on the ${settings.renderer.backend} backend)`;
}

/**
 * Turns a requested tier into the job settings to run. A tier that cannot run gives way to the one below it, and every step
 * says what was missing. `base` is the caller's settings without `quality`; the result's `report` always names the tier picked.
 * `estimateOf(settings)` is the job estimate: a final job whose frame is expected to outlast the path tracer's maxSeconds gives way too,
 * since the job would fail past that limit instead of finishing.
 */
export function applyQuality({ quality, base, backend, nativeTracer, estimateOf }) {
  const requested = parseQuality(quality);
  if (base.renderer !== undefined) throw new TypeError('quality picks the renderer: leave settings.renderer out, or leave settings.quality out to choose it yourself.');
  const steps = [];
  let tier = requested;
  while (true) {
    const missing = missingCapability(tier, { backend, jobSettings: base })
      ?? (tier === 'final' ? traceTooLong(finalSettings(base, backend, nativeTracer), estimateOf) : undefined);
    if (!missing) break;
    const lower = QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) - 1];
    steps.push({ from: tier, to: lower, missing });
    tier = lower;
  }
  const settings = tier === 'final' ? finalSettings(base, backend, nativeTracer) : { ...base, quality: tier };
  const message = steps.length
    ? `quality ${requested} could not run, so ${tier} ran: ${steps.map(step => `${step.from} lacks ${step.missing}`).join('; ')}.`
    : undefined;
  return { settings, report: { requested, picked: tier, ...(steps.length ? { steps, message } : {}) } };
}
