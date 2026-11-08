import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { box } from '../src/geometry.js';
import { createMorphPose } from '../src/morph.js';
import { mat4 } from 'gl-matrix';
import { Vector3 } from 'three';

test('exported GLB loads with an independent glTF loader and preserves every part', async () => {
  const parts = createModel();
  const binary = exportGlb(parts);
  const header = new DataView(binary);
  assert.equal(header.getUint32(0, true), 0x46546c67);
  assert.equal(header.getUint32(8, true), binary.byteLength);
  const gltf = await new GLTFLoader().parseAsync(binary, '');
  let meshCount = 0;
  gltf.scene.traverse((node) => { if (node.isMesh) meshCount++; });
  assert.equal(meshCount, parts.length);
  assert.ok(binary.byteLength < 1024 * 1024);
});

test('GLB export writes alpha mode, cutoff, opacity and double-sided so the loader reads them back', async () => {
  const part = createModel()[0];
  const material = { ...part.material, alphaMode: 'mask', alphaCutoff: 0.3, opacity: 0.6, doubleSided: true };
  const gltf = await new GLTFLoader().parseAsync(exportGlb([{ ...part, material }]), '');
  let loaded;
  gltf.scene.traverse((node) => { if (node.isMesh) loaded = node.material; });
  assert.equal(loaded.alphaTest, 0.3);
  assert.equal(loaded.side, 2);
  assert.ok(Math.abs(loaded.opacity - 0.6) < 1e-6);
});

test('GLB export names the fix when textures have no UVs or exceed the size limit', () => {
  const part = createModel()[0];
  const image = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
  const textured = { ...part, material: { ...part.material, map: { image } } };
  assert.throws(() => exportGlb([textured]), /uv_unwrap/);
  const withUvs = { ...textured, geometry: { ...part.geometry, uvs: new Float32Array(part.geometry.positions.length / 3 * 2) } };
  assert.throws(() => exportGlb([withUvs], { maxTextureSize: 2 }), /maxTextureSize 2/);
  assert.ok(exportGlb([withUvs]).byteLength > 0);
});

test('GLB export rejects a skin without joints and skin attributes without a skin', () => {
  const part = createModel()[0];
  assert.throws(() => exportGlb([{ ...part, geometry: { ...part.geometry, skinIndices: new Uint16Array(4) } }]), /[Ss]kin/);
  assert.throws(() => exportGlb([{ ...part, skin: { jointMatrices: new Float32Array(16) } }]), /[Ss]kin/);
});

test('GLB export rejects malformed morph pairs rather than discarding expressions', () => {
  const part = createModel()[0];
  assert.throws(() => exportGlb([{ ...part, morph: { weights: new Float32Array(1) } }]), /target array/);
  assert.throws(() => exportGlb([{ ...part, geometry: { ...part.geometry, morphTargets: [] } }]), /require a morph pose/);
});

test('GLB morph snapshots retain relative channels, shared meshes and independent signed node weights', async () => {
  const geometry = box();
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] = 0.25;
    positions[offset + 1] = 0.125;
    normals[offset + 2] = 0.1;
  }
  geometry.morphTargets = [{ positions }, { normals }];
  const first = createMorphPose(2);
  const second = createMorphPose(2);
  first.weights.set([1.5, -0.5]);
  second.weights.set([-0.25, 0.75]);
  const material = { color: [0.4, 0.5, 0.6], metallic: 0, roughness: 0.7, emission: 0 };
  const parts = [first, second].map((morph, index) => ({ name: `instance ${index}`, geometry, material, morph, matrix: mat4.create() }));
  const binary = exportGlb(parts);
  const view = new DataView(binary);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
  assert.equal(document.meshes.length, 1);
  assert.deepEqual(document.nodes.map(node => node.weights), [[1.5, -0.5], [-0.25, 0.75]]);
  const targets = document.meshes[0].primitives[0].targets;
  assert.deepEqual(Object.keys(targets[0]), ['POSITION']);
  assert.deepEqual(Object.keys(targets[1]), ['NORMAL']);
  assert.deepEqual(document.accessors[targets[0].POSITION].min, [0.25, 0.125, 0]);
  const loaded = await new GLTFLoader().parseAsync(binary, '');
  const meshes = [];
  loaded.scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  assert.equal(meshes.length, 2);
  assert.equal(meshes[0].geometry, meshes[1].geometry);
  assert.deepEqual(meshes.map(mesh => mesh.morphTargetInfluences), [[1.5, -0.5], [-0.25, 0.75]]);
  for (let instance = 0; instance < meshes.length; instance++) {
    // GLTFLoader fills an omitted position channel with the base attribute.
    // Isolate the declared position target when using its CPU vertex helper.
    meshes[instance].morphTargetInfluences[1] = 0;
    const point = meshes[instance].getVertexPosition(0, new Vector3());
    assert.equal(point.x, geometry.positions[0] + parts[instance].morph.weights[0] * positions[0]);
    assert.equal(point.y, geometry.positions[1] + parts[instance].morph.weights[0] * positions[1]);
  }
  first.weights[0] = NaN;
  assert.throws(() => exportGlb(parts), /finite Float32/);
});

