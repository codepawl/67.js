import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, CompressedTexture, DataTexture, Float32BufferAttribute } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { parseGltf } from '../src/gltf.js';

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const TRIANGLE_UVS = new Float32Array([0, 0, 1, 0, 0, 1]);

function padToFour(length) {
  return Math.ceil(length / 4) * 4;
}

function bytesOf(typedArray) {
  return new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function buildGlb(document, binary) {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = padToFour(json.length);
  const binaryLength = padToFour(binary.length);
  const glb = new Uint8Array(28 + jsonLength + binaryLength);
  const header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, glb.length, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  glb.fill(32, 20, 20 + jsonLength);
  glb.set(json, 20);
  header.setUint32(20 + jsonLength, binaryLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  glb.set(binary, 28 + jsonLength);
  return glb.buffer;
}

/** Packs chunks into one buffer and returns the matching bufferViews. */
function packChunks(chunks) {
  const bufferViews = [];
  const parts = [];
  let offset = 0;
  for (const chunk of chunks) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: chunk.length });
    parts.push(chunk);
    offset += padToFour(chunk.length);
  }
  const binary = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) {
    binary.set(part, cursor);
    cursor += padToFour(part.length);
  }
  return { binary, bufferViews };
}

function triangleDocument({ extraChunks = [], edit = () => {} } = {}) {
  const { binary, bufferViews } = packChunks([bytesOf(TRIANGLE_POSITIONS), bytesOf(TRIANGLE_UVS), ...extraChunks]);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Triangle', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: {} }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };
  edit(document);
  return buildGlb(document, binary);
}

function mockImageBitmap(context) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
}

function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-6, `index ${index}: ${actual[index]} vs ${expected[index]}`);
  }
}

function addTexturedMaterial(document, transforms) {
  document.images = [{ uri: PNG_IMAGE }];
  document.textures = [{ source: 0 }];
  const withTransform = transform => ({ index: 0, ...(transform && { extensions: { KHR_texture_transform: transform } }) });
  document.materials[0].pbrMetallicRoughness.baseColorTexture = withTransform(transforms[0]);
  document.materials[0].normalTexture = withTransform(transforms[1]);
  document.extensionsUsed = ['KHR_texture_transform'];
}

test('KHR_texture_transform bakes one shared offset, rotation and scale into the UVs', async context => {
  mockImageBitmap(context);
  const shared = { offset: [0.5, 0], rotation: Math.PI / 2, scale: [1, 1] };
  const asset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [shared, shared]) }));
  assertClose(asset.parts[0].geometry.uvs, [0.5, 0, 0.5, -1, 1.5, 0]);
  const scaled = { offset: [0.25, 0.5], scale: [2, 4] };
  const scaledAsset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [scaled, scaled]) }));
  assertClose(scaledAsset.parts[0].geometry.uvs, [0.25, 0.5, 2.25, 0.5, 0.25, 4.5]);
});

test('KHR_texture_transform rejects different transforms and texCoord overrides on one material', async context => {
  mockImageBitmap(context);
  const tiled = { scale: [2, 2] };
  const metallicRoughnessTiledThrice = document => {
    addTexturedMaterial(document, [tiled, tiled]);
    document.materials[0].pbrMetallicRoughness.metallicRoughnessTexture = { index: 0, extensions: { KHR_texture_transform: { scale: [3, 3] } } };
  };
  await assert.rejects(parseGltf(triangleDocument({ edit: metallicRoughnessTiledThrice })), /cannot share one UV space/);
  await assert.rejects(parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [{ texCoord: 1 }, { texCoord: 1 }]) })), /texCoord/);
});

