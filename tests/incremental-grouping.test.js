import assert from 'node:assert/strict';
import test from 'node:test';
import { groupParts, groupPartsIncrementally } from '../src/renderer.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const makeGeometry = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
});
const materials = [0, 1, 2].map(index => ({ color: [index / 3, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 }));
const geometries = Array.from({ length: 6 }, makeGeometry);
const makePart = (index, geometry) => ({ name: `part ${index}`, geometry, matrix: identity(), material: materials[index % materials.length] });
const worldParts = Array.from({ length: 30 }, (_, index) => makePart(index, geometries[Math.floor(index / 5)]));

const sameBatches = (left, right) => left.length === right.length && left.every((batch, index) => batch.length === right[index].length && batch.every((part, position) => part === right[index][position]));

test('growing a world by whole geometries groups exactly as groupParts does', () => {
  let state = null;
  for (let end = 5; end <= worldParts.length; end += 5) {
    const prefix = worldParts.slice(0, end);
    const grouped = groupPartsIncrementally(state, prefix);
    assert.ok(sameBatches(grouped.batches, groupParts(prefix)), `prefix of ${end} parts`);
    state = grouped.state;
  }
});

test('a slice that shares a geometry with earlier parts falls back to grouping everything', () => {
  const first = worldParts.slice(0, 10);
  const grouped = groupPartsIncrementally(null, first);
  const sharing = [...first, makePart(100, geometries[0])];
  const next = groupPartsIncrementally(grouped.state, sharing);
  assert.ok(sameBatches(next.batches, groupParts(sharing)));
});

test('removed or reordered parts fall back to grouping everything', () => {
  const grouped = groupPartsIncrementally(null, worldParts.slice(0, 15));
  const reordered = [worldParts[1], worldParts[0], ...worldParts.slice(2, 20)];
  assert.ok(sameBatches(groupPartsIncrementally(grouped.state, reordered).batches, groupParts(reordered)));
  const shorter = worldParts.slice(0, 5);
  assert.ok(sameBatches(groupPartsIncrementally(grouped.state, shorter).batches, groupParts(shorter)));
});

test('without batching every part keeps its own group', () => {
  const grouped = groupPartsIncrementally(null, worldParts.slice(0, 10), false);
  const next = groupPartsIncrementally(grouped.state, worldParts.slice(0, 20), false);
  assert.ok(sameBatches(next.batches, groupParts(worldParts.slice(0, 20), false)));
});

test('an invalid appended part still throws', () => {
  const grouped = groupPartsIncrementally(null, worldParts.slice(0, 5));
  const broken = { ...makePart(200, geometries[5]), matrix: new Float32Array(3) };
  assert.throws(() => groupPartsIncrementally(grouped.state, [...worldParts.slice(0, 5), broken]));
});
