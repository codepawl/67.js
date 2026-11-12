import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRUCT_STRIDES_V2,
  buildNativeInputV2,
  findNativeAddon,
  packMaterialRecordV2,
  planNativeSessionUpdate,
  traceNative,
} from '../packages/render-native/index.mjs';
import { INVALID_INDEX_V2, shareEqualMaterialRecords } from '../packages/render-native/pack-input-v2.mjs';
import { buildJobNativeInput } from '../packages/render-native/job-input.mjs';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const WIDTH = 32;
const HEIGHT = 24;
const camera = createCamera({ eye: [0, 3, 9], target: [0, 0.5, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 2, bounces: 3, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };

const MATERIAL_OFFSET_IN_INSTANCE = 112;
const MATERIAL_INDEX_OFFSET_IN_TRIANGLE = 12;
const MATERIAL_INDEX_OFFSET_IN_EMISSIVE = 60;
const MATERIAL_COUNT_OFFSET_IN_PARAMETERS = 92;

const quad = {
  positions: Float32Array.from([-0.6, 0, -0.6, 0.6, 0, -0.6, 0.6, 0, 0.6, -0.6, 0, 0.6]),
  normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
};

function placedPart(index, material, geometry = quad) {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 1.4, 0, 0, 1];
  return { name: `part-${index}`, geometry, matrix, material };
}

function jobInput(parts) {
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.ok(scene.instances, 'the parts share a geometry, so the scene is instanced');
  return buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
}

function wordAt(table, recordIndex, stride, byteOffset) {
  return new DataView(table.buffer, table.byteOffset).getUint32(recordIndex * stride + byteOffset, true);
}

function instanceOverride(input, instanceIndex) {
  return wordAt(input.instances, instanceIndex, STRUCT_STRIDES_V2.instance, MATERIAL_OFFSET_IN_INSTANCE);
}

function recordHex(input, recordIndex) {
  const start = input.materials.byteOffset + recordIndex * STRUCT_STRIDES_V2.material;
  return Buffer.from(input.materials.buffer, start, STRUCT_STRIDES_V2.material).toString('hex');
}

test('records with equal bytes share one record, in the order of their first part', () => {
  const grey = () => packMaterialRecordV2({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const red = () => packMaterialRecordV2({ color: [0.8, 0.1, 0.1], roughness: 0.7 });
  const { records, recordIndexOf } = shareEqualMaterialRecords([grey(), red(), grey(), red(), grey()]);
  assert.equal(records.length, 2);
  assert.deepEqual([0, 1, 2, 3, 4].map(recordIndexOf), [0, 1, 0, 1, 0]);
});

test('a scene without equal records keeps its table', () => {
  const materials = [0.1, 0.2, 0.3, 0.4].map(roughness => packMaterialRecordV2({ roughness }));
  const { records, recordIndexOf } = shareEqualMaterialRecords(materials);
  assert.equal(records.length, 4);
  assert.deepEqual([0, 1, 2, 3].map(recordIndexOf), [0, 1, 2, 3]);
});

test('any differing material field keeps its own record', () => {
  const base = { color: [0.6, 0.5, 0.4], roughness: 0.5 };
  const variations = {
    color: { color: [0.6, 0.5, 0.41] },
    metallic: { metallic: 0.5 },
    roughness: { roughness: 0.51 },
    ior: { ior: 1.45 },
    emission: { emission: 1 },
    emissionColor: { emission: 1, emissiveColor: [1, 0, 0] },
    transmission: { transmission: 0.2 },
    clearcoat: { clearcoat: 0.3 },
    alphaMode: { alphaMode: 'blend', opacity: 0.5 },
    sheen: { sheenColor: [1, 1, 1] },
    anisotropy: { anisotropy: 0.4 },
    subsurface: { subsurfaceWeight: 0.5 },
    doubleSided: { doubleSided: false },
    thinWalled: { thinWalled: true },
    absorption: { absorptionDistance: 2, absorptionColor: [0.5, 0.8, 0.6] },
    normalScale: { normalScale: 0.5 },
  };
  for (const [name, change] of Object.entries(variations)) {
    const { records } = shareEqualMaterialRecords([packMaterialRecordV2(base), packMaterialRecordV2({ ...base, ...change })]);
    assert.equal(records.length, 2, `a part that differs in ${name} shares nothing`);
  }
});

test('records that differ only in a texture slot stay apart, equal textures share', () => {
  const imageA = { image: { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) }, colorSpace: 'srgb' };
  const imageB = { image: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) }, colorSpace: 'srgb' };
  const parts = [{ map: imageA }, { map: imageA }, { map: imageB }, { metallicRoughnessMap: imageA }, {}].map(material => ({ color: [1, 1, 1], ...material }));
  const scene = buildTraceScene(parts.map((material, index) => placedPart(index, material)), environment, { instancing: true });
  const input = buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  assert.equal(input.materialCount, 4, 'two parts with the same image share, the others differ in the image or the slot');
});

