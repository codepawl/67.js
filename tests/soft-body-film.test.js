import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { FILM_FRAMES_PER_SECOND, FLAG_FILM_SECONDS, axisRange, foldingFlagRecipe, jellyCubeRecipe, measureLanding, recordFilm, unjoinedMinimumDistance } from '../scripts/soft-body-film.mjs';

// Film tests for #696: each film is one recipe baked twice. The frames must match byte for byte, and the numbers a viewer
// would see (the landing, the dent, the height and layers of the fold) are measured from the baked vertices, not read off a picture.
const JELLY_FRAMES = 120;
const FLAG_FRAMES = FLAG_FILM_SECONDS * FILM_FRAMES_PER_SECOND;
const FLAG_SAMPLE_EVERY = 12;
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

test('a flag dropped by its pole falls to the floor and ends as a thin layer whose folds keep their layers apart', context => {
  const first = recordFilm(foldingFlagRecipe(), 'flag', FLAG_FRAMES);
  const second = recordFilm(foldingFlagRecipe(), 'flag', FLAG_FRAMES);
  assert.deepEqual(first.hashes, second.hashes, 'two bakes of the same recipe give the same bytes in every frame');
  const last = FLAG_FRAMES - 1;
  assert.ok(Buffer.from(first.frames[last].buffer).equals(Buffer.from(second.frames[last].buffer)));

  const indices = createAgentScene(foldingFlagRecipe()).parts.find(part => part.name === 'flag').geometry.indices;
  const restHeight = axisRange(first.frames[0], 1).extent;
  const touch = measureLanding(first.frames, restHeight).contact;
  assert.ok(touch > 30 && touch < 90, `the hanging flag first touches the floor within frames 30 to 90, got ${touch}`);
  const midFall = Math.round(touch * 0.7);
  assert.ok(axisRange(first.frames[midFall], 1).extent > restHeight * 0.6, 'mid fall the flag is still hanging in the air');

  const finalRange = axisRange(first.frames[last], 1);
  assert.ok(finalRange.high < 0.055, `the flag ends no more than 5.5 cm above the floor, got ${finalRange.high} m`);
  assert.ok(axisRange(first.frames[last], 2).extent > 0.7, 'the flag lies spread over the floor, not stacked in one place');

  const without = recordFilm(foldingFlagRecipe({ selfCollision: false }), 'flag', FLAG_FRAMES);
  let closestWith = Infinity;
  let closestWithout = Infinity;
  for (let frame = touch; frame < FLAG_FRAMES; frame += FLAG_SAMPLE_EVERY) {
    closestWith = Math.min(closestWith, unjoinedMinimumDistance(first.frames[frame], indices));
    closestWithout = Math.min(closestWithout, unjoinedMinimumDistance(without.frames[frame], indices));
  }
  assert.ok(closestWith > 0.005, `with self collision no two unjoined particles come within 5 mm in any sampled frame (closest ${closestWith} m)`);
  assert.ok(closestWithout < closestWith * 0.9, `without self collision the layers come closer (${closestWithout} m)`);

  const bake = first.bakeMilliseconds;
  context.diagnostic(`flag: touch at frame ${touch}, final height ${finalRange.high.toFixed(4)} m from ${restHeight.toFixed(3)} m, closest unjoined pair ${closestWith.toFixed(4)} m (${closestWithout.toFixed(4)} m without self collision)`);
  context.diagnostic(`flag: bake ${milliseconds(bake)} ms for ${FLAG_FRAMES} steps (${milliseconds(bake / FLAG_FRAMES)} ms a step with self collision, ${milliseconds(without.bakeMilliseconds / FLAG_FRAMES)} ms without)`);
});
