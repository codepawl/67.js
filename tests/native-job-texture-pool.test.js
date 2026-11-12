import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { STRUCT_STRIDES_V2 } from '../packages/render-native/index.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput, carriedMaterialFieldsOfScene } from '../packages/render-native/job-input.mjs';
import { buildNativeInput, packNativeMaterialTables } from '../packages/render-native/pack-input.mjs';
import { TEXTURE_POOL_MAX_BYTES, TexturePoolFullError, buildNativeInputV2, reduceV1MaterialTable } from '../packages/render-native/pack-input-v2.mjs';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const WIDTH = 24;
const HEIGHT = 16;
const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 16, bounces: 4, seed: 7, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] };

function quad(scale) {
  return {
    positions: Float32Array.from([-scale, -scale, 0, scale, -scale, 0, scale, scale, 0, -scale, scale, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

const translate = x => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

function pattern(width, height, seedByte) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let texel = 0; texel < width * height; texel++) {
    data.set([(texel * 37 + seedByte) % 256, (texel * 91) % 256, (texel * 13 + seedByte * 3) % 256, 255 - (texel % 4) * 40], texel * 4);
  }
  return { image: { width, height, data }, colorSpace: 'srgb' };
}

function texturedParts() {
  const shared = quad(1);
  return [
    { name: 'copy-a', geometry: shared, matrix: translate(-2), material: { color: [0.8, 0.2, 0.2], roughness: 0.5, map: pattern(8, 8, 9), normalMap: pattern(4, 4, 2) } },
    { name: 'copy-b', geometry: shared, matrix: translate(2), material: { color: [0.2, 0.2, 0.8], metallicRoughnessMap: pattern(6, 2, 3), emission: 2, emissiveMap: pattern(2, 2, 4) } },
    { name: 'leaf', geometry: quad(0.8), matrix: translate(0), material: { color: [1, 1, 1], map: pattern(4, 4, 5), alphaMode: 'mask', alphaCutoff: 0.4 } },
  ];
}

function hashOfTable(table) {
  return createHash('sha256').update(Buffer.from(table.buffer, table.byteOffset, table.byteLength)).digest('hex');
}

// Every packed table of the input, by name.
function hashesOfPackedTables(input) {
  const tableNames = Object.keys(input).filter(name => ArrayBuffer.isView(input[name])).sort();
  assert.ok(tableNames.length >= 10);
  return Object.fromEntries(tableNames.map(name => [name, hashOfTable(input[name])]));
}

// SHA-256 of every packed table of the two scenes, taken on the unmodified code of origin/main at the branch base (55efd532),
// where every map still went through the v1 atlas: stash the change, run this file with PRINT_POOL_HASHES=1, copy the printed hashes.
const GOLDEN_INSTANCED_HASHES = {
  emissiveTriangles: '2e38284e3690d5a05476c1c3068ea5e3b87e9667c3417183f287d60b1c5834b9',
  environmentTexels: '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb',
  instances: 'a196ea995083d3efc659bedb4a91ecffb87a008462be5532196dbb3cc20d94ac',
  kernelParams: '0a786f473a472a962889ba8cc747f2bdf43d73eecef1d8c1e31df0ba9a716d85',
  lightToTree: '363f012b74b9c88d828c809a568dc50627214866415aeb36ef6effbc3061741f',
  lightTreeEmitters: '6d3621e3ca86542383ba5f3f8990f1b21aa214e30cef3bca52693d1a0e05a3a8',
  lightTreeNodes: 'df3874b6cd51492d661ee5e9b3821d45275729a0cc583f1b51362158bb6f7156',
  lights: '5b7b79a262b416ac80244a7134d249c40df90df2a296cf9e17f4a5639a5c8ee8',
  materials: 'b27b23b445b1a0ba1dcbc84d8d5c14a42a67aa5025d43428abe77cb889709f83',
  textureDescriptors: 'e755bedfb56672eae156d9456473ab7fda65a6988cb270710a348c3a11dfc11a',
  textureTexels: 'd9b9eb4847af896ad84f6c2135359c7c4d037bf4a7e062e53a782710414a7a16',
  triangles: '2d22067f2b24404afca1bbaf2b9bc093876194114bdb568c9d10afa40de9be4f',
};
const GOLDEN_FLATTENED_HASHES = {
  emissiveTriangles: '2f834ad7899f3eaf0e5dcd2879c8477e1536cfed5ef945aa2b44c6ce61079001',
  environmentTexels: '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb',
  instances: '3df2d7e9401c8d2496e079d72c063298e79bf509bf3d0a6dd48e349d6ee58186',
  kernelParams: '40b03e08a41099a7cd7c75f3abb16163de889cd6f1ef747337ee2bd1c2f9ca1b',
  lightToTree: '363f012b74b9c88d828c809a568dc50627214866415aeb36ef6effbc3061741f',
  lightTreeEmitters: '07b5da35edf058375e8651d377e64187d81c65b885f2f587f455c9b19ceb128f',
  lightTreeNodes: 'ed8ee54927b117ebebb291c33752b0f94ee091db758c14049ebf05cea17f8ad5',
  lights: 'cacd8feeb79d5493f0f783d3f68baa5df766800397331160b0bc6c371384d5d6',
  materials: 'b27b23b445b1a0ba1dcbc84d8d5c14a42a67aa5025d43428abe77cb889709f83',
  textureDescriptors: 'e755bedfb56672eae156d9456473ab7fda65a6988cb270710a348c3a11dfc11a',
  textureTexels: 'd9b9eb4847af896ad84f6c2135359c7c4d037bf4a7e062e53a782710414a7a16',
  triangles: '96c8ea48ddace72c91112c5b773822350ad6e97fc59755853db57362e7f3fc59',
};

test('a textured instanced job packs the tables it packed through the v1 atlas', () => {
  const scene = buildTraceScene(texturedParts(), environment, { instancing: true });
  assert.ok(scene.instances);
  const hashes = hashesOfPackedTables(buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture));
  if (process.env.PRINT_POOL_HASHES) console.log('INSTANCED', JSON.stringify(hashes));
  assert.deepEqual(hashes, GOLDEN_INSTANCED_HASHES);
});

test('a textured flattened job packs the tables it packed through the v1 atlas', () => {
  const scene = buildTraceScene(texturedParts(), environment);
  const hashes = hashesOfPackedTables(buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture));
  if (process.env.PRINT_POOL_HASHES) console.log('FLATTENED', JSON.stringify(hashes));
  assert.deepEqual(hashes, GOLDEN_FLATTENED_HASHES);
});

