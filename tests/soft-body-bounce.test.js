import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloth } from '../src/cloth.js';
import { frameHashes, jellyCubeRecipe, measureBounce, recordJelly } from './support/jelly-cube.mjs';

const FRAME_COUNT = 110;

function measure(softBody, sheet) {
  return measureBounce(recordJelly(jellyCubeRecipe({ softBody, sheet }), FRAME_COUNT));
}

// The 0.5 m cube dropped from 1.95 m lands at step 48. Numbers measured on this solver, in metres.
test('rebound height grows with softBody.bounce and the dent does not change', () => {
  const rebounds = [0, 0.25, 0.5, 0.75, 1].map(bounce => measure({ bounce }));
  const heights = rebounds.map(result => result.reboundHeight);
  for (let index = 1; index < heights.length; index++) {
    assert.ok(heights[index] > heights[index - 1], `rebound should rise with bounce: ${heights.map(height => height.toFixed(3)).join(', ')}`);
  }
  assert.ok(heights[0] < 0.1, `bounce 0 keeps today's small rebound, got ${heights[0]}`);
  assert.ok(heights[2] > 0.12 && heights[2] < 0.2, `bounce 0.5 lifts it about 0.15 m, got ${heights[2]}`);
  assert.ok(heights[4] > 0.4, `bounce 1 lifts it about 0.47 m, got ${heights[4]}`);
  for (const result of rebounds) assert.ok(Math.abs(result.dent - rebounds[0].dent) < 1e-6, 'the dent is made before the turn-around, so bounce leaves it alone');
});

test('the dent grows as shape and stiffness drop', () => {
  const firm = measure({ shape: 1 });
  const normal = measure({});
  const soft = measure({ shape: 0.02 });
  const softest = measure({ shape: 0.02 }, { stiffness: 0.1 });
  const dents = [firm, normal, soft, softest].map(result => result.dent);
  assert.ok(dents[0] > 0.02 && dents[0] < 0.035, `shape 1 dents about 0.026 m, got ${dents[0]}`);
  assert.ok(dents[3] > 0.09, `shape 0.02 with stiffness 0.1 dents about 0.1 m, got ${dents[3]}`);
  for (let index = 1; index < dents.length; index++) assert.ok(dents[index] > dents[index - 1], `dents should grow: ${dents.map(dent => dent.toFixed(3)).join(', ')}`);
});

test('a body falling without air drag returns to its drop height at bounce 1', () => {
  const result = measure({ bounce: 1 }, { damping: 0 });
  assert.ok(result.reboundHeight > 1.5, `expected most of the 1.95 m drop back, got ${result.reboundHeight}`);
});

test('a recipe without softBody.bounce bakes the same frames as bounce 0', () => {
  const withoutField = frameHashes(recordJelly(jellyCubeRecipe(), FRAME_COUNT));
  const withZero = frameHashes(recordJelly(jellyCubeRecipe({ softBody: { bounce: 0 } }), FRAME_COUNT));
  assert.deepEqual(withZero, withoutField);
});

test('a jelly at rest does not buzz at bounce 1', () => {
  const frames = recordJelly(jellyCubeRecipe({ softBody: { bounce: 1 }, sheet: { damping: 8 } }), 150);
  const rest = frames.at(-1);
  const earlier = frames.at(-10);
  let largestMove = 0;
  for (let index = 0; index < rest.length; index++) largestMove = Math.max(largestMove, Math.abs(rest[index] - earlier[index]));
  assert.ok(largestMove < 0.01, `a resting body should stay put; moved ${largestMove} m in 9 steps`);
});

test('softBody.bounce outside 0 to 1 names the field and the range', () => {
  const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0);
  const triangles = Uint32Array.of(0, 1, 2);
  for (const bounce of [-0.1, 1.5, Number.NaN]) {
    assert.throws(() => createCloth(positions, triangles, { softBody: { pressure: 0, bounce } }), /softBody\.bounce must be a number from 0 to 1/);
  }
});

test('a recipe sheet rejects a bad bounce at the boundary', async () => {
  const { createAgentScene } = await import('../src/agent-scene.js');
  assert.throws(() => createAgentScene(jellyCubeRecipe({ softBody: { bounce: 2 } })), /softBody\.bounce.*0.*1/s);
});