function glbDocument(binary) {
  const view = new DataView(binary);
  const jsonLength = view.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, jsonLength)));
  function values(index) {
    const accessor = document.accessors[index];
    const bufferView = document.bufferViews[accessor.bufferView];
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type];
    return Array.from(new Float32Array(binary, 28 + jsonLength + bufferView.byteOffset, accessor.count * components));
  }
  return { document, values };
}

function coloredPart() {
  const geometry = box();
  const colorStorage = new Float32Array(geometry.positions.length + 6).fill(99);
  geometry.colors = colorStorage.subarray(3, colorStorage.length - 3);
  for (let offset = 0; offset < geometry.colors.length; offset += 3) geometry.colors.set([0.125, 0.5, 0.875], offset);
  const uvStorage = new Float32Array(geometry.positions.length / 3 * 2 + 4).fill(99);
  geometry.uvs = uvStorage.subarray(2, uvStorage.length - 2);
  for (let offset = 0; offset < geometry.uvs.length; offset += 2) geometry.uvs.set([-0.25, 2.5], offset);
  return { name: 'editable channels', geometry, matrix: mat4.create(), material: {
    color: [0.25, 0.5, 0.75], metallic: 0.25, roughness: 0.625,
    emissiveColor: new Float32Array([0.875, 0.125, 0.25]), emission: 12.5,
  } };
}

