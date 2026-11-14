import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { CrucibleRenderer } from '../src/renderer.js';

// This file never imports the replace-textured-parts addon, so the core has no texture bookkeeping registered.
test('adding a textured part without the addon names the import to add', () => {
  const renderer = Object.create(CrucibleRenderer.prototype);
  renderer.groundPart = null;
  renderer.batching = true;
  renderer.geometryBuffers = new Map();
  renderer.partLocations = new Map();
  const geometry = { ...box(), uvs: new Float32Array(box().positions.length / 3 * 2) };
  const textured = { name: 'textured', geometry, matrix: mat4.create(), material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5, map: { image: { width: 1, height: 1 } } } };
  assert.throws(() => renderer.replaceParts([textured]), /import replace-textured-parts/);
});
