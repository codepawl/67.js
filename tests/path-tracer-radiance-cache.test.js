import assert from 'node:assert/strict';
import test from 'node:test';

import { CACHE_HISTORY_LIMIT, CACHE_SLOT_COUNT, cacheLevel, cacheSlot, mergeCell } from '../src/path-tracer-radiance-cache.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';

const EYE = [0, 1.5, 6];
const CELL_SIZE = 0.1;
const LEVEL_DISTANCE = 6.4;
const slotOf = (point, normal = [0, 1, 0], eye = EYE) => cacheSlot({ point, normal, eye, cellSize: CELL_SIZE, levelDistance: LEVEL_DISTANCE });

test('a point and a nearby point of the same cell share a slot, and the slot is stable', () => {
  const slot = slotOf([1.23, 0, -0.41]);
  assert.equal(slotOf([1.23, 0, -0.41]), slot);
  assert.equal(slotOf([1.2301, 0.0001, -0.4099]), slot);
  assert.ok(slot >= 0 && slot < CACHE_SLOT_COUNT);
});

test('cells far apart and surfaces facing opposite ways get different slots', () => {
  const slot = slotOf([1.23, 0, -0.41]);
  assert.notEqual(slotOf([1.53, 0, -0.41]), slot);
  assert.notEqual(slotOf([1.23, 0, -0.41], [0, -1, 0]), slot);
  assert.notEqual(slotOf([1.23, 0, -0.41], [1, 0, 0]), slot);
});

test('a normal that wobbles around an axis stays in one cell', () => {
  const slot = slotOf([0.5, 0, 0.5], [0, 1, 0]);
  assert.equal(slotOf([0.5, 0, 0.5], [0.1, 0.99, -0.05]), slot);
});

test('cells grow with the distance from the eye, one level each time the distance doubles', () => {
  assert.equal(cacheLevel(1, LEVEL_DISTANCE), 0);
  assert.equal(cacheLevel(LEVEL_DISTANCE * 1.9, LEVEL_DISTANCE), 0);
  assert.equal(cacheLevel(LEVEL_DISTANCE * 2, LEVEL_DISTANCE), 1);
  assert.equal(cacheLevel(LEVEL_DISTANCE * 4.5, LEVEL_DISTANCE), 2);
  assert.equal(cacheLevel(1e9, LEVEL_DISTANCE), 8);
  const farEye = [0, 1.5, 40];
  assert.equal(slotOf([0, 0, 0], [0, 1, 0], farEye), slotOf([0.15, 0, 0.1], [0, 1, 0], farEye));
  assert.notEqual(slotOf([0, 0, 0]), slotOf([0.15, 0, 0.1]));
});

test('the hash spreads cells evenly over the slots', () => {
  const buckets = new Uint32Array(64);
  let count = 0;
  for (let x = 0; x < 60; x++) {
    for (let z = 0; z < 60; z++) {
      for (let y = 0; y < 30; y++) {
        buckets[slotOf([(x + 0.5) * CELL_SIZE, (y + 0.5) * CELL_SIZE, (z + 0.5) * CELL_SIZE]) % 64]++;
        count++;
      }
    }
  }
  const expected = count / 64;
  for (const bucket of buckets) assert.ok(Math.abs(bucket - expected) < expected * 0.1, `bucket ${bucket} against ${expected}`);
});

test('few cells collide at the size a room needs', () => {
  const seen = new Set();
  let cells = 0;
  for (let x = 0; x < 50; x++) {
    for (let z = 0; z < 50; z++) {
      for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0]]) {
        seen.add(slotOf([(x + 0.5) * CELL_SIZE, 0.05, (z + 0.5) * CELL_SIZE], normal));
        cells++;
      }
    }
  }
  assert.ok((cells - seen.size) / cells < 0.01, `${cells - seen.size} of ${cells} cells collided`);
});

test('a cell averages the records it receives, quickly while it is new and slowly once it has history', () => {
  const fresh = mergeCell({ previousMean: [0, 0, 0], previousCount: 0, mean: [2, 4, 6], count: 4 });
  assert.deepEqual(fresh.mean, [2, 4, 6]);
  assert.equal(fresh.count, 4);
  const settled = mergeCell({ previousMean: [1, 1, 1], previousCount: 10000, mean: [3, 3, 3], count: 1 });
  assert.ok(Math.abs(settled.mean[0] - (1 + 2 / (CACHE_HISTORY_LIMIT + 1))) < 1e-12);
  assert.deepEqual(mergeCell({ previousMean: [1, 2, 3], previousCount: 7, mean: [9, 9, 9], count: 0 }), { mean: [1, 2, 3], count: 7 });
});

test('the kernel gets the cache only when it is asked for', () => {
  const plain = buildFragmentSource();
  const cached = buildFragmentSource({ radianceCache: true });
  for (const name of ['outCacheUpdate', 'uRadianceCache', 'cacheLookup', 'cacheHash']) {
    assert.ok(!plain.includes(name), `${name} in the plain kernel`);
    assert.ok(cached.includes(name), `${name} missing from the cached kernel`);
  }
  assert.equal(buildFragmentSource({ radianceCache: false }), plain);
});
