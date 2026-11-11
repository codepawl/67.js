import assert from 'node:assert/strict';
import test from 'node:test';
import { groupParts, groupPartsIncrementally, groupWorld } from '../src/renderer.js';

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

const floorPart = { name: 'floor', geometry: makeGeometry(), matrix: identity(), material: materials[0] };
const sharingFloor = { name: 'shared floor', geometry: geometries[2], matrix: identity(), material: materials[0] };

test('groupWorld with a floor and growing prefixes builds the batches of one full grouping', () => {
  let state = null;
  for (let end = 5; end <= worldParts.length; end += 5) {
    const prefix = worldParts.slice(0, end);
    const grouped = groupWorld(state, prefix, floorPart, true, true);
    assert.ok(sameBatches(grouped.batches, groupParts([...prefix, floorPart])), `prefix of ${end} parts`);
    state = grouped.state;
  }
  assert.equal(state.parts.includes(floorPart), false, 'the floor is not part of the kept state');
});

test('groupWorld puts a floor that shares a geometry with a world part into that batch, as before', () => {
  let state = null;
  for (let end = 5; end <= worldParts.length; end += 5) {
    const prefix = worldParts.slice(0, end);
    const grouped = groupWorld(state, prefix, sharingFloor, true, true);
    assert.ok(sameBatches(grouped.batches, groupParts([...prefix, sharingFloor])), `prefix of ${end} parts`);
    state = grouped.state;
  }
});

test('groupWorld without retainedUnchanged groups the whole list and keeps no state', () => {
  const kept = groupWorld(null, worldParts.slice(0, 10), floorPart, true, true);
  const whole = groupWorld(kept.state, worldParts.slice(0, 20), floorPart, true, false);
  assert.ok(sameBatches(whole.batches, groupParts([...worldParts.slice(0, 20), floorPart])));
  assert.equal(whole.state, null);
  const withoutFloor = groupWorld(kept.state, worldParts.slice(0, 20), null, true, false);
  assert.ok(sameBatches(withoutFloor.batches, groupParts(worldParts.slice(0, 20))));
});

test('groupWorld without a floor returns the incremental grouping as it is', () => {
  const first = groupWorld(null, worldParts.slice(0, 10), null, true, true);
  const next = groupWorld(first.state, worldParts.slice(0, 20), null, true, true);
  assert.ok(sameBatches(next.batches, groupParts(worldParts.slice(0, 20))));
});

// A small seeded generator keeps the random part sets the same on every run.
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const randomMaterials = [
  ...materials,
  { color: [0.2, 0.2, 0.2], metallic: 0, roughness: 0.5, emission: 0, alphaMode: 'blend', opacity: 0.5 },
  { color: [0.9, 0.9, 0.9], metallic: 1, roughness: 0.1, emission: 0.5 },
];

function makeRandomParts(random, count, sharedGeometries) {
  return Array.from({ length: count }, (_, index) => {
    const part = makePart(index, sharedGeometries[Math.floor(random() * sharedGeometries.length)]);
    part.material = randomMaterials[Math.floor(random() * randomMaterials.length)];
    if (random() < 0.3) part.castShadow = false;
    return part;
  });
}

test('growing random part sets in random slices builds the batches of one full grouping', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = makeRandom(seed);
    const sharedGeometries = Array.from({ length: 1 + Math.floor(random() * 8) }, makeGeometry);
    const parts = makeRandomParts(random, 1 + Math.floor(random() * 120), sharedGeometries);
    let state = null;
    let end = 0;
    while (end < parts.length) {
      end = Math.min(parts.length, end + 1 + Math.floor(random() * 25));
      const grouped = groupPartsIncrementally(state, parts.slice(0, end));
      assert.ok(sameBatches(grouped.batches, groupParts(parts.slice(0, end))), `seed ${seed}, ${end} parts`);
      state = grouped.state;
    }
  }
});

test('a slice that fails validation leaves the next call to group everything', () => {
  const grouped = groupPartsIncrementally(null, worldParts.slice(0, 10));
  const broken = { ...makePart(300, geometries[0]), matrix: new Float32Array(3) };
  assert.throws(() => groupPartsIncrementally(grouped.state, [...worldParts.slice(0, 10), makePart(301, geometries[0]), broken]));
  const retry = [...worldParts.slice(0, 10), makePart(302, geometries[0])];
  assert.ok(sameBatches(groupPartsIncrementally(grouped.state, retry).batches, groupParts(retry)));
});

test('a slice that shares geometries and keys with earlier parts joins their batches', () => {
  const first = worldParts.slice(0, 10);
  const grouped = groupPartsIncrementally(null, first);
  const batchCount = grouped.batches.length;
  const joining = makePart(400, first[0].geometry);
  joining.material = first[0].material;
  const next = groupPartsIncrementally(grouped.state, [...first, joining]);
  assert.equal(next.batches.length, batchCount);
  assert.equal(next.batches[0].at(-1), joining);
});

test('batches a renderer copied earlier stay equal to their prefix grouping after later appends', () => {
  // Renderer67.uploadBatch keeps `[...parts]`; those copies must not change when the grouping grows in place.
  const heldCopies = [];
  let state = null;
  for (let end = 5; end <= worldParts.length; end += 5) {
    const prefix = worldParts.slice(0, end);
    const grouped = groupPartsIncrementally(state, prefix);
    heldCopies.push({ prefix, copies: grouped.batches.map(batch => [...batch]) });
    state = grouped.state;
  }
  for (const { prefix, copies } of heldCopies) {
    assert.ok(sameBatches(copies, groupParts(prefix)), `copies held at ${prefix.length} parts`);
  }
});

test('the parts a state keeps are a copy, so later changes to the caller list do not reach it', () => {
  const list = worldParts.slice(0, 10);
  const grouped = groupPartsIncrementally(null, list);
  list.push(makePart(500, geometries[5]));
  assert.equal(grouped.state.parts.length, 10);
  const next = groupPartsIncrementally(grouped.state, worldParts.slice(0, 10));
  assert.ok(sameBatches(next.batches, groupParts(worldParts.slice(0, 10))));
});

test('a fallback regrouping leaves the batches returned earlier untouched', () => {
  const grouped = groupPartsIncrementally(null, worldParts.slice(0, 15));
  const before = grouped.batches.map(batch => [...batch]);
  const reordered = [worldParts[1], worldParts[0], ...worldParts.slice(2, 20)];
  groupPartsIncrementally(grouped.state, reordered);
  assert.ok(sameBatches(grouped.batches, before));
});

test('parts that differ in one key value never share a batch', () => {
  const geometry = geometries[0];
  const shadowless = { ...makePart(600, geometry), material: materials[0], castShadow: false };
  const shadowing = { ...makePart(601, geometry), material: materials[0] };
  const otherMaterial = { ...makePart(602, geometry), material: { ...materials[1], alphaMode: 'blend', opacity: 0.5 } };
  const grouped = groupPartsIncrementally(null, [shadowing, shadowless, otherMaterial]);
  assert.equal(grouped.batches.length, 3);
});
