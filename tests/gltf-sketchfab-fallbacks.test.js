import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const TRIANGLE_UVS = new Float32Array([0, 0, 1, 0, 0, 1]);

function dataUri(...arrays) {
  const bytes = Buffer.concat(arrays.map(array => Buffer.from(array.buffer)));
  return `data:application/octet-stream;base64,${bytes.toString('base64')}`;
}

/** Stands in for the browser image decoder, which Node does not have. */
async function withImageDecoder(run) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  try {
    return await run();
  } finally {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  }
}

/** One triangle with one material and one texture, with or without TEXCOORD_0. */
function triangleDocument(material, { withUvs, extensionsRequired } = {}) {
  const attributes = { POSITION: 0 };
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }];
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];
  if (withUvs) {
    attributes.TEXCOORD_0 = 1;
    accessors.push({ bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' });
    bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 24 });
  }
  const byteLength = withUvs ? 60 : 36;
  return JSON.stringify({
    asset: { version: '2.0' },
    ...(extensionsRequired ? { extensionsUsed: extensionsRequired, extensionsRequired } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    materials: [material],
    accessors,
    bufferViews,
    buffers: [{ byteLength, uri: withUvs ? dataUri(TRIANGLE_POSITIONS, TRIANGLE_UVS) : dataUri(TRIANGLE_POSITIONS) }],
    textures: [{ source: 0 }],
    images: [{ uri: PNG_IMAGE }],
  });
}

test('a required KHR_materials_pbrSpecularGlossiness material loads as metallic-roughness', async () => {
  const extension = { diffuseFactor: [0.5, 0.25, 0.125, 1], glossinessFactor: 0.25, diffuseTexture: { index: 0 }, specularFactor: [1, 1, 1] };
  const document = triangleDocument({ name: 'old paint', extensions: { KHR_materials_pbrSpecularGlossiness: extension } }, { withUvs: true, extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'] });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.deepEqual(material.color.map(value => Number(value.toFixed(3))), [0.5, 0.25, 0.125]);
  assert.equal(material.metallic, 0);
  assert.equal(material.roughness, 0.75);
  assert.ok(material.map, 'the diffuse texture becomes the base color map');
  assert.ok(warnings.some(warning => /KHR_materials_pbrSpecularGlossiness converted to metallic-roughness.*old paint/.test(warning)));
});

test('a KHR_materials_unlit material with a base color map loads with the unlit tag and no lit maps', async () => {
  const document = triangleDocument({
    pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1], baseColorTexture: { index: 0 } },
    normalTexture: { index: 0 },
    extensions: { KHR_materials_unlit: {} },
  }, { withUvs: true, extensionsRequired: ['KHR_materials_unlit'] });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.equal(material.tag, 'unlit');
  assert.deepEqual(material.color, [1, 0.5, 0]);
  assert.equal(material.emission, 0);
  assert.ok(material.map);
  assert.equal(material.normalMap, undefined);
  assert.deepEqual(warnings, []);
});

test('a normal map on a primitive without TEXCOORD_0 is dropped with a warning', async () => {
  const document = triangleDocument({ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] }, normalTexture: { index: 0 } }, { withUvs: false });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.equal(material.normalMap, undefined);
  assert.deepEqual(material.color.map(value => Number(value.toFixed(3))), [0.2, 0.4, 0.6]);
  assert.ok(warnings.some(warning => /Dropped normalTexture from primitives without TEXCOORD_0/.test(warning)));
});

test('an unlit material with a base color map and no UVs loads without the map', async () => {
  const document = triangleDocument({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }, { withUvs: false });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  assert.equal(parts[0].material.tag, 'unlit');
  assert.equal(parts[0].material.map, undefined);
  assert.ok(warnings.some(warning => /Dropped baseColorTexture/.test(warning)));
});

test('a material that loses a texture to missing UVs is named in the warning and the mesh is kept', async () => {
  const document = triangleDocument({ name: 'plank', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { withUvs: false });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].material.map, undefined);
  assert.ok(warnings.some(warning => /Dropped baseColorTexture.*material plank/.test(warning)));
});

test('KHR_materials_specular colour factors above 4 load', async () => {
  const document = triangleDocument({
    name: 'glossy wood',
    extensions: { KHR_materials_specular: { specularColorFactor: [10, 9.6, 9.8] } },
  }, { withUvs: true, extensionsRequired: ['KHR_materials_specular'] });
  const { parts } = await withImageDecoder(() => parseGltf(document));
  assert.deepEqual(parts[0].material.specularColor, [10, 9.6, 9.8]);
});

