import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildNativeInput, buildNativeTexelInput, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { STRUCT_STRIDES_V2 } from '../packages/render-native/pack-input-v2.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../packages/render-native/job-input.mjs';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, partRayVisibilityFlags, RAY_VISIBILITY_BITS, refuseLocalVolumes, resolveTexture } from '../src/path-tracer-scene.js';

const INSTANCE_VISIBILITY_OFFSET = 116;
const ALL_RAY_KINDS = 63;
const SHADOW_OFF = ALL_RAY_KINDS & ~RAY_VISIBILITY_BITS.shadow;
const WIDTH = 8;
const HEIGHT = 8;
const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const options = { width: WIDTH, height: HEIGHT, samples: 4, bounces: 2, seed: 1, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

const sharedBox = box(0, 1);
const translate = x => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
const surface = { tag: 'surface', color: [0.5, 0.5, 0.5], roughness: 0.8, metallic: 0 };

function sharedPart(name, x, extra = {}) {
  return { name, geometry: sharedBox, matrix: translate(x), material: surface, ...extra };
}

function uniquePart(name, x, extra = {}) {
  return { name, geometry: box(0, 1), matrix: translate(x), material: surface, ...extra };
}

function exportedVisibility(parts, instancing) {
  const exported = exportNativeSceneTables({ parts, environment, camera, options, kernel: 'cycles', instancing, modules });
  const bytes = Buffer.from(exported.tables.instances, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = [];
  for (let index = 0; index < bytes.byteLength / STRUCT_STRIDES_V2.instance; index++) {
    flags.push(view.getUint32(index * STRUCT_STRIDES_V2.instance + INSTANCE_VISIBILITY_OFFSET, true) & ALL_RAY_KINDS);
  }
  return { exported, flags };
}

function digestOfTables(exported) {
  const hash = createHash('sha256');
  for (const name of Object.keys(exported.tables).sort()) hash.update(name).update(exported.tables[name]);
  return hash.digest('hex');
}

test('the bits are the FORMAT-v2 instance visibility layout', () => {
  assert.deepEqual({ ...RAY_VISIBILITY_BITS }, { camera: 1, diffuse: 2, glossy: 4, transmission: 8, shadow: 16, volumeScatter: 32 });
});

test('a part maps rayVisibility, castShadow false and shadowOnly to visibility bits', () => {
  assert.equal(partRayVisibilityFlags({}), ALL_RAY_KINDS);
  assert.equal(partRayVisibilityFlags({ castShadow: true, rayVisibility: { shadow: true } }), ALL_RAY_KINDS);
  assert.equal(partRayVisibilityFlags({ castShadow: false }), SHADOW_OFF);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { shadow: false } }), SHADOW_OFF);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { camera: false, glossy: false } }), ALL_RAY_KINDS & ~1 & ~4);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { diffuse: false, transmission: false, volumeScatter: false } }), 1 | 4 | 16);
  assert.equal(partRayVisibilityFlags({ shadowOnly: true }), 62);
  assert.equal(partRayVisibilityFlags({ shadowOnly: true, rayVisibility: { glossy: false } }), 62 & ~4);
});

test('a bad rayVisibility says what to pass', () => {
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: 'shadow' }), /part "pane" rayVisibility must be an object such as \{ shadow: false \}/);
  assert.throws(() => partRayVisibilityFlags({ rayVisibility: [] }), /part 0 rayVisibility must be an object/);
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: { refraction: false } }), /unknown ray kind "refraction": use camera, diffuse, glossy, transmission, shadow, volumeScatter/);
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: { shadow: 0 } }), /rayVisibility\.shadow must be true or false, got 0/);
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', castShadow: false, rayVisibility: { shadow: true } }), /castShadow: false and rayVisibility\.shadow: true, which disagree/);
  assert.throws(() => partRayVisibilityFlags({ name: 'ghost', shadowOnly: true, castShadow: false }), /shadowOnly with shadow rays off/);
});

test('buildTraceScene refuses a bad rayVisibility on both scene shapes', () => {
  const flattened = [uniquePart('a', 0, { rayVisibility: { shadow: 'no' } }), uniquePart('b', 2)];
  assert.throws(() => buildTraceScene(flattened, environment), /part "a" rayVisibility\.shadow must be true or false/);
  const instanced = [sharedPart('a', 0, { rayVisibility: { bogus: false } }), sharedPart('b', 2)];
  assert.throws(() => buildTraceScene(instanced, environment, { instancing: true }), /unknown ray kind "bogus"/);
});

test('an instanced scene carries visibility only on the parts that ask for it', () => {
  const scene = buildTraceScene([sharedPart('plain', 0), sharedPart('pane', 2, { castShadow: false }), sharedPart('glow', 4, { rayVisibility: { camera: false, shadow: false } })], environment, { instancing: true });
  assert.equal('visibilityFlags' in scene.instances[0], false, 'a default part adds no field');
  assert.equal(scene.instances[1].visibilityFlags, SHADOW_OFF);
  assert.equal(scene.instances[2].visibilityFlags, ALL_RAY_KINDS & ~1 & ~16);
});

test('a flattened scene carries one visibility byte per part, or none when no part asks', () => {
  assert.equal(buildTraceScene([uniquePart('a', 0), uniquePart('b', 2, { shadowOnly: true })], environment).partRayVisibility, null);
  const scene = buildTraceScene([uniquePart('a', 0), uniquePart('b', 2, { castShadow: false }), uniquePart('c', 4, { shadowOnly: true, rayVisibility: { glossy: false } })], environment);
  assert.deepEqual([...scene.partRayVisibility], [ALL_RAY_KINDS, SHADOW_OFF, 62 & ~4]);
});

