import test from 'node:test';
import assert from 'node:assert/strict';
import { findFlushPairs, flushTolerance, isDeformingPart, nearTolerance } from '../src/flush-search.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A quad on the plane y = height, facing up, from (x, z) to (x + width, z + depth).
function quadCorners(x, z, width, depth, height) {
  return [x, height, z, x, height, z + depth, x + width, height, z + depth, x + width, height, z];
}

function partOf(name, quads, { matrix = IDENTITY, material = {}, ...extra } = {}) {
  const positions = quads.flat();
  const indices = [];
  for (let quad = 0; quad < quads.length; quad++) indices.push(quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3);
  return { name, geometry: { positions: new Float32Array(positions), indices: new Uint32Array(indices) }, matrix: new Float32Array(matrix), material, ...extra };
}

function movedTo(x, y, z) {
  const matrix = [...IDENTITY];
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

// The y axis turned by `degrees` about z, so a quad on y = 0 gets the normal [-sin, cos, 0].
function tiltedAboutZ(degrees) {
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle), 0, 0, -Math.sin(angle), Math.cos(angle), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

test('tolerances follow the coordinates and the size of the pair', () => {
  assert.equal(flushTolerance(1), 1e-4);
  assert.ok(Math.abs(flushTolerance(1000) - 8 * 2 ** -14) < 1e-12, 'eight float32 steps at 1 km');
  assert.equal(nearTolerance(1), 0.002);
  assert.ok(Math.abs(nearTolerance(200) - 0.03) < 1e-12);
  assert.equal(nearTolerance(1e5), 0.25);
});

test('duplicate faces inside one geometry are found', () => {
  const kitbash = partOf('kitbash', [quadCorners(0, 0, 4, 4, 0), quadCorners(1, 1, 1, 1, 0)]);
  const found = findFlushPairs([kitbash]);
  assert.equal(found.count, 4);
  assert.equal(found.pairs.length, 2, 'both quads split along the same diagonal, so each small triangle lies on one wall triangle');
  assert.ok(found.pairs.every(pair => found.owner[pair.first] === 0 && found.owner[pair.second] === 0));
  assert.ok(found.pairs.every(pair => Math.abs(pair.gap) < 1e-9 && pair.flush && !pair.opposite));
  const shared = found.pairs.reduce((sum, pair) => sum + pair.area, 0);
  assert.ok(Math.abs(shared - 1) < 1e-9, 'the shared pieces add up to the small quad');
});

test('triangles of one flat mesh that only share edges are not pairs', () => {
  const tiles = [];
  for (let row = 0; row < 12; row++) {
    for (let column = 0; column < 12; column++) tiles.push(quadCorners(column, row, 1, 1, 0));
  }
  assert.deepEqual(findFlushPairs([partOf('floor', tiles)]).pairs, []);
});

test('normals on two sides of a hash boundary still meet', () => {
  // Normal x components of 0.0249 and 0.0251 round to different cells at 20 steps per unit.
  const first = partOf('first', [quadCorners(-1, -1, 2, 2, 0)], { matrix: tiltedAboutZ(-Math.asin(0.0249) * 180 / Math.PI) });
  const second = partOf('second', [quadCorners(-0.5, -0.5, 1, 1, 0)], { matrix: tiltedAboutZ(-Math.asin(0.0251) * 180 / Math.PI) });
  assert.ok(findFlushPairs([first, second]).pairs.length >= 2);
  // On a diagonal the dominant component changes, and with it the sign the normal is folded by.
  const diagonal = partOf('diagonal', [quadCorners(-1, -1, 2, 2, 0)], { matrix: tiltedAboutZ(-135.004) });
  const neighbour = partOf('neighbour', [quadCorners(-0.5, -0.5, 1, 1, 0)], { matrix: tiltedAboutZ(-134.996) });
  assert.ok(findFlushPairs([diagonal, neighbour]).pairs.length >= 2);
  const twoDegrees = partOf('twoDegrees', [quadCorners(-0.5, -0.5, 1, 1, 0)], { matrix: tiltedAboutZ(2) });
  assert.deepEqual(findFlushPairs([partOf('level', [quadCorners(-1, -1, 2, 2, 0)]), twoDegrees]).pairs, [], 'planes two degrees apart cross, they do not lie flush');
});

test('the gap is signed along the normal: positive when the second triangle is in front', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  const plaque = partOf('plaque', [quadCorners(1, 1, 1, 1, 0.001)]);
  for (const pair of findFlushPairs([wall, plaque]).pairs) assert.ok(Math.abs(pair.gap - 0.001) < 1e-7 && !pair.flush);
  for (const pair of findFlushPairs([plaque, wall]).pairs) assert.ok(Math.abs(pair.gap + 0.001) < 1e-7);
  // A far backdrop in the scene does not widen what counts as one plane near the origin, but faces out there do get the wider band.
  const backdrop = partOf('backdrop', [quadCorners(40000, 0, 100, 100, 5)]);
  assert.ok(findFlushPairs([wall, plaque, backdrop]).pairs.every(pair => !pair.flush));
  const distant = [partOf('distantWall', [quadCorners(40000, 0, 4, 4, 0)]), partOf('distantPlaque', [quadCorners(40001, 1, 1, 1, 0.001)])];
  assert.ok(findFlushPairs(distant).pairs.length >= 2);
  assert.ok(findFlushPairs(distant).pairs.every(pair => pair.flush), 'a millimetre is rounding 40 km out');
  const farther = partOf('farther', [quadCorners(1, 1, 1, 1, 0.01)]);
  assert.deepEqual(findFlushPairs([wall, farther]).pairs, [], 'a centimetre is clear of a wall this small');
});

