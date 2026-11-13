import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { estimateRenderJob } from '../scripts/agent-render-estimate.mjs';
import { budgetCandidates, chooseBudgetSettings, parseBudget } from '../scripts/agent-render-budget.mjs';

const recipe = { format: '67js.scene' };
const size = { parts: 40, assetParts: 0, triangles: 60000, materials: 4, textures: 0, lights: 3 };
const base = { kind: 'image', width: 1280, height: 720 };

function choose(budget, overrides = {}, history = []) {
  const input = { ...base, ...overrides };
  const frameCount = normalizeJobSettings(input, [], recipe).frameCount;
  const estimateOf = raw => estimateRenderJob({ size, settings: normalizeJobSettings(raw, [], recipe), backend: 'gpu', memoryBudgetMiB: 192, history });
  return chooseBudgetSettings({ base: input, budget: parseBudget(budget), tracerBackend: 'gpu', frameCount, estimateOf });
}

test('a frame rate becomes seconds per frame and bad budgets say what to pass', () => {
  assert.equal(parseBudget({ framesPerSecond: 30 }).secondsPerFrame, 1 / 30);
  assert.deepEqual(parseBudget({ secondsPerFrame: 2, memoryMiB: 512 }), { secondsPerFrame: 2, memoryMiB: 512 });
  assert.throws(() => parseBudget({}), /exactly one of secondsPerFrame/);
  assert.throws(() => parseBudget({ secondsPerFrame: 1, framesPerSecond: 30 }), /exactly one of secondsPerFrame/);
  assert.throws(() => parseBudget({ secondsPerFrame: -1 }), /budget.secondsPerFrame must be a number from 0.001 to 3600/);
  assert.throws(() => parseBudget({ framesPerSecond: 1000 }), /budget.framesPerSecond must be a number from 0.01 to 240/);
  assert.throws(() => parseBudget({ secondsPerFrame: 1, memoryMiB: 8 }), /budget.memoryMiB must be a number from 64/);
  assert.throws(() => parseBudget({ secondsPerFrame: 1, fps: 30 }), /no field fps/);
  assert.throws(() => parseBudget('fast'), /budget must be an object/);
});

test('candidates run from the path tracer to a small raster frame, and shrink only the raster ones', () => {
  const labels = budgetCandidates({ ...base }, 'gpu').map(candidate => candidate.label);
  assert.deepEqual(labels, ['path tracer, 256 samples, full size', 'path tracer, 64 samples, full size', 'path tracer, 16 samples, full size', 'raster, full size', 'raster, 0.75 scale', 'raster, 0.5 scale', 'raster, 0.25 scale']);
  const raster = budgetCandidates({ ...base }, 'gpu').filter(candidate => !candidate.settings.renderer);
  assert.deepEqual(raster.map(candidate => candidate.settings.width), [1280, 960, 640, 320]);
});

test('a job that a path tracer cannot write keeps to raster, and video sides stay even', () => {
  const withPasses = budgetCandidates({ ...base, passes: ['depth'] }, 'gpu');
  assert.ok(withPasses.every(candidate => !candidate.settings.renderer));
  const video = budgetCandidates({ kind: 'video', width: 854, height: 480 }, 'cpu').filter(candidate => !candidate.settings.renderer);
  assert.ok(video.every(candidate => candidate.settings.width % 2 === 0 && candidate.settings.height % 2 === 0));
});

test('a loose budget picks the path tracer and a tight one picks a smaller raster frame', () => {
  const loose = choose({ secondsPerFrame: 600 });
  assert.equal(loose.report.fits, true);
  assert.equal(loose.settings.renderer.samples, 256);
  const tight = choose({ framesPerSecond: 45 }, { kind: 'video', fps: 45, duration: 10 });
  assert.equal(tight.settings.renderer, undefined);
  assert.equal(tight.report.fits, true);
  assert.ok(tight.report.picked.expected.secondsPerFrame <= 1 / 45);
  assert.match(tight.report.reason, /needs about .* so raster/);
});

test('a memory cap rules out candidates that need more', () => {
  const capped = choose({ secondsPerFrame: 600, memoryMiB: 100 });
  assert.equal(capped.report.fits, false);
  assert.match(capped.report.reason, /Nothing fits: .* 100 MiB/);
});

test('when nothing fits the cheapest candidate is picked and the result says so', () => {
  const nothing = choose({ secondsPerFrame: 0.001 });
  assert.equal(nothing.report.fits, false);
  assert.equal(nothing.report.picked.label, 'raster, 0.25 scale');
  assert.match(nothing.report.reason, /^Nothing fits: the cheapest candidate, raster, 0.25 scale/);
  assert.equal(nothing.report.considered.length, 7);
  assert.ok(nothing.report.considered.every(candidate => candidate.fits === false));
});