test('a normal map may differ from the other maps by scale and offset, which the shader applies', async context => {
  mockImageBitmap(context);
  const base = { offset: [-3, 3], scale: [7, 7] };
  const normal = { offset: [-0.5, 0.5], scale: [2, 2] };
  const asset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [base, normal]) }));
  assertClose(asset.parts[0].geometry.uvs, [-3, 3, 4, 3, -3, 10]);
  const [scaleU, scaleV, offsetU, offsetV] = asset.parts[0].material.normalMap.uvTransform;
  assertClose([scaleU, scaleV, offsetU, offsetV], [2 / 7, 2 / 7, -0.5 + 6 / 7, 0.5 - 6 / 7]);
  assert.notEqual(asset.parts[0].material.normalMap, asset.parts[0].material.baseColorMap);
  const firstVertexNormalUv = [-3 * scaleU + offsetU, 3 * scaleV + offsetV];
  assertClose(firstVertexNormalUv, [-0.5, 0.5]);
});

test('a texture transform that only repeats the texture own texCoord changes nothing', async context => {
  mockImageBitmap(context);
  const edit = document => {
    addTexturedMaterial(document, [undefined, undefined]);
    document.meshes[0].primitives[0].attributes.TEXCOORD_1 = 1;
    document.materials[0].occlusionTexture = { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { texCoord: 1 } } };
  };
  const asset = await parseGltf(triangleDocument({ edit }));
  assert.equal(asset.parts[0].material.occlusionMap.uvChannel, 1);
  assertClose(asset.parts[0].geometry.uvs, TRIANGLE_UVS);
});

test('a normal map with the same transform as its material keeps no extra transform', async context => {
  mockImageBitmap(context);
  const shared = { offset: [0.25, 0.5], scale: [2, 4] };
  const asset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [shared, shared]) }));
  assert.equal(asset.parts[0].material.normalMap.uvTransform, undefined);
  assertClose(asset.parts[0].geometry.uvs, [0.25, 0.5, 2.25, 0.5, 0.25, 4.5]);
  const plainBase = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [undefined, undefined]) }));
  assert.equal(plainBase.parts[0].material.normalMap.uvTransform, undefined);
  assertClose(plainBase.parts[0].geometry.uvs, TRIANGLE_UVS);
});

test('a normal map transform that needs a different rotation is rejected', async context => {
  mockImageBitmap(context);
  const base = { scale: [2, 2] };
  const rotated = { scale: [2, 2], rotation: 0.5 };
  await assert.rejects(parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [base, rotated]) })), /offset and a positive scale/);
});

function instancingDocument(translations, edit = () => {}) {
  return triangleDocument({
    extraChunks: [bytesOf(new Float32Array(translations))],
    edit: document => {
      document.accessors.push({ bufferView: 2, componentType: 5126, count: translations.length / 3, type: 'VEC3' });
      document.extensionsUsed = ['EXT_mesh_gpu_instancing'];
      document.nodes[0].translation = [0, 10, 0];
      document.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } };
      edit(document);
    },
  });
}

test('EXT_mesh_gpu_instancing expands into parts that share one geometry', async () => {
  const asset = await parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]));
  assert.equal(asset.parts.length, 3);
  assert.equal(new Set(asset.parts.map(part => part.geometry)).size, 1);
  assert.equal(new Set(asset.parts.map(part => part.material)).size, 1);
  assert.deepEqual(asset.parts.map(part => Array.from(part.matrix.slice(12, 15))), [[1, 10, 0], [2, 10, 0], [3, 10, 0]]);
});

test('EXT_mesh_gpu_instancing handles several primitives and a bounded instance count', async () => {
  const twoPrimitives = document => {
    document.meshes[0].primitives.push({ attributes: { POSITION: 0 } });
  };
  const asset = await parseGltf(instancingDocument([1, 0, 0, 2, 0, 0], twoPrimitives));
  assert.equal(asset.parts.length, 4);
  assert.equal(asset.nodes.length, 1);
  assert.equal(asset.nodes[0].meshIds.length, 4);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]), { maxInstances: 2 }), /maxInstances/);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]), { maxParts: 2 }), /maxParts/);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0], document => { document.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes = {}; })), /needs TRANSLATION/);
});

