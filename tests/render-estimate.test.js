import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRenderJobs, normalizeJobSettings, RENDER_HISTORY_FILE } from '../scripts/agent-render-jobs.mjs';
import {
  CORRECTION_BOUND, HISTORY_LIMIT, correctionFromHistory, estimateRenderJob, historyWithJob, jobKind, parseHistory, renderReport, sceneSizeFrom,
} from '../scripts/agent-render-estimate.mjs';

const recipe = { format: '67js.scene', materials: [{ id: 'wood', map: 'planks' }, { id: 'steel', normalMap: 'dents' }, { id: 'plain' }] };

function inspection({ nodeCount, trianglesEach, truncated = false, parts = nodeCount }) {
  return {
    counts: { nodes: nodeCount, parts, geometries: 1, materials: 3, vertices: trianglesEach },
    look: { pointLights: 2, spotLights: 1, areaLights: 0 },
    nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `part-${index}`, triangles: trianglesEach })),
    truncated,
  };
}

function settingsFor(overrides) {
  return normalizeJobSettings({ kind: 'image', width: 640, height: 360, ...overrides }, [], { format: '67js.scene' });
}

test('scene size counts every placed node, textures and lights', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 10, trianglesEach: 1200 }), recipe);
  assert.deepEqual(size, { parts: 10, triangles: 12000, materials: 3, textures: 2, lights: 4 });
});

test('a truncated node list is scaled up to the part count', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 64, trianglesEach: 100, truncated: true, parts: 640 }), recipe);
  assert.equal(size.triangles, 64000);
});

test('with no node list the vertex count stands in for the triangle count', () => {
  const size = sceneSizeFrom({ counts: { parts: 1, vertices: 3000 }, nodes: [] }, {});
  assert.equal(size.triangles, 1500);
});

test('the same scene and settings always give the same estimate', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 50, trianglesEach: 2000 }), recipe);
  const settings = settingsFor({ kind: 'video', width: 480, height: 270, fps: 12, duration: 2 });
  const first = estimateRenderJob({ size, settings, backend: 'gpu' });
  const second = estimateRenderJob({ size, settings, backend: 'gpu' });
  assert.deepEqual(first, second);
  assert.equal(first.basis, 'scene size');
  assert.equal(first.seconds, first.modelSeconds);
});

test('more triangles, more frames and bigger frames cost more time', () => {
  const small = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const large = sceneSizeFrom(inspection({ nodeCount: 300, trianglesEach: 5000 }), recipe);
  const image = settingsFor({});
  const video = settingsFor({ kind: 'video', fps: 12, duration: 4, width: 640, height: 360 });
  const estimate = (size, settings) => estimateRenderJob({ size, settings, backend: 'gpu' });
  assert.ok(estimate(large, image).seconds > estimate(small, image).seconds);
  assert.ok(estimate(small, video).seconds > estimate(small, image).seconds);
  assert.ok(estimate(large, image).peakMemoryMiB > estimate(small, image).peakMemoryMiB);
  assert.ok(estimate(large, settingsFor({ kind: 'video', width: 1920, height: 1080, fps: 24, duration: 5 })).seconds > estimate(large, settingsFor({ kind: 'video', width: 480, height: 270, fps: 24, duration: 5 })).seconds);
});

test('the path tracer is capped by maxSeconds and the first GPU trace pays for its kernel', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 20, trianglesEach: 1000 }), recipe);
  const longTrace = settingsFor({ width: 640, height: 360, renderer: { type: 'pathTracer', backend: 'cpu', samples: 1024, bounces: 8, maxSeconds: 5 } });
  assert.ok(estimateRenderJob({ size, settings: longTrace, backend: 'gpu' }).seconds < 5 + 5);
  const gpuTrace = settingsFor({ width: 256, height: 144, renderer: { type: 'pathTracer', backend: 'gpu', samples: 32, bounces: 3, maxSeconds: 30 } });
  const cold = estimateRenderJob({ size, settings: gpuTrace, backend: 'gpu', gpuTracerWarm: false });
  const warm = estimateRenderJob({ size, settings: gpuTrace, backend: 'gpu', gpuTracerWarm: true });
  assert.ok(cold.seconds - warm.seconds > 5);
});

function historyEntry(ratio, kind = 'raster-image-gpu') {
  return { kind, estimatedSeconds: 2, measuredSeconds: 2 * ratio, estimatedPeakMemoryMiB: 200, measuredPeakMemoryMiB: 200 * ratio };
}

