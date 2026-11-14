import assert from 'node:assert/strict';
import test from 'node:test';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Matrix4, Vector3 } from 'three';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { GLTF_CAPABILITIES, loadGltf, parseGltf } from '../src/gltf.js';

function triangleAsset(edit = () => {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const times = new Float32Array([0, 2]);
  const translations = new Float32Array([1, 2, 3, 5, 2, 3]);
  const alternate = new Float32Array([1, 2, 3, 1, 6, 3]);
  const chunks = [positions, uvs, times, translations, alternate];
  let offset = 0;
  const bufferViews = chunks.map(chunk => {
    const view = { buffer: 0, byteOffset: offset, byteLength: chunk.byteLength };
    offset += chunk.byteLength;
    return view;
  });
  const document = {
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Parent', translation: [10, 0, 0], children: [1, 2] }, { name: 'First', mesh: 0, translation: [1, 2, 3] }, { name: 'Second', mesh: 0, translation: [0, 4, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: 0.35, roughnessFactor: 0.7 }, emissiveFactor: [0.1, 0.2, 0.3] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews, buffers: [{ byteLength: offset }],
  };
  function appendAccessor(data, type, normalized = false) {
    chunks.push(data);
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    offset += Math.ceil(data.byteLength / 4) * 4;
    document.buffers[0].byteLength = offset;
    const accessor = document.accessors.length;
    document.accessors.push({ bufferView, componentType: data instanceof Uint8Array ? 5121 : 5126, count: data.length / (type === 'VEC4' ? 4 : 3), type, normalized });
    return accessor;
  }
  edit(document, appendAccessor);
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + offset);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, offset, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  for (let index = 0; index < chunks.length; index++) {
    bytes.set(new Uint8Array(chunks[index].buffer, chunks[index].byteOffset, chunks[index].byteLength), 28 + jsonLength + bufferViews[index].byteOffset);
  }
  return result;
}

test('GLB bridge preserves hierarchy, shared geometry, missing normals, UVs and linear PBR factors', async () => {
  const asset = await parseGltf(triangleAsset());
  assert.equal(asset.parts.length, 2);
  const [first, second] = asset.parts;
  assert.equal(first.geometry, second.geometry);
  assert.deepEqual(Array.from(first.matrix.subarray(12, 15)), [11, 2, 3]);
  assert.deepEqual(Array.from(second.matrix.subarray(12, 15)), [10, 4, 0]);
  assert.deepEqual(Array.from(first.geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(first.geometry.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(first.geometry.uvs), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(first.material.color, [0.2, 0.4, 0.6]);
  assert.deepEqual(first.material.emissiveColor, [0.1, 0.2, 0.3]);
  assert.equal(first.material.metallic, 0.35);
  assert.equal(first.material.roughness, 0.7);
  assert.equal(asset.capabilities, GLTF_CAPABILITIES);
  asset.dispose();
  asset.dispose();
});

test('Crucible exported GLB roundtrip preserves transforms and repeated primitive identity', async () => {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const material = { color: [0.2, 0.4, 0.6], metallic: 0.25, roughness: 0.6, emission: 0 };
  const matrix = mat4.fromTranslation(mat4.create(), [4, 5, 6]);
  const input = [{ name: 'Roundtrip', geometry, matrix, material }, { name: 'Instance', geometry, matrix: mat4.create(), material }];
  const asset = await parseGltf(exportGlb(input));
  assert.deepEqual(Array.from(asset.parts[0].matrix), Array.from(matrix));
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(geometry.positions));
  assert.equal(asset.parts[0].geometry, asset.parts[1].geometry);
  assert.equal(asset.parts[0].material, asset.parts[1].material);
  asset.dispose();
});

test('rigid animation seeks are absolute, order independent, clip selectable and clamped', async () => {
  const asset = await parseGltf(triangleAsset(document => {
    document.animations = [3, 4].map((output, index) => ({
      name: `Clip ${index}`,
      samplers: [{ input: 2, output, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
    }));
  }));
  assert.equal(asset.animations.length, 2);
  assert.equal(asset.applyAnimation(1), asset.parts);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [13, 2, 3]);
  const middle = Array.from(asset.parts[0].matrix);
  asset.applyAnimation(2);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [15, 2, 3]);
  asset.applyAnimation(0.1);
  asset.applyAnimation(1);
  assert.deepEqual(Array.from(asset.parts[0].matrix), middle);
  asset.applyAnimation(1, 1);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [11, 4, 3]);
  asset.applyAnimation(-1);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [11, 2, 3]);
  assert.throws(() => asset.applyAnimation(Infinity), /finite/);
  assert.throws(() => asset.applyAnimation(1, 8), /clip index/);
  asset.dispose();
  assert.throws(() => asset.applyAnimation(1), /disposed/);
});