const LAYER_MATERIAL_EXTENSIONS = {
  KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 },
  KHR_materials_transmission: { transmissionFactor: 0.6 },
  KHR_materials_ior: { ior: 1.4 },
  KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [1, 0.9, 0.8] },
  KHR_materials_sheen: { sheenColorFactor: [0.5, 0.4, 0.3], sheenRoughnessFactor: 0.3 },
  KHR_materials_volume: { thicknessFactor: 0.1, attenuationDistance: 2, attenuationColor: [0.8, 0.9, 1] },
};
const SURFACE_EFFECT_MATERIAL_EXTENSIONS = {
  KHR_materials_anisotropy: { anisotropyStrength: 0.6, anisotropyRotation: 1.2 },
  KHR_materials_iridescence: { iridescenceFactor: 0.8, iridescenceIor: 1.6, iridescenceThicknessMinimum: 150, iridescenceThicknessMaximum: 500 },
};

test('KHR_materials layer extensions import as material layers', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = Object.keys(LAYER_MATERIAL_EXTENSIONS);
      document.materials[0].extensions = structuredClone(LAYER_MATERIAL_EXTENSIONS);
    },
  }));
  const material = asset.parts[0].material;
  assert.equal(material.clearcoat, 1);
  assert.equal(material.clearcoatRoughness, 0.1);
  assert.equal(material.transmission, 0.6);
  assert.equal(material.ior, 1.4);
  assert.equal(material.specular, 0.5);
  assert.deepEqual(material.specularColor, [1, 0.9, 0.8]);
  assert.deepEqual(material.sheenColor, [0.5, 0.4, 0.3]);
  assert.equal(material.sheenRoughness, 0.3);
  assert.equal(material.thickness, 0.1);
  assert.equal(material.attenuationDistance, 2);
  assert.deepEqual(material.attenuationColor, [0.8, 0.9, 1]);
  assert.deepEqual(asset.warnings, []);
  const plain = await parseGltf(triangleDocument());
  assert.deepEqual(plain.warnings, []);
  assert.equal('transmission' in plain.parts[0].material, false);
});

test('anisotropy and iridescence import as material layers without a warning', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = Object.keys(SURFACE_EFFECT_MATERIAL_EXTENSIONS);
      document.materials[0].extensions = structuredClone(SURFACE_EFFECT_MATERIAL_EXTENSIONS);
    },
  }));
  const material = asset.parts[0].material;
  assert.equal(material.anisotropy, 0.6);
  assert.equal(material.anisotropyRotation, 1.2);
  assert.equal(material.iridescence, 0.8);
  assert.equal(material.iridescenceIor, 1.6);
  assert.equal(material.iridescenceThickness, 500, 'without a thickness texture the film is as thick as the maximum');
  assert.deepEqual(asset.warnings, []);
});

test('metadata extensions such as KHR_xmp_json_ld and the earlier KHR_xmp do not stop an import', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = ['KHR_xmp', 'KHR_xmp_json_ld'];
      document.extensions = { KHR_xmp_json_ld: { packets: [] } };
      document.asset.extensions = { KHR_xmp: { packet: 0 } };
    },
  }));
  assert.equal(asset.parts.length, 1);
  assert.deepEqual(asset.warnings, []);
});

test('required material extensions, bad layer values and missing decoders are rejected', async () => {
  const required = triangleDocument({ edit: document => { document.extensionsRequired = ['KHR_materials_made_up']; } });
  await assert.rejects(parseGltf(required), /Unsupported glTF extension: KHR_materials_made_up/);
  const badIridescence = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_iridescence: { iridescenceFactor: 2 } }; } });
  await assert.rejects(parseGltf(badIridescence), /iridescence must be between 0 and 1/);
  const badTransmission = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_transmission: { transmissionFactor: 2 } }; } });
  await assert.rejects(parseGltf(badTransmission), /transmission must be between 0 and 1.*Use a number inside that range/);
  const badIor = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_ior: { ior: 0.5 } }; } });
  await assert.rejects(parseGltf(badIor), /ior must be between 1 and 2.5/);
  for (const [extension, decoder] of [['KHR_draco_mesh_compression', 'draco'], ['KHR_texture_basisu', 'ktx2']]) {
    const data = triangleDocument({ edit: document => { document.extensionsRequired = [extension]; } });
    await assert.rejects(parseGltf(data), new RegExp(`options\\.decoders\\.${decoder}`));
  }
});

