import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import * as pack from '../src/path-tracer-gpu-pack.js';

function floor() {
  return {
    positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const camera = createCamera({ eye: [0, 1, 4], target: [0, 1, 0], fov: 50 }, 16, 16);
const options = { width: 16, height: 16, samples: 1, bounces: 2, seed: 0 };
const plainParts = [{ name: 'floor', geometry: floor(), material: { color: [0.5, 0.5, 0.5] } }];
const subsurfaceParts = [{ name: 'skin', geometry: floor(), material: { color: [0.7, 0.4, 0.3], subsurface: { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 } } }];
const fog = { volumeFog: { minimum: [-30, 1, -30], maximum: [30, 2, 30], density: 0.5 } };

function floatWords(input) {
  return new Float32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
}

function unsignedWords(input) {
  return new Uint32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
}

test('a plain scene packs no fog and no subsurface table, so the kernel compiles without either', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, options, pack);
  assert.equal(input.parameters.byteLength, 16 * 16);
  assert.equal(floatWords(input)[51], 0, 'fog density');
  assert.equal(unsignedWords(input)[60], 0, 'subsurface offset');
  assert.equal(floatWords(input)[35], 0, 'noise threshold');
});

test('fog packs its box, medium and density where the kernel reads them', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, fog), camera, options, pack);
  const words = floatWords(input);
  assert.deepEqual([...words.subarray(48, 51)], [-30, 1, -30]);
  assert.equal(words[51], 0.5);
  assert.deepEqual([...words.subarray(52, 55)], [30, 2, 30]);
});

test('subsurface appends its table after the materials and points the kernel at it', () => {
  const scene = buildTraceScene(subsurfaceParts, {});
  const plainMaterials = pack.packMaterials(scene.materials, pack.packAtlas(scene.materials)).data;
  const input = buildNativeInput(scene, camera, options, pack);
  const offset = unsignedWords(input)[60];
  assert.equal(offset, plainMaterials.length / 4);
  assert.equal(input.materials.length, plainMaterials.length + pack.packSubsurface(scene.materials).data.length);
  assert.equal(input.materials[offset * 4], 1, 'the subsurface weight of the first material');
});

test('noiseThreshold lands in the parameter block and defaults to drawing every sample', () => {
  const input = buildNativeInput(buildTraceScene(plainParts, {}), camera, { ...options, noiseThreshold: 0.02 }, pack);
  assert.ok(Math.abs(floatWords(input)[35] - 0.02) < 1e-7);
});

test('the kernel declares the two constants the host rewrites and reads the vectors the packer writes', () => {
  const kernel = readFileSync(new URL('../packages/render-native/src/kernel.wgsl', import.meta.url), 'utf8');
  assert.match(kernel, /const HAS_VOLUME: bool = false;/);
  assert.match(kernel, /const HAS_SUBSURFACE: bool = false;/);
  assert.match(kernel, /volumeMinimumDensity: vec4<f32>,\s+volumeMaximumAnisotropy: vec4<f32>,\s+volumeAlbedoDistance: vec4<f32>,\s+\/\/[^\n]*\n\s+extras: vec4<u32>,/);
});
