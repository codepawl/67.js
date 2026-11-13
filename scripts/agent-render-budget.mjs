// Picks a render job's settings from a budget instead of by hand. The candidates run from the best looking to the cheapest; the
// first one whose estimate fits the budget wins. Nothing here renders: it asks agent-render-estimate.mjs what each candidate
// would cost, so the same scene, budget and history always give the same pick.

/** What scene_capabilities topic jobs says about the budget. The details are in docs/mcp.md. */
export const RENDER_BUDGET_NOTE = 'settings.budget { secondsPerFrame | framesPerSecond, memoryMiB? } replaces hand-picked renderer settings: width and height become the largest frame, and the job takes the best candidate whose estimate fits (path tracer at 256, 64 or 16 samples, then raster at scale 1, 0.75, 0.5, 0.25). secondsPerFrame counts the whole job divided by its frames; framesPerSecond is a render-speed budget (not settings.fps, the video rate) and counts only the per-frame cost, leaving startup and scene build out. A pick is expected to use at most 85% of the time. submit returns budget { picked, fits, reason, considered }, and picked.tier names the quality tier (final, realtime-high or realtime, draft); when nothing fits the cheapest candidate runs and fits is false.';

export const BUDGET_LIMITS = Object.freeze({
  secondsPerFrame: Object.freeze({ minimum: 0.001, maximum: 3600 }),
  framesPerSecond: Object.freeze({ minimum: 0.01, maximum: 240 }),
  memoryMiB: Object.freeze({ minimum: 64, maximum: 65536 }),
});

/** Quality order, best first. A path tracer candidate keeps the frame size; a raster candidate shrinks it. */
export const PATH_TRACER_SAMPLE_STEPS = Object.freeze([256, 64, 16]);
export const RASTER_SCALE_STEPS = Object.freeze([1, 0.75, 0.5, 0.25]);

/** A candidate must be expected to finish within this share of the time budget, because the estimate is only good to a few tens of percent. */
export const TIME_HEADROOM = 0.85;
const MINIMUM_SIDE = 64;
const TRACER_BLOCKERS = ['passes', 'transparent', 'region', 'multilayer'];