/** Encodes bytes with the meshopt ATTRIBUTES codec using literal 8-bit delta groups only. */
function encodeMeshoptLiteral(bytes, count, stride) {
  assert.ok(count <= 16, 'the test encoder handles one group of sixteen elements');
  const header = 0xa0;
  const tailSize = Math.max(32, stride);
  const encoded = [header];
  for (let lane = 0; lane < stride; lane++) {
    encoded.push(0b11);
    let previous = 0;
    for (let element = 0; element < 16; element++) {
      const value = element < count ? bytes[element * stride + lane] : previous;
      const delta = (value - previous) << 24 >> 24;
      encoded.push(((delta << 1) ^ (delta >> 7)) & 0xff);
      previous = value;
    }
  }
  encoded.push(...new Array(tailSize).fill(0));
  return Uint8Array.from(encoded);
}

test('EXT_meshopt_compression decodes a real encoded vertex buffer', async () => {
  const compressed = encodeMeshoptLiteral(bytesOf(TRIANGLE_POSITIONS), 3, 12);
  const { binary, bufferViews } = packChunks([compressed, bytesOf(TRIANGLE_UVS)]);
  const document = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: [
      {
        buffer: 1, byteLength: 36, byteStride: 12,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: compressed.length, byteStride: 12, mode: 'ATTRIBUTES', count: 3 } },
      },
      { ...bufferViews[1] },
    ],
    buffers: [{ byteLength: binary.length }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
  };
  const asset = await parseGltf(buildGlb(document, binary), { decoders: { meshopt: MeshoptDecoder } });
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(TRIANGLE_POSITIONS));
});

test('KHR_draco_mesh_compression decodes through the supplied Draco loader', async () => {
  const decodedGeometry = new BufferGeometry();
  decodedGeometry.setAttribute('position', new Float32BufferAttribute(TRIANGLE_POSITIONS, 3));
  const requested = [];
  const dracoLoader = {
    preload() {},
    decodeDracoFile(buffer, onLoad, attributeIds) {
      requested.push(attributeIds);
      onLoad(decodedGeometry);
    },
  };
  const data = triangleDocument({
    extraChunks: [new Uint8Array(8)],
    edit: document => {
      document.accessors[0].bufferView = undefined;
      document.meshes[0].primitives[0] = { attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 2, attributes: { POSITION: 0 } } } };
      document.extensionsUsed = ['KHR_draco_mesh_compression'];
      document.extensionsRequired = ['KHR_draco_mesh_compression'];
    },
  });
  const asset = await parseGltf(data, { decoders: { draco: dracoLoader } });
  assert.deepEqual(requested, [{ position: 0 }]);
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(TRIANGLE_POSITIONS));
});

test('KHR_texture_basisu textures arrive as RGBA8 pixels from the supplied KTX2 loader', async context => {
  mockImageBitmap(context);
  const ktx2Header = new Uint8Array(80);
  ktx2Header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(ktx2Header.buffer).setUint32(20, 2, true);
  new DataView(ktx2Header.buffer).setUint32(24, 2, true);
  const pixels = Uint8Array.from({ length: 16 }, (unused, index) => index * 10);
  const ktx2Loader = {
    load(url, onLoad) {
      onLoad(new DataTexture(pixels, 2, 2));
    },
  };
  const data = triangleDocument({
    extraChunks: [ktx2Header],
    edit: document => {
      document.images = [{ bufferView: 2, mimeType: 'image/ktx2' }];
      document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
      document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
      document.extensionsUsed = ['KHR_texture_basisu'];
      document.extensionsRequired = ['KHR_texture_basisu'];
    },
  });
  const asset = await parseGltf(data, { decoders: { ktx2: ktx2Loader }, maxTexturePixels: 4 });
  const { image } = asset.parts[0].material.map;
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.deepEqual(Array.from(image.data), Array.from(pixels));
  await assert.rejects(parseGltf(data, { decoders: { ktx2: ktx2Loader }, maxTexturePixels: 3 }), /maxTexturePixels/);
});

