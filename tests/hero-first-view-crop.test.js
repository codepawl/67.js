import test from 'node:test';
import assert from 'node:assert/strict';
import { CROP_DEFAULTS, nearestVisibleDistance, sampleFlightPoses } from '../scripts/hero-first-view-crop.mjs';
import { parseArguments } from '../scripts/build-hero-first-view.mjs';

const lookingDownZ = [{ eye: [0, 0, 0], forward: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0], tanVertical: Math.tan(Math.PI / 8) }];

test('a sphere in front of the camera is seen at its surface distance', () => {
  const distance = nearestVisibleDistance(lookingDownZ, [0, 0, 100], 10, CROP_DEFAULTS);
  assert.equal(distance, 90);
});

test('spheres behind the camera or far outside the frustum are dropped', () => {
  assert.equal(nearestVisibleDistance(lookingDownZ, [0, 0, -100], 10, CROP_DEFAULTS), Infinity);
  assert.equal(nearestVisibleDistance(lookingDownZ, [5000, 0, 100], 10, CROP_DEFAULTS), Infinity);
  assert.equal(nearestVisibleDistance(lookingDownZ, [0, 5000, 100], 10, CROP_DEFAULTS), Infinity);
});

test('the port flight yields poses that start at the first key', () => {
  const poses = sampleFlightPoses('port', 5);
  assert.deepEqual(poses[0].eye.map(Math.round), [-20, 130, -300]);
  assert.throws(() => sampleFlightPoses('nowhere', 5), /No scene nowhere/);
});

test('build options reject unknown names and non-positive numbers', () => {
  assert.equal(parseArguments(['--near-pixels', '2']).nearPixels, 2);
  assert.throws(() => parseArguments(['--bogus', '1']), /Unknown option/);
  assert.throws(() => parseArguments(['--far-pixels', '0']), /positive number/);
});
