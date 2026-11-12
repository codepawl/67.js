import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGreyDiffuseOverride, createGreyDiffuseMaterial, GREY_DIFFUSE_ALBEDO } from '../bench/cycles-parity/grey-diffuse-override.mjs';

function buildDescription() {
  return {
    id: 'sample',
    parts: [{ name: 'a', geometry: 0, material: 0 }, { name: 'b', geometry: 1, material: 1 }],
    geometries: [
      { positions: { type: 'Float32Array', base64: 'AA==' }, colors: { type: 'Float32Array', base64: 'AA==' } },
      { positions: { type: 'Float32Array', base64: 'AA==' } },
    ],
    materials: [
      { tag: 'surface', color: [1, 0, 0], metallic: 1, roughness: 0.1, emission: 5, map: { image: { imageId: 0 } } },
      { tag: 'surface', color: [0, 1, 0], transmission: 1, roughness: 0.2, emission: 0 },
    ],
    images: [{ width: 1, height: 1, data: { type: 'Uint8Array', base64: 'AAAAAA==' } }],
    environment: { pointLights: [{ position: [0, 1, 0], intensity: 3 }] },
  };
}

test('grey diffuse override gives every material the same rough, non-metallic, non-emissive grey', () => {
  const overridden = applyGreyDiffuseOverride(buildDescription());
  assert.equal(overridden.materials.length, 2);
  for (const material of overridden.materials) {
    assert.deepEqual(material, createGreyDiffuseMaterial());
    assert.deepEqual(material.color, [GREY_DIFFUSE_ALBEDO, GREY_DIFFUSE_ALBEDO, GREY_DIFFUSE_ALBEDO]);
    assert.equal(material.metallic, 0);
    assert.equal(material.roughness, 1);
    assert.equal(material.emission, 0);
    assert.equal(material.specular, 0);
    assert.equal(material.transmission, undefined);
    assert.equal(material.map, undefined);
  }
});

test('grey diffuse override drops vertex colours and images but keeps parts, geometry and lights', () => {
  const source = buildDescription();
  const overridden = applyGreyDiffuseOverride(source);
  assert.equal(overridden.geometries[0].colors, undefined);
  assert.deepEqual(overridden.geometries[0].positions, source.geometries[0].positions);
  assert.deepEqual(overridden.images, []);
  assert.deepEqual(overridden.parts, source.parts);
  assert.deepEqual(overridden.environment, source.environment);
});

test('grey diffuse override leaves its input untouched and each call returns separate materials', () => {
  const source = buildDescription();
  const snapshot = JSON.stringify(source);
  const overridden = applyGreyDiffuseOverride(source);
  assert.equal(JSON.stringify(source), snapshot);
  assert.notEqual(overridden.materials[0], overridden.materials[1]);
});

test('grey diffuse override names what is missing from a malformed description', () => {
  assert.throws(() => applyGreyDiffuseOverride({ parts: [] }), /materials and geometries/);
});
