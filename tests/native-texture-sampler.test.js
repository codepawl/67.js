import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCT_STRIDES_V2, buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { TEXTURE_POOL_MAX_BYTES } from '../packages/render-native/pack-input-v2.mjs';
import { createCamera } from '../src/path-tracer.js';

const QUAD_UVS = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);

function quadGeometry(z = 0) {
  return {
    positions: new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: QUAD_UVS,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function solidImage(width, height, byteValue) {
  return { width, height, data: new Uint8Array(width * height * 4).fill(byteValue) };
}

function packWithMaps(maps, extraMaterial = {}) {
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 40 }, 8, 8);
  return buildNativeInputV2(
    {
      materials: maps.map((map) => ({ color: [1, 1, 1], ...extraMaterial, map })),
      instances: maps.map((_, index) => ({ geometry: quadGeometry(index), materialIndex: index })),
      lights: {},
    },
    camera,
    { width: 8, height: 8, samples: 1 },
  );
}

function readDescriptorWord(input, textureIndex, wordIndex) {
  const stride = STRUCT_STRIDES_V2.textureDescriptor;
  const view = new Uint32Array(input.textureDescriptors.buffer, input.textureDescriptors.byteOffset + textureIndex * stride, stride / 4);
  return view[wordIndex];
}

test('a texture past the pool budget fails at packing with the size, the limit and what to pass', () => {
  const oversize = { width: 16384, height: 32768, data: new Uint8Array(4) };
  assert.throws(
    () => packWithMaps([{ image: oversize, colorSpace: 'srgb' }]),
    (error) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /texture pool is full/);
      assert.match(error.message, /16384x32768 texture needs 2048 MiB/);
      assert.match(error.message, /at most 1024 MiB/);
      assert.match(error.message, /Pass smaller textures/);
      return true;
    },
  );
  assert.equal(TEXTURE_POOL_MAX_BYTES, 1 << 30);
});

test('the pool holds each texture once, in order, and descriptors point at their own words', () => {
  const first = solidImage(4, 4, 10);
  const second = solidImage(8, 2, 200);
  const input = packWithMaps([{ image: first }, { image: second }]);
  assert.equal(input.textureCount, 2);
  assert.equal(readDescriptorWord(input, 0, 0), 0);
  assert.equal(readDescriptorWord(input, 1, 0), 16);
  assert.equal(input.textureTexels[0], 0x0a0a0a0a);
  assert.equal(input.textureTexels[16], 0xc8c8c8c8);
  assert.equal(input.textureTexels.length, 16 + 16);
});

test('two uv transforms of one image stay two descriptors (the dedupe key carries uvScale and uvOffset)', () => {
  const image = solidImage(4, 4, 90);
  const same = packWithMaps([{ image }, { image }]);
  assert.equal(same.textureCount, 1);
  const scaled = packWithMaps([{ image }, { image, uvScale: [2, 2] }]);
  assert.equal(scaled.textureCount, 2);
  const shifted = packWithMaps([{ image }, { image, uvOffset: [0.25, 0] }]);
  assert.equal(shifted.textureCount, 2);
});

function opaqueLeftAndRightOfAMirroredMask() {
  // Two texels wide: the left one opaque, the right one clear. Mirrored over u in [0, 2] the quad shows
  // opaque, clear, clear, opaque, so the cutout must be symmetric about the middle of the quad.
  const data = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0]);
  return { width: 2, height: 1, data };
}

function renderMirroredCutout(filter) {
  const width = 32;
  const height = 8;
  const camera = createCamera({ eye: [0, 0, 2.2], target: [0, 0, 0], fov: 30 }, width, height);
  const mirroredMap = {
    image: opaqueLeftAndRightOfAMirroredMask(),
    colorSpace: 'linear',
    wrapU: 2,
    wrapV: 1,
    uvScale: [2, 1],
    ...filter,
  };
  const input = buildNativeInputV2(
    {
      materials: [
        { color: [0.1, 0.9, 0.1], alphaMode: 'mask', alphaCutoff: 0.5, map: mirroredMap },
        { color: [0.9, 0.1, 0.1] },
      ],
      instances: [
        { geometry: quadGeometry(0), matrix: [1.6, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
        { geometry: quadGeometry(0), matrix: [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1], materialIndex: 1 },
      ],
      lights: { points: [{ position: [0, 0, 3], color: [1, 1, 1], intensity: 4, radius: 0.1 }] },
    },
    camera,
    { width, height, samples: 4 },
  );
  const result = traceNative(input, { width, height, samples: 4, kernel: 'cycles' });
  const row = Math.floor(height / 2);
  return Array.from({ length: width }, (_, column) => result.albedo[(row * width + column) * 3 + 1] > 0.5);
}

for (const [label, filter] of [['nearest', { nearest: true }], ['bilinear', {}]]) {
  test(`a mirrored alpha cutout is symmetric about its fold (${label}), as its shading is`, { skip: !findNativeAddon() }, () => {
    const showsForeground = renderMirroredCutout(filter);
    const covered = showsForeground.filter(Boolean).length;
    assert.ok(covered > 0 && covered < showsForeground.length, 'the quad is partly opaque and partly clear');
    const mismatches = showsForeground.filter((value, column) => value !== showsForeground[showsForeground.length - 1 - column]);
    assert.ok(mismatches.length <= 2, `columns that differ from their mirror: ${mismatches.length}`);
  });
}

test('a pool of many small textures packs, uploads and renders', { skip: !findNativeAddon() }, () => {
  const maps = Array.from({ length: 64 }, (_, index) => ({ image: solidImage(8, 8, 3 * index + 1), colorSpace: 'srgb' }));
  const input = packWithMaps(maps);
  assert.equal(input.textureCount, 64);
  const result = traceNative(input, { width: 8, height: 8, samples: 1, kernel: 'cycles' });
  assert.ok(result.rgba.every(Number.isFinite));
});

const ALPHA_TEX_WORD = 62;
const BASE_COLOR_TEX_WORD = 52;

function readMaterialWord(input, materialIndex, wordIndex) {
  const stride = STRUCT_STRIDES_V2.material;
  const view = new Int32Array(input.materials.buffer, input.materials.byteOffset + materialIndex * stride, stride / 4);
  return view[wordIndex];
}

test('a masked material reads its base map alpha through base_color_tex, not through alpha_tex (whose red channel it would multiply in)', () => {
  const image = solidImage(4, 4, 200);
  const camera = createCamera({ eye: [0, 0, 3], target: [0, 0, 0], fov: 40 }, 8, 8);
  const input = buildNativeInputV2(
    {
      materials: [
        { color: [1, 1, 1], alphaMode: 'mask', alphaCutoff: 0.5, map: { image, colorSpace: 'srgb' } },
        { color: [1, 1, 1], alphaMode: 'mask', alphaCutoff: 0.5, map: { image, colorSpace: 'srgb' }, alphaMap: { image: solidImage(2, 2, 90), colorSpace: 'linear' } },
      ],
      instances: [{ geometry: quadGeometry(0), materialIndex: 0 }, { geometry: quadGeometry(1), materialIndex: 1 }],
      lights: {},
    },
    camera,
    { width: 8, height: 8, samples: 1 },
  );
  assert.equal(readMaterialWord(input, 0, BASE_COLOR_TEX_WORD), 0);
  assert.equal(readMaterialWord(input, 0, ALPHA_TEX_WORD), -1);
  assert.equal(readMaterialWord(input, 1, ALPHA_TEX_WORD), 1, 'an explicit alpha map is still bound');
});