test('mirrored static transforms keep the authored winding and the world matrix; the renderer owns the reversal', async () => {
  const asset = await parseGltf(triangleAsset(document => { document.nodes[2].scale = [-1, 1, 1]; }));
  assert.deepEqual(Array.from(asset.parts[0].geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(asset.parts[1].geometry.indices), [0, 1, 2]);
  assert.equal(asset.parts[1].matrix[0], -1);
  assert.equal(asset.parts[0].geometry, asset.parts[1].geometry);
  asset.dispose();
});

test('alpha mode, cutoff, base color alpha and double-sided map onto the material contract', async () => {
  const blended = await parseGltf(triangleAsset(document => {
    document.materials[0].alphaMode = 'BLEND';
    document.materials[0].doubleSided = true;
    document.materials[0].pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 0.25];
  }));
  assert.equal(blended.parts[0].material.alphaMode, 'blend');
  assert.equal(blended.parts[0].material.opacity, 0.25);
  assert.equal(blended.parts[0].material.doubleSided, true);
  blended.dispose();
  const masked = await parseGltf(triangleAsset(document => {
    document.materials[0].alphaMode = 'MASK';
    document.materials[0].alphaCutoff = 0.3;
  }));
  assert.equal(masked.parts[0].material.alphaMode, 'mask');
  assert.equal(masked.parts[0].material.alphaCutoff, 0.3);
  assert.equal(masked.parts[0].material.doubleSided, false);
  masked.dispose();
  const plain = await parseGltf(triangleAsset());
  assert.equal(plain.parts[0].material.alphaMode, 'opaque');
  assert.equal(plain.parts[0].material.opacity, 1);
  plain.dispose();
});

test('unsupported features fail explicitly before loading resources', async () => {
  const cases = [
    [document => { document.nodes[1].skin = 0; }, /skin index/],
    [document => {
      const primitive = document.meshes[0].primitives[0];
      primitive.attributes.NORMAL = primitive.attributes.POSITION;
      primitive.targets = [{ TANGENT: 0 }];
    }, /Unsupported morph/],
    [document => { document.meshes[0].primitives[0].attributes.COLOR_0 = 1; }, /COLOR_0/],
    [document => { document.meshes[0].primitives[0].mode = 5; }, /TRIANGLES/],
    [document => { document.materials[0].alphaMode = 'DITHER'; }, /alpha mode/],
    [document => { document.materials[0].alphaCutoff = 2; }, /alphaCutoff/],
    [document => { document.materials[0].doubleSided = 'yes'; }, /doubleSided/],
    [document => { document.materials[0].normalTexture = { index: 0 }; }, /normalTexture texture index/],
    [document => { document.extensionsRequired = ['KHR_draco_mesh_compression']; }, /KHR_draco/],
    [document => { document.extensionsRequired = ['KHR_materials_unknown_vendor']; }, /KHR_materials_unknown_vendor/],
    [document => { document.buffers[0].uri = 'external.bin'; }, /baseUrl/],
    [document => { document.nodes[2].children = [0]; }, /Cyclic/],
    [document => { document.accessors[1].count = 4; }, /TEXCOORD_0/],
  ];
  for (const [edit, expected] of cases) await assert.rejects(parseGltf(triangleAsset(edit)), expected);
});

