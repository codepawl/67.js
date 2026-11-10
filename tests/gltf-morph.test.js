import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

function morphAsset(edit = () => {}, jsonOnly = false) {
  const chunks = [];
  let byteLength = 0;
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'First', mesh: 0 }, { name: 'Second', mesh: 0, translation: [2, 0, 0] }],
    meshes: [{ primitives: [{ attributes: {} }] }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  function append(values, type) {
    const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const index = document.accessors.length;
    chunks.push(values);
    document.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: values.byteLength });
    byteLength += Math.ceil(values.byteLength / 4) * 4;
    document.buffers[0].byteLength = byteLength;
    const accessor = { bufferView: index, componentType: 5126, count: values.length / components, type };
    if (type === 'SCALAR') {
      accessor.min = [Math.min(...values)];
      accessor.max = [Math.max(...values)];
    }
    document.accessors.push(accessor);
    return index;
  }
  const primitive = document.meshes[0].primitives[0];
  primitive.attributes.POSITION = append(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3');
  Object.assign(document.accessors[0], { min: [0, 0, 0], max: [1, 1, 0] });
  primitive.attributes.NORMAL = append(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3');
  const positions = append(new Float32Array([0, 0, 0, 0, 0, 0, 0, 1, 0]), 'VEC3');
  Object.assign(document.accessors[positions], { min: [0, 0, 0], max: [0, 1, 0] });
  const normals = append(new Float32Array([0, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0]), 'VEC3');
  primitive.targets = [{ POSITION: positions }, { NORMAL: normals }];
  edit(document, append, chunks);
  const binary = new Uint8Array(byteLength);
  chunks.forEach((chunk, index) => binary.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), document.bufferViews[index].byteOffset));
  if (jsonOnly) {
    document.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(binary).toString('base64')}`;
    return JSON.stringify(document);
  }
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + byteLength);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, byteLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength);
  return result;
}

function addWeightsClip(document, append, interpolation = 'LINEAR', values = [0, 0, 1, -1]) {
  const input = append(new Float32Array([0, 2]), 'SCALAR');
  const output = append(new Float32Array(values), 'SCALAR');
  document.animations = [{ samplers: [{ input, output, interpolation }], channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }] }];
}

test('GLB imports relative channels with missing zeros, independent node defaults and shared geometry', async () => {
  const asset = await parseGltf(morphAsset(document => {
    document.meshes[0].weights = [-0.25, 0.5];
    document.nodes[0].weights = [0.75, -1];
  }));
  const [first, second] = asset.parts;
  assert.equal(first.geometry, second.geometry);
  assert.notEqual(first.morph, second.morph);
  assert.notEqual(first.morph.weights, second.morph.weights);
  assert.deepEqual(Array.from(first.morph.weights), [0.75, -1]);
  assert.deepEqual(Array.from(second.morph.weights), [-0.25, 0.5]);
  assert.equal(first.geometry.morphTargets[0].normals, undefined);
  assert.equal(first.geometry.morphTargets[1].positions, undefined);
  assert.deepEqual(Array.from(first.geometry.morphTargets[0].positions), [0, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.ok(Math.abs(first.geometry.morphTargets[1].normals[1] - 0.2) < 1e-7);
  first.morph.weights[0] = -2;
  assert.equal(second.morph.weights[0], -0.25);
  asset.dispose();
});

for (const scene of [0, 1]) {
  test(`selected scene ${scene} preserves morph primitive declarations after association reduction`, async () => {
    const asset = await parseGltf(morphAsset(document => {
      document.scenes = [{ nodes: [0] }, { nodes: [1] }];
      document.scene = scene;
      document.nodes[0].weights = [0.25, -0.5];
      document.nodes[1].weights = [-0.75, 1];
    }));
    assert.equal(asset.parts.length, 1);
    assert.equal(asset.parts[0].name, scene === 0 ? 'First' : 'Second');
    assert.deepEqual(Array.from(asset.parts[0].morph.weights), scene === 0 ? [0.25, -0.5] : [-0.75, 1]);
    assert.equal(asset.parts[0].geometry.morphTargets[0].normals, undefined);
    assert.equal(asset.parts[0].geometry.morphTargets[1].positions, undefined);
    asset.dispose();
  });
  test(`selected scene ${scene} still imports ordinary meshes without morph targets`, async () => {
    const asset = await parseGltf(morphAsset(document => {
      document.scenes = [{ nodes: [0] }, { nodes: [1] }];
      document.scene = scene;
      delete document.meshes[0].primitives[0].targets;
    }));
    assert.equal(asset.parts.length, 1);
    assert.equal(asset.parts[0].morph, undefined);
    assert.equal(asset.parts[0].matrix[12], scene * 2);
    asset.dispose();
  });
}

test('multi-scene multi-primitive mappings retain each distinct morph channel declaration, including cloned scene roots', async () => {
  for (const scene of [0, 1]) {
    const asset = await parseGltf(morphAsset(document => {
      document.scenes = [{ nodes: [0] }, { nodes: [0] }];
      document.scene = scene;
      const original = document.meshes[0].primitives[0];
      document.meshes[0].primitives.push({ attributes: { ...original.attributes }, targets: [{ NORMAL: 3 }, { POSITION: 2 }] });
    }));
    assert.equal(asset.parts.length, 2);
    const [first, second] = asset.parts;
    assert.ok(first.geometry.morphTargets[0].positions);
    assert.equal(first.geometry.morphTargets[0].normals, undefined);
    assert.equal(second.geometry.morphTargets[0].positions, undefined);
    assert.ok(second.geometry.morphTargets[0].normals);
    assert.ok(second.geometry.morphTargets[1].positions);
    assert.equal(second.geometry.morphTargets[1].normals, undefined);
    asset.dispose();
  }
});

test('only the selected scene is decoded', async () => {
  const asset = await parseGltf(morphAsset((document, append) => {
    document.scenes = [{ nodes: [0] }, { nodes: [1] }];
    const positions = append(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), 'VEC3');
    Object.assign(document.accessors[positions], { min: [0, 0, 0], max: [2, 2, 0] });
    document.meshes.push({ primitives: [{ attributes: { POSITION: positions, NORMAL: 1 } }] });
    document.nodes.push({ name: 'Orphan', mesh: 1 });
  }));
  assert.equal(asset.parts.length, 1);
  assert.equal(asset.nodes.length, 1);
  asset.dispose();
});

test('embedded glTF JSON defaults omitted node and mesh weights to retained zeros', async () => {
  const previous = globalThis.ProgressEvent;
  globalThis.ProgressEvent ??= class { constructor(type) { this.type = type; } };
  try {
    const asset = await parseGltf(morphAsset(() => {}, true));
    assert.ok(asset.parts[0].morph.weights instanceof Float32Array);
    assert.deepEqual(Array.from(asset.parts[0].morph.weights), [0, 0]);
    asset.dispose();
  } finally {
    if (previous === undefined) delete globalThis.ProgressEvent;
    else globalThis.ProgressEvent = previous;
  }
});

for (const [interpolation, values, expected] of [
  ['LINEAR', [0, 0, 1, -1], [0.5, -0.5]],
  ['STEP', [0, 0, 1, -1], [0, 0]],
  ['CUBICSPLINE', [0, 0, 0, 0, 2, 0, 0, 0, 1, -1, 0, 0], [1, -0.5]],
]) {
  test(`${interpolation} weights animation uses loader interpolation and repeated absolute seeks`, async () => {
    const asset = await parseGltf(morphAsset((document, append) => addWeightsClip(document, append, interpolation, values)));
    const weights = asset.parts[0].morph.weights;
    const matrix = asset.parts[0].matrix;
    asset.applyAnimation(1);
    assert.deepEqual(Array.from(weights), expected);
    asset.applyAnimation(2);
    assert.deepEqual(Array.from(weights), [1, -1]);
    asset.applyAnimation(0.1);
    asset.applyAnimation(1);
    assert.deepEqual(Array.from(weights), expected);
    assert.equal(asset.parts[0].morph.weights, weights);
    assert.equal(asset.parts[0].matrix, matrix);
    assert.deepEqual(Array.from(asset.parts[1].morph.weights), [0, 0]);
    asset.applyAnimation(-1);
    assert.deepEqual(Array.from(weights), [0, 0]);
    asset.dispose();
  });
}

test('morphs compose with skin palettes and invalid samples publish no matrix, palette or weights', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    const primitive = document.meshes[0].primitives[0];
    const delta = append(new Float32Array(18).fill(2), 'VEC3');
    Object.assign(document.accessors[delta], { min: [2, 2, 2], max: [2, 2, 2] });
    primitive.targets = [{ POSITION: delta }];
    const input = document.animations[0].samplers[0].input;
    const output = append(new Float32Array([0.5, 3e38]), 'SCALAR');
    document.animations[0].samplers.push({ input, output, interpolation: 'STEP' });
    document.animations[0].channels.push({ sampler: 1, target: { node: 1, path: 'weights' } });
  }));
  const part = asset.parts[0];
  assert.ok(part.skin && part.morph);
  asset.applyAnimation(1);
  const matrix = Array.from(part.matrix);
  const palette = Array.from(part.skin.jointMatrices);
  const weights = Array.from(part.morph.weights);
  assert.equal(weights[0], 0.5);
  assert.ok(Math.abs(part.skin.jointMatrices[16 + 1]) > 0.5);
  assert.throws(() => asset.applyAnimation(2), /Float32 position/);
  assert.deepEqual(Array.from(part.matrix), matrix);
  assert.deepEqual(Array.from(part.skin.jointMatrices), palette);
  assert.deepEqual(Array.from(part.morph.weights), weights);
  asset.applyAnimation(0);
  asset.applyAnimation(1);
  assert.deepEqual(Array.from(part.skin.jointMatrices), palette);
  assert.deepEqual(Array.from(part.morph.weights), weights);
  asset.dispose();
});

test('target expansion and primitive instance budgets reject before decoding', async () => {
  await assert.rejects(parseGltf(morphAsset(), { maxVertices: 8 }), /maxVertices/);
  await assert.rejects(parseGltf(morphAsset(document => {
    document.meshes[0].primitives = Array.from({ length: 3 }, () => document.meshes[0].primitives[0]);
  }), { maxParts: 2 }), /maxParts/);
  const repeated = morphAsset((document, append) => {
    const primitive = document.meshes[0].primitives[0];
    const positions = append(new Float32Array(900), 'VEC3');
    Object.assign(document.accessors[positions], { min: [0, 0, 0], max: [0, 0, 0] });
    const normals = new Float32Array(900);
    for (let index = 2; index < normals.length; index += 3) normals[index] = 1;
    primitive.attributes = { POSITION: positions, NORMAL: append(normals, 'VEC3') };
    primitive.targets = Array.from({ length: 64 }, () => ({ POSITION: positions }));
  });
  await assert.rejects(parseGltf(repeated, { maxBytes: repeated.byteLength }), /decoded accessor bytes/);
});

test('composed world bounds and changed public identities fail before any part publishes', async () => {
  const asset = await parseGltf(morphAsset((document, append) => {
    document.nodes[0].scale = [2e38, 2e38, 2e38];
    addWeightsClip(document, append, 'STEP', [0, 0, 2, 0]);
    const output = append(new Float32Array([2, 0, 0, 4, 0, 0]), 'VEC3');
    document.animations[0].samplers.push({ input: 4, output, interpolation: 'LINEAR' });
    document.animations[0].channels.push({ sampler: 1, target: { node: 1, path: 'translation' } });
  }));
  asset.applyAnimation(1);
  const previous = asset.parts.map(part => ({ matrix: Array.from(part.matrix), weights: Array.from(part.morph.weights) }));
  assert.throws(() => asset.applyAnimation(2), /Morph world position/);
  asset.parts.forEach((part, index) => {
    assert.deepEqual(Array.from(part.matrix), previous[index].matrix);
    assert.deepEqual(Array.from(part.morph.weights), previous[index].weights);
  });
  const weights = asset.parts[1].morph.weights;
  asset.parts[1].morph.weights = new Float32Array(weights);
  assert.throws(() => asset.applyAnimation(0), /weight identity/);
  assert.deepEqual(Array.from(asset.parts[0].matrix), previous[0].matrix);
  asset.parts[1].morph.weights = weights;
  asset.applyAnimation(1);
  assert.deepEqual(Array.from(asset.parts[1].matrix), previous[1].matrix);
  asset.dispose();
});

test('clip switches restore untracked instance defaults before later weight seeks', async () => {
  const asset = await parseGltf(morphAsset((document, append) => {
    document.nodes[0].weights = [-0.25, 0.5];
    addWeightsClip(document, append);
    const translation = append(new Float32Array([0, 0, 0, 2, 0, 0]), 'VEC3');
    document.animations.push({ samplers: [{ input: 4, output: translation }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] });
  }));
  asset.applyAnimation(1, 0);
  assert.deepEqual(Array.from(asset.parts[0].morph.weights), [0.5, -0.5]);
  asset.applyAnimation(1, 1);
  assert.deepEqual(Array.from(asset.parts[0].morph.weights), [-0.25, 0.5]);
  assert.equal(asset.parts[0].matrix[12], 1);
  asset.applyAnimation(1, 0);
  assert.deepEqual(Array.from(asset.parts[0].morph.weights), [0.5, -0.5]);
  assert.equal(asset.parts[0].matrix[12], 0);
  asset.dispose();
});

test('exactly 64 targets import and larger counts reject explicitly', async () => {
  const asset = await parseGltf(morphAsset(document => {
    document.meshes[0].primitives[0].targets = Array.from({ length: 64 }, () => ({ POSITION: 2 }));
  }));
  assert.equal(asset.parts[0].morph.weights.length, 64);
  assert.equal(asset.parts[0].geometry.morphTargets.length, 64);
  asset.dispose();
  await assert.rejects(parseGltf(morphAsset(document => {
    document.meshes[0].primitives[0].targets = Array.from({ length: 65 }, () => ({ POSITION: 2 }));
  })), /64/);
});

test('malformed deltas, defaults, accessor shapes and all animation channels reject', async () => {
  const cases = [
    document => { document.meshes[0].primitives[0].targets[0] = { TANGENT: 2 }; },
    document => { document.meshes[0].primitives[0].targets[0] = {}; },
    document => { document.accessors[2].type = 'VEC4'; },
    document => { document.accessors[2].count = 2; },
    document => { document.accessors[2].componentType = 5123; },
    document => { document.accessors[2].normalized = true; },
    document => { delete document.accessors[2].min; },
    document => { delete document.meshes[0].primitives[0].attributes.NORMAL; },
    document => { document.meshes[0].primitives.push({ attributes: { POSITION: 0, NORMAL: 1 }, targets: [{ POSITION: 2 }] }); },
    document => { document.meshes[0].weights = [0]; },
    document => { document.nodes[0].weights = [1e39, 0]; },
    (document, append) => { addWeightsClip(document, append); document.animations[0].samplers[0].output = 0; },
    (document, append) => { addWeightsClip(document, append); document.nodes[0].mesh = undefined; },
    (document, append) => { addWeightsClip(document, append); document.animations[0].channels[0].target.node = 99; },
    (document, append) => { addWeightsClip(document, append); document.animations[0].samplers[0].interpolation = 'BEZIER'; },
    (document, append, chunks) => { addWeightsClip(document, append); chunks[4][1] = 0; },
    (document, append, chunks) => { addWeightsClip(document, append); chunks[5][0] = Infinity; },
    (document, append) => { addWeightsClip(document, append); document.animations[0].channels.push({ ...document.animations[0].channels[0] }); },
    (document, append) => { addWeightsClip(document, append); document.animations.push({ samplers: [{ input: 4, output: 0 }], channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }] }); },
  ];
  for (const edit of cases) await assert.rejects(parseGltf(morphAsset(edit)));
});
