import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildNativeInput, findNativeAddon, traceNative, upgradeNativeInputV1ToV2 } from '../packages/render-native/index.mjs';
import { STRUCT_STRIDES_V2 } from '../packages/render-native/pack-input-v2.mjs';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { MATERIAL_TEXELS } from '../src/path-tracer-gpu-shader.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;
const INSTANCE_VISIBILITY_CAMERA = 1;
const INSTANCE_VISIBILITY_OFFSET = 116;
const SIZE = 16;
const environment = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
const cameraDescription = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color) {
  return { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color };
}

function floor() {
  return { name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [20, 0.1, 20]), material: surface([0.5, 0.5, 0.5]) };
}

function caster(extra) {
  return { name: 'caster', geometry: box(0, 1), matrix: placed([0, 1.5, 0], [3, 0.2, 3]), material: surface([0.9, 0.2, 0.1]), ...extra };
}

function packScene(parts, size) {
  const scene = buildTraceScene(parts, environment);
  const camera = createCamera(cameraDescription, size, size);
  return buildNativeInput(scene, camera, { width: size, height: size, samples: 32, bounces: 2, seed: 1 }, pack);
}

function render(parts, kernel, size = SIZE) {
  const input = packScene(parts, size);
  return traceNative(input, { width: size, height: size, samples: 32, bounces: 2, kernel }).rgba;
}

function centreBrightness(rgba, size = SIZE) {
  let sum = 0;
  const first = size / 2 - 2;
  for (let row = first; row < first + 4; row++) {
    for (let column = first; column < first + 4; column++) {
      const offset = (row * size + column) * 4;
      sum += rgba[offset] + rgba[offset + 1] + rgba[offset + 2];
    }
  }
  return sum / 16;
}

function instanceVisibility(upgraded, instanceIndex) {
  const bytes = upgraded.instances;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(instanceIndex * STRUCT_STRIDES_V2.instance + INSTANCE_VISIBILITY_OFFSET, true);
}

test('the material table flags a shadow-only part and leaves the table of a scene without one unchanged', () => {
  const plain = buildTraceScene([floor(), caster()], environment);
  const withFlag = buildTraceScene([floor(), caster({ shadowOnly: true })], environment);
  assert.equal(plain.shadowOnlyParts, null);
  const atlas = pack.packAtlas(plain.materials);
  const unflagged = pack.packMaterials(plain.materials, atlas, plain.shadowOnlyParts).data;
  assert.deepEqual(unflagged, pack.packMaterials(plain.materials, atlas).data, 'a scene without shadow-only parts packs the same bytes');
  const flagged = pack.packMaterials(withFlag.materials, atlas, withFlag.shadowOnlyParts).data;
  const casterFloatOffset = MATERIAL_TEXELS * 4;
  const differing = [];
  flagged.forEach((value, index) => {
    if (value !== unflagged[index]) differing.push(index);
  });
  assert.deepEqual(differing, [casterFloatOffset + pack.SHADOW_ONLY_SLOT], 'only the caster flag differs');
});

test('the cycles input hides a shadow-only part from camera rays and keeps every other ray bit', () => {
  const scene = buildTraceScene([floor(), caster({ shadowOnly: true })], environment);
  const camera = createCamera(cameraDescription, SIZE, SIZE);
  const input = buildNativeInput(scene, camera, { width: SIZE, height: SIZE, samples: 4, bounces: 2, seed: 1 }, pack);
  const upgraded = upgradeNativeInputV1ToV2(input, { width: SIZE, height: SIZE, samples: 4 });
  assert.equal(upgraded.instanceCount, 2);
  const visibility = [instanceVisibility(upgraded, 0), instanceVisibility(upgraded, 1)];
  const cameraVisible = visibility.filter(flags => (flags & INSTANCE_VISIBILITY_CAMERA) !== 0);
  const cameraHidden = visibility.filter(flags => (flags & INSTANCE_VISIBILITY_CAMERA) === 0);
  assert.equal(cameraVisible.length, 1, 'the floor stays visible to the camera');
  assert.equal(cameraHidden.length, 1, 'the caster is hidden from the camera');
  assert.equal(cameraHidden[0] & 0x3e, 0x3e, 'the hidden part still takes diffuse, glossy, transmission, shadow and volume rays');
});

for (const kernel of ['legacy', 'cycles']) {
  test(`the native ${kernel} kernel draws the shadow of a shadow-only caster and not the caster`, { skip: skipWithoutAddon }, () => {
    const lit = centreBrightness(render([floor()], kernel));
    const visibleCaster = centreBrightness(render([floor(), caster()], kernel));
    const shadowOnly = centreBrightness(render([floor(), caster({ shadowOnly: true })], kernel));
    assert.ok(lit > 0.5, `the bare floor is lit by the sun: ${lit}`);
    assert.ok(visibleCaster > lit * 0.5, `a visible caster is drawn in the middle of the picture: ${visibleCaster} against ${lit}`);
    assert.ok(shadowOnly < lit * 0.15, `the floor under a shadow-only caster is in its shadow: ${shadowOnly} against ${lit}`);
    assert.ok(visibleCaster > shadowOnly * 5, `the shadow-only caster is not drawn: ${visibleCaster} against ${shadowOnly}`);
  });
}

// Set COOK_SHADOW_ONLY_IMAGE_DIRECTORY to keep the three renders side by side (floor, visible caster, shadow-only caster) as a PPM.
test('the native legacy kernel writes the comparison picture when asked', { skip: skipWithoutAddon || !process.env.COOK_SHADOW_ONLY_IMAGE_DIRECTORY }, () => {
  const size = 128;
  const renders = [[floor()], [floor(), caster()], [floor(), caster({ shadowOnly: true })]].map(parts => render(parts, 'legacy', size));
  const pixels = Buffer.alloc(size * 3 * size * 3);
  renders.forEach((rgba, panel) => {
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        for (let channel = 0; channel < 3; channel++) {
          const linear = Math.min(1, Math.max(0, rgba[(row * size + column) * 4 + channel]));
          const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
          pixels[(row * size * 3 + panel * size + column) * 3 + channel] = Math.round(encoded * 255);
        }
      }
    }
  });
  const directory = process.env.COOK_SHADOW_ONLY_IMAGE_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'shadow-only-native.ppm'), Buffer.concat([Buffer.from(`P6\n${size * 3} ${size}\n255\n`), pixels]));
});
