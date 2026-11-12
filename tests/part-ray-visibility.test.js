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

test('a part maps rayVisibility and shadowOnly to visibility bits', () => {
  assert.equal(partRayVisibilityFlags({}), ALL_RAY_KINDS);
  assert.equal(partRayVisibilityFlags({ rayVisibility: {} }), ALL_RAY_KINDS);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { shadow: true, camera: true } }), ALL_RAY_KINDS);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { shadow: false } }), SHADOW_OFF);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { camera: false, glossy: false } }), ALL_RAY_KINDS & ~1 & ~4);
  assert.equal(partRayVisibilityFlags({ rayVisibility: { diffuse: false, transmission: false, volumeScatter: false } }), 1 | 4 | 16);
  assert.equal(partRayVisibilityFlags({ shadowOnly: true }), 62);
  assert.equal(partRayVisibilityFlags({ shadowOnly: true, rayVisibility: { glossy: false } }), 62 & ~4);
});

test('castShadow never reaches the ray visibility, because library code sets it as a raster default', () => {
  assert.equal(partRayVisibilityFlags({ castShadow: false }), ALL_RAY_KINDS);
  const castingOff = [uniquePart('a', 0, { castShadow: false }), uniquePart('b', 2, { castShadow: false, shadowOnly: true })];
  assert.equal(buildTraceScene(castingOff, environment).partRayVisibility, null);
  const instanced = buildTraceScene([sharedPart('a', 0, { castShadow: false }), sharedPart('b', 2)], environment, { instancing: true });
  assert.equal(instanced.instances.some(instance => 'visibilityFlags' in instance), false);
  const plainFlattened = [uniquePart('a', 0), uniquePart('b', 2, { shadowOnly: true })];
  assert.equal(digestOfTables(exportedVisibility(castingOff, false).exported), digestOfTables(exportedVisibility(plainFlattened, false).exported));
  const plainShared = [sharedPart('a', 0), sharedPart('b', 2)];
  const castingOffShared = plainShared.map(part => ({ ...part, castShadow: false }));
  assert.equal(digestOfTables(exportedVisibility(castingOffShared, true).exported), digestOfTables(exportedVisibility(plainShared, true).exported));
});

test('a bad rayVisibility says what to pass', () => {
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: 'shadow' }), /part "pane" rayVisibility must be an object such as \{ shadow: false \}/);
  assert.throws(() => partRayVisibilityFlags({ rayVisibility: [] }), /part 0 rayVisibility must be an object/);
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: { refraction: false } }), /unknown ray kind "refraction": use camera, diffuse, glossy, transmission, shadow, volumeScatter/);
  assert.throws(() => partRayVisibilityFlags({ name: 'pane', rayVisibility: { shadow: 0 } }), /rayVisibility\.shadow must be true or false, got 0/);
  assert.throws(() => partRayVisibilityFlags({ name: 'ghost', shadowOnly: true, rayVisibility: { shadow: false } }), /shadowOnly with rayVisibility\.shadow: false/);
});

test('an emitter may hide from camera, shadow and volume rays but not from bounce rays, which would drop part of its light', () => {
  const lamp = { tag: 'surface', color: [1, 0.8, 0.6], emission: 4, roughness: 1 };
  assert.equal(partRayVisibilityFlags({ material: lamp, rayVisibility: { camera: false } }), ALL_RAY_KINDS & ~1);
  assert.equal(partRayVisibilityFlags({ material: lamp, rayVisibility: { shadow: false, volumeScatter: false } }), ALL_RAY_KINDS & ~16 & ~32);
  for (const kind of ['diffuse', 'glossy', 'transmission']) {
    assert.throws(() => partRayVisibilityFlags({ name: 'lamp', material: lamp, rayVisibility: { [kind]: false } }), /part "lamp" emits light and sets rayVisibility\.diffuse, glossy or transmission to false/);
  }
  assert.equal(partRayVisibilityFlags({ material: surface, rayVisibility: { diffuse: false } }), ALL_RAY_KINDS & ~2, 'a part that does not emit may hide from bounce rays');
  const parts = [uniquePart('wall', 0), uniquePart('lamp', 2, { material: lamp, rayVisibility: { glossy: false } })];
  assert.throws(() => buildTraceScene(parts, environment), /part "lamp" emits light/);
  assert.throws(() => buildTraceScene(parts.map(part => ({ ...part, geometry: sharedBox })), environment, { instancing: true }), /part "lamp" emits light/);
});

test('buildTraceScene refuses a bad rayVisibility on both scene shapes', () => {
  const flattened = [uniquePart('a', 0, { rayVisibility: { shadow: 'no' } }), uniquePart('b', 2)];
  assert.throws(() => buildTraceScene(flattened, environment), /part "a" rayVisibility\.shadow must be true or false/);
  const instanced = [sharedPart('a', 0, { rayVisibility: { bogus: false } }), sharedPart('b', 2)];
  assert.throws(() => buildTraceScene(instanced, environment, { instancing: true }), /unknown ray kind "bogus"/);
});

test('an instanced scene carries visibility only on the parts that hide from a ray kind', () => {
  const parts = [
    sharedPart('plain', 0),
    sharedPart('pane', 2, { rayVisibility: { shadow: false } }),
    sharedPart('glow', 4, { rayVisibility: { camera: false, shadow: false } }),
    sharedPart('empty', 6, { rayVisibility: {} }),
  ];
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.equal('visibilityFlags' in scene.instances[0], false, 'a default part adds no field');
  assert.equal(scene.instances[1].visibilityFlags, SHADOW_OFF);
  assert.equal(scene.instances[2].visibilityFlags, ALL_RAY_KINDS & ~1 & ~16);
  assert.equal('visibilityFlags' in scene.instances[3], false, 'an empty rayVisibility is the default');
});