test('a large pair of parts is searched with a wider gap than a small one', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 200, 60, 0)]);
  const cladding = partOf('cladding', [quadCorners(0, 0, 200, 60, 0.016)]);
  const found = findFlushPairs([wall, cladding]);
  assert.ok(found.pairs.length >= 2);
  assert.ok(found.pairs.every(pair => Math.abs(pair.gap - 0.016) < 1e-6));
});

test('faces that look opposite ways fight only when one of them shows both sides', () => {
  const floor = partOf('floor', [quadCorners(0, 0, 2, 2, 0)]);
  const flipped = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 2, 1];
  const underside = partOf('underside', [quadCorners(0, 0, 2, 2, 0)], { matrix: flipped });
  assert.deepEqual(findFlushPairs([floor, underside]).pairs, []);
  const leaf = { ...underside, material: { doubleSided: true } };
  const { pairs } = findFlushPairs([floor, leaf]);
  assert.ok(pairs.length >= 2);
  assert.ok(pairs.every(pair => pair.opposite));
});

test('a two-triangle wall meets hundreds of small faces spread over it', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 400, 400, 0)]);
  const tiles = [];
  for (let index = 0; index < 400; index++) tiles.push(quadCorners((index % 20) * 20 + 3, Math.floor(index / 20) * 20 + 3, 0.5, 0.5, 0));
  const found = findFlushPairs([wall, partOf('tiles', tiles)]);
  const touched = new Set(found.pairs.map(pair => pair.second));
  assert.equal(touched.size, 800, 'every tile triangle is paired with the wall');
  assert.equal(found.truncated, false);
});

test('parts past the triangle budget are returned as unchecked, the largest parts are searched', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 10, 10, 0)]);
  const plaque = partOf('plaque', [quadCorners(1, 1, 2, 2, 0)]);
  const pebble = partOf('pebble', [quadCorners(5, 5, 0.1, 0.1, 0)]);
  const found = findFlushPairs([pebble, wall, plaque], { triangleBudget: 4 });
  assert.deepEqual(found.unchecked.map(part => part.name), ['pebble']);
  assert.deepEqual(found.parts.map(part => part.name), ['wall', 'plaque']);
  assert.ok(found.pairs.length >= 2);
  const cut = findFlushPairs([wall, plaque], { pairBudget: 1 });
  assert.equal(cut.pairs.length, 1);
  assert.equal(cut.truncated, true);
});

test('deforming parts and stacked copies are left out', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  const banner = partOf('banner', [quadCorners(1, 1, 1, 1, 0)], { skin: {} });
  const grass = partOf('grass', [quadCorners(1, 1, 1, 1, 0)], { material: { tag: 'grass' } });
  const water = partOf('water', [quadCorners(1, 1, 1, 1, 0)], { material: { transmission: 1 } });
  assert.ok([banner, grass, water].every(isDeformingPart));
  assert.equal(isDeformingPart(wall), false);
  assert.deepEqual(findFlushPairs([wall, banner, grass, water]).pairs, []);
  const mote = partOf('mote', [quadCorners(0, 0, 1, 1, 0)]);
  const parked = Array.from({ length: 300 }, (unused, index) => ({ ...mote, name: `mote${index}` }));
  const found = findFlushPairs(parked);
  assert.equal(found.parts.length, 2);
  assert.ok(found.pairs.length <= 4);
});

test('a mirrored part keeps the facing its matrix gives it', () => {
  const floor = partOf('floor', [quadCorners(0, 0, 2, 2, 0)]);
  const mirrored = partOf('mirrored', [quadCorners(0, 0, 1, 1, 0)], { matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] });
  const { pairs } = findFlushPairs([floor, mirrored]);
  assert.ok(pairs.length >= 1);
  assert.ok(pairs.every(pair => !pair.opposite));
  assert.deepEqual(findFlushPairs([floor, { ...mirrored, matrix: new Float32Array(movedTo(10, 0, 0)) }]).pairs, []);
});
