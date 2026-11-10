import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { FILM_FRAMES_PER_SECOND, axisRange, foldingFlagRecipe, jellyCubeRecipe, measureLanding, recordFilm, unjoinedMinimumDistance } from '../scripts/soft-body-film.mjs';

// Film tests for #696: each film is one recipe baked twice. The frames must match byte for byte, and the numbers a viewer
// would see (the landing, the dent, the layers of the fold) are measured from the baked vertices, not read off a picture.
const JELLY_FRAMES = 120;
const FLAG_FRAMES = 150;
function milliseconds(value) {
  return Number(value.toFixed(2));
}

test('a jelly cube landing is byte-identical across two bakes and dents on contact', context => {
  const first = recordFilm(jellyCubeRecipe(), 'cube', JELLY_FRAMES);
  const second = recordFilm(jellyCubeRecipe(), 'cube', JELLY_FRAMES);
  assert.deepEqual(first.hashes, second.hashes, 'two bakes of the same recipe give the same bytes in every frame');
  for (let frame = 0; frame < JELLY_FRAMES; frame++) assert.ok(Buffer.from(first.frames[frame].buffer).equals(Buffer.from(second.frames[frame].buffer)));

  const restHeight = axisRange(first.frames[0], 1).extent;
  const landing = measureLanding(first.frames, restHeight);
  assert.ok(landing.contact > 40 && landing.contact < 55, `free fall from 1.95 m reaches the floor near frame 48, got ${landing.contact}`);
  assert.ok(axisRange(first.frames[landing.contact - 1], 1).extent > restHeight * 0.999, 'the cube is not dented in the frame before contact');
  assert.ok(landing.maxDentFrame - landing.contact <= 4, `the dent is deepest within 4 frames of contact, got ${landing.maxDentFrame - landing.contact}`);
  assert.ok(landing.maxDentDepth > 0.03, `the cube dents ${landing.maxDentDepth} m on landing, more than 3 cm`);
  const widest = axisRange(first.frames[landing.maxDentFrame], 0).extent;
  assert.ok(widest > restHeight * 1.04, `the squashed cube bulges sideways to ${widest} m`);

  const bake = first.bakeMilliseconds;
  context.diagnostic(`jelly cube: contact frame ${landing.contact}, max dent ${landing.maxDentDepth.toFixed(4)} m at frame ${landing.maxDentFrame}`);
  context.diagnostic(`jelly cube: bake ${milliseconds(bake)} ms for ${JELLY_FRAMES} steps (${milliseconds(bake / JELLY_FRAMES)} ms a step, ${FILM_FRAMES_PER_SECOND} steps a second)`);
});

test('measureLanding names the problem when the body never reaches the floor', () => {
  const airborne = [new Float32Array([0, 5, 0, 1, 6, 1])];
  assert.throws(() => measureLanding(airborne, 1), /never reached the floor within 1 frames/);
});

test('a flag lowered into folds is byte-identical across two bakes and keeps its layers apart', context => {
  const first = recordFilm(foldingFlagRecipe(), 'flag', FLAG_FRAMES);
  const second = recordFilm(foldingFlagRecipe(), 'flag', FLAG_FRAMES);
  assert.deepEqual(first.hashes, second.hashes, 'two bakes of the same recipe give the same bytes in every frame');
  const last = FLAG_FRAMES - 1;
  assert.ok(Buffer.from(first.frames[last].buffer).equals(Buffer.from(second.frames[last].buffer)));

  const indices = createAgentScene(foldingFlagRecipe()).parts.find(part => part.name === 'flag').geometry.indices;
  const restHeight = axisRange(first.frames[0], 1).extent;
  const pileHeight = axisRange(first.frames[last], 1).extent;
  assert.ok(pileHeight < restHeight * 0.6, `the flag folds from ${restHeight} m to a pile ${pileHeight} m tall`);
  const without = recordFilm(foldingFlagRecipe({ selfCollision: false }), 'flag', FLAG_FRAMES);
  const gap = unjoinedMinimumDistance(first.frames[last], indices);
  const gapWithout = unjoinedMinimumDistance(without.frames[last], indices);
  assert.ok(gap > gapWithout * 5, `layers stay apart with self collision (${gap} m) and merge without it (${gapWithout} m)`);
  assert.ok(gap > 0.005, `the closest unjoined pair is ${gap} m apart`);

  const bake = first.bakeMilliseconds;
  context.diagnostic(`flag: pile ${pileHeight.toFixed(3)} m from ${restHeight.toFixed(3)} m, closest unjoined pair ${gap.toFixed(4)} m (${gapWithout.toFixed(4)} m without self collision)`);
  context.diagnostic(`flag: bake ${milliseconds(bake)} ms for ${FLAG_FRAMES} steps (${milliseconds(bake / FLAG_FRAMES)} ms a step with self collision, ${milliseconds(without.bakeMilliseconds / FLAG_FRAMES)} ms without)`);
});