test('byte, vertex, part and input guards reject oversized or malformed assets', async () => {
  const data = triangleAsset();
  await assert.rejects(parseGltf(data, { maxBytes: 32 }), /maxBytes/);
  await assert.rejects(parseGltf(data, { maxVertices: 2 }), /maxVertices/);
  await assert.rejects(parseGltf(data, { maxParts: 1 }), /maxParts/);
  await assert.rejects(parseGltf(data, { maxVertices: NaN }), /positive safe integer/);
  await assert.rejects(parseGltf(new ArrayBuffer(2)), /truncated/);
  const malformed = data.slice(0);
  new DataView(malformed).setUint32(8, data.byteLength + 10, true);
  await assert.rejects(parseGltf(malformed), /declared length/);
  const oversizedAccessor = triangleAsset(document => { document.accessors.push({ componentType: 5126, count: 30_000_000, type: 'MAT4' }); });
  await assert.rejects(parseGltf(oversizedAccessor), /decoded accessor bytes/);
  await assert.rejects(loadGltf(new Blob([data]), { maxBytes: 10 }), /maxBytes/);
  await assert.rejects(loadGltf({ arrayBuffer: () => Promise.resolve(data) }), /File\/Blob/);
  const asset = await loadGltf(new Blob([data]));
  assert.equal(asset.parts.length, 2);
  asset.dispose();
});

test('texture pixel budgets reject compressed images before browser decoding', async () => {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 100000);
  view.setUint32(20, 100000);
  const oversized = triangleAsset(document => {
    document.images = [{ uri: `data:image/png;base64,${Buffer.from(header).toString('base64')}` }];
  });
  await assert.rejects(parseGltf(oversized), /pixels [0-9]+, over maxTextureImagePixels/);
});

