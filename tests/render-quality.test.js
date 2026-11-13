import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { applyQuality, parseQuality, rasterOptionsFor, tierReport, QUALITY_TIERS } from '../scripts/agent-render-quality.mjs';
import { chooseBudgetSettings, parseBudget } from '../scripts/agent-render-budget.mjs';
import { estimateRenderJob } from '../scripts/agent-render-estimate.mjs';

const recipe = { format: '67js.scene' };
const base = { kind: 'image', width: 640, height: 360 };

test('the four tiers are named worst to best and a bad name says what to pass', () => {
  assert.deepEqual(QUALITY_TIERS, ['draft', 'realtime', 'realtime-high', 'final']);
  assert.equal(parseQuality('draft'), 'draft');
  assert.throws(() => parseQuality('ultra'), /quality must be one of draft, realtime, realtime-high, final/);
});

test('raster tiers differ in samples, shading and detail, and a software runtime never asks for more than one sample', () => {
  assert.deepEqual(rasterOptionsFor('draft', 'gpu'), { samples: 1, shading: 'light', lodPixelError: 4 });
  assert.deepEqual(rasterOptionsFor('realtime', 'gpu'), { samples: 4 });
  assert.deepEqual(rasterOptionsFor('realtime-high', 'gpu'), { samples: 8, lodPixelError: 0.5 });
  assert.equal(rasterOptionsFor('realtime-high', 'cpu').samples, 1);
  assert.equal(rasterOptionsFor('realtime', 'cpu').samples, 1);
});

test('the same settings render in every tier when only quality differs', () => {
  for (const tier of QUALITY_TIERS) {
    const { settings, report } = applyQuality({ quality: tier, base, backend: 'gpu', nativeTracer: false });
    assert.equal(report.picked, tier);
    assert.equal(report.steps, undefined);
    assert.equal(settings.quality, tier);
    const normalized = normalizeJobSettings(settings, [], recipe);
    assert.equal(normalized.quality, tier);
    assert.equal(Boolean(normalized.renderer), tier === 'final');
  }
  assert.equal(applyQuality({ quality: 'final', base, backend: 'gpu', nativeTracer: true }).settings.renderer.backend, 'native');
  assert.equal(applyQuality({ quality: 'final', base, backend: 'gpu', nativeTracer: false }).settings.renderer.backend, 'gpu');
  assert.equal(applyQuality({ quality: 'final', base, backend: 'cpu', nativeTracer: false }).settings.renderer.backend, 'cpu');
});

test('a tier the runtime cannot run falls back one tier and names the missing capability', () => {
  const software = applyQuality({ quality: 'realtime-high', base, backend: 'cpu', nativeTracer: false });
  assert.equal(software.report.picked, 'realtime');
  assert.match(software.report.message, /realtime-high lacks a hardware GPU/);
  assert.equal(software.settings.quality, 'realtime');
});

test('final falls back through realtime-high to realtime when the job cannot be traced and the runtime has no GPU', () => {
  const passes = applyQuality({ quality: 'final', base: { ...base, passes: ['depth'] }, backend: 'gpu', nativeTracer: false });
  assert.equal(passes.report.picked, 'realtime-high');
  assert.match(passes.report.steps[0].missing, /lit PNG image.*passes/);
  const software = applyQuality({ quality: 'final', base: { ...base, format: 'exr' }, backend: 'cpu', nativeTracer: false });
  assert.deepEqual(software.report.steps.map(step => `${step.from}>${step.to}`), ['final>realtime-high', 'realtime-high>realtime']);
  assert.match(software.report.message, /format exr/);
  assert.equal(software.settings.renderer, undefined);
});

test('quality refuses to combine with renderer, and normalize checks the pair', () => {
  assert.throws(() => applyQuality({ quality: 'draft', base: { ...base, renderer: { type: 'pathTracer' } }, backend: 'gpu' }), /quality picks the renderer/);
  assert.throws(() => normalizeJobSettings({ ...base, quality: 'final' }, [], recipe), /quality final needs the path tracer/);
  assert.throws(() => normalizeJobSettings({ ...base, quality: 'draft', renderer: { type: 'pathTracer' } }, [], recipe), /raster renderer/);
  assert.throws(() => normalizeJobSettings({ ...base, quality: 'best' }, [], recipe), /quality must be one of/);
});

test('the capabilities report lists the tiers a device can run and why it cannot run the others', () => {
  const gpu = tierReport({ backend: 'gpu', nativeTracer: true });
  assert.deepEqual(gpu.map(entry => entry.available), [true, true, true, true]);
  assert.match(gpu[3].runs, /native backend/);
  const software = tierReport({ backend: 'cpu', nativeTracer: false });
  assert.deepEqual(software.map(entry => entry.available), [true, true, false, true]);
  assert.match(software[2].missing, /hardware GPU/);
  assert.equal(software[2].fallsBackTo, 'realtime');
  assert.match(software[3].runs, /cpu backend/);
});

test('a budget names the tier it picked, and its settings carry the quality', () => {
  const size = { parts: 40, assetParts: 0, triangles: 60000, materials: 4, textures: 0, lights: 3 };
  const estimateOf = raw => estimateRenderJob({ size, settings: normalizeJobSettings(raw, [], recipe), backend: 'gpu', memoryBudgetMiB: 192 });
  const choose = budget => chooseBudgetSettings({ base, budget: parseBudget(budget), tracerBackend: 'gpu', frameCount: 1, estimateOf });
  const slow = choose({ secondsPerFrame: 60 });
  assert.equal(slow.report.picked.tier, 'final');
  assert.equal(slow.settings.quality, 'final');
  const fast = choose({ framesPerSecond: 20 });
  assert.equal(fast.report.picked.tier, 'realtime-high');
  assert.equal(fast.settings.quality, 'realtime-high');
  const tiny = choose({ framesPerSecond: 240 });
  assert.ok(['draft', 'realtime-high'].includes(tiny.report.picked.tier));
});

test('final gives way when the trace is estimated past maxSeconds, and stays final when it fits', () => {
  const size = { parts: 40, assetParts: 0, triangles: 60000, materials: 4, textures: 0, lights: 3 };
  const estimateFor = backend => raw => estimateRenderJob({ size, settings: normalizeJobSettings(raw, [], recipe), backend, memoryBudgetMiB: 192 });
  const large = { kind: 'image', width: 1920, height: 1080 };
  const slow = applyQuality({ quality: 'final', base: large, backend: 'cpu', nativeTracer: false, estimateOf: estimateFor('cpu') });
  assert.equal(slow.report.picked, 'realtime');
  assert.match(slow.report.steps[0].missing, /fits the 120 s limit on one frame.*1920x1080, 256 samples on the cpu backend/);
  assert.equal(slow.settings.renderer, undefined);
  const fitting = applyQuality({ quality: 'final', base: { kind: 'image', width: 640, height: 360 }, backend: 'gpu', nativeTracer: false, estimateOf: estimateFor('gpu') });
  assert.equal(applyQuality({ quality: 'final', base: large, backend: 'gpu', nativeTracer: false, estimateOf: estimateFor('gpu') }).report.picked, 'realtime-high');
  assert.equal(fitting.report.picked, 'final');
  const small = applyQuality({ quality: 'final', base: { kind: 'image', width: 128, height: 72 }, backend: 'cpu', nativeTracer: false, estimateOf: estimateFor('cpu') });
  assert.equal(small.report.picked, 'final');
});