// The maps are distinct arrays (the packers tell maps apart by their array) over one buffer, so a test holds one copy of the pixels.
function manyMapParts(mapCount, mapSize) {
  const shared = quad(1);
  const pixels = pattern(mapSize, mapSize, 1).image.data;
  return Array.from({ length: mapCount }, (_, index) => ({
    name: `part-${index}`,
    geometry: index < 2 ? shared : quad(1 + index / 100),
    matrix: translate(index),
    material: { color: [1, 1, 1], map: { image: { width: mapSize, height: mapSize, data: new Uint8ClampedArray(pixels.buffer, 0, pixels.length) }, colorSpace: 'srgb' } },
  }));
}

const OVER_ATLAS_MAP_COUNT = 70;
const OVER_ATLAS_MAP_SIZE = 1024;

test('v1 atlas alone rejects the maps the v2 pool takes', () => {
  const parts = manyMapParts(OVER_ATLAS_MAP_COUNT, OVER_ATLAS_MAP_SIZE);
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.throws(() => pack.packAtlas(scene.traceMaterials), /do not fit the GPU atlas/);
});

test('an instanced job with maps beyond the v1 atlas packs them into the texture pool', () => {
  const parts = manyMapParts(OVER_ATLAS_MAP_COUNT, OVER_ATLAS_MAP_SIZE);
  const scene = buildTraceScene(parts, environment, { instancing: true });
  const input = buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  const mapBytes = OVER_ATLAS_MAP_COUNT * OVER_ATLAS_MAP_SIZE * OVER_ATLAS_MAP_SIZE * 4;
  assert.ok(input.textureTexels.byteLength >= mapBytes);
  assert.ok(input.textureTexels.byteLength <= TEXTURE_POOL_MAX_BYTES);
  assert.equal(input.textureDescriptors.byteLength / STRUCT_STRIDES_V2.textureDescriptor, OVER_ATLAS_MAP_COUNT);
});