test('a flattened scene carries one visibility byte per part, or none when no part hides from a ray kind', () => {
  assert.equal(buildTraceScene([uniquePart('a', 0), uniquePart('b', 2, { shadowOnly: true })], environment).partRayVisibility, null);
  const hidingNothing = [uniquePart('a', 0, { rayVisibility: {} }), uniquePart('b', 2, { rayVisibility: { shadow: true, camera: true } })];
  assert.equal(buildTraceScene(hidingNothing, environment).partRayVisibility, null);
  const hiding = [uniquePart('a', 0), uniquePart('b', 2, { rayVisibility: { shadow: false } }), uniquePart('c', 4, { shadowOnly: true, rayVisibility: { glossy: false } })];
  assert.deepEqual([...buildTraceScene(hiding, environment).partRayVisibility], [ALL_RAY_KINDS, SHADOW_OFF, 62 & ~4]);
});

test('a native render job packs the visibility of an instanced scene into the instance table', () => {
  const parts = [sharedPart('wall', 0), sharedPart('pane', 2, { rayVisibility: { shadow: false } }), sharedPart('wall2', 4)];
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

test('scenes whose rayVisibility hides nothing export the same tables as scenes without it', () => {
  const plain = [uniquePart('wall', 0), uniquePart('lamp', 4, { shadowOnly: true })];
  const withDefaults = [uniquePart('wall', 0, { rayVisibility: {} }), uniquePart('lamp', 4, { shadowOnly: true, rayVisibility: { shadow: true } })];
  assert.equal(digestOfTables(exportedVisibility(withDefaults, false).exported), digestOfTables(exportedVisibility(plain, false).exported));
  const sharedPlain = [sharedPart('a', 0), sharedPart('b', 2, { shadowOnly: true })];
  const sharedDefaults = [sharedPart('a', 0, { rayVisibility: {} }), sharedPart('b', 2, { shadowOnly: true, rayVisibility: { camera: true } })];
  assert.equal(digestOfTables(exportedVisibility(sharedDefaults, true).exported), digestOfTables(exportedVisibility(sharedPlain, true).exported));
});

function withoutRayVisibility(parts) {
  return parts.map(({ rayVisibility, ...part }) => part);
}

test('the v1 tables of the legacy kernel refuse a hidden ray kind, and a light bake leaves it out', () => {
  const hiding = [uniquePart('wall', 0), uniquePart('pane', 2, { rayVisibility: { shadow: false } })];
  const scene = buildTraceScene(hiding, environment);
  assert.throws(() => buildNativeInput(scene, camera, options, pack), /v1 tables of kernel "legacy" cannot carry.*kernel "cycles"/);
  const bakeOptions = { texelCount: 4, samples: 4, bounces: 2, seed: 1 };
  const plainScene = buildTraceScene(withoutRayVisibility(hiding), environment);
  assert.deepEqual(buildNativeTexelInput(scene, bakeOptions, pack), buildNativeTexelInput(plainScene, bakeOptions, pack));
});

test('a job on the legacy kernel refuses a hidden ray kind', () => {
  const parts = [uniquePart('wall', 0), uniquePart('pane', 2, { rayVisibility: { shadow: false } })];
  assert.throws(
    () => exportNativeSceneTables({ parts, environment, camera, options, kernel: 'legacy', instancing: false, modules }),
    /only the "cycles" kernel can carry/,
  );
});

test('the v1 fallback of a cycles job draws without the visibility and reports why', () => {
  const parts = [uniquePart('wall', 0), uniquePart('pane', 2, { rayVisibility: { shadow: false } })];
  const failingModules = { ...modules, buildFlattenedJobNativeInput: () => { throw new Error('forced material failure'); } };
  const exported = exportNativeSceneTables({ parts, environment, camera, options, kernel: 'cycles', instancing: false, modules: failingModules });
  assert.equal(exported.wholeMaterials, false);
  assert.equal(exported.materialsReason, 'forced material failure');
  assert.equal(exported.rayVisibility, 'ignored');
  assert.equal(exported.rayVisibilityReason, 'forced material failure');
  const withoutSetting = exportNativeSceneTables({ parts: withoutRayVisibility(parts), environment, camera, options, kernel: 'cycles', instancing: false, modules: failingModules });
  assert.deepEqual(exported.tables, withoutSetting.tables);
});

// The sun is a delta light: only a shadow ray can reach it. Measured on the native kernel, the mean of the top-down picture
// is about 5.6 with the clear pane blocking shadow rays (the floor is dimmer, not black) and about 9.3 once it does not.
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
  test(`the native cycles kernel lights the floor through a ${shape} pane with rayVisibility shadow false`, { skip: skipWithoutAddon }, () => {
    const blocked = floorBrightness(paneOverFloor({}, geometryFor), instancing);
    const lit = floorBrightness(paneOverFloor({ rayVisibility: { shadow: false } }, geometryFor), instancing);
    assert.ok(lit > blocked * 1.3, `shadow rays that pass the pane reach the sun: ${lit} against ${blocked}`);
    assert.ok(lit - blocked > 2, `the sun reaches the floor through the pane: ${lit} less ${blocked}`);
  });
}
