import assert from 'node:assert/strict';
import test from 'node:test';

import { createCamera } from '../src/path-tracer.js';
import { bilinearTaps, isHistoryConsistent, motionVector, pixelRayDirection, projectToPixel } from '../src/path-tracer-reprojection.js';

const WIDTH = 480;
const HEIGHT = 270;
const camera = createCamera({ eye: [0, 1.5, 6], target: [0, 1.2, 0], fov: 50 }, WIDTH, HEIGHT);
const pointAt = (pixelX, pixelY, distance, view = camera) => {
  const direction = pixelRayDirection(view, pixelX, pixelY, WIDTH, HEIGHT);
  return direction.map((component, axis) => view.eye[axis] + component * distance);
};

test('a point seen through a pixel projects back to that pixel with its eye distance', () => {
  for (const [pixelX, pixelY, distance] of [[240.5, 135.5, 6], [10.25, 20.75, 3], [470.5, 260.5, 12]]) {
    const projected = projectToPixel(camera, pointAt(pixelX, pixelY, distance), WIDTH, HEIGHT);
    assert.ok(Math.abs(projected.x - pixelX) < 1e-6 && Math.abs(projected.y - pixelY) < 1e-6);
    assert.ok(Math.abs(projected.distance - distance) < 1e-9);
  }
});

test('the picture centre is where the camera looks, and up is toward row 0', () => {
  const target = [0, 1.2, 0];
  const centre = projectToPixel(camera, target, WIDTH, HEIGHT);
  assert.ok(Math.abs(centre.x - WIDTH / 2) < 1e-6 && Math.abs(centre.y - HEIGHT / 2) < 1e-6);
  const above = projectToPixel(camera, [0, 2.2, 0], WIDTH, HEIGHT);
  assert.ok(above.y < centre.y);
});

test('a resting camera gives a zero motion vector', () => {
  const vector = motionVector(camera, camera, 100.5, 50.5, 4, WIDTH, HEIGHT);
  assert.ok(Math.abs(vector.x) < 1e-6 && Math.abs(vector.y) < 1e-6);
});

test('a camera that moves right sees a near surface move left (vector toward this frame), more than a far one', () => {
  const moved = createCamera({ eye: [0.2, 1.5, 6], target: [0.2, 1.2, 0], fov: 50 }, WIDTH, HEIGHT);
  const near = motionVector(moved, camera, 240.5, 135.5, 2, WIDTH, HEIGHT);
  const far = motionVector(moved, camera, 240.5, 135.5, 20, WIDTH, HEIGHT);
  assert.ok(near.x < 0 && far.x < 0, 'the surface was further to the right in the previous frame, so the vector toward this frame points left');
  assert.ok(near.x < far.x);
  assert.ok(Math.abs(near.y) < 1e-3);
});

test('a camera that turns moves every surface by the same amount whatever its distance', () => {
  const turned = createCamera({ eye: [0, 1.5, 6], target: [1, 1.2, 0], fov: 50 }, WIDTH, HEIGHT);
  const near = motionVector(turned, camera, 240.5, 135.5, 2, WIDTH, HEIGHT);
  const far = motionVector(turned, camera, 240.5, 135.5, 50, WIDTH, HEIGHT);
  assert.ok(Math.abs(near.x - far.x) < 1e-6);
  assert.ok(Math.abs(near.x) > 10);
});

test('a point behind the previous camera has no history', () => {
  const behind = createCamera({ eye: [0, 1.5, 6], target: [0, 1.5, 12], fov: 50 }, WIDTH, HEIGHT);
  assert.equal(projectToPixel(behind, [0, 1.2, 0], WIDTH, HEIGHT), null);
  assert.equal(motionVector(camera, behind, 240.5, 135.5, 4, WIDTH, HEIGHT), null);
});

test('bilinear taps add up to one and fall on the pixel centres around the position', () => {
  const taps = bilinearTaps(10.25, 20.75);
  assert.ok(Math.abs(taps.reduce((sum, tap) => sum + tap.weight, 0) - 1) < 1e-12);
  assert.deepEqual(taps.map(tap => [tap.column, tap.row]), [[9, 20], [10, 20], [9, 21], [10, 21]]);
  const centred = bilinearTaps(10.5, 20.5);
  assert.deepEqual(centred.map(tap => tap.weight), [1, 0, 0, 0]);
});

test('history is rejected across a depth jump or a turned surface and accepted along a slope', () => {
  const flat = [0, 1, 0];
  const base = { expectedDistance: 5, historyDistance: 5.1, normal: flat, historyNormal: flat };
  assert.equal(isHistoryConsistent(base), true);
  assert.equal(isHistoryConsistent({ ...base, historyDistance: 7 }), false, 'a surface two units behind is a disocclusion');
  assert.equal(isHistoryConsistent({ ...base, historyNormal: [1, 0, 0] }), false);
  assert.equal(isHistoryConsistent({ ...base, historyNormal: [0.2, 0.98, 0] }), true);
});