function limitedNumber(value, name) {
  const { minimum, maximum } = BUDGET_LIMITS[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`budget.${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

/** The budget as { secondsPerFrame, memoryMiB? }; a frame rate is turned into seconds per frame. Throws with what to pass instead. */
export function parseBudget(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('budget must be an object such as { "secondsPerFrame": 2 } or { "framesPerSecond": 30, "memoryMiB": 1024 }.');
  }
  const unknown = Object.keys(input).filter(name => !(name in BUDGET_LIMITS));
  if (unknown.length) throw new TypeError(`budget has no field ${unknown.join(', ')}. Use secondsPerFrame or framesPerSecond, and optionally memoryMiB.`);
  const hasSeconds = input.secondsPerFrame !== undefined;
  const hasRate = input.framesPerSecond !== undefined;
  if (hasSeconds === hasRate) throw new TypeError('budget needs exactly one of secondsPerFrame (offline renders) or framesPerSecond (realtime previews).');
  const secondsPerFrame = hasSeconds ? limitedNumber(input.secondsPerFrame, 'secondsPerFrame') : 1 / limitedNumber(input.framesPerSecond, 'framesPerSecond');
  const budget = { secondsPerFrame };
  if (hasRate) budget.framesPerSecond = input.framesPerSecond;
  if (input.memoryMiB !== undefined) budget.memoryMiB = limitedNumber(input.memoryMiB, 'memoryMiB');
  return budget;
}

/** Both sides shrink by one factor so the aspect holds; the factor is raised when it would take the short side under the minimum. */
function scaledSize(base, scale) {
  const unit = base.kind === 'video' ? 2 : 1;
  const factor = Math.max(scale, MINIMUM_SIDE / Math.min(base.width, base.height));
  const side = length => Math.min(length, Math.max(MINIMUM_SIDE, Math.round((length * factor) / unit) * unit));
  return { width: side(base.width), height: side(base.height) };
}

/** Raw job settings (what the caller would have written by hand) for each candidate, best first, with a label. */
export function budgetCandidates(base, tracerBackend) {
  const candidates = [];
  const tracerAllowed = !TRACER_BLOCKERS.some(name => base[name]) && !(base.format && base.format !== 'png');
  if (tracerAllowed) {
    for (const samples of PATH_TRACER_SAMPLE_STEPS) {
      candidates.push({ tier: 'final', label: `path tracer, ${samples} samples, full size`, settings: { ...base, quality: 'final', renderer: { type: 'pathTracer', backend: tracerBackend, samples, denoise: 'wavelet' } } });
    }
  }
  // A region is placed in pixels of the full frame, so a region job keeps the full size.
  for (const scale of base.region ? [1] : RASTER_SCALE_STEPS) {
    const { width, height } = scaledSize(base, scale);
    const previous = candidates[candidates.length - 1]?.settings;
    if (previous && !previous.renderer && previous.width === width && previous.height === height) continue;
    // Full size raster is Glaze at its best for the device; a smaller frame is the draft tier. The estimate cannot tell realtime from realtime-high, so realtime is never picked here.
    const tier = scale === 1 ? (tracerBackend === 'cpu' ? 'realtime' : 'realtime-high') : 'draft';
    candidates.push({ tier, label: `raster, ${scale === 1 ? 'full size' : `${scale} scale`}`, settings: { ...base, width, height, quality: tier } });
  }
  return candidates;
}

function cost(estimate) {
  return { seconds: estimate.seconds, peakMemoryMiB: estimate.peakMemoryMiB };
}

/**
 * Chooses among the candidates. `estimateOf(rawSettings)` returns an estimate for a candidate; `frameCount` turns its seconds into seconds per frame. The result holds the settings to
 * submit and the report of the choice: what was picked, whether it fits, why, and what each candidate was expected to cost.
 */
export function chooseBudgetSettings({ base, budget, tracerBackend, frameCount, estimateOf, serverMemoryMiB }) {
  const failures = [];
  const considered = [];
  for (const candidate of budgetCandidates(base, tracerBackend)) {
    try {
      const estimate = estimateOf(candidate.settings);
      // A frame rate budget is about render speed, so it leaves the one-time startup and scene build out.
      const timePerFrame = budget.framesPerSecond === undefined ? estimate.seconds / frameCount : estimate.frameSeconds;
      considered.push({ ...candidate, estimate, timePerFrame, secondsPerFrame: round(timePerFrame, 3) });
    } catch (error) {
      failures.push(`${candidate.label}: ${error.message}`);
    }
  }
  if (!considered.length) throw new RangeError(`budget found no candidate this job can use. ${failures.join(' ')}`);
  const fits = candidate => candidate.timePerFrame <= budget.secondsPerFrame * TIME_HEADROOM && (budget.memoryMiB === undefined || candidate.estimate.peakMemoryMiB <= budget.memoryMiB);
  const fitting = considered.find(fits);
  const cheapest = [...considered].sort((first, second) => first.timePerFrame - second.timePerFrame || first.estimate.peakMemoryMiB - second.estimate.peakMemoryMiB)[0];
  const picked = fitting ?? cheapest;
  const { settings, label } = picked;
  const requested = { secondsPerFrame: round(budget.secondsPerFrame, 4) };
  if (budget.framesPerSecond !== undefined) requested.framesPerSecond = budget.framesPerSecond;
  if (budget.memoryMiB !== undefined) requested.memoryMiB = budget.memoryMiB;
  const warnings = [];
  if (serverMemoryMiB !== undefined && budget.memoryMiB !== undefined && budget.memoryMiB > serverMemoryMiB) {
    warnings.push(`budget.memoryMiB ${budget.memoryMiB} is above the server --memory render-target cap of ${serverMemoryMiB} MiB, which is the limit that applies.`);
  }
  if (serverMemoryMiB !== undefined) warnings.push(`The server --memory cap of ${serverMemoryMiB} MiB may still shrink the frame; metrics.report.fallbacks in the result says if it did.`);
  if (budget.framesPerSecond !== undefined && picked.estimate.fixedSeconds > 0) {
    warnings.push(`Startup and scene build take about ${picked.estimate.fixedSeconds} s once and are not counted against framesPerSecond.`);
  }
  return {
    settings,
    report: {
      requested,
      picked: { tier: picked.tier, label, width: settings.width, height: settings.height, renderer: settings.renderer ? { backend: settings.renderer.backend, samples: settings.renderer.samples, denoise: settings.renderer.denoise } : 'raster', expected: { ...cost(picked.estimate), secondsPerFrame: picked.secondsPerFrame } },
      fits: Boolean(fitting),
      reason: fitting ? reasonForFit(picked, considered, budget) : reasonForMiss(picked, budget, frameCount),
      ...(warnings.length ? { warnings } : {}),
      considered: considered.map(candidate => ({ tier: candidate.tier, label: candidate.label, secondsPerFrame: candidate.secondsPerFrame, peakMemoryMiB: candidate.estimate.peakMemoryMiB, fits: fits(candidate) })),
      ...(failures.length ? { skipped: failures } : {}),
    },
  };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function reasonForFit(picked, considered, budget) {
  const better = considered.slice(0, considered.indexOf(picked));
  if (!better.length) return `The best candidate fits: about ${picked.secondsPerFrame} s per frame and ${picked.estimate.peakMemoryMiB} MiB.`;
  const next = better[better.length - 1];
  const over = next.timePerFrame > budget.secondsPerFrame * TIME_HEADROOM ? `${next.label} needs about ${next.secondsPerFrame} s per frame against ${round(budget.secondsPerFrame * TIME_HEADROOM, 4)} s` : `${next.label} needs about ${next.estimate.peakMemoryMiB} MiB against ${budget.memoryMiB} MiB`;
  return `${over}, so ${picked.label} is the best that fits.`;
}

function reasonForMiss(picked, budget, frameCount) {
  const fixedPerFrame = picked.estimate.fixedSeconds / frameCount;
  const fixedNote = budget.framesPerSecond === undefined && fixedPerFrame > budget.secondsPerFrame * TIME_HEADROOM
    ? ` Startup and scene build alone take about ${round(fixedPerFrame, 3)} s per frame over ${frameCount} frame${frameCount === 1 ? '' : 's'}.`
    : '';
  return `Nothing fits: the cheapest candidate, ${picked.label}, needs about ${picked.secondsPerFrame} s per frame and ${picked.estimate.peakMemoryMiB} MiB against ${round(budget.secondsPerFrame, 4)} s${budget.memoryMiB === undefined ? '' : ` and ${budget.memoryMiB} MiB`}. It runs anyway; raise the budget or lengthen the job.${fixedNote}`;
}
