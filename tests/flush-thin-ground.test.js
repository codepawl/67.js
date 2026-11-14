import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlush } from '../src/flush-resolve.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function flatQuad(x, z, width, depth) {
  return [x, 0, z, x, 0, z + depth, x + width, 0, z + depth, x + width, 0, z];
}

function partOf(name, quads, matrix = IDENTITY) {
  const indices = [];
  for (let quad = 0; quad < quads.length; quad++) indices.push(quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3);
  return { name, geometry: { positions: new Float32Array(quads.flat()), indices: new Uint32Array(indices) }, matrix: new Float32Array(matrix), material: {} };
}

function scaledTo(scaleX, scaleY, scaleZ) {
  return [scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, 0, 0, 0, 1];
}

function denseFlatProp(name, offsetX, rows) {
  const quads = [];
  for (let row = 0; row < rows; row++) quads.push(flatQuad(offsetX, row * 0.1, 0.1, 0.1));
  return partOf(name, quads);
}

test('a 400 m, 2 cm ground beside dense flat props stops the search at its limit instead of throwing (#1216)', () => {
  const ground = partOf('ground', [flatQuad(-0.5, -0.5, 1, 1)], scaledTo(400, 0.02, 400));
  const props = Array.from({ length: 18 }, (_, index) => denseFlatProp(`prop${index}`, index * 0.2, 20));
  const resolved = resolveFlush([ground, ...props], { testedPairLimit: 40 });
  const unchecked = resolved.leftovers.filter(leftover => leftover.reason === 'unchecked');
  assert.equal(unchecked.length, 1);
  assert.notEqual(unchecked[0].part, 'scene', 'the leftover names the part the search stopped at');
  assert.equal(resolved.leftovers.some(leftover => leftover.reason === 'collapsed-node'), false);
});

test('a thin ground is not a collapsed node, an axis scaled to nothing still is (#1216)', () => {
  assert.deepEqual(resolveFlush([partOf('slab', [flatQuad(0, 0, 1, 1)], scaledTo(400, 0.02, 400))]).leftovers, []);
  assert.equal(resolveFlush([partOf('slab', [flatQuad(0, 0, 1, 1)], scaledTo(400, 0, 400))]).leftovers[0].reason, 'collapsed-node');
});