test('history needs two runs of the same kind and moves the estimate by their median', () => {
  assert.deepEqual(correctionFromHistory([historyEntry(3)], 'raster-image-gpu'), { seconds: 1, memory: 1, runs: 1 });
  assert.equal(correctionFromHistory([historyEntry(3), historyEntry(2), historyEntry(1.5)], 'raster-image-gpu').seconds, 2);
  assert.equal(correctionFromHistory([historyEntry(3), historyEntry(2)], 'raster-video-gpu').runs, 0);
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const settings = settingsFor({});
  const base = estimateRenderJob({ size, settings, backend: 'gpu' });
  const corrected = estimateRenderJob({ size, settings, backend: 'gpu', history: [historyEntry(2), historyEntry(2)] });
  assert.equal(corrected.modelSeconds, base.modelSeconds);
  assert.ok(Math.abs(corrected.seconds - base.modelSeconds * 2) < 0.1);
  assert.match(corrected.basis, /last 2 raster-image-gpu jobs/);
});

test('the correction is bounded either way', () => {
  assert.equal(correctionFromHistory([historyEntry(100), historyEntry(100)], 'raster-image-gpu').seconds, CORRECTION_BOUND);
  assert.equal(correctionFromHistory([historyEntry(0.001), historyEntry(0.001)], 'raster-image-gpu').seconds, 1 / CORRECTION_BOUND);
});

test('the history keeps the newest entries only', () => {
  const settings = settingsFor({});
  const estimate = { modelSeconds: 1, modelPeakMemoryMiB: 200 };
  const report = { measured: { seconds: 1.5, peakMemoryMiB: 220 } };
  let history = [];
  for (let run = 0; run < HISTORY_LIMIT + 5; run++) history = historyWithJob(history, { settings, backend: 'gpu', estimate, report });
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].kind, jobKind(settings, 'gpu'));
  assert.equal(historyWithJob(history, { settings, backend: 'gpu', estimate: undefined, report }), history);
});

test('a damaged history file counts as no history', () => {
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory('{"kind":"x"}'), []);
  assert.deepEqual(parseHistory(JSON.stringify([{ kind: 'x', estimatedSeconds: 'slow' }, historyEntry(2)])), [historyEntry(2)]);
  assert.equal(parseHistory(JSON.stringify(Array.from({ length: 100 }, () => historyEntry(2)))).length, HISTORY_LIMIT);
});

test('the report puts the estimate, the measurement and what fell back in one record', () => {
  const settings = settingsFor({ width: 1920, height: 1080, renderer: { type: 'pathTracer', backend: 'native', samples: 64 } });
  const metrics = {
    elapsedSeconds: 12.345, peakNodeBytes: 300 * 1024 ** 2, peakBrowserHeap: 100 * 1024 ** 2, requestedWidth: 1920, requestedHeight: 1080, width: 1280, height: 720,
    pathTracer: { averageSamples: 48, backendNote: 'No native tracer was found. The gpu backend ran instead.', denoiserNote: 'OIDN is not installed; the wavelet denoiser ran.' },
  };
  const report = renderReport({ estimate: { seconds: 10, peakMemoryMiB: 350, basis: 'scene size' }, settings, metrics });
  assert.deepEqual(report.measured, { seconds: 12.35, peakMemoryMiB: 400, frames: 1, secondsPerFrame: 12.345 });
  assert.equal(report.secondsRatio, 1.23);
  assert.equal(report.samplesDrawn, 48);
  assert.equal(report.samplesRequested, 64);
  assert.equal(report.fallbacks.length, 3);
  assert.match(report.fallbacks[0], /1920x1080 to 1280x720/);
  assert.deepEqual(renderReport({ settings: settingsFor({}), metrics: { elapsedSeconds: 1 } }).fallbacks, []);
});

test('the job store keeps the history file beside its jobs and counts it', async context => {
  const root = await mkdtemp(join(tmpdir(), '67js-render-history-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async ({ directory, progress }) => {
    await writeFile(join(directory, 'render.png.partial'), Buffer.from('fixture PNG bytes'));
    await progress({ frames: 1, maximumPendingFrames: 1 });
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  };
  const first = await createAgentRenderJobs({ root, run });
  await first.close();
  await writeFile(join(root, RENDER_HISTORY_FILE), JSON.stringify([historyEntry(2)]));
  const second = await createAgentRenderJobs({ root, run });
  const { jobId } = await second.submit({ sourceRevision: 0, snapshot: { recipe: { format: 'fixture' } }, settings: { kind: 'image', width: 64, height: 64 } });
  while (second.status(jobId).state !== 'completed') await new Promise(resolve => setTimeout(resolve, 5));
  await second.close();
  assert.equal(JSON.parse(await readFile(join(root, RENDER_HISTORY_FILE), 'utf8')).length, 1);
});