test('a native render job packs the visibility of an instanced scene into the instance table', () => {
  const parts = [sharedPart('wall', 0), sharedPart('pane', 2, { castShadow: false }), sharedPart('wall2', 4)];
  const { exported, flags } = exportedVisibility(parts, true);
  assert.equal(exported.instances, 3, 'the copies stay instances');
  assert.deepEqual(flags, [ALL_RAY_KINDS, SHADOW_OFF, ALL_RAY_KINDS]);
});

test('a native render job packs the visibility of a flattened scene into the instance table', () => {
  const parts = [uniquePart('wall', 0), uniquePart('pane', 2, { rayVisibility: { shadow: false } }), uniquePart('lamp', 4, { shadowOnly: true })];
  const { exported, flags } = exportedVisibility(parts, false);
  assert.equal(exported.schemaVersion, 2);
  assert.deepEqual(flags, [ALL_RAY_KINDS, SHADOW_OFF, 62]);
});

test('scenes that ask for no visibility export the same tables whether or not shadowOnly is the only flag', () => {
  const plain = [uniquePart('wall', 0), uniquePart('lamp', 4, { shadowOnly: true })];
  const withDefaults = [uniquePart('wall', 0, { rayVisibility: {}, castShadow: true }), uniquePart('lamp', 4, { shadowOnly: true, rayVisibility: {} })];
  assert.equal(digestOfTables(exportedVisibility(withDefaults, false).exported), digestOfTables(exportedVisibility(plain, false).exported));
  const sharedPlain = [sharedPart('a', 0), sharedPart('b', 2, { shadowOnly: true })];
  const sharedDefaults = [sharedPart('a', 0, { rayVisibility: {} }), sharedPart('b', 2, { shadowOnly: true, rayVisibility: {} })];
  assert.equal(digestOfTables(exportedVisibility(sharedDefaults, true).exported), digestOfTables(exportedVisibility(sharedPlain, true).exported));
});

test('the v1 tables and a light bake refuse a flattened scene with part visibility instead of ignoring it', () => {
  const scene = buildTraceScene([uniquePart('wall', 0), uniquePart('pane', 2, { castShadow: false })], environment);
  assert.throws(() => buildNativeInput(scene, camera, options, pack), /cannot carry.*kernel "cycles"/);
  assert.throws(() => buildNativeTexelInput(scene, { texelCount: 4, samples: 4, bounces: 2, seed: 1 }, pack), /cannot carry/);
});

test('a job on the legacy kernel refuses part visibility', () => {
  const parts = [uniquePart('wall', 0), uniquePart('pane', 2, { castShadow: false })];
  assert.throws(
    () => exportNativeSceneTables({ parts, environment, camera, options, kernel: 'legacy', instancing: false, modules }),
    /only the "cycles" kernel with FORMAT-v2 tables can carry/,
  );
});

// The sun is a delta light: only a shadow ray can reach it, so a glass pane over the floor leaves the floor dark until the pane stops blocking shadow rays.
const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;
const SIZE = 16;
const sunEnvironment = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
const topDownCamera = createCamera({ eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 }, SIZE, SIZE);
const clearGlass = { tag: 'surface', color: [1, 1, 1], roughness: 0, metallic: 0, transmission: 1, ior: 1.5 };

function scaled(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function paneOverFloor(paneExtra, geometryFor) {
  return [
    { name: 'floor', geometry: geometryFor('floor'), matrix: scaled([0, -0.05, 0], [20, 0.1, 20]), material: surface },
    { name: 'pane', geometry: geometryFor('pane'), matrix: scaled([0, 1.5, 0], [6, 0.004, 6]), material: clearGlass, ...paneExtra },
  ];
}

function floorBrightness(parts, instancing) {
  const scene = buildTraceScene(parts, sunEnvironment, { instancing });
  assert.equal(Boolean(scene.instances), instancing, 'the scene has the shape under test');
  const tracedOptions = { width: SIZE, height: SIZE, samples: 64, bounces: 4, seed: 3, noiseThreshold: 0 };
  const input = instancing
    ? buildJobNativeInput(scene, topDownCamera, tracedOptions, pack, resolveTexture)
    : buildFlattenedJobNativeInput(scene, topDownCamera, tracedOptions, pack, resolveTexture);
  const rgba = traceNative(input, { width: SIZE, height: SIZE, samples: 64, kernel: 'cycles' }).rgba;
  let sum = 0;
  for (let pixel = 0; pixel < SIZE * SIZE; pixel++) sum += rgba[pixel * 4] + rgba[pixel * 4 + 1] + rgba[pixel * 4 + 2];
  return sum / (SIZE * SIZE);
}

for (const [shape, instancing, geometryFor] of [
  ['flattened', false, () => box(0, 1)],
  ['instanced', true, () => sharedBox],
]) {
  test(`the native cycles kernel lights the floor through a ${shape} pane with castShadow false`, { skip: skipWithoutAddon }, () => {
    const blocked = floorBrightness(paneOverFloor({}, geometryFor), instancing);
    const lit = floorBrightness(paneOverFloor({ castShadow: false }, geometryFor), instancing);
    const viaRayVisibility = floorBrightness(paneOverFloor({ rayVisibility: { shadow: false } }, geometryFor), instancing);
    // Measured on the native kernel: the mean of the pane-over-floor picture is 5.59 blocked and 9.30 with the pane out of the shadow rays' way.
    assert.ok(lit > blocked * 1.3, `shadow rays that pass the pane reach the sun: ${lit} against ${blocked}`);
    assert.ok(Math.abs(viaRayVisibility - lit) < lit * 0.01, `castShadow false and rayVisibility.shadow false are the same setting: ${viaRayVisibility} against ${lit}`);
  });
}
