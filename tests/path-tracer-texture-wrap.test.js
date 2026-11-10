import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { box } from '../src/geometry.js';

const REPEAT_WRAP = 10497;
const CLAMP_TO_EDGE = 33071;
const image = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 };

function textureOf(map) {
  const part = { name: 'wall', geometry: box(0, 1), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: { color: [1, 1, 1], map } };
  return buildTraceScene([part]).materials[0].texture;
}

test('a map with no wrap mode repeats, as the rasteriser draws it', () => {
  assert.equal(textureOf({ image, colorSpace: 'srgb' }).repeat, true);
});

test('a map that asks for repeat or clamp keeps that wrap mode', () => {
  assert.equal(textureOf({ image, wrapS: REPEAT_WRAP }).repeat, true);
  assert.equal(textureOf({ image, wrapS: CLAMP_TO_EDGE }).repeat, false);
});
