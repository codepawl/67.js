import assert from 'node:assert/strict';
import test from 'node:test';
import { groupParts, groupWorld } from '../src/renderer.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const makeGeometry = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const sameBatches = (left, right) => left.length === right.length && left.every((batch, index) => batch.length === right[index].length && batch.every((part, position) => part === right[index][position]));

// replaceParts({ retainedUnchanged: true }) may be given any edit of the previous list: appended, removed, replaced or reordered parts.
// Whatever the edit, the batches must equal one full regroup of the same list.
test('random edits of a world group exactly as one full regroup does, for 30 seeds', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = seededRandom(seed * 104729);
    const geometries = Array.from({ length: 6 }, makeGeometry);
    const materials = Array.from({ length: 4 }, (_, index) => ({ color: [index / 4, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 }));
    let counter = 0;
    const newPart = () => ({
      name: `part ${counter++}`,
      geometry: geometries[Math.floor(random() * geometries.length)],
      matrix: identity(),
      material: materials[Math.floor(random() * materials.length)],
      castShadow: random() < 0.8,
    });
    let parts = Array.from({ length: 5 + Math.floor(random() * 20) }, newPart);
    const groundPart = random() < 0.5 ? { name: 'ground', geometry: random() < 0.5 ? geometries[0] : makeGeometry(), matrix: identity(), material: { ...materials[0], tag: 'floor' } } : null;
    let state = null;
    for (let step = 0; step < 25; step++) {
      const edit = random();
      if (edit < 0.5) parts = [...parts, ...Array.from({ length: 1 + Math.floor(random() * 6) }, newPart)];
      else if (edit < 0.65 && parts.length > 2) parts = parts.filter(() => random() < 0.8);
      else if (edit < 0.8 && parts.length > 0) parts = parts.map(part => (random() < 0.2 ? newPart() : part));
      else if (edit < 0.9) parts = [...parts].sort(() => random() - 0.5);
      const grouped = groupWorld(state, parts, groundPart, true, true);
      state = grouped.state;
      const expected = groupParts(groundPart ? [...parts, groundPart] : parts, true);
      assert.ok(sameBatches(grouped.batches, expected), `seed ${seed} step ${step}`);
    }
  }
});
