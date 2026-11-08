import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMegakernelSource, MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { REALTIME_KERNEL_PIECES } from '../src/path-tracer-realtime-webgpu-kernel.js';
import { CACHE_SLOT_COUNT, MAXIMUM_LEVEL, NORMAL_AXIS_THRESHOLD } from '../src/path-tracer-radiance-cache.js';
import { outputRowWords } from '../src/path-tracer-realtime-webgpu-passes.js';
import { cacheCellSizes, resolveRealtimeOptions, viewsMatch } from '../src/path-tracer-realtime-options.js';

test('the default megakernel does not carry the real-time pieces', () => {
  assert.equal(MEGAKERNEL_SOURCE, buildMegakernelSource());
  for (const name of ['cacheLookup', 'cacheHash', 'traceRealtime', 'cacheRecords', 'chooseEmitterByImportance']) {
    assert.ok(!MEGAKERNEL_SOURCE.includes(name), name);
  }
  assert.ok(MEGAKERNEL_SOURCE.includes('fn main('));
});

test('the real-time megakernel ends paths in the cache, records the hit before, and has its own entry point', () => {
  const source = buildMegakernelSource({ realtime: REALTIME_KERNEL_PIECES });
  assert.ok(source.includes('fn traceRealtime('));
  assert.ok(!source.includes('fn main('));
  assert.ok(source.includes('addRadiance(depth, throughput * hitColor * cacheLookup(hitPoint, normal));'));
  assert.ok(source.includes('recordedSlot = f32(cacheHash(hitPoint, normal)) + 1.0;'));
  assert.ok(source.includes('firstHitMaterial = f32(hitMaterialIndex) + 1.0;'));
  assert.equal(source.split('fn addLights(').length, 2, 'one light selection only');
  assert.ok(source.includes('chooseEmitterByImportance(normal)'));
});

test('the WGSL cache hash uses the constants of the JavaScript reference', () => {
  assert.ok(REALTIME_KERNEL_PIECES.declarations.includes(`hash & ${CACHE_SLOT_COUNT - 1}u`));
  assert.ok(REALTIME_KERNEL_PIECES.declarations.includes(`0.0, ${MAXIMUM_LEVEL}.0)`));
  assert.ok(REALTIME_KERNEL_PIECES.declarations.includes(`component > ${NORMAL_AXIS_THRESHOLD}`));
  for (const constant of ['73856093u', '19349663u', '83492791u', '0x9e3779b1u', '0x85ebca6bu', '0x7feb352du', '0x846ca68bu']) {
    assert.ok(REALTIME_KERNEL_PIECES.declarations.includes(constant), constant);
  }
});

test('the real-time pieces stay out of the other kernel variants', () => {
  assert.ok(REALTIME_KERNEL_PIECES.addLights.includes('chooseEmitterByImportance'));
  assert.ok(!REALTIME_KERNEL_PIECES.main.includes('@group(0)'), 'bindings are declared once, in the declarations');
  assert.ok(buildMegakernelSource({ texelBake: true }).includes('fn bakeTexels('));
  assert.ok(!buildMegakernelSource({ texelBake: true }).includes('traceRealtime'));
});

test('the output rows of the texture copy are whole 256 byte multiples', () => {
  assert.equal(outputRowWords(1920), 1920);
  assert.equal(outputRowWords(960), 960);
  assert.equal(outputRowWords(100), 128);
  assert.equal(outputRowWords(1) * 4 % 256, 0);
});

test('the real-time options default to WebGL2 and name the backends they know', () => {
  assert.equal(resolveRealtimeOptions({}).backend, 'gpu');
  assert.equal(resolveRealtimeOptions({ backend: 'webgpu', width: 1920, height: 1080 }).traceWidth, 960);
  assert.throws(() => resolveRealtimeOptions({ backend: 'vulkan' }), /"gpu", "webgpu"|gpu, webgpu/);
  const resolved = resolveRealtimeOptions({ bounces: 3 });
  assert.equal(resolved.options.bounces, 3);
  assert.equal(resolved.options.radianceCache, true);
});

test('the cache cell size follows the scene unless it is given', () => {
  assert.deepEqual(cacheCellSizes({ farDistance: 2e4 }, 0.5), { cellSize: 0.5, levelDistance: 32 });
  const derived = cacheCellSizes({ farDistance: 2e4 });
  assert.equal(derived.cellSize, 2 / 200);
  assert.equal(derived.levelDistance, derived.cellSize * 64);
});

test('two cameras that look the same way match', () => {
  const view = { eye: [0, 1, 4], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 0.5 };
  assert.equal(viewsMatch(view, { ...view, eye: [0, 1, 4] }), true);
  assert.equal(viewsMatch(view, { ...view, eye: [0, 1, 4.1] }), false);
  assert.equal(viewsMatch(null, view), false);
});
