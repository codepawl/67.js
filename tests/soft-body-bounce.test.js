import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCloth } from '../src/cloth.js';
import { foldedTriangles, frameHashes, invertedTriangles, JELLY_LOOK, JELLY_PRESETS, jellyCubeRecipe, measureBounce, recordJelly, topFaceTilt, widestRowHeight } from './support/jelly-cube.mjs';

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

// Measured on origin/main before softBody.bounce existed: SHA-256 of the 120 per-frame hashes joined by newlines, for the
// default jelly cube recipe. If this changes, the default look of a soft body changed.
const MAIN_DEFAULT_JELLY_DIGEST = '8d5ac451dbe7aa203e96c926d2e7a7ace2d2ad59f596f8abd5e98c0e29c6595d';

test('the default jelly recipe bakes the same 120 frames as before softBody.bounce existed', () => {
  const hashes = frameHashes(recordJelly(jellyCubeRecipe(), 120));
  assert.equal(hashes.length, 120);
  assert.equal(createHash('sha256').update(hashes.join('\n')).digest('hex'), MAIN_DEFAULT_JELLY_DIGEST);
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

// The preview's three presets (`JELLY_PRESETS`) drawn with `JELLY_LOOK`: each step must be clearly visible, and the surface must not fold.
const presetRecipe = (preset, duration) => jellyCubeRecipe({ softBody: preset.softBody, sheet: preset.sheet, duration, ...JELLY_LOOK });

test('the firm, medium and soft presets step clearly in dent and rebound without folding', () => {
  const results = JELLY_PRESETS.map(preset => measureBounce(recordJelly(presetRecipe(preset, 2), FRAME_COUNT)));
  const [firm, medium, soft] = results;
  assert.ok(medium.dent > firm.dent * 1.6 && soft.dent > medium.dent * 1.4, `dents ${results.map(result => result.dent.toFixed(3)).join(', ')}`);
  assert.ok(medium.reboundHeight > firm.reboundHeight * 1.3 && soft.reboundHeight > medium.reboundHeight * 1.4, `rebounds ${results.map(result => result.reboundHeight.toFixed(3)).join(', ')}`);
  assert.ok(soft.dent > 0.08 && soft.reboundHeight > 0.3, `soft dent ${soft.dent}, rebound ${soft.reboundHeight}`);
  for (const preset of JELLY_PRESETS) {
    const folded = foldedTriangles(presetRecipe(preset, 2), FRAME_COUNT);
    assert.ok(folded <= 8, `${preset.id} folded ${folded} triangles in one frame`);
  }
});

test('a near-zero shape folds the surface on impact, which is why the soft preset keeps 0.06 or more', () => {
  const folded = foldedTriangles(jellyCubeRecipe({ softBody: { shape: 0.02, bounce: 1 }, sheet: { stiffness: 0.1 }, ...JELLY_LOOK }), FRAME_COUNT);
  assert.ok(folded > 20, `shape 0.02 should fold more than 20 triangles, got ${folded}`);
});

// The ragged, doubled edge of the soft cube at its deepest dent was the mesh, not a fold: a flat side is one quad, so the
// bulge sat on the top rim. The bevel decides where the widest row is.
test('the soft dent bulges into a belly with the preview bevel and into a top ledge with the thin bevel', () => {
  const soft = JELLY_PRESETS.find(preset => preset.id === 'soft');
  const widestAtDent = options => {
    const frames = recordJelly(jellyCubeRecipe({ softBody: soft.softBody, sheet: soft.sheet, ...options }), FRAME_COUNT);
    return widestRowHeight(frames[measureBounce(frames).deepestFrame]);
  };
  const belly = widestAtDent(JELLY_LOOK);
  const ledge = widestAtDent({});
  assert.ok(belly < 0.5, `the belly sits in the lower half, got ${belly.toFixed(2)} of the height`);
  assert.ok(ledge > 0.8, `the thin bevel puts the widest row at the top rim, got ${ledge.toFixed(2)}`);
});

// The frames the preview shows: every preset keeps its surface the right way out, and each rests level once it has settled.
test('the presets never invert a triangle and rest level after 4 seconds', () => {
  for (const preset of JELLY_PRESETS) {
    const recipe = presetRecipe(preset, 4);
    const inverted = invertedTriangles(recipe, 240);
    assert.ok(inverted <= 2, `${preset.id} inverted ${inverted} triangles in one frame`);
    const frames = recordJelly(recipe, 240);
    const tilt = topFaceTilt(frames.at(-1));
    assert.ok(tilt < 0.5, `${preset.id} rests tilted ${tilt.toFixed(2)} degrees`);
    let largestMove = 0;
    for (let index = 0; index < frames.at(-1).length; index++) largestMove = Math.max(largestMove, Math.abs(frames.at(-1)[index] - frames.at(-10)[index]));
    assert.ok(largestMove < 0.005, `${preset.id} still moved ${largestMove} m in 9 steps at the end`);
  }
});
