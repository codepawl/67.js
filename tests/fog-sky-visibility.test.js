import test from 'node:test';
import assert from 'node:assert/strict';
import { skyVisibilityGrid, skyGridSize, SKY_GRID_POINTS, SKY_GRID_LONGEST_AXIS } from '../src/closed-room.js';
import { createPostFragment, postFragment } from '../src/post.js';
import '../src/fog-shader.js';

function flatPart(name, height, facesDown, half = 50, centreX = 0) {
  const corners = [centreX - half, height, -half, centreX + half, height, -half, centreX + half, height, half, centreX - half, height, half];
  const indices = facesDown ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return { name, geometry: { positions: new Float32Array(corners), indices: new Uint32Array(indices) }, matrix: identity };
}

const minimum = [-4, 0.5, -4];
const maximum = [4, 2.5, 4];

test('the sky grid is full under open sky, empty under a ceiling and the same on every run', () => {
  const open = skyVisibilityGrid([flatPart('floor', 0, false)], minimum, maximum);
  assert.ok(open.data.every(value => value === 255));
  const closed = skyVisibilityGrid([flatPart('floor', 0, false), flatPart('ceiling', 3, true)], minimum, maximum);
  assert.ok(closed.data.every(value => value < 64), "only grazing rays leave past the edge of the ceiling");
  assert.deepEqual(skyVisibilityGrid([flatPart('floor', 0, false), flatPart('ceiling', 3, true)], minimum, maximum), closed);
});

test('a ceiling with a gap lights only the cells under the gap, and an empty scene has no grid', () => {
  const roof = [flatPart('left', 3, true, 2, -6), flatPart('right', 3, true, 2, 6)];
  const grid = skyVisibilityGrid(roof, minimum, maximum);
  const [width, height] = grid.size;
  const middle = grid.data[Math.floor(height / 2) * width + Math.floor(width / 2)];
  const edge = grid.data[Math.floor(height / 2) * width];
  assert.ok(middle > 200, `under the gap ${middle}`);
  assert.ok(edge < middle, `at the edge ${edge}`);
  assert.equal(skyVisibilityGrid([], minimum, maximum), null);
});

test('the grid stays small for any box', () => {
  for (const [low, high] of [[[-100, 0, -100], [100, 20, 100]], [[0, 0, 0], [1, 1, 1]], [[0, 0, 0], [500, 0.1, 5]]]) {
    const size = skyGridSize(low, high);
    assert.ok(size.every(cells => cells >= 2 && cells <= SKY_GRID_LONGEST_AXIS));
    assert.ok(size[0] * size[1] * size[2] <= SKY_GRID_POINTS * 8);
  }
});

test('the post shader without the sky step is the same program as before and compiles the grid out', () => {
  assert.equal(createPostFragment(), postFragment);
  assert.match(postFragment, /#define POST_SKY false/);
  assert.match(createPostFragment(['volume', 'sky']), /#define POST_SKY \(true\)/);
});
