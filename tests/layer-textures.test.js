import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { LAYER_TEXTURE_SLOTS } from '../src/gltf-layers.js';
import { box } from '../src/geometry.js';
import { createFragmentShader } from '../src/shaders.js';
import '../src/material-layer-shaders.js';

// Node has no image decoder: decode the exporter's PNGs (unfiltered rows) so parseGltf sees real pixels.
globalThis.self = globalThis;
globalThis.createImageBitmap = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : 3;
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < channels; channel++) {
        data[(row * width + column) * 4 + channel] = raw[row * (width * channels + 1) + 1 + column * channels + channel];
      }
    }
  }
  return { width, height, data, close() {} };
};

const IMAGE_SIZE = 4;

function gradientImage(seed) {
  const data = new Uint8ClampedArray(IMAGE_SIZE * IMAGE_SIZE * 4);
  for (let texel = 0; texel < IMAGE_SIZE * IMAGE_SIZE; texel++) {
    data.set([(texel * 16 + seed) % 256, (texel * 7 + seed * 3) % 256, (seed * 29) % 256, 255], texel * 4);
  }
  return { width: IMAGE_SIZE, height: IMAGE_SIZE, data };
}

function descriptorFor(seed, colorSpace, uvChannel = 0) {
  return { image: gradientImage(seed), wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729, colorSpace, uvChannel };
}

function boxPart(material, { secondUvSet = false } = {}) {
  const geometry = box();
  const vertexCount = geometry.positions.length / 3;
  geometry.uvs = new Float32Array(vertexCount * 2).map((unused, index) => (index % 5) / 5);
  if (secondUvSet) geometry.lightUvs = new Float32Array(vertexCount * 2).map((unused, index) => (index % 3) / 3);
  return { name: 'Box', geometry, matrix: mat4.create(), material };
}

function layeredMaterial() {
  const layerMaps = {};
  LAYER_TEXTURE_SLOTS.forEach(([, property, colorSpace], index) => {
    layerMaps[property] = descriptorFor(index + 1, colorSpace);
  });
  return {
    color: [0.8, 0.7, 0.6],
    metallic: 0.5,
    roughness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.2,
    anisotropy: 0.8,
    sheenColor: [0.5, 0.5, 0.5],
    sheenRoughness: 0.5,
    layerMaps,
  };
}

test('every layer texture slot round trips through GLB with its pixels and colour space', async () => {
  const source = boxPart(layeredMaterial());
  const imported = await parseGltf(exportGlb([source]));
  const material = imported.parts[0].material;
  assert.deepEqual(Object.keys(material.layerMaps).sort(), LAYER_TEXTURE_SLOTS.map(([, property]) => property).sort());
  for (const [, property, colorSpace] of LAYER_TEXTURE_SLOTS) {
    const expected = source.material.layerMaps[property];
    const actual = material.layerMaps[property];
    assert.equal(actual.colorSpace, colorSpace, property);
    assert.equal(actual.uvChannel, 0, property);
    assert.deepEqual(Array.from(actual.image.data), Array.from(expected.image.data), property);
  }
});

test('textures that share an image in the file share one descriptor', async () => {
  const material = layeredMaterial();
  material.layerMaps.clearcoatRoughnessTexture = material.layerMaps.clearcoatTexture;
  const imported = await parseGltf(exportGlb([boxPart(material)]));
  const { layerMaps } = imported.parts[0].material;
  assert.equal(layerMaps.clearcoatRoughnessTexture, layerMaps.clearcoatTexture);
});

test('an occlusion texture on TEXCOORD_1 round trips with the second UV set', async () => {
  const material = { color: [1, 1, 1], metallic: 0, roughness: 0.5, occlusionMap: descriptorFor(9, 'linear', 1) };
  const glb = exportGlb([boxPart(material, { secondUvSet: true })]);
  const imported = await parseGltf(glb);
  const part = imported.parts[0];
  assert.equal(part.material.occlusionMap.uvChannel, 1);
  assert.equal(part.geometry.lightUvs.length, part.geometry.positions.length / 3 * 2);
  assert.equal(part.material.map, undefined);
});

test('a texture that needs a second UV set the mesh lacks is dropped with a warning and the mesh loads', async () => {
  const material = { name: 'Painted', color: [1, 1, 1], metallic: 0, roughness: 0.5, occlusionMap: descriptorFor(9, 'linear', 1) };
  const imported = await parseGltf(exportGlb([boxPart(material)]));
  assert.equal(imported.parts.length, 1);
  assert.equal(imported.parts[0].material.occlusionMap, undefined);
  assert.ok(imported.warnings.some(warning => /Dropped occlusionTexture from primitives without TEXCOORD_1.*material 0/.test(warning)));
});

test('a normal map on the second UV set loads on that set', async () => {
  const material = { color: [1, 1, 1], metallic: 0, roughness: 0.5, normalMap: descriptorFor(4, 'linear', 1) };
  const imported = await parseGltf(exportGlb([boxPart(material, { secondUvSet: true })]));
  const part = imported.parts[0];
  assert.equal(part.material.normalMap.uvChannel, 1);
  assert.equal(part.geometry.lightUvs.length, part.geometry.positions.length / 3 * 2);
});

test('a base color map alone on the second UV set stays on that set', async () => {
  const material = { name: 'Floor', color: [1, 1, 1], metallic: 0, roughness: 0.5, map: descriptorFor(6, 'srgb', 1) };
  const source = boxPart(material, { secondUvSet: true });
  const imported = await parseGltf(exportGlb([source]));
  const part = imported.parts[0];
  assert.equal(part.material.map.uvChannel, 1);
  assert.equal(part.geometry.lightUvs.length, part.geometry.positions.length / 3 * 2);
  assert.deepEqual(imported.warnings, []);
});

test('a base color map on the second UV set beside a first-set map keeps both maps', async () => {
  const material = { name: 'Mixed', color: [1, 1, 1], metallic: 0, roughness: 0.5, map: descriptorFor(6, 'srgb', 1), emissiveMap: descriptorFor(2, 'srgb', 0) };
  const imported = await parseGltf(exportGlb([boxPart(material, { secondUvSet: true })]));
  assert.equal(imported.parts[0].material.map.uvChannel, 1);
  assert.equal(imported.parts[0].material.emissiveMap.uvChannel, 0);
  assert.deepEqual(imported.warnings, []);
});

test('layer texture features splice their sampler once and guard shared code, whatever order they come in', () => {
  const features = ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture', 'anisotropy', 'anisotropyTexture', 'sheenColorTexture'];
  for (const ordered of [features, [...features].reverse()]) {
    const source = createFragmentShader(ordered);
    for (const name of ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture', 'anisotropyTexture', 'sheenColorTexture']) {
      assert.equal(source.split(`uniform sampler2D ${name};`).length - 1, 1, name);
    }
    assert.ok(source.includes('#ifndef ANISOTROPY_DECLARED\n#define ANISOTROPY_DECLARED\n'));
    assert.match(source, /#define materialCoat coatState/);
    assert.match(source, /#define materialSheen sheenState/);
  }
});

test('a scene without layer textures gets no layer texture code', () => {
  const source = createFragmentShader(['anisotropy']);
  assert.doesNotMatch(source, /coatState|sheenState|uniform sampler2D anisotropyTexture/);
});
