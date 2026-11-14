import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from '../src/lighting.js';

const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function triangleDocument(edit = () => {}) {
  const bytes = new Uint8Array(TRIANGLE_POSITIONS.buffer);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Triangle', mesh: 0 }],
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 0.125, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  };
  edit(document);
  return JSON.stringify(document);
}

function addLights(document, lights, nodeEdits = []) {
  document.extensionsUsed = ['KHR_lights_punctual'];
  document.extensions = { KHR_lights_punctual: { lights } };
  lights.forEach((light, index) => {
    document.nodes.push({ name: `Light ${index}`, ...nodeEdits[index], extensions: { KHR_lights_punctual: { light: index } } });
    document.scenes[0].nodes.push(document.nodes.length - 1);
  });
}

test('a file that only lists KHR_lights_punctual, KHR_materials_unlit or EXT_texture_avif loads', async () => {
  for (const extension of ['KHR_lights_punctual', 'KHR_materials_unlit']) {
    const asset = await parseGltf(triangleDocument(document => { document.extensionsUsed = [extension]; }));
    assert.equal(asset.parts.length, 1);
    assert.deepEqual(asset.warnings, []);
  }
  const avif = await parseGltf(triangleDocument(document => { document.extensionsUsed = ['EXT_texture_avif']; }));
  assert.equal(avif.parts.length, 1);
  assert.deepEqual(avif.warnings, ['EXT_texture_avif is accepted but not rendered.']);
});

test('an optional extension that Crucible does not know is ignored and named in the warnings', async () => {
  const asset = await parseGltf(triangleDocument(document => {
    document.extensionsUsed = ['VENDOR_made_up'];
    document.materials[0].extensions = { VENDOR_made_up: {} };
  }));
  assert.deepEqual(asset.warnings, ['VENDOR_made_up is accepted but not rendered.']);
});

test('an unknown extension in extensionsRequired is still refused', async () => {
  const data = triangleDocument(document => {
    document.extensionsUsed = ['VENDOR_made_up'];
    document.extensionsRequired = ['VENDOR_made_up'];
  });
  await assert.rejects(parseGltf(data), /Unsupported glTF extension: VENDOR_made_up\./);
});

test('line and point primitives are skipped with a warning that names the mesh', async () => {
  const asset = await parseGltf(triangleDocument(document => {
    document.meshes[0].primitives.push({ attributes: { POSITION: 0 }, mode: 1 }, { attributes: { POSITION: 0 }, mode: 0 });
  }));
  assert.equal(asset.parts.length, 1);
  assert.deepEqual(asset.warnings, ['Skipped 1 LINES, 1 POINTS primitive(s) in mesh "Body": Crucible draws triangles only.']);
});

test('a file with only line primitives has nothing to draw and says so', async () => {
  const data = triangleDocument(document => { document.meshes[0].primitives[0].mode = 3; });
  await assert.rejects(parseGltf(data), /no supported triangle meshes/);
});

test('triangle strips and fans are still refused', async () => {
  const data = triangleDocument(document => { document.meshes[0].primitives[0].mode = 5; });
  await assert.rejects(parseGltf(data), /Only glTF TRIANGLES primitives are supported/);
});

test('KHR_materials_unlit becomes the unlit tag and keeps only the base color', async () => {
  const asset = await parseGltf(triangleDocument(document => {
    document.extensionsUsed = ['KHR_materials_unlit'];
    document.materials[0].extensions = { KHR_materials_unlit: {} };
    document.materials[0].emissiveFactor = [1, 0, 0];
  }));
  const material = asset.parts[0].material;
  assert.equal(material.tag, 'unlit');
  assert.deepEqual(material.color, [0.5, 0.25, 0.125]);
  assert.equal(material.emission, 0);
  assert.deepEqual(asset.warnings, []);
});

test('KHR_lights_punctual lights map onto point, spot and key light options', async () => {
  const asset = await parseGltf(triangleDocument(document => addLights(document, [
    { type: 'point', color: [1, 0.5, 0.25], intensity: 40, range: 12, name: 'Lamp' },
    { type: 'spot', intensity: 90, spot: { innerConeAngle: 0.2, outerConeAngle: 0.8 } },
    { type: 'directional', color: [1, 1, 0.5], intensity: 3 },
  ], [{ translation: [1, 2, 3] }, { translation: [0, 4, 0], rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }, {}])));
  const { pointLights, spotLights, keyColor, lightDirection, keyIntensity } = asset.lights;
  assert.equal(pointLights.length, 1);
  assert.deepEqual(pointLights[0].position, [1, 2, 3]);
  assert.deepEqual(pointLights[0].color, [1, 0.5, 0.25]);
  assert.equal(pointLights[0].intensity, 40);
  assert.equal(pointLights[0].range, 12);
  assert.equal(spotLights.length, 1);
  assert.deepEqual(spotLights[0].position, [0, 4, 0]);
  assert.ok(Math.abs(spotLights[0].direction[1] + 1) < 1e-6, 'a spot turned to face down shines along -Y');
  assert.equal(spotLights[0].angle, 0.8);
  assert.ok(Math.abs(spotLights[0].penumbra - 0.75) < 1e-6);
  assert.deepEqual(keyColor, [3, 3, 1.5]);
  assert.deepEqual(lightDirection, [0, 0, 1], 'the key direction points toward the light, against its travel along -Z');
  assert.equal(keyIntensity, 1);
  assert.deepEqual(asset.warnings, []);
});

test('lights beyond the renderer limits are skipped, each with a warning', async () => {
  const lights = Array.from({ length: MAX_POINT_LIGHTS + 2 }, () => ({ type: 'point' }));
  lights.push(...Array.from({ length: MAX_SPOT_LIGHTS + 1 }, () => ({ type: 'spot' })));
  lights.push({ type: 'directional' }, { type: 'directional', name: 'Second sun' }, { type: 'spot', spot: { innerConeAngle: 1, outerConeAngle: 0.5 } });
  const asset = await parseGltf(triangleDocument(document => addLights(document, lights)));
  assert.equal(asset.lights.pointLights.length, MAX_POINT_LIGHTS);
  assert.equal(asset.warnings.filter(warning => warning.includes(`at most ${MAX_POINT_LIGHTS} point lights`)).length, 2);
  assert.equal(asset.warnings.filter(warning => /Second sun/.test(warning)).length, 1);
  assert.equal(asset.warnings.filter(warning => /cone angles are invalid/.test(warning)).length, 1);
  assert.equal(asset.lights.spotLights.length, MAX_SPOT_LIGHTS);
  assert.equal(asset.warnings.filter(warning => warning.includes(`at most ${MAX_SPOT_LIGHTS} spot lights`)).length, 1);
});

test('a file without lights returns an empty lights object', async () => {
  const asset = await parseGltf(triangleDocument());
  assert.deepEqual(asset.lights, {});
});