test('the same scene, budget and history give the same pick', () => {
  const history = [
    { kind: 'raster-image-gpu', estimatedSeconds: 1, measuredSeconds: 2, estimatedPeakMemoryMiB: 200, measuredPeakMemoryMiB: 220 },
    { kind: 'raster-image-gpu', estimatedSeconds: 1, measuredSeconds: 2, estimatedPeakMemoryMiB: 200, measuredPeakMemoryMiB: 220 },
  ];
  assert.deepEqual(choose({ secondsPerFrame: 1 }, {}, history), choose({ secondsPerFrame: 1 }, {}, history));
  const corrected = choose({ secondsPerFrame: 1 }, {}, history).report.considered.find(candidate => candidate.label === 'raster, full size');
  const plain = choose({ secondsPerFrame: 1 }).report.considered.find(candidate => candidate.label === 'raster, full size');
  assert.ok(corrected.secondsPerFrame > plain.secondsPerFrame);
});

test('a region job keeps the full frame instead of throwing on a smaller candidate', () => {
  const chosen = choose({ secondsPerFrame: 0.001 }, { region: { x: 100, y: 100, width: 400, height: 300 } });
  assert.equal(chosen.settings.width, 1280);
  assert.deepEqual(chosen.report.considered.map(candidate => candidate.label), ['raster, full size']);
});

test('one candidate that cannot be estimated is skipped, and none usable names the budget', () => {
  const failing = raw => {
    if (raw.renderer) throw new RangeError('tracer refused');
    return estimateRenderJob({ size, settings: normalizeJobSettings(raw, [], recipe), backend: 'gpu', history: [] });
  };
  const chosen = chooseBudgetSettings({ base, budget: parseBudget({ secondsPerFrame: 600 }), tracerBackend: 'gpu', frameCount: 1, estimateOf: failing });
  assert.equal(chosen.report.picked.label, 'raster, full size');
  assert.equal(chosen.report.skipped.length, 3);
  const none = () => { throw new RangeError('no'); };
  assert.throws(() => chooseBudgetSettings({ base, budget: parseBudget({ secondsPerFrame: 600 }), tracerBackend: 'gpu', frameCount: 1, estimateOf: none }), /budget found no candidate/);
});

test('scaling keeps the aspect, holds the 64 px floor on the short side and drops same-size duplicates', () => {
  const wide = budgetCandidates({ kind: 'image', width: 1920, height: 80 }, 'gpu').filter(candidate => !candidate.settings.renderer);
  assert.deepEqual(wide.map(candidate => [candidate.settings.width, candidate.settings.height]), [[1920, 80], [1536, 64]]);
  const small = budgetCandidates({ kind: 'image', width: 64, height: 64 }, 'gpu').filter(candidate => !candidate.settings.renderer);
  assert.equal(small.length, 1);
});

test('a frame rate budget counts the per-frame cost and leaves startup out', () => {
  const rate = choose({ framesPerSecond: 15 });
  assert.equal(rate.report.fits, true);
  assert.equal(rate.settings.renderer, undefined);
  assert.match(rate.report.warnings.join(' '), /not counted against framesPerSecond/);
  const perJob = choose({ secondsPerFrame: 1 / 30 });
  assert.equal(perJob.report.fits, false);
  assert.match(perJob.report.reason, /Startup and scene build alone take about/);
});

test('the fit test uses unrounded seconds and the server memory cap is reported', () => {
  const estimateOf = () => ({ seconds: 0.8504, frameSeconds: 0.01, fixedSeconds: 0.84, peakMemoryMiB: 100 });
  const regionBase = { ...base, region: { x: 0, y: 0, width: 64, height: 64 } };
  const edge = chooseBudgetSettings({ base: regionBase, budget: parseBudget({ secondsPerFrame: 1 }), tracerBackend: 'gpu', frameCount: 1, estimateOf });
  assert.equal(edge.report.fits, false);
  const server = chooseBudgetSettings({ base, budget: parseBudget({ secondsPerFrame: 600, memoryMiB: 4096 }), tracerBackend: 'gpu', frameCount: 1, estimateOf, serverMemoryMiB: 192 });
  assert.match(server.report.warnings.join(' '), /above the server --memory render-target cap of 192 MiB/);
  assert.match(server.report.warnings.join(' '), /may still shrink the frame/);
});
