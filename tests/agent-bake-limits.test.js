import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { bakeSecondsLimit } from '../src/agent-bake.js';
import { BAKE_PRESET_PATH_WORK, BAKE_EXPLICIT_PATH_WORK_LIMIT, BAKE_MAXIMUM_SECONDS, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { largeRoom } from './support/agent-bake-rooms.mjs';

test('explicit settings over the hard limit fail up front with a lower setting to try', () => {
  const heavy = { preset: 'draft', samples: 256, bounces: 3, texelsPerUnit: 12 };
  let message = '';
  assert.throws(() => createAgentScene(largeRoom(heavy)), error => {
    message = error.message;
    return /path steps/.test(error.message) && message.includes(String(BAKE_EXPLICIT_PATH_WORK_LIMIT));
  });
  const fittingSamples = Number(/samples (\d+) or fewer/.exec(message)?.[1]);
  const fittingDensity = Number(/texelsPerUnit ([\d.]+) or less/.exec(message)?.[1]);
  assert.ok(fittingSamples >= 1 && fittingSamples < 256, message);
  assert.ok(fittingDensity >= 1 && fittingDensity < 12, message);
});

test('explicit settings far above the preset budget run when they fit the hard limit, and are never reduced', () => {
  const explicit = { samples: 160, bounces: 2, texelsPerUnit: 6 };
  // A busy machine can pass the real limit here, and this test is about the settings, so the clock stands still.
  const realNow = performance.now;
  performance.now = () => 0;
  try {
    const bake = createAgentScene(largeRoom(explicit)).inspect().bake;
    assert.equal(bake.reduced, false);
    assert.deepEqual(bake.used, { ...explicit, probes: 'room' });
    assert.ok(bake.texels * explicit.samples * explicit.bounces > BAKE_PRESET_PATH_WORK);
  } finally {
    performance.now = realNow;
  }
});

test('an explicit bake that passes maxSeconds fails cleanly with a lower setting to try', () => {
  const slow = { samples: 256, bounces: 3, texelsPerUnit: 4 };
  // A fast machine finishes this bake inside the real limit, so each clock read is made to cost a second.
  const realNow = performance.now;
  let clockReads = 0;
  performance.now = () => {
    clockReads += 1;
    return realNow.call(performance) + clockReads * 1000;
  };
  try {
    assert.throws(() => createAgentScene(largeRoom(slow)), error => /maxSeconds/.test(error.message) && /Try samples 128/.test(error.message));
  } finally {
    performance.now = realNow;
  }
});

test('the bake kernel carries 20 s on the page thread and 90 s inside a worker', () => {
  assert.equal(bakeSecondsLimit(), BAKE_MAXIMUM_SECONDS);
  globalThis.WorkerGlobalScope = Object;
  try {
    assert.equal(bakeSecondsLimit(), BAKE_WORKER_MAXIMUM_SECONDS);
  } finally {
    delete globalThis.WorkerGlobalScope;
  }
});