function pngHeaderUri(width, height) {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${Buffer.from(header).toString('base64')}`;
}

function mockImageBitmapWithResize(context) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  const requests = [];
  globalThis.createImageBitmap = async (blob, options) => {
    requests.push(options);
    return { width: options.resizeWidth ?? 1024, height: options.resizeHeight ?? 1024, close() {} };
  };
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
  return requests;
}

test('forty 1024 px maps load with default options by scaling them down and naming each one', async context => {
  const requests = mockImageBitmapWithResize(context);
  const asset = await parseGltf(triangleAsset(document => {
    document.images = Array.from({ length: 40 }, (unused, index) => ({ name: `map ${index}`, uri: pngHeaderUri(1024, 1024) }));
  }));
  assert.equal(asset.scaledTextures.length, 40);
  assert.deepEqual(asset.scaledTextures[3], { name: 'map 3', from: [1024, 1024], to: [512, 512] });
  assert.match(asset.warnings.join(" "), /^Scaled 40 texture image[(]s[)] to fit maxTexturePixels: map 0 1024x1024 to 512x512, map 1 1024x1024 to 512x512, map 2 1024x1024 to 512x512 and 37 more [(]see asset.scaledTextures[)][.]$/);
  assert.equal(requests.length, 0, 'unreferenced images are not decoded');
  asset.dispose();
});

test('base color keeps twice the size of a data map when textures are scaled', async context => {
  mockImageBitmapWithResize(context);
  const asset = await parseGltf(triangleAsset(document => {
    addMaterialMaps(document);
    document.images = [{ name: 'color', uri: pngHeaderUri(8, 8) }, { name: 'normal', uri: pngHeaderUri(8, 8) }];
    document.textures = [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }];
    const material = document.materials[0];
    material.pbrMetallicRoughness.metallicRoughnessTexture = { index: 1 };
    material.normalTexture = { index: 1 };
    material.occlusionTexture = { index: 1 };
  }), { maxTexturePixels: 80 });
  assert.deepEqual(asset.scaledTextures, [{ name: 'normal', from: [8, 8], to: [4, 4] }]);
  asset.dispose();
});

test('only the largest maps are scaled, and decoding requests the scaled size', async context => {
  const requests = mockImageBitmapWithResize(context);
  const asset = await parseGltf(triangleAsset(document => {
    addMaterialMaps(document);
    document.images = [{ name: 'big', uri: pngHeaderUri(4, 4) }];
  }), { maxTexturePixels: 8 });
  assert.deepEqual(asset.scaledTextures, [{ name: 'big', from: [4, 4], to: [2, 2] }]);
  assert.equal(requests[0].resizeWidth, 2);
  assert.equal(requests[0].resizeHeight, 2);
  const unscaled = await parseGltf(triangleAsset(addMaterialMaps));
  assert.deepEqual(unscaled.scaledTextures, []);
  asset.dispose();
  unscaled.dispose();
});

test('the single image ceiling still rejects a hostile image whatever the combined budget', async () => {
  const hostile = triangleAsset(document => {
    document.images = [{ uri: pngHeaderUri(100000, 100000) }];
  });
  await assert.rejects(parseGltf(hostile, { maxTexturePixels: 1_000_000_000_000 }), /pixels [0-9]+, over maxTextureImagePixels/);
  const large = triangleAsset(document => {
    document.images = [{ uri: pngHeaderUri(2048, 2048) }];
  });
  await assert.rejects(parseGltf(large, { maxTextureImagePixels: 1024 * 1024 }), /pixels [0-9]+, over maxTextureImagePixels/);
});

test('one limit error names every option a file goes over, its measured value and the value that fits', async () => {
  const overLimits = triangleAsset(document => {
    document.images = [{ uri: pngHeaderUri(16, 16) }, { uri: pngHeaderUri(64, 32) }];
  });
  await assert.rejects(parseGltf(overLimits, { maxVertices: 2, maxTextureImagePixels: 100 }), error => {
    assert.match(error.message, /^glTF over its limits: vertices 3, over maxVertices 2;/);
    assert.match(error.message, /image 0 [(]16x16[)] pixels 256, over maxTextureImagePixels 100/);
    assert.match(error.message, /image 1 [(]64x32[)] pixels 2048, over maxTextureImagePixels 100/);
    assert.match(error.message, /Fix: pass \{ maxVertices: 3, maxTextureImagePixels: 2048 \}\.$/);
    return true;
  });
  await assert.rejects(parseGltf(triangleAsset(), { maxBytes: 32 }), /bytes [0-9]+, over maxBytes 32[.] Fix: pass [{] maxBytes: [0-9]+ [}]/);
});

test('the default limits take a large exported scene: a 240 MB file, 8 million vertices and a 6144 x 3072 texture', async context => {
  const limits = GLTF_CAPABILITIES.limits;
  assert.ok(limits.maxBytes >= 240_000_000);
  assert.ok(limits.maxVertices >= 8_000_000);
  assert.ok(limits.maxTextureImagePixels >= 6144 * 3072);
  assert.ok(limits.maxInstances >= 65_536 && limits.maxParts >= 65_536 && limits.maxResources >= 256);
  mockImageBitmapWithResize(context);
  const asset = await parseGltf(triangleAsset(document => {
    document.images = [{ uri: pngHeaderUri(6144, 3072) }];
  }));
  assert.deepEqual(asset.scaledTextures, [{ name: 'image 0', from: [6144, 3072], to: [3072, 1536] }]);
  asset.dispose();
});

test('hierarchy depth guards reject long chains regardless of node ordering', async () => {
  for (const reverse of [false, true]) {
    const asset = triangleAsset(document => {
      document.nodes = Array.from({ length: 300 }, (_, index) => {
        const child = reverse ? index - 1 : index + 1;
        return child >= 0 && child < 300 ? { children: [child] } : { mesh: 0 };
      });
      document.scenes = [{ nodes: [reverse ? 299 : 0] }];
    });
    await assert.rejects(parseGltf(asset), /256 levels/);
  }
});

test('relative external buffer paths normalize both fetch and decoder lookups', async context => {
  const previousProgressEvent = globalThis.ProgressEvent;
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, details) { this.type = type; Object.assign(this, details); }
  };
  context.after(() => {
    if (previousProgressEvent) globalThis.ProgressEvent = previousProgressEvent;
    else delete globalThis.ProgressEvent;
  });
  const source = triangleAsset();
  const header = new DataView(source);
  const jsonLength = header.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength)));
  document.buffers[0].uri = '../mesh.bin';
  const binary = new Uint8Array(source, 28 + jsonLength);
  const fetched = [];
  context.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url));
    return new Response(binary);
  });
  const asset = await parseGltf(JSON.stringify(document), { baseUrl: 'https://example.test/models/' });
  assert.equal(asset.parts.length, 2);
  assert.equal(fetched[0], 'https://example.test/mesh.bin');
  asset.dispose();
});

test('URL loading streams within maxBytes and cancels oversized responses', async context => {
  const data = triangleAsset();
  const url = `data:model/gltf-binary;base64,${Buffer.from(data).toString('base64')}`;
  const asset = await loadGltf(url);
  assert.equal(asset.parts.length, 2);
  asset.dispose();
  let cancelled = false;
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new Uint8Array(64));
    },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(loadGltf('https://example.invalid/asset.glb', { maxBytes: 80 }), /maxBytes/);
  assert.equal(cancelled, true);
});

test('linear RGB and normalized Uint8 vertex colors become shared Float32 RGB geometry', async () => {
  const inputs = [
    { colors: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]), type: 'VEC3', normalized: false },
    { colors: new Uint8Array([0, 128, 255, 255, 64, 0, 128, 255, 64]), type: 'VEC3', normalized: true },
    { colors: new Uint8Array([0, 128, 255, 255, 255, 64, 0, 255, 128, 255, 64, 255]), type: 'VEC4', normalized: true },
  ];
  for (const input of inputs) {
    const asset = await parseGltf(triangleAsset((document, append) => {
      document.meshes[0].primitives[0].attributes.COLOR_0 = append(input.colors, input.type, input.normalized);
    }));
    const colors = asset.parts[0].geometry.colors;
    assert.ok(colors instanceof Float32Array);
    assert.equal(colors.length, 9);
    assert.equal(asset.parts[0].geometry, asset.parts[1].geometry);
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let component = 0; component < 3; component++) {
        const value = input.colors[vertex * (input.type === 'VEC4' ? 4 : 3) + component];
        const expected = input.normalized ? value / 255 : value;
        assert.ok(Math.abs(colors[vertex * 3 + component] - expected) < 1e-7);
      }
    }
    asset.dispose();
  }
});

test('RGBA vertex colors with alpha below one keep their RGB and warn that the alpha is ignored', async () => {
  const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 0.25]);
  const asset = await parseGltf(triangleAsset((document, append) => {
    document.meshes[0].primitives[0].attributes.COLOR_0 = append(colors, 'VEC4');
  }));
  assert.deepEqual(Array.from(asset.parts[0].geometry.colors), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(asset.warnings.length, 1);
  assert.match(asset.warnings[0], /alpha of RGBA COLOR_0/);
  asset.dispose();
});

test('RGBA vertex colors that are fully opaque load without a warning', async () => {
  const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  const asset = await parseGltf(triangleAsset((document, append) => {
    document.meshes[0].primitives[0].attributes.COLOR_0 = append(colors, 'VEC4');
  }));
  assert.deepEqual(asset.warnings, []);
  asset.dispose();
});

test('vertex colors reject invalid RGB factors explicitly', async () => {
  const colors = new Float32Array([1, 0, 0, 0, -0.1, 0, 0, 0, 1]);
  await assert.rejects(parseGltf(triangleAsset((document, append) => {
    document.meshes[0].primitives[0].attributes.COLOR_0 = append(colors, 'VEC3');
  })), /COLOR_0 RGB/);
});

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';

function addMaterialMaps(document) {
  document.images = [{ uri: PNG_IMAGE }];
  document.samplers = [{ wrapS: 33071, wrapT: 33648, minFilter: 9728, magFilter: 9729 }];
  document.textures = [{ source: 0, sampler: 0 }];
  const material = document.materials[0];
  material.pbrMetallicRoughness.baseColorTexture = { index: 0 };
  material.pbrMetallicRoughness.metallicRoughnessTexture = { index: 0 };
  material.normalTexture = { index: 0, scale: 0.35 };
  material.occlusionTexture = { index: 0, strength: 0.4 };
  material.emissiveTexture = { index: 0 };
}

test('all glTF map channels preserve sampler, linear data, sRGB color, scales, sharing and image disposal', async context => {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  let decoded = 0;
  let closed = 0;
  globalThis.createImageBitmap = async () => {
    decoded++;
    return { width: 2, height: 2, close() { closed++; } };
  };
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
  const asset = await parseGltf(triangleAsset(addMaterialMaps), { maxTexturePixels: 4 });
  const material = asset.parts[0].material;
  assert.equal(material, asset.parts[1].material);
  assert.deepEqual(material.normalScale, [0.35, 0.35]);
  assert.equal(material.occlusionStrength, 0.4);
  assert.equal(material.map, material.emissiveMap);
  assert.equal(material.normalMap, material.metallicRoughnessMap);
  assert.equal(material.normalMap, material.occlusionMap);
  assert.notEqual(material.map, material.normalMap);
  assert.equal(material.map.image, material.normalMap.image);
  for (const field of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    const descriptor = material[field];
    assert.equal(descriptor.colorSpace, ['map', 'emissiveMap'].includes(field) ? 'srgb' : 'linear');
    assert.equal(descriptor.uvChannel, 0);
    assert.equal(descriptor.flipY, false);
    assert.equal(descriptor.wrapS, 33071);
    assert.equal(descriptor.wrapT, 33648);
    assert.equal(descriptor.minFilter, 9728);
    assert.equal(descriptor.magFilter, 9729);
  }
  assert.equal(decoded, 1);
  asset.dispose();
  asset.dispose();
  assert.equal(closed, 1);
  assert.ok(GLTF_CAPABILITIES.supported.includes('normal/occlusion/emissive/metallic-roughness textures'));
});

test('map preflight rejects unsupported UVs, sampler states, invalid scales and missing geometry UVs', async () => {
  const changes = [
    [document => { document.materials[0].normalTexture.texCoord = 2; }, /TEXCOORD_0 or TEXCOORD_1/],
    [document => { document.materials[0].normalTexture.scale = 'invalid'; }, /finite float/],
    [document => { document.materials[0].normalTexture.scale = '1'; }, /finite float/],
    [document => { document.materials[0].occlusionTexture.strength = 2; }, /strength/],
    [document => { document.samplers[0].wrapS = 4; }, /wrap mode/],
    [document => { document.samplers[0].minFilter = 4; }, /filtering/],
    [document => { document.textures[0].source = 4; }, /image index/],
    [document => { document.textures[0].sampler = 4; }, /sampler index/],
    [document => { document.materials[0].emissiveTexture.extensions = { KHR_texture_transform: { offset: [0.2, 0] } }; }, /KHR_texture_transform/],
  ];
  for (const [change, expected] of changes) {
    await assert.rejects(parseGltf(triangleAsset(document => {
      addMaterialMaps(document);
      change(document);
    })), expected);
  }
});

function skinPosition(part, vertex) {
  const result = new Vector3();
  const input = new Vector3().fromArray(part.geometry.positions, vertex * 3);
  for (let influence = 0; influence < 4; influence++) {
    const offset = vertex * 4 + influence;
    const matrix = new Matrix4().fromArray(part.skin.jointMatrices, part.geometry.skinIndices[offset] * 16);
    result.addScaledVector(input.clone().applyMatrix4(matrix), part.geometry.skinWeights[offset]);
  }
  return result.applyMatrix4(new Matrix4().fromArray(part.matrix));
}

test('GLB skin import retains inverse binds, ordered bones and deterministic visibly bent poses matching Three', async () => {
  const data = skinnedStripAsset();
  const asset = await parseGltf(data);
  const part = asset.parts[0];
  const palette = part.skin.jointMatrices;
  const matrix = part.matrix;
  assert.equal(asset.skins.length, 1);
  assert.equal(asset.skins[0], part.skin);
  assert.deepEqual(part.skin.joints.map(joint => joint.name), ['Root', 'Tip']);
  assert.deepEqual(part.skin.joints.map(joint => joint.parent), [-1, 0]);
  assert.equal(part.skin.inverseBindMatrices[29], -1);
  const restTop = skinPosition(part, 4);
  const restBottom = skinPosition(part, 0);
  asset.applyAnimation(2);
  assert.ok(skinPosition(part, 4).distanceTo(restTop) > 1);
  assert.ok(skinPosition(part, 0).distanceTo(restBottom) < 1e-6, 'lower vertices stay fixed while upper vertices bend');
  const bent = Array.from(palette);
  asset.applyAnimation(0.4);
  asset.applyAnimation(2);
  assert.deepEqual(Array.from(palette), bent);
  asset.applyAnimation(2, 1);
  asset.applyAnimation(2, 0);
  assert.deepEqual(Array.from(palette), bent, 'switching clips restores unanimated bone properties');
  assert.equal(part.skin.jointMatrices, palette);
  assert.equal(part.matrix, matrix);
  const decoded = await new GLTFLoader().parseAsync(data, '');
  decoded.scene.updateMatrixWorld(true);
  let mesh;
  decoded.scene.traverse(node => { if (node.isSkinnedMesh) mesh = node; });
  mesh.skeleton.bones[1].rotation.z = Math.PI / 2;
  decoded.scene.updateMatrixWorld(true);
  for (let vertex = 0; vertex < 6; vertex++) {
    const expected = mesh.applyBoneTransform(vertex, new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex)).applyMatrix4(mesh.matrixWorld);
    assert.ok(skinPosition(part, vertex).distanceTo(expected) < 1e-6);
  }
  mesh.geometry.dispose();
  mesh.material.dispose();
  mesh.skeleton.dispose();
  asset.dispose();
  assert.throws(() => asset.applyAnimation(1), /disposed/);
});

test('skin preflight guards joints, influence shapes, raw zero weights, indices and budgets', async () => {
  const cases = [
    [document => { document.skins[0].joints = [2, 2]; }, /distinct/],
    [document => { document.skins[0].joints = [2, 9]; }, /valid node/],
    [document => { document.accessors[document.skins[0].inverseBindMatrices].type = 'VEC4'; }, /Inverse bind/],
    [document => { document.meshes[0].primitives[0].attributes.JOINTS_1 = 0; }, /four/],
    [document => { delete document.meshes[0].primitives[0].attributes.WEIGHTS_0; }, /JOINTS_0/],
    [(document, append, chunks) => { chunks[document.meshes[0].primitives[0].attributes.WEIGHTS_0].fill(0); }, /positive total/],
    [(document, append, chunks) => { chunks[document.meshes[0].primitives[0].attributes.JOINTS_0][0] = 9; }, /index/],
    [(document, append, chunks) => { chunks[document.meshes[0].primitives[0].attributes.WEIGHTS_0][0] = -0.2; }, /weights/],
  ];
  for (const [edit, expected] of cases) await assert.rejects(parseGltf(skinnedStripAsset(edit)), expected);
  await assert.rejects(parseGltf(skinnedStripAsset(), { maxJoints: 1 }), /maxJoints/);
  await assert.rejects(parseGltf(skinnedStripAsset(document => {
    document.nodes.push({ name: 'Second strip', mesh: 0, skin: 0 });
    document.nodes[0].children.push(4);
  }), { maxJoints: 2 }), /skin pose joints/);
});

test('a skeletal animation that scales a joint to zero collapses it to a point and restores with the base pose', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    const scales = append(new Float32Array([1, 1, 1, 0, 1, 1]), 'VEC3');
    document.animations[0].samplers[0].output = scales;
    document.animations[0].channels[0].target.path = 'scale';
  }));
  const part = asset.parts[0];
  const matrix = Array.from(part.matrix);
  const palette = Array.from(part.skin.jointMatrices);
  const world = Array.from(part.skin.jointWorldMatrices);
  asset.applyAnimation(2);
  assert.ok(Array.from(part.skin.jointMatrices).every(Number.isFinite));
  assert.deepEqual(Array.from(part.matrix), matrix);
  assert.notDeepEqual(Array.from(part.skin.jointWorldMatrices), world);
  asset.applyAnimation(0);
  assert.deepEqual(Array.from(part.skin.jointMatrices), palette);
  asset.dispose();
});

test('normalized integer skin weights import correctly and skinned mesh node transforms cancel without reversed winding', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    const weights = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 128, 127, 0, 0, 128, 127, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]);
    document.meshes[0].primitives[0].attributes.WEIGHTS_0 = append(weights, 'VEC4', true);
    document.nodes[1].scale = [-1, 1, 1];
  }));
  const part = asset.parts[0];
  assert.deepEqual(Array.from(part.geometry.indices.subarray(0, 3)), [0, 1, 2]);
  assert.ok(Math.abs(part.geometry.skinWeights[8] - 128 / 255) < 1e-6);
  assert.ok(skinPosition(part, 0).distanceTo(new Vector3(0.7, 2, 0)) < 1e-6);
  asset.applyAnimation(2);
  assert.ok(skinPosition(part, 4).x < 0.1);
  asset.dispose();
});

function webpLosslessUri(width, height) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8);
  view.setUint32(16, 10, true);
  bytes[20] = 0x2f;
  view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
}

function webpExtendedUri(width, height) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  for (const [offset, value] of [[24, width - 1], [27, height - 1]]) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  }
  return `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`;
}

function mockImageBitmapByType(context, decodable) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  const decodedTypes = [];
  globalThis.createImageBitmap = async blob => {
    if (!decodable(blob.type)) throw new Error(`cannot decode ${blob.type}`);
    decodedTypes.push(blob.type);
    return { width: 4, height: 4, close() {} };
  };
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
  return decodedTypes;
}

function useWebpTexture(document, images, texture) {
  document.images = images;
  document.textures = [texture];
  document.extensionsUsed = ['EXT_texture_webp'];
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
}

test('EXT_texture_webp textures decode as WebP', async context => {
  const decodedTypes = mockImageBitmapByType(context, () => true);
  const asset = await parseGltf(triangleAsset(document => {
    useWebpTexture(document, [{ uri: webpLosslessUri(4, 4) }], { extensions: { EXT_texture_webp: { source: 0 } } });
    document.extensionsRequired = ['EXT_texture_webp'];
  }));
  assert.ok(asset.parts[0].material.map);
  assert.deepEqual(decodedTypes, ['image/webp']);
  assert.ok(GLTF_CAPABILITIES.supported.some(entry => entry.includes('EXT_texture_webp')));
  asset.dispose();
});

test('a WebP texture falls back to its PNG source when the browser cannot decode WebP', async context => {
  const decodedTypes = mockImageBitmapByType(context, type => type !== 'image/webp');
  const asset = await parseGltf(triangleAsset(document => {
    useWebpTexture(document, [{ uri: webpLosslessUri(4, 4) }, { uri: PNG_IMAGE }], { source: 1, extensions: { EXT_texture_webp: { source: 0 } } });
  }));
  assert.ok(asset.parts[0].material.map);
  assert.deepEqual(decodedTypes, ['image/png']);
  asset.dispose();
});

test('WebP image sizes count toward the texture budgets before decoding', async () => {
  const oversized = triangleAsset(document => {
    useWebpTexture(document, [{ uri: webpExtendedUri(10000, 10000) }], { extensions: { EXT_texture_webp: { source: 0 } } });
  });
  await assert.rejects(parseGltf(oversized), /pixels [0-9]+, over maxTextureImagePixels/);
});
