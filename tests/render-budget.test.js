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
