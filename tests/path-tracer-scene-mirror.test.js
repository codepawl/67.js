import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCopyScene } from '../bench/instancing/copies-scene.mjs';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const COPIES = 8;

function sceneDigest(scene) {
  const hash = createHash('sha256');
  for (const name of ['positions', 'normals', 'uvs', 'colors', 'indices', 'triangleMaterial']) {
    hash.update(Buffer.from(scene[name].buffer, scene[name].byteOffset, scene[name].byteLength));
  }
  return hash.digest('hex');
}

// Every triangle's cross-product normal, dotted with the mean of its three vertex normals.
function windingAgreement(scene) {
  const { positions, normals, indices } = scene;
  const agreements = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const [first, second, third] = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
    const edgeOne = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
    const edgeTwo = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
    const cross = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    let agreement = 0;
    for (let axis = 0; axis < 3; axis++) agreement += cross[axis] * (normals[first + axis] + normals[second + axis] + normals[third + axis]);
    agreements.push(agreement);
  }
  return agreements;
}

for (const variant of ['translate', 'rotscale', 'mirror', 'mirror-rotscale']) {
  test(`${variant} copies flatten with a cross-product normal that agrees with the vertex normals`, () => {
    const { parts, environment } = buildCopyScene(variant, COPIES);
    const agreements = windingAgreement(buildTraceScene(parts, environment));
    assert.ok(agreements.length > 0);
    assert.ok(agreements.every(agreement => agreement > 0), `${agreements.filter(agreement => agreement <= 0).length} triangles face inward`);
  });
}

test('a mirrored part swaps the last two corners of each triangle and keeps its first corner', () => {
  const { geometry, parts, environment } = buildCopyScene('mirror', 1);
  const scene = buildTraceScene(parts, environment);
  for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
    assert.equal(scene.indices[triangle * 3], geometry.indices[triangle * 3]);
    assert.equal(scene.indices[triangle * 3 + 1], geometry.indices[triangle * 3 + 2]);
    assert.equal(scene.indices[triangle * 3 + 2], geometry.indices[triangle * 3 + 1]);
  }
});

// Digests of the scene built before mirrored parts changed winding: scenes without a mirrored part stay byte identical.
const UNMIRRORED_DIGESTS = {
  translate: '4916b01dfdf073757660a7ff31385c8ee3bce96c00e0d36b8eb805692d4e4fb9',
  rotscale: '2c6fa5d10f9598ae5e27cf2f641bf2468384d836a470fffac25b943dc01e53d6',
};

for (const [variant, expected] of Object.entries(UNMIRRORED_DIGESTS)) {
  test(`${variant} copies build the same trace scene bytes as before`, () => {
    const { parts, environment } = buildCopyScene(variant, COPIES);
    assert.equal(sceneDigest(buildTraceScene(parts, environment)), expected);
  });
}