test('a flattened job with maps beyond the v1 atlas packs them into the texture pool', () => {
  const parts = manyMapParts(OVER_ATLAS_MAP_COUNT, OVER_ATLAS_MAP_SIZE);
  const scene = buildTraceScene(parts, environment);
  const input = buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
  assert.ok(input.textureTexels.byteLength >= OVER_ATLAS_MAP_COUNT * OVER_ATLAS_MAP_SIZE * OVER_ATLAS_MAP_SIZE * 4);
});

const POOL_MESSAGE = /texture pool is full[\s\S]*Pass smaller textures/;

// One map a row taller than the 1 GiB pool. Its data is 4 bytes: the pool check runs before the data is read or a word is allocated.
function oversizeMapParts(shared) {
  const side = 16384;
  const oversize = { image: { width: side, height: side + 1, data: new Uint8ClampedArray(4) }, colorSpace: 'srgb' };
  return [
    { name: 'copy-a', geometry: shared, matrix: translate(0), material: { color: [1, 1, 1], map: oversize } },
    { name: 'copy-b', geometry: shared, matrix: translate(2), material: { color: [1, 1, 1] } },
  ];
}

function assertPoolRefusal(callback) {
  assert.throws(callback, error => error instanceof TexturePoolFullError && error instanceof RangeError && error.texturePoolFull === true && POOL_MESSAGE.test(error.message));
}

test('an instanced job whose map exceeds the texture pool says what to pass instead', () => {
  const scene = buildTraceScene(oversizeMapParts(quad(1)), environment, { instancing: true });
  assertPoolRefusal(() => buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture));
});

test('a flattened job whose map exceeds the texture pool says what to pass instead', () => {
  const scene = buildTraceScene(oversizeMapParts(quad(1)), environment);
  assertPoolRefusal(() => buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture));
});

// The maps share one small buffer through distinct views, and `texturePoolMaxBytes` lowers the pool to 6 MiB: each 1024 x 1024
// map (4 MiB) fits alone and the second one passes the pool. That option is the seam that keeps these tests from allocating a gigabyte.
const SMALL_POOL_OPTIONS = { ...packOptions, texturePoolMaxBytes: 6 * 1024 * 1024 };

test('maps that each fit the pool but not together are refused by both job builders', () => {
  const parts = manyMapParts(3, 1024);
  assertPoolRefusal(() => buildJobNativeInput(buildTraceScene(parts, environment, { instancing: true }), camera, SMALL_POOL_OPTIONS, pack, resolveTexture));
  assertPoolRefusal(() => buildFlattenedJobNativeInput(buildTraceScene(parts, environment), camera, SMALL_POOL_OPTIONS, pack, resolveTexture));
  const single = buildFlattenedJobNativeInput(buildTraceScene(manyMapParts(1, 1024), environment), camera, SMALL_POOL_OPTIONS, pack, resolveTexture);
  assert.equal(single.textureCount, 1);
});

test('the pool limit can be lowered and never raised', () => {
  const scene = buildTraceScene(manyMapParts(1, 8), environment);
  for (const bad of [0, 1.5, TEXTURE_POOL_MAX_BYTES + 1, '4096']) {
    assert.throws(() => buildFlattenedJobNativeInput(scene, camera, { ...packOptions, texturePoolMaxBytes: bad }, pack, resolveTexture), /texturePoolMaxBytes/);
  }
});