test('copies of a mesh with equal materials share one record and need no override', () => {
  const copyCount = 12;
  const parts = Array.from({ length: copyCount }, (_, index) => placedPart(index, { color: [0.6, 0.6, 0.6], roughness: 0.7 }));
  const input = jobInput(parts);
  assert.equal(input.instanceCount, copyCount);
  assert.equal(input.materialCount, 1);
  for (let index = 0; index < copyCount; index++) {
    assert.equal(instanceOverride(input, index), INVALID_INDEX_V2, `copy ${index} reads the triangle's material`);
  }
  assert.equal(wordAt(input.triangles, 0, STRUCT_STRIDES_V2.triangle, MATERIAL_INDEX_OFFSET_IN_TRIANGLE), 0);
});

test('a copy with another material keeps an override to its own record', () => {
  const grey = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const red = () => ({ color: [0.8, 0.1, 0.1], roughness: 0.7 });
  const parts = [grey(), red(), grey(), red(), grey()].map((material, index) => placedPart(index, material));
  const input = jobInput(parts);
  assert.equal(input.materialCount, 2);
  assert.deepEqual([0, 1, 2, 3, 4].map(index => instanceOverride(input, index)), [INVALID_INDEX_V2, 1, INVALID_INDEX_V2, 1, INVALID_INDEX_V2]);
  assert.notEqual(recordHex(input, 0), recordHex(input, 1));
});

test('an explicit override and an override flag point at the shared record', () => {
  const grey = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const red = () => ({ color: [0.8, 0.1, 0.1], roughness: 0.7 });
  const scene = buildTraceScene([grey(), red(), grey(), red()].map((material, index) => placedPart(index, material)), environment, { instancing: true });
  const instances = scene.instances.map((instance, index) => {
    if (index === 0) return { ...instance, materialOverride: 3 };
    if (index === 2) return { ...instance, overrideMaterial: true };
    return instance;
  });
  const input = buildNativeInputV2(scene, camera, { ...packOptions, instances });
  assert.equal(input.materialCount, 2);
  assert.equal(instanceOverride(input, 0), 1, 'part 3 is red, whose record is 1');
  assert.equal(instanceOverride(input, 2), 0, 'part 2 is grey, whose record is 0');
});

test('a mesh with per-triangle materials names the shared records in its triangles', () => {
  const twoMaterialMesh = { ...quad, triangleMaterial: Uint32Array.from([0, 3]) };
  const grey = () => ({ color: [0.6, 0.6, 0.6] });
  const materials = [grey(), { color: [0.8, 0.1, 0.1] }, grey(), grey()];
  const scene = buildTraceScene([placedPart(0, grey()), placedPart(1, grey())], environment, { instancing: true });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const instances = [{ geometry: twoMaterialMesh, matrix: identity, materialIndex: 0 }];
  const input = buildNativeInputV2(scene, camera, { ...packOptions, instances, materials });
  assert.equal(input.materialCount, 2);
  assert.equal(input.triangleCount, 2);
  for (let triangle = 0; triangle < input.triangleCount; triangle++) {
    assert.equal(wordAt(input.triangles, triangle, STRUCT_STRIDES_V2.triangle, MATERIAL_INDEX_OFFSET_IN_TRIANGLE), 0, `triangle ${triangle} reads the grey record`);
  }
});

test('emissive copies share a record and their emissive entries name it', () => {
  const lamp = () => ({ color: [1, 0.8, 0.6], emission: 4 });
  const wall = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const parts = [lamp(), wall(), lamp(), wall(), lamp()].map((material, index) => placedPart(index, material));
  const input = jobInput(parts);
  assert.equal(input.materialCount, 2);
  assert.equal(input.emissiveTriangleCount, 6, 'three lamps of two triangles each');
  for (let entry = 0; entry < input.emissiveTriangleCount; entry++) {
    assert.equal(wordAt(input.emissiveTriangles, entry, STRUCT_STRIDES_V2.emissiveTriangle, MATERIAL_INDEX_OFFSET_IN_EMISSIVE), 0, 'every lamp entry reads the lamp record');
  }
});

