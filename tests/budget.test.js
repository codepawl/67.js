import test from 'node:test';
import assert from 'node:assert/strict';
import { planRenderSize, RENDER_PRESETS, estimateFrameBytes, estimateTextureBytes } from '../src/budget.js';

test('high resolution render targets shrink before exceeding their memory budget', () => {
  const plan = planRenderSize({ width: 7680, height: 4320, samples: 4, memoryBudgetMiB: 128, geometryBytes: 20 * 1024 ** 2 });
  assert.ok(plan.reduced);
  assert.ok(plan.estimatedBytes <= 128 * 1024 ** 2);
  assert.ok(Math.abs(plan.width / plan.height - 16 / 9) < 0.003);
});

test('HDR, two half-resolution bloom targets and cached texture mipmaps fit inside the budget', () => {
  const textureBytes = estimateTextureBytes(2048, 2048);
  assert.equal(textureBytes, 22369620);
  assert.equal(estimateTextureBytes(3, 5), 72);
  assert.equal(estimateTextureBytes(3, 5, { mipmaps: false }), 60);
  const plan = planRenderSize({ width: 7681, height: 4321, hdr: true, bloom: true, textureBytes, samples: 4, memoryBudgetMiB: 128 });
  assert.ok(plan.reduced);
  assert.ok(plan.estimatedBytes <= 128 * 1024 ** 2);
  assert.equal(plan.estimatedBytes, estimateFrameBytes(plan.width, plan.height, 4, 2048, { hdr: true, bloom: true }) + textureBytes);
  assert.ok(estimateFrameBytes(100, 101, 4, 0, { hdr: true, bloom: true }) > estimateFrameBytes(100, 101, 4, 0));
  assert.throws(() => planRenderSize({ width: 640, height: 360, textureBytes: 200 * 1024 ** 2, memoryBudgetMiB: 128 }), /cannot hold/);
  assert.throws(() => estimateTextureBytes(-1, 32), /positive/);
});

test('presets fit their budget and device texture limits', () => {
  for (const preset of Object.values(RENDER_PRESETS)) {
    const plan = planRenderSize({ ...preset, maximumSize: 1024 });
    assert.ok(plan.width <= 1024 && plan.height <= 1024);
    assert.ok(plan.estimatedBytes <= preset.memoryBudgetMiB * 1024 ** 2);
  }
});

test('invalid or impossible memory requests fail before allocation', () => {
  assert.throws(() => planRenderSize({ width: 0, height: 720 }));
  assert.throws(() => planRenderSize({ width: 1280, height: 720, geometryBytes: 300 * 1024 ** 2, memoryBudgetMiB: 128 }), /cannot hold/);
  assert.throws(() => planRenderSize({ width: Infinity, height: 720 }));
});

test('a budget error names the bytes it counted and a memoryBudgetMiB that then fits', () => {
  const scene = { width: 1280, height: 720, geometryBytes: 300 * 1024 ** 2, textureBytes: 40 * 1024 ** 2, memoryBudgetMiB: 128 };
  let message = '';
  assert.throws(() => planRenderSize(scene), error => {
    message = error.message;
    return error instanceof RangeError;
  });
  assert.match(message, /geometry 300\.0 MiB, textures 40\.0 MiB and frame [0-9.]+ MiB, over memoryBudgetMiB 128\. Fix: pass \{ memoryBudgetMiB: \d+ \}/);
  const suggested = Number(message.match(/memoryBudgetMiB: (\d+) \}/)[1]);
  const plan = planRenderSize({ ...scene, memoryBudgetMiB: suggested });
  assert.equal(plan.reduced, false);
});

test('resolved depth adds exactly four bytes per pixel and participates in resolution reduction', () => {
  assert.equal(estimateFrameBytes(540, 960, 4, 2048, { hdr: true, depth: true }) - estimateFrameBytes(540, 960, 4, 2048, { hdr: true }), 540 * 960 * 4);
  const options = { width: 7680, height: 4320, hdr: true, bloom: true, samples: 4, memoryBudgetMiB: 64 };
  const ordinary = planRenderSize(options);
  const resolved = planRenderSize({ ...options, depth: true });
  assert.ok(resolved.width < ordinary.width);
  assert.equal(resolved.estimatedBytes, estimateFrameBytes(resolved.width, resolved.height, 4, 2048, { hdr: true, bloom: true, depth: true }));
  assert.ok(resolved.estimatedBytes <= 64 * 1024 ** 2);
});

test('without memoryBudgetMiB the budget fits the scene, from 256 MiB up to a device ceiling', () => {
  const small = planRenderSize({ width: 1280, height: 720 });
  assert.equal(small.memoryBudgetMiB, 256);
  const large = planRenderSize({ width: 1440, height: 810, geometryBytes: 280 * 1024 ** 2, textureBytes: 60 * 1024 ** 2 });
  assert.ok(large.memoryBudgetMiB > 340 && large.memoryBudgetMiB <= 512);
  assert.equal(large.reduced, false);
  assert.throws(() => planRenderSize({ width: 1280, height: 720, geometryBytes: 600 * 1024 ** 2 }), /Fix: pass \{ memoryBudgetMiB: \d+ \}/);
});

test('a reduced plan names the budget its full frame needs, and that budget fits the requested frame', () => {
  const sceneTextureBytes = 75 * 1024 ** 2;
  const reducedPlan = planRenderSize({ width: 1920, height: 1080, samples: 4, memoryBudgetMiB: 192, hdr: true, bloom: true, depth: true, textureBytes: sceneTextureBytes });
  assert.ok(reducedPlan.reduced);
  assert.ok(reducedPlan.requiredMemoryMiB > 192);
  const fittedPlan = planRenderSize({ width: 1920, height: 1080, samples: 4, memoryBudgetMiB: reducedPlan.requiredMemoryMiB, hdr: true, bloom: true, depth: true, textureBytes: sceneTextureBytes });
  assert.equal(fittedPlan.reduced, false);
  assert.equal(fittedPlan.width, 1920);
  assert.equal(fittedPlan.height, 1080);
});