test('a map whose data is shorter than its size is refused with both sizes', () => {
  const short = { image: { width: 8, height: 8, data: new Uint8ClampedArray(100) }, colorSpace: 'srgb' };
  const shared = quad(1);
  const parts = [
    { name: 'a', geometry: shared, matrix: translate(0), material: { color: [1, 1, 1], map: short } },
    { name: 'b', geometry: shared, matrix: translate(2), material: { color: [1, 1, 1] } },
  ];
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.throws(() => buildJobNativeInput(scene, camera, packOptions, pack, resolveTexture), /8x8 material texture needs 256 bytes[\s\S]*holds 100/);
});

test('with mip levels the virtual pack equals the pack through the real v1 atlas, byte for byte', () => {
  const scene = buildTraceScene(texturedParts(), environment, { instancing: true });
  const options = { ...packOptions, textureMips: true };
  const tables = packNativeMaterialTables(scene.traceMaterials, null, pack);
  const reducedMaterials = reduceV1MaterialTable({
    materials: tables.materials,
    atlas: tables.atlas,
    atlasWidth: tables.atlasWidth,
    subsurfaceVec4Offset: tables.subsurfaceVec4Offset,
    materialCount: scene.traceMaterials.length,
    carriedFields: carriedMaterialFieldsOfScene(scene, resolveTexture),
    textureMips: true,
  });
  const instances = scene.instances.map(instance => {
    const lightMask = reducedMaterials.materialLightMasks[instance.materialIndex] ?? 0xffffffff;
    return { ...instance, lightMask, lightMaskHi: lightMask === 0xffffffff ? 0xffffffff : 0 };
  });
  const { fireflyClamp, ...withoutClamp } = options;
  const throughAtlas = buildNativeInputV2(scene, camera, { ...withoutClamp, instances, reducedMaterials });
  const virtual = buildJobNativeInput(scene, camera, options, pack, resolveTexture);
  assert.deepEqual(hashesOfPackedTables(virtual), hashesOfPackedTables(throughAtlas));
  const firstDescriptor = new Uint32Array(virtual.textureDescriptors.buffer, virtual.textureDescriptors.byteOffset, 8);
  assert.ok(((firstDescriptor[3] >>> 8) & 0xff) > 1, 'the scene stores mip levels');
});

function exportModules(overrides = {}) {
  return {
    buildTraceScene,
    refuseLocalVolumes: () => {},
    resolveTexture,
    buildNativeInput: (scene, view, options, tables) => buildNativeInput(scene, view, options, tables),
    buildJobNativeInput,
    buildFlattenedJobNativeInput,
    pack,
    ...overrides,
  };
}

function exportParts(parts, options, modules = exportModules(), instancing = true) {
  return exportNativeSceneTables({ parts, environment, camera, options, kernel: 'cycles', instancing, modules });
}

test('the page export of an instanced scene over the pool shows the pool message, not the atlas one', () => {
  const parts = manyMapParts(3, 1024);
  assert.throws(() => exportParts(parts, SMALL_POOL_OPTIONS), error => POOL_MESSAGE.test(error.message) && !/GPU atlas/.test(error.message));
});

test('the page export of a flattened scene over the pool shows the pool message, not the atlas one', () => {
  const parts = manyMapParts(3, 1024).map((part, index) => ({ ...part, geometry: quad(1 + index / 10) }));
  assert.throws(() => exportParts(parts, SMALL_POOL_OPTIONS), error => POOL_MESSAGE.test(error.message) && !/GPU atlas/.test(error.message));
});

test('the page export keeps the first reason when the v1 fallback fails on the atlas too', () => {
  const parts = manyMapParts(OVER_ATLAS_MAP_COUNT, OVER_ATLAS_MAP_SIZE);
  const modules = exportModules({ buildFlattenedJobNativeInput: () => { throw new RangeError('the records do not fit'); } });
  assert.throws(() => exportParts(parts, packOptions, modules, false), /GPU atlas[\s\S]*already failed: the records do not fit/);
});