const BPTC_RGBA = 0x8e8c;
const ETC1_RGB = 36196;

/** A CompressedTexture shaped like the KTX2Loader result: BC7 mips of a square image, 16 bytes a 4x4 block. */
function compressedKtx2Texture(size, format = BPTC_RGBA, { levelCount = Infinity } = {}) {
  const mipmaps = [];
  for (let width = size; width >= 1 && mipmaps.length < levelCount; width >>= 1) {
    const blocks = Math.ceil(width / 4) ** 2;
    mipmaps.push({ data: new Uint8Array(blocks * 16), width, height: width });
  }
  return new CompressedTexture(mipmaps, size, size, format);
}

function ktx2BaseColorDocument(size) {
  const header = new Uint8Array(80);
  header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(header.buffer).setUint32(20, size, true);
  new DataView(header.buffer).setUint32(24, size, true);
  return triangleDocument({
    extraChunks: [header],
    edit: document => {
      document.images = [{ bufferView: 2, mimeType: 'image/ktx2' }];
      document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
      document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
      document.extensionsUsed = ['KHR_texture_basisu'];
      document.extensionsRequired = ['KHR_texture_basisu'];
    },
  });
}

function ktx2LoaderReturning(texture, workerConfig) {
  return { workerConfig, load: (url, onLoad) => onLoad(texture) };
}

test('KHR_texture_basisu keeps a GPU-compressed texture and records its format and bytes', async context => {
  mockImageBitmap(context);
  const loader = ktx2LoaderReturning(compressedKtx2Texture(8), { bptcSupported: true });
  const asset = await parseGltf(ktx2BaseColorDocument(8), { decoders: { ktx2: loader } });
  const { image } = asset.parts[0].material.map;
  assert.equal(image.compressed.name, 'bc7');
  assert.equal(image.compressed.levels.length, 4);
  assert.equal(image.compressed.bytes, 64 + 16 + 16 + 16);
  assert.deepEqual(asset.textureFormats, [{ format: 'bc7', width: 8, height: 8, colorSpace: 'srgb', bytes: 112 }]);
});

test('a compressed KTX2 image counts a quarter of its RGBA8 pixels toward maxTexturePixels', async context => {
  mockImageBitmap(context);
  const texture = compressedKtx2Texture(8);
  const unconfigured = ktx2LoaderReturning(texture, null);
  const configured = ktx2LoaderReturning(texture, { bptcSupported: true });
  await assert.rejects(parseGltf(ktx2BaseColorDocument(8), { decoders: { ktx2: unconfigured }, maxTexturePixels: 20 }), /maxTexturePixels/);
  await parseGltf(ktx2BaseColorDocument(8), { decoders: { ktx2: configured }, maxTexturePixels: 20 });
});

test('a KTX2 loader that transcoded to RGBA8 reports the rgba8 format', async context => {
  mockImageBitmap(context);
  const loader = ktx2LoaderReturning(new DataTexture(new Uint8Array(4 * 2 * 2), 2, 2), { bptcSupported: false });
  const asset = await parseGltf(ktx2BaseColorDocument(2), { decoders: { ktx2: loader } });
  assert.equal(asset.textureFormats[0].format, 'rgba8');
});

test('a compressed KTX2 texture with a partial mip chain keeps its first level', async context => {
  mockImageBitmap(context);
  const loader = ktx2LoaderReturning(compressedKtx2Texture(8, BPTC_RGBA, { levelCount: 2 }), { bptcSupported: true });
  const asset = await parseGltf(ktx2BaseColorDocument(8), { decoders: { ktx2: loader } });
  assert.equal(asset.parts[0].material.map.image.compressed.levels.length, 1);
});