test('GLB keeps editable offset RGB/UV accessors and separate HDR emission with shared meshes', async () => {
  const part = coloredPart();
  const binary = exportGlb([part, { ...part, name: 'shared instance' }]);
  const { document, values } = glbDocument(binary);
  assert.equal(document.meshes.length, 1);
  const attributes = document.meshes[0].primitives[0].attributes;
  assert.equal(document.accessors[attributes.COLOR_0].type, 'VEC3');
  assert.equal(document.accessors[attributes.TEXCOORD_0].type, 'VEC2');
  assert.equal(document.accessors[attributes.TEXCOORD_0].count, part.geometry.positions.length / 3);
  assert.deepEqual(values(attributes.COLOR_0), Array.from(part.geometry.colors));
  assert.deepEqual(values(attributes.TEXCOORD_0), Array.from(part.geometry.uvs));
  assert.deepEqual(document.materials[0].pbrMetallicRoughness.baseColorFactor, [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(document.materials[0].emissiveFactor, [0.875, 0.125, 0.25]);
  assert.equal(document.materials[0].extensions.KHR_materials_emissive_strength.emissiveStrength, 12.5);
  assert.deepEqual(document.extensionsRequired, ['KHR_materials_emissive_strength']);
  const loaded = await new GLTFLoader().parseAsync(binary, '');
  const meshes = [];
  loaded.scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  assert.equal(meshes[0].geometry, meshes[1].geometry);
  assert.deepEqual(Array.from(meshes[0].geometry.attributes.color.array), Array.from(part.geometry.colors));
  assert.deepEqual(Array.from(meshes[0].geometry.attributes.uv.array), Array.from(part.geometry.uvs));
  assert.deepEqual(meshes[0].material.emissive.toArray(), [0.875, 0.125, 0.25]);
  assert.equal(meshes[0].material.emissiveIntensity, 12.5);
  const { parseGltf } = await import('../src/gltf.js');
  const imported = await parseGltf(binary);
  try {
    assert.equal(imported.parts[0].geometry, imported.parts[1].geometry);
    assert.deepEqual(Array.from(imported.parts[0].geometry.colors), Array.from(part.geometry.colors));
    assert.deepEqual(Array.from(imported.parts[0].geometry.uvs), Array.from(part.geometry.uvs));
    assert.deepEqual(imported.parts[0].material.emissiveColor, [0.875, 0.125, 0.25]);
    assert.equal(imported.parts[0].material.emission, 12.5);
  } finally {
    imported.dispose();
  }
});

test('GLB defaults remain dark without extensions and active emission preserves color and scalar', async () => {
  for (const emission of [undefined, 0, 1, 0.25, 1000]) {
    const part = coloredPart();
    delete part.material.emissiveColor;
    part.material.emission = emission;
    const binary = exportGlb([part]);
    const { document } = glbDocument(binary);
    assert.deepEqual(document.materials[0].emissiveFactor, emission ? part.material.color : [0, 0, 0]);
    assert.equal(Boolean(document.extensionsUsed), Boolean(emission && emission !== 1));
    const loaded = await new GLTFLoader().parseAsync(binary, '');
    const material = loaded.scene.children[0].material;
    assert.equal(material.emissive.r * material.emissiveIntensity, part.material.color[0] * (emission ?? 0));
  }
});

test('GLB validates every channel and material before binary allocation without clamping', () => {
  for (const [field, value] of [
    ['colors', new Float32Array(3)], ['colors', new Float64Array(72)],
    ['uvs', new Float32Array(3)], ['uvs', new Float64Array(48)],
    ['positions', new Float64Array(72)], ['normals', new Float32Array(72)],
    ['indices', new Uint16Array([0, 1, 2])], ['indices', new Uint32Array([0, 1, 4294967295])],
  ]) {
    const part = coloredPart();
    part.geometry[field] = value;
    assert.throws(() => exportGlb([part]), /GLB/);
  }
  for (const [field, invalid] of [['colors', NaN], ['colors', -0.01], ['colors', 1.001], ['uvs', Infinity]]) {
    const part = coloredPart();
    part.geometry[field][0] = invalid;
    assert.throws(() => exportGlb([part]), /finite values/);
  }
  for (const [field, invalid] of [
    ['color', [1.001, 0, 0]], ['color', [0, 0]], ['emissiveColor', [0, NaN, 0]],
    ['emissiveColor', [-1, 0, 0]], ['metallic', 1.01], ['roughness', -0.01],
    ['emission', -1], ['emission', Infinity], ['emission', 1e40],
  ]) {
    const part = coloredPart();
    part.material[field] = invalid;
    assert.throws(() => exportGlb([part]), /GLB/);
  }
  const part = coloredPart();
  part.matrix[3] = 1;
  assert.throws(() => exportGlb([part]), /affine/);
  assert.throws(() => exportGlb([]), /nonempty/);
});


test('GLB rejects an invalid later part before allocating its output buffer', () => {
  const valid = coloredPart();
  const invalid = coloredPart();
  invalid.material.emission = Infinity;
  const NativeArrayBuffer = globalThis.ArrayBuffer;
  let allocations = 0;
  globalThis.ArrayBuffer = class extends NativeArrayBuffer {
    constructor(...argumentsList) {
      super(...argumentsList);
      allocations++;
    }
  };
  try {
    assert.throws(() => exportGlb([valid, invalid]), /GLB emission/);
    assert.equal(allocations, 0);
  } finally {
    globalThis.ArrayBuffer = NativeArrayBuffer;
  }
});

test('GLB scans shared static geometry once while preserving different instance materials', () => {
  const part = coloredPart();
  const positions = part.geometry.positions;
  let reads = 0;
  Object.defineProperty(part.geometry, 'positions', { get() { reads++; return positions; } });
  exportGlb([part]);
  const singleReads = reads;
  reads = 0;
  const second = { ...part, material: { ...part.material, emissiveColor: [0.125, 0.875, 0.25] } };
  const { document } = glbDocument(exportGlb([part, second]));
  assert.equal(reads, singleReads);
  assert.equal(document.meshes.length, 2);
  assert.equal(document.meshes[0].primitives[0].attributes.COLOR_0, document.meshes[1].primitives[0].attributes.COLOR_0);
  assert.deepEqual(document.materials.map(material => material.emissiveFactor), [[0.875, 0.125, 0.25], [0.125, 0.875, 0.25]]);
});

test('GLB rejects shear and zero scales before output allocation', () => {
  for (const [offset, value, message] of [[4, 0.5, /shear/], [0, 0, /nonzero scales/], [0, 1e-50, /nonzero scales/]]) {
    const part = coloredPart();
    part.matrix = Array.from(part.matrix);
    part.matrix[offset] = value;
    const NativeArrayBuffer = globalThis.ArrayBuffer;
    let allocations = 0;
    globalThis.ArrayBuffer = class extends NativeArrayBuffer {
      constructor(...argumentsList) {
        super(...argumentsList);
        allocations++;
      }
    };
    try {
      assert.throws(() => exportGlb([part]), message);
      assert.equal(allocations, 0);
    } finally {
      globalThis.ArrayBuffer = NativeArrayBuffer;
    }
  }
  const scaledShear = coloredPart();
  mat4.scale(scaledShear.matrix, scaledShear.matrix, [1e-25, 2e-25, 3e-25]);
  scaledShear.matrix[4] = 1e-25;
  assert.throws(() => exportGlb([scaledShear]), /shear/);
});

test('GLB Float32 rotated nonuniform, reflected and tiny TRS transforms roundtrip through Three', async () => {
  for (const scale of [[0.125, 7, 2.5], [-0.125, 7, 2.5], [0.125, -7, -2.5], [1e-30, 2e-25, -3e-20]]) {
    const part = coloredPart();
    mat4.translate(part.matrix, part.matrix, [0.25, -1.5, 3]);
    mat4.rotateX(part.matrix, part.matrix, 0.47);
    mat4.rotateY(part.matrix, part.matrix, -0.71);
    mat4.rotateZ(part.matrix, part.matrix, 1.13);
    mat4.scale(part.matrix, part.matrix, scale);
    const binary = exportGlb([part]);
    assert.deepEqual(glbDocument(binary).document.nodes[0].matrix, Array.from(part.matrix, value => value === 0 ? 0 : value));
    const loaded = await new GLTFLoader().parseAsync(binary, '');
    loaded.scene.updateMatrixWorld(true);
    const actual = loaded.scene.children[0].matrix.elements;
    for (let column = 0; column < 4; column++) {
      const magnitude = Math.max(...Array.from(part.matrix.slice(column * 4, column * 4 + 4), Math.abs));
      for (let row = 0; row < 4; row++) {
        const offset = column * 4 + row;
        assert.ok(Number.isFinite(actual[offset]));
        assert.ok(Math.abs(actual[offset] - part.matrix[offset]) <= magnitude * 1e-6, `scale ${scale}, component ${offset}`);
      }
    }
  }
});

test('GLB export writes an additive material as BLEND because glTF has no additive mode', async () => {
  const part = createModel()[0];
  const material = { ...part.material, alphaMode: 'add', opacity: 0.5 };
  const gltf = await new GLTFLoader().parseAsync(exportGlb([{ ...part, material }]), '');
  let loaded;
  gltf.scene.traverse((node) => { if (node.isMesh) loaded = node.material; });
  assert.equal(loaded.transparent, true);
  assert.ok(Math.abs(loaded.opacity - 0.5) < 1e-6);
});