test('a material update to one part leaves the parts that shared its record alone', () => {
  const grey = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const before = jobInput([grey(), grey(), grey(), { color: [0.8, 0.1, 0.1], roughness: 0.7 }].map((material, index) => placedPart(index, material)));
  assert.equal(before.materialCount, 2);

  const otherRedPart = jobInput([grey(), grey(), grey(), { color: [0.1, 0.1, 0.8], roughness: 0.7 }].map((material, index) => placedPart(index, material)));
  assert.deepEqual(Object.keys(planNativeSessionUpdate(before, otherRedPart)), ['materials'], 'a part with a record of its own updates in place');
  assert.equal(recordHex(otherRedPart, 0), recordHex(before, 0), 'the shared record is untouched');

  const sharedPartChanges = jobInput([grey(), { color: [0.9, 0.9, 0.2], roughness: 0.7 }, grey(), { color: [0.8, 0.1, 0.1], roughness: 0.7 }].map((material, index) => placedPart(index, material)));
  assert.throws(() => planNativeSessionUpdate(before, sharedPartChanges), { message: /`materialCount` changes from 2 to 3/ });
  assert.equal(sharedPartChanges.materialCount, 3);
  assert.equal(recordHex(sharedPartChanges, 0), recordHex(before, 0), 'the parts that stayed grey keep the grey record');
  assert.equal(instanceOverride(sharedPartChanges, 2), INVALID_INDEX_V2, 'the part that stayed grey still reads the shared record');
  assert.notEqual(instanceOverride(sharedPartChanges, 1), INVALID_INDEX_V2, 'the changed part reads a record of its own');
});

test('a material update that remaps parts to other records is refused, not applied', () => {
  const grey = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const red = () => ({ color: [0.8, 0.1, 0.1], roughness: 0.7 });
  const green = () => ({ color: [0.1, 0.8, 0.1], roughness: 0.7 });
  const build = materials => jobInput(materials.map((material, index) => placedPart(index, material)));
  const before = build([grey(), grey(), red()]);
  const swapped = build([grey(), red(), red()]);
  assert.equal(before.materialCount, swapped.materialCount);
  assert.ok(Object.keys(planNativeSessionUpdate(before, swapped)).includes('instances'), 'the instance overrides are replaced with the materials');
  const regrouped = build([grey(), green(), red()]);
  assert.throws(() => planNativeSessionUpdate(before, regrouped), { message: /`materialCount` changes from 2 to 3/ });
});

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

// Rebuilds the input the way it was packed before records were shared: every instance reads a copy of the record it resolves to,
// appended after the shared table through its override. A non-emissive scene sees the same materials by either layout.
function withUnsharedRecords(input) {
  const recordBytes = STRUCT_STRIDES_V2.material;
  const instanceBytes = STRUCT_STRIDES_V2.instance;
  const materials = new Uint8Array(recordBytes * (input.materialCount + input.instanceCount));
  materials.set(input.materials.subarray(0, input.materialCount * recordBytes), 0);
  const instances = Uint8Array.from(input.instances);
  const view = new DataView(instances.buffer);
  for (let index = 0; index < input.instanceCount; index++) {
    const override = instanceOverride(input, index);
    const resolved = override === INVALID_INDEX_V2 ? wordAt(input.triangles, 0, STRUCT_STRIDES_V2.triangle, MATERIAL_INDEX_OFFSET_IN_TRIANGLE) : override;
    const copyIndex = input.materialCount + index;
    materials.set(input.materials.subarray(resolved * recordBytes, (resolved + 1) * recordBytes), copyIndex * recordBytes);
    view.setUint32(index * instanceBytes + MATERIAL_OFFSET_IN_INSTANCE, copyIndex, true);
  }
  const materialCount = input.materialCount + input.instanceCount;
  const kernelParams = Uint8Array.from(input.kernelParams);
  new DataView(kernelParams.buffer).setUint32(MATERIAL_COUNT_OFFSET_IN_PARAMETERS, materialCount, true);
  return { ...input, instances, materials, materialCount, kernelParams };
}

test('shared records trace the picture of one record per part', { skip: addonSkip }, t => {
  const grey = () => ({ color: [0.6, 0.6, 0.6], roughness: 0.7 });
  const red = () => ({ color: [0.8, 0.1, 0.1], roughness: 0.7 });
  const parts = [grey(), red(), grey(), red(), grey(), red()].map((material, index) => placedPart(index, material));
  const shared = jobInput(parts);
  assert.equal(shared.materialCount, 2);
  const unshared = withUnsharedRecords(shared);
  const traceOptions = { width: WIDTH, height: HEIGHT, samples: 8, kernel: 'cycles' };
  let sharedPicture;
  let unsharedPicture;
  try {
    sharedPicture = traceNative(shared, traceOptions).rgba;
    unsharedPicture = traceNative(unshared, traceOptions).rgba;
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  assert.equal(Buffer.compare(Buffer.from(sharedPicture.buffer, sharedPicture.byteOffset, sharedPicture.byteLength), Buffer.from(unsharedPicture.buffer, unsharedPicture.byteOffset, unsharedPicture.byteLength)), 0);
});