test('a compressed KTX2 format Crucible does not upload fails with a clear message', async context => {
  mockImageBitmap(context);
  const loader = ktx2LoaderReturning(compressedKtx2Texture(8, ETC1_RGB), { bptcSupported: true });
  await assert.rejects(parseGltf(ktx2BaseColorDocument(8), { decoders: { ktx2: loader } }), /does not upload/);
});

// A 2 by 2 image whose four texels differ, with its pixels attached the way a decoded image carries them.
function patternBitmap() {
  const data = new Uint8Array([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]);
  return { width: 2, height: 2, data, close() {} };
}

function mockPatternBitmap(context) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => patternBitmap();
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
}

function redAt(image, u, v) {
  const fraction = value => value - Math.floor(value);
  const column = Math.floor(fraction(u) * image.width);
  const row = Math.floor(fraction(v) * image.height);
  return image.data[(row * image.width + column) * 4];
}

function tiledBaseWithPlainEmissive(document, emissiveExtra = {}) {
  document.images = [{ uri: PNG_IMAGE }];
  document.textures = [{ source: 0 }];
  document.materials[0].name = 'Crate';
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } };
  document.materials[0].emissiveTexture = { index: 0, ...emissiveExtra };
  document.extensionsUsed = ['KHR_texture_transform'];
}

test('a tiled base color map beside an untransformed emissive map loads, with the tiled map resampled and a warning', async context => {
  mockPatternBitmap(context);
  const asset = await parseGltf(triangleDocument({ edit: document => tiledBaseWithPlainEmissive(document) }));
  assertClose(asset.parts[0].geometry.uvs, TRIANGLE_UVS);
  assert.equal(asset.warnings.filter(warning => /Resampled baseColorTexture of "Crate" \(material 0\) from 2x2 to 4x4/.test(warning)).length, 1);
  const { map, emissiveMap } = asset.parts[0].material;
  assert.equal(emissiveMap.image.width, 2);
  assert.equal(map.image.width, 4);
  const original = patternBitmap();
  for (const [u, v] of [[0.1, 0.1], [0.3, 0.8], [0.6, 0.2], [0.9, 0.9], [0.45, 0.55]]) {
    const originalTexel = redAt(original, 2 * u, 2 * v);
    assert.equal(redAt(map.image, u, v), originalTexel, `base color at ${u}, ${v}`);
  }
  assert.equal(redAt(emissiveMap.image, 0.1, 0.1), 10);
  assert.equal(redAt(emissiveMap.image, 0.9, 0.9), 40);
});

test('resampled maps stay within four times their source pixels and name the cap', async context => {
  mockPatternBitmap(context);
  const edit = document => {
    tiledBaseWithPlainEmissive(document);
    document.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform.scale = [4, 4];
  };
  const asset = await parseGltf(triangleDocument({ edit }));
  assert.equal(asset.parts[0].material.map.image.width, 4);
  assert.equal(asset.parts[0].material.map.image.height, 4);
  assert.ok(asset.warnings.some(warning => /from 2x2 to 4x4.*capped/.test(warning)));
});

test('maps that cannot be resampled still fail the import, naming the material', async context => {
  mockPatternBitmap(context);
  const clamped = document => {
    tiledBaseWithPlainEmissive(document);
    document.samplers = [{ wrapS: 33071, wrapT: 33071 }];
    document.textures[0].sampler = 0;
  };
  await assert.rejects(parseGltf(triangleDocument({ edit: clamped })), /Crate.*cannot share one UV space/);
  const tiledTwiceAndThrice = document => {
    tiledBaseWithPlainEmissive(document, { extensions: { KHR_texture_transform: { scale: [3, 3] } } });
  };
  await assert.rejects(parseGltf(triangleDocument({ edit: tiledTwiceAndThrice })), /Crate.*cannot share one UV space/);
});
