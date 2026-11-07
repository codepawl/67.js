import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { BAKE_PRESETS, BAKE_PRESET_PATH_WORK } from '../src/agent-scene-capabilities.js';
import { closedRoom, lightmapBytesOf, largeRoom } from './support/agent-bake-rooms.mjs';

// The bake is bound by a 20 s wall clock on the page thread, and a CI run with coverage and other test files beside it can miss that
// on a bake that takes half the time elsewhere. This test checks the budget the preset is cut to, so the clock is frozen, as in
// agent-bake-limits.test.js.
test('a preset on a 56 part room shrinks to the path work budget, finishes, and reports what it used', () => {
  const realNow = performance.now;
  performance.now = () => 0;
  try {
    const scene = createAgentScene(largeRoom({ preset: 'standard' }));
    const bake = scene.inspect().bake;
    assert.equal(scene.parts.length, 56);
    assert.equal(bake.reduced, true);
    assert.ok(bake.used.samples < BAKE_PRESETS.standard.samples);
    assert.ok(bake.used.texelsPerUnit < BAKE_PRESETS.standard.texelsPerUnit);
    assert.equal(bake.used.bounces, BAKE_PRESETS.standard.bounces);
    assert.ok(bake.texels * bake.used.samples * bake.used.bounces <= BAKE_PRESET_PATH_WORK);
    assert.ok(Number.isFinite(bake.seconds) && bake.seconds >= 0, 'the report carries the time the bake took');
    const again = createAgentScene(largeRoom({ preset: 'standard' }));
    assert.deepEqual(again.inspect().bake.used, bake.used);
    assert.deepEqual(lightmapBytesOf(again, 'floor'), lightmapBytesOf(scene, 'floor'));
  } finally {
    performance.now = realNow;
  }
});

test('a preset that already fits is not reduced', () => {
  const bake = createAgentScene(closedRoom()).inspect().bake;
  assert.equal(bake.reduced, false);
  assert.deepEqual(bake.used, { ...BAKE_PRESETS.draft, probes: 'room' });
});
