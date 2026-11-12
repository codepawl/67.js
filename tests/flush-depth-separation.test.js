import test from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_FLUSH_RANK } from '../src/depth-layer.js';
import { reverseProjectionDepth } from '../src/reversed-depth.js';

// The constants applyDepthRank sends to the shader (src/renderer.js), checked against the rank test that pins them.
const METRES_PER_RANK = 1e-4;
const RELATIVE_PER_RANK = 2 ** -19;
const CLIP_PER_RANK = 2 ** -22;
const DEPTH_BITS = 24;

const DISTANCES = [1, 10, 100, 1000];
const CAMERAS = [{ near: 0.1, far: 2000 }, { near: 1, far: 2000 }, { near: 0.05, far: 5000 }];

function perspective({ near, far }) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
}

// The vertex shader's lift for a point straight ahead at `distance`: clip space moves `shift` metres toward the eye, then
// the 24-bit path adds the clip-space step. Returns the stored depth in 0..1 (standard) or 1..0 (reversed).
function storedDepth(camera, distance, rank, reversed) {
  const standard = perspective(camera);
  const matrix = reversed ? reverseProjectionDepth(new Array(16).fill(0), standard) : standard;
  const clipDepth = matrix[10] * -distance + matrix[14];
  const clipW = distance;
  const clipDepthPerMetre = -matrix[10];
  const shift = rank * (METRES_PER_RANK + RELATIVE_PER_RANK * distance);
  const lifted = (clipDepth - shift * clipDepthPerMetre) / (clipW - shift);
  const clipStep = !reversed && rank ? -rank * CLIP_PER_RANK : 0;
  const depth = reversed ? lifted : (lifted + clipStep + 1) / 2;
  return reversed ? Math.fround(depth) : Math.round(depth * (2 ** DEPTH_BITS - 1));
}

// How many metres toward the eye a rank moves the surface, read back through the unbiased projection.
function viewSeparation(camera, distance, rank, reversed) {
  const unbiased = storedDepth(camera, distance, 0, reversed);
  const biased = storedDepth(camera, distance, rank, reversed);
  const slope = (storedDepth(camera, distance + 1e-3, 0, reversed) - unbiased) / 1e-3;
  return (biased - unbiased) / -slope;
}

function everyRankDiffers(camera, distance, reversed) {
  const depths = Array.from({ length: MAXIMUM_FLUSH_RANK + 1 }, (_, rank) => storedDepth(camera, distance, rank, reversed));
  return depths.every((depth, rank) => rank === 0 || depth !== depths[rank - 1]);
}

test('on 24-bit and float depth every rank 1..15 stores a nearer depth than the rank below it, at 1 to 1000 m', () => {
  for (const camera of CAMERAS) {
    for (const distance of DISTANCES) {
      for (const reversed of [false, true]) {
        assert.ok(everyRankDiffers(camera, distance, reversed), `${reversed ? 'float' : '24-bit'} depth, ${distance} m, near ${camera.near}`);
      }
    }
  }
});

test('a rank moves float depth by the metric step and 24-bit depth by at least that step and two depth values', () => {
  for (const camera of CAMERAS) {
    for (const distance of DISTANCES) {
      const metric = METRES_PER_RANK + RELATIVE_PER_RANK * distance;
      const float = viewSeparation(camera, distance, 1, true);
      assert.ok(Math.abs(float - metric) / metric < 0.05, `float ${float} against ${metric} at ${distance} m`);
      const steps = viewSeparation(camera, distance, 1, false);
      assert.ok(steps >= metric * 0.98, `24-bit ${steps} against ${metric} at ${distance} m`);
      const depthStepsMoved = storedDepth(camera, distance, 0, false) - storedDepth(camera, distance, 1, false);
      assert.ok(depthStepsMoved >= 2, `24-bit moves ${depthStepsMoved} depth values per rank at ${distance} m`);
    }
  }
});

test('the accepted difference: far away a 24-bit rank is a depth-limited step, far wider than the float metric step', () => {
  const camera = { near: 0.1, far: 2000 };
  assert.ok(Math.abs(viewSeparation(camera, 1, 1, false) - viewSeparation(camera, 1, 1, true)) < 1e-5, 'the same at 1 m');
  assert.ok(viewSeparation(camera, 1000, 1, false) > 0.5, '24-bit cannot hold a step below its own depth resolution at 1 km');
  assert.ok(viewSeparation(camera, 1000, 1, true) < 0.003, 'float keeps the 2 mm metric step');
});
