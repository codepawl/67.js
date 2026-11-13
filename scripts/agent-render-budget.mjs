// Picks a render job's settings from a budget instead of by hand. The candidates run from the best looking to the cheapest; the
// first one whose estimate fits the budget wins. Nothing here renders: it asks agent-render-estimate.mjs what each candidate
// would cost, so the same scene, budget and history always give the same pick.

/** What scene_capabilities topic jobs says about the budget. The details are in docs/mcp.md. */
export const RENDER_BUDGET_NOTE = 'settings.budget { secondsPerFrame | framesPerSecond, memoryMiB? } replaces hand-picked renderer settings: width and height become the largest frame, and the job takes the best candidate whose estimate fits (path tracer at 256, 64 or 16 samples, then raster at scale 1, 0.75, 0.5, 0.25). Time is the whole job divided by its frames, and a pick is expected to use at most 85% of it. submit returns budget { picked, fits, reason, considered }; when nothing fits the cheapest candidate runs and fits is false.';

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

function scaledSide(side, scale, even) {
  const unit = even ? 2 : 1;
  return Math.max(MINIMUM_SIDE, Math.round((side * scale) / unit) * unit);
}

/** Raw job settings (what the caller would have written by hand) for each candidate, best first, with a label. */
export function budgetCandidates(base, tracerBackend) {
  const candidates = [];
  const tracerAllowed = !TRACER_BLOCKERS.some(name => base[name]) && !(base.format && base.format !== 'png');
  if (tracerAllowed) {
    for (const samples of PATH_TRACER_SAMPLE_STEPS) {
      candidates.push({ label: `path tracer, ${samples} samples, full size`, settings: { ...base, renderer: { type: 'pathTracer', backend: tracerBackend, samples, denoise: 'wavelet' } } });
    }
  }
  const even = base.kind === 'video';
  for (const scale of RASTER_SCALE_STEPS) {
    const width = scaledSide(base.width, scale, even);
    const height = scaledSide(base.height, scale, even);
    candidates.push({ label: `raster, ${scale === 1 ? 'full size' : `${scale} scale`}`, settings: { ...base, width, height } });
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
export function chooseBudgetSettings({ base, budget, tracerBackend, frameCount, estimateOf }) {
  const considered = budgetCandidates(base, tracerBackend).map(candidate => {
    const estimate = estimateOf(candidate.settings);
    return { ...candidate, estimate, secondsPerFrame: round(estimate.seconds / frameCount, 3) };
  });
  const fits = candidate => candidate.secondsPerFrame <= budget.secondsPerFrame * TIME_HEADROOM && (budget.memoryMiB === undefined || candidate.estimate.peakMemoryMiB <= budget.memoryMiB);
  const fitting = considered.find(fits);
  const cheapest = [...considered].sort((first, second) => first.secondsPerFrame - second.secondsPerFrame || first.estimate.peakMemoryMiB - second.estimate.peakMemoryMiB)[0];
  const picked = fitting ?? cheapest;
  const { settings, label } = picked;
  const requested = { secondsPerFrame: round(budget.secondsPerFrame, 4) };
  if (budget.framesPerSecond !== undefined) requested.framesPerSecond = budget.framesPerSecond;
  if (budget.memoryMiB !== undefined) requested.memoryMiB = budget.memoryMiB;
  return {
    settings,
    report: {
      requested,
      picked: { label, width: settings.width, height: settings.height, renderer: settings.renderer ? { backend: settings.renderer.backend, samples: settings.renderer.samples, denoise: settings.renderer.denoise } : 'raster', expected: { ...cost(picked.estimate), secondsPerFrame: picked.secondsPerFrame } },
      fits: Boolean(fitting),
      reason: fitting ? reasonForFit(picked, considered, budget) : reasonForMiss(picked, budget),
      considered: considered.map(candidate => ({ label: candidate.label, secondsPerFrame: candidate.secondsPerFrame, peakMemoryMiB: candidate.estimate.peakMemoryMiB, fits: fits(candidate) })),
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
  const over = next.secondsPerFrame > budget.secondsPerFrame * TIME_HEADROOM ? `${next.label} needs about ${next.secondsPerFrame} s per frame against ${round(budget.secondsPerFrame * TIME_HEADROOM, 4)} s` : `${next.label} needs about ${next.estimate.peakMemoryMiB} MiB against ${budget.memoryMiB} MiB`;
  return `${over}, so ${picked.label} is the best that fits.`;
}

function reasonForMiss(picked, budget) {
  return `Nothing fits: the cheapest candidate, ${picked.label}, needs about ${picked.secondsPerFrame} s per frame and ${picked.estimate.peakMemoryMiB} MiB against ${round(budget.secondsPerFrame, 4)} s${budget.memoryMiB === undefined ? '' : ` and ${budget.memoryMiB} MiB`}. It runs anyway; raise the budget or shorten the job.`;
}
