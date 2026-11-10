import test from 'node:test';
import assert from 'node:assert/strict';
import { skyOpenness } from '../src/closed-room.js';
import { resolveVolumeFog } from '../src/volumetric.js';
import { volumeShadowAmbient } from '../src/fog-field.js';
import { Renderer67 } from '../src/renderer.js';

test('bounded volume controls default disabled and preserve ordinary input data', () => {
  assert.equal(resolveVolumeFog().density, 0);
  const input = { density: 0.05, minimum: [-4, 0, -4], maximum: [4, 5, 4], color: [0.8, 0.6, 0.3], steps: 24 };
  const snapshot = structuredClone(input);
  const resolved = resolveVolumeFog(input);
  assert.equal(resolved.density, 0.05);
  assert.equal(resolved.steps, 24);
  assert.deepEqual(input, snapshot);
});

test('volume preflight rejects malformed controls and Float32 collapsed bounds', () => {
  for (const input of [null, [], { density: -1 }, { density: Infinity }, { steps: 7 }, { steps: 12.5 }, { noiseScale: 0 }, { noiseAmount: 1.01 }, { anisotropy: 1 }, { minimum: [1e5, 0, 0], maximum: [1e5 + 1e-8, 1, 1] }, { color: [1, NaN, 1] }, { drift: [0, '1', 0] }, { shadowAmbient: -0.1 }, { shadowAmbient: 1.1 }]) {
    assert.throws(() => resolveVolumeFog(input));
  }
  assert.throws(() => new Renderer67({}, [], { hdr: true, environment: { volumeFog: { density: 0.1 } } }), /depth:true/);
  assert.throws(() => new Renderer67({}, [], { hdr: true, depth: true, transparent: true, environment: { volumeFog: { density: 0.1 } } }), /opaque/);
});

test('volume shadow ambient stays unset until the renderer derives it, and accepts the full range', () => {
  assert.equal(resolveVolumeFog({ density: 0.1 }).shadowAmbient, undefined);
  assert.equal(resolveVolumeFog({ density: 0.1, shadowAmbient: 1 }).shadowAmbient, 1);
  assert.equal(resolveVolumeFog({ density: 0.1, shadowAmbient: 0 }).shadowAmbient, 0);
});

function flatPart(name, height, facesDown) {
  const half = 50;
  const corners = [-half, height, -half, half, height, -half, half, height, half, -half, height, half];
  const indices = facesDown ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return { name, geometry: { positions: new Float32Array(corners), indices: new Uint32Array(indices) }, matrix: identity };
}

test('an unset volume shadow ambient follows how open the sky is above the fog', () => {
  const fog = resolveVolumeFog({ density: 0.1, minimum: [-4, 0, -4], maximum: [4, 2, 4] });
  const floor = flatPart('floor', 0, false);
  const room = [floor, flatPart('ceiling', 3, true)];
  assert.equal(volumeShadowAmbient(fog, [floor], skyOpenness), 1);
  assert.ok(volumeShadowAmbient(fog, room, skyOpenness) < 0.3, 'a ceiling over the fog leaves almost nothing open');
  assert.equal(volumeShadowAmbient({ ...fog, shadowAmbient: 0.6 }, room, skyOpenness), 0.6);
  assert.equal(volumeShadowAmbient(fog, [floor]), 0.15, 'without a measure the scene counts as enclosed');
});

test('height falloff in metres keeps its metres, and a flat volume keeps zero', () => {
  assert.equal(resolveVolumeFog({ density: 0.1 }).heightFalloff, 0);
  assert.equal(resolveVolumeFog({ density: 0.1, heightFalloff: 25 }).heightFalloff, 25);
  assert.equal(resolveVolumeFog({ density: 0.1, heightFalloff: 0 }).heightFalloff, 0);
});