/** A triangle with TEXCOORD_0 and a different TEXCOORD_1, so a test can tell which set a map reads. */
function twoUvSetDocument(material) {
  const document = JSON.parse(triangleDocument(material, { withUvs: true }));
  document.meshes[0].primitives[0].attributes.TEXCOORD_1 = 2;
  document.accessors.push({ bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' });
  document.bufferViews.push({ buffer: 0, byteOffset: 60, byteLength: 24 });
  document.buffers[0] = { byteLength: 84, uri: dataUri(TRIANGLE_POSITIONS, TRIANGLE_UVS, new Float32Array([0, 0, 2, 0, 0, 2])) };
  return document;
}

test('a material whose maps all read TEXCOORD_1 loads with that set as its UVs', async () => {
  const document = twoUvSetDocument({
    name: 'Laminate floor',
    normalTexture: { index: 0, texCoord: 1 },
    pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } },
  });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.ok(parts[0].material.map, 'the base color map is kept');
  assert.equal(parts[0].material.map.uvChannel, 0);
  assert.deepEqual([...parts[0].geometry.uvs], [0, 0, 2, 0, 0, 2]);
  assert.ok(warnings.some(warning => /Laminate floor.*TEXCOORD_1/.test(warning)));
});

test('a base color map on TEXCOORD_1 beside maps on TEXCOORD_0 is dropped with the material named', async () => {
  const document = twoUvSetDocument({
    name: 'mixed',
    emissiveTexture: { index: 0 },
    pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } },
  });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.equal(parts[0].material.map, undefined);
  assert.ok(parts[0].material.emissiveMap);
  assert.ok(warnings.some(warning => /Dropped baseColorTexture of mixed/.test(warning)));
});

test('an unused material with a base color map on TEXCOORD_1 does not fail the file', async () => {
  const document = twoUvSetDocument({ name: 'used' });
  document.materials.push({ name: 'unused', pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } });
  const { parts } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.equal(parts.length, 1);
});

test('a KHR_texture_transform texCoord of 1 is promoted with the map', async () => {
  const document = twoUvSetDocument({
    name: 'tiled',
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { texCoord: 1, scale: [2, 2] } } },
    },
  });
  document.extensionsUsed = ['KHR_texture_transform'];
  const { parts } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.ok(parts[0].material.map);
  assert.deepEqual([...parts[0].geometry.uvs], [0, 0, 4, 0, 0, 4]);
});

test('a normal map on texCoord 1 loads and reads the second UV set', async () => {
  const secondUvs = new Float32Array([0, 0, 2, 0, 0, 2]);
  const document = JSON.parse(triangleDocument({ normalTexture: { index: 0, texCoord: 1 } }, { withUvs: true }));
  document.meshes[0].primitives[0].attributes.TEXCOORD_1 = 2;
  document.accessors.push({ bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' });
  document.bufferViews.push({ buffer: 0, byteOffset: 60, byteLength: 24 });
  document.buffers[0] = { byteLength: 84, uri: dataUri(TRIANGLE_POSITIONS, TRIANGLE_UVS, secondUvs) };
  const { parts } = await withImageDecoder(() => parseGltf(JSON.stringify(document)));
  assert.equal(parts[0].material.normalMap.uvChannel, 1);
  assert.ok(parts[0].geometry.lightUvs, 'the second UV set is kept on the geometry');
});

test('a texCoord of -1 drops that map with a warning and keeps the mesh', async () => {
  const material = { name: 'scissors_metal', pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: -1 } } };
  const { parts, warnings } = await withImageDecoder(() => parseGltf(triangleDocument(material, { withUvs: false })));
  assert.equal(parts.length, 1);
  assert.ok(warnings.some(warning => warning.includes('baseColorTexture of scissors_metal') && warning.includes('negative texCoord')));
});

test('a roughness or metallic factor outside 0..1 is clamped with a warning', async () => {
  const material = { name: 'pages_mat', pbrMetallicRoughness: { roughnessFactor: 2, metallicFactor: -0.5 } };
  const { parts, warnings } = await parseGltf(triangleDocument(material, { withUvs: false }));
  assert.equal(parts[0].material.roughness, 1);
  assert.equal(parts[0].material.metallic, 0);
  assert.ok(warnings.some(warning => warning.includes('roughnessFactor 2 of pages_mat') && warning.includes('metallicFactor -0.5')));
});

test('in-range factors add no repair warning', async () => {
  const material = { name: 'fine', pbrMetallicRoughness: { roughnessFactor: 0.5 } };
  const { warnings } = await parseGltf(triangleDocument(material, { withUvs: false }));
  assert.ok(!warnings.some(warning => warning.startsWith('Clamped') || warning.includes('negative texCoord')));
});
