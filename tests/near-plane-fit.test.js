import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { fittedNearPlane, nearestDepthOfBounds, sceneBoundsOfParts } from '../src/near-plane-fit.js';

function boxPart(translation, size = 2) {
  const half = size / 2;
  const positions = new Float32Array([-half, -half, -half, half, half, half]);
  return { geometry: { positions }, matrix: mat4.fromTranslation(mat4.create(), translation) };
}

function lookingDownNegativeZ() {
  return mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
}

test('scene bounds cover every part with a small padding', () => {
  const bounds = sceneBoundsOfParts([boxPart([0, 0, -50]), boxPart([10, 0, -60])]);
  assert.ok(bounds.minimum[2] < -61);
  assert.ok(bounds.maximum[2] > -49);
});

test('a part that can leave its bounds disables the fit', () => {
  assert.equal(sceneBoundsOfParts([{ ...boxPart([0, 0, -50]), skin: {} }]), null);
  assert.equal(sceneBoundsOfParts([{ ...boxPart([0, 0, -50]), crowd: {} }]), null);
});

test('the near plane stays at the default when the eye is inside the scene and moves out when it is far', () => {
  const view = lookingDownNegativeZ();
  const close = sceneBoundsOfParts([boxPart([0, 0, 0])]);
  assert.equal(fittedNearPlane(close, view, 100), 0.1);
  const far = sceneBoundsOfParts([boxPart([0, 0, -80])]);
  const near = fittedNearPlane(far, view, 10000);
  assert.ok(near > 50 && near < nearestDepthOfBounds(far, view));
});

test('the near plane never passes one percent of the far plane', () => {
  const bounds = sceneBoundsOfParts([boxPart([0, 0, -500])]);
  assert.equal(fittedNearPlane(bounds, lookingDownNegativeZ(), 100), 1);
});
