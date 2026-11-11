import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWorldTriangles, castPixelOwners, compareWithGroundTruth, NO_TRIANGLE } from '../bench/flicker/ground-truth.js';
import { resolveFlushParts } from '../src/coplanar-overlap.js';
import { flushOrderOf } from '../src/depth-layer.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const WIDTH = 64;
const HEIGHT = 48;
const CENTRE = (HEIGHT / 2) * WIDTH + WIDTH / 2;
const CAMERA = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
const RED = [1, 0, 0];
const BLUE = [0, 0, 1];
const WALL_PIXEL = [200, 20, 20];
const PLAQUE_PIXEL = [20, 20, 200];

// A quad in the plane z = depth, facing +z, with one flat colour.
function wallPart(name, width, height, depth, colour, material = {}) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * width / 2, y * height / 2, depth]);
  return {
    name,
    geometry: {
      positions: new Float32Array(corners.flat()),
      normals: new Float32Array(corners.flatMap(() => [0, 0, 1])),
      colors: new Float32Array(corners.flatMap(() => colour)),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: new Float32Array(IDENTITY),
    material: { color: [1, 1, 1], ...material },
  };
}

// A 12 m wall (triangles 0 and 1) and a 4 m plaque (triangles 2 and 3) `frontDepth` in front of it.
function wallWithPlaque(frontDepth) {
  return [wallPart('wall', 12, 12, 0, RED), wallPart('plaque', 4, 4, frontDepth, BLUE)];
}

// A frame in which every pixel shows the face the ray cast names, except where `override` gives another colour.
function paintFrame(cast, override = () => null) {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const owner = cast.owner[pixel];
    const truth = owner === NO_TRIANGLE ? [0, 0, 0] : owner >= 2 ? PLAQUE_PIXEL : WALL_PIXEL;
    pixels.set([...(override(pixel) ?? truth), 255], pixel * 4);
  }
  return pixels;
}

function castWallWithPlaque(frontDepth) {
  const world = collectWorldTriangles(wallWithPlaque(frontDepth), () => null);
  return { world, cast: castPixelOwners(world, CAMERA, WIDTH, HEIGHT) };
}

test('the ray cast names the plaque in front of the wall, with the wall as its rival', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  assert.equal(world.count, 4);
  assert.ok(cast.owner[CENTRE] >= 2);
  assert.equal(cast.rivals[CENTRE * 2], world.keyOf[0]);
  assert.ok(cast.owner[0] >= 0 && cast.owner[0] < 2, 'the corner of the frame sees the wall');
});

test('a frame that shows the visible face everywhere has no wrong pixel', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  const outcome = compareWithGroundTruth({ pixels: paintFrame(cast), world, cast, width: WIDTH, height: HEIGHT });
  assert.ok(outcome.contested > 100, `contested ${outcome.contested}`);
  assert.equal(outcome.wrong, 0);
  assert.equal(outcome.swapped, 0);
});

test('plaque pixels that show the wall colour are swapped pixels, even beside a colour step', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  const speckled = [CENTRE, CENTRE + 1, CENTRE + 2 * WIDTH];
  const pixels = paintFrame(cast, pixel => (speckled.includes(pixel) ? WALL_PIXEL : null));
  const outcome = compareWithGroundTruth({ pixels, world, cast, width: WIDTH, height: HEIGHT });
  assert.equal(outcome.wrong, 3);
  assert.equal(outcome.swapped, 3);
});

test('a pixel with another colour next to it is an edge, not a judged pixel', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  const outcome = compareWithGroundTruth({ pixels: paintFrame(cast), world, cast, width: WIDTH, height: HEIGHT });
  assert.ok(outcome.edge > 0);
});

test('the ray cast reports the depth of the visible face in front of the camera, and 0 for the background', () => {
  const { cast } = castWallWithPlaque(1);
  assert.ok(Math.abs(cast.distance[CENTRE] - 9) < 0.01, `plaque at ${cast.distance[CENTRE]}`);
  assert.ok(Math.abs(cast.distance[0] - 10) < 0.01, `wall at ${cast.distance[0]}`);
  const empty = castPixelOwners(collectWorldTriangles([], () => null), CAMERA, WIDTH, HEIGHT);
  assert.ok(empty.distance.every(distance => distance === 0));
});

test('a swapped pixel is marked 2 in the mismatch mask and a merely wrong one 1', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  const swappedPixel = CENTRE;
  const wrongPixel = CENTRE + 2;
  const pixels = paintFrame(cast, pixel => (pixel === swappedPixel ? WALL_PIXEL : pixel === wrongPixel ? [20, 200, 20] : null));
  const outcome = compareWithGroundTruth({ pixels, world, cast, width: WIDTH, height: HEIGHT });
  assert.equal(outcome.mismatchMask[swappedPixel], 2);
  assert.equal(outcome.mismatchMask[wrongPixel], 1);
  assert.equal(outcome.swapped, 1);
  assert.equal(outcome.wrong, 2);
});

test('a plaque exactly on the wall leaves the plaque alone at its place once the flush pass ran', () => {
  const parts = wallWithPlaque(0);
  resolveFlushParts(parts);
  const world = collectWorldTriangles(parts, flushOrderOf);
  const cast = castPixelOwners(world, CAMERA, WIDTH, HEIGHT);
  assert.equal(world.keyOf[cast.owner[CENTRE]], world.keyOf[world.count - 1], 'the plaque is the visible face');
  assert.equal(cast.rivals[CENTRE * 2], -1, 'nothing lies behind it once the wall is cut away');
});

test('the same plaque without the flush pass is a tie: counted as tied, never as a wrong pixel', () => {
  const { world, cast } = castWallWithPlaque(0);
  assert.equal(cast.tied[CENTRE], 1);
  const pixels = paintFrame(cast, pixel => (pixel % 2 === 0 ? WALL_PIXEL : PLAQUE_PIXEL));
  const outcome = compareWithGroundTruth({ pixels, world, cast, width: WIDTH, height: HEIGHT });
  assert.ok(outcome.tied > 100, `tied ${outcome.tied}`);
  assert.equal(outcome.wrong, 0);
});

// The case of the issue: glass 1 cm in front of a wall. It cannot be cut (it is not opaque), so it takes rank 1 above the wall;
// two triangles in a chain of two never come near the 15 ranks.
test('glass 1 cm in front of a large wall is ranked above it and is not a leftover', () => {
  const parts = [wallPart('wall', 200, 200, 0, RED), wallPart('glass', 20, 20, 0.01, BLUE, { alphaMode: 'blend' })];
  const resolved = resolveFlushParts(parts);
  assert.deepEqual(resolved.leftovers, []);
  assert.equal(resolved.ranked, 1);
  assert.deepEqual(Array.from(flushOrderOf(parts[1]).triangleRanks), [1, 1]);
  const world = collectWorldTriangles(parts, flushOrderOf);
  assert.equal(world.count, 2, 'the blended glass is not collected');
});

test('a wall behind the eye is not hit, and one that crosses the eye plane still is', () => {
  const behind = collectWorldTriangles([wallPart('behind', 12, 12, 20, RED)], () => null);
  assert.ok(castPixelOwners(behind, CAMERA, WIDTH, HEIGHT).owner.every(owner => owner === NO_TRIANGLE));
  const floor = wallPart('floor', 40, 40, 0, RED);
  floor.geometry.positions = new Float32Array([-20, -2, 30, 20, -2, 30, 20, -2, -30, -20, -2, -30]);
  floor.geometry.normals = new Float32Array(12).map((unused, index) => (index % 3 === 1 ? 1 : 0));
  const crossing = collectWorldTriangles([floor], () => null);
  const cast = castPixelOwners(crossing, CAMERA, WIDTH, HEIGHT);
  assert.notEqual(cast.owner[(HEIGHT - 2) * WIDTH + WIDTH / 2], NO_TRIANGLE, 'the floor shows below the horizon');
});

// Moller-Trumbore for one ray, the slow way: the nearest triangle that faces the eye. Two triangles of one quad that meet on the
// diagonal through a pixel centre tie, so the test compares quads (two triangles each), not triangles.
function bruteForceOwner(world, origin, direction) {
  let best = NO_TRIANGLE;
  let bestDistance = Infinity;
  for (let triangle = 0; triangle < world.count; triangle++) {
    const c = world.corners.subarray(triangle * 9, triangle * 9 + 9);
    const edgeOne = [c[3] - c[0], c[4] - c[1], c[5] - c[2]];
    const edgeTwo = [c[6] - c[0], c[7] - c[1], c[8] - c[2]];
    const pivot = [direction[1] * edgeTwo[2] - direction[2] * edgeTwo[1], direction[2] * edgeTwo[0] - direction[0] * edgeTwo[2], direction[0] * edgeTwo[1] - direction[1] * edgeTwo[0]];
    const determinant = edgeOne[0] * pivot[0] + edgeOne[1] * pivot[1] + edgeOne[2] * pivot[2];
    if (determinant <= 0) continue;
    const toOrigin = [origin[0] - c[0], origin[1] - c[1], origin[2] - c[2]];
    const u = (toOrigin[0] * pivot[0] + toOrigin[1] * pivot[1] + toOrigin[2] * pivot[2]) / determinant;
    const cross = [toOrigin[1] * edgeOne[2] - toOrigin[2] * edgeOne[1], toOrigin[2] * edgeOne[0] - toOrigin[0] * edgeOne[2], toOrigin[0] * edgeOne[1] - toOrigin[1] * edgeOne[0]];
    const v = (direction[0] * cross[0] + direction[1] * cross[1] + direction[2] * cross[2]) / determinant;
    const distance = (edgeTwo[0] * cross[0] + edgeTwo[1] * cross[1] + edgeTwo[2] * cross[2]) / determinant;
    if (u < 0 || v < 0 || u + v > 1 || distance <= 0 || distance >= bestDistance) continue;
    best = triangle;
    bestDistance = distance;
  }
  return best;
}

test('the scan-converted cast names the same face as a ray per pixel centre, on tilted overlapping quads', () => {
  const parts = [wallPart('back', 14, 14, -3, RED), wallPart('middle', 6, 8, 0, BLUE), wallPart('front', 3, 3, 2, RED)];
  parts[1].matrix = new Float32Array([0.9, 0, -0.4, 0, 0, 1, 0, 0, 0.4, 0, 0.9, 0, 1, 0.5, 0, 1]);
  const world = collectWorldTriangles(parts, () => null);
  const cast = castPixelOwners(world, CAMERA, WIDTH, HEIGHT);
  const tangent = Math.tan(CAMERA.fov * Math.PI / 360);
  let different = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const direction = [((x + 0.5) / WIDTH * 2 - 1) * (WIDTH / HEIGHT) * tangent, (1 - (y + 0.5) / HEIGHT * 2) * tangent, -1];
      const expected = bruteForceOwner(world, CAMERA.eye, direction);
      const found = cast.owner[y * WIDTH + x];
      if (Math.floor(expected / 2) !== Math.floor(found / 2)) different++;
    }
  }
  assert.ok(different <= 2, `${different} pixels differ`);
});

test('a one-sided face seen from behind is not hit', () => {
  const world = collectWorldTriangles(wallWithPlaque(0.5), () => null);
  const behind = castPixelOwners(world, { ...CAMERA, eye: [0, 0, -10] }, WIDTH, HEIGHT);
  assert.ok(behind.owner.every(owner => owner === NO_TRIANGLE));
});

test('failingTraps flags a swapped pixel with the flush pass on and ignores runs with it off', async () => {
  const { failingTraps } = await import('../bench/flicker/verdict.js');
  const results = [
    { trap: 'plaque-0.5m', configuration: 'reversed1-offset0', truth: { swapped: 389 } },
    { trap: 'plaque-0.5m', configuration: 'reversed1', truth: { swapped: 0 } },
    { trap: 'stacked', configuration: 'reversed0', truth: { swapped: 7 } },
    { trap: 'missing', configuration: 'reversed0' },
  ];
  assert.deepEqual(failingTraps(results), [
    { trap: 'stacked', configuration: 'reversed0', swapped: 7 },
    { trap: 'missing', configuration: 'reversed0', swapped: null },
  ]);
});

test('failingTraps judges an exact run on true flips, not on the swaps the flush pass asked for', async () => {
  const { failingTraps } = await import('../bench/flicker/verdict.js');
  const results = [
    { trap: 'lifted', configuration: 'reversed1-facets2', truth: { swapped: 900, flipped: 0, ranked: 900 } },
    { trap: 'flipping', configuration: 'reversed0-facets2', truth: { swapped: 5, flipped: 3, ranked: 2 } },
  ];
  assert.deepEqual(failingTraps(results), [{ trap: 'flipping', configuration: 'reversed0-facets2', swapped: 5, flipped: 3 }]);
});

// The bytes a face of this colour shows in an unlit frame painted one colour per face.
const exactBytes = colour => colour.map(channel => Math.round(channel * 255));

// A frame that shows exactly the face the ray cast names, except where `override` gives other bytes.
function paintExactFrame(cast, override = () => null) {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const owner = cast.owner[pixel];
    const truth = owner === NO_TRIANGLE ? [0, 0, 0] : owner >= 2 ? [0, 0, 255] : [255, 0, 0];
    pixels.set([...(override(pixel) ?? truth), 255], pixel * 4);
  }
  return pixels;
}

function compareExact(pixels, world, cast) {
  return compareWithGroundTruth({ pixels, world, cast, width: WIDTH, height: HEIGHT, exact: exactBytes });
}

test('an exact frame with the right face everywhere has no wrong pixel', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  assert.deepEqual(world.keyColours, [[1e7, 0, 0], [0, 0, 1e7]]);
  const outcome = compareExact(paintExactFrame(cast), world, cast);
  assert.equal(outcome.wrong, 0);
  assert.ok(outcome.contested > 0);
});

test('an exact frame showing the wall through the plaque counts one true visibility flip', () => {
  const { world, cast } = castWallWithPlaque(0.01);
  const outcome = compareExact(paintExactFrame(cast, pixel => (pixel === CENTRE ? [255, 0, 0] : null)), world, cast);
  assert.equal(outcome.wrong, 1);
  assert.equal(outcome.swapped, 1);
  assert.equal(outcome.flipped, 1);
  assert.equal(outcome.ranked, 0);
  assert.equal(outcome.mismatchMask[CENTRE], 2);
});

test('a face lifted over a nearer one by its rank is swapped but not a flip', () => {
  const { world, cast } = castWallWithPlaque(-0.0005);
  world.ranks[0] = 0;
  world.ranks[1] = 0;
  world.ranks[2] = 1;
  world.ranks[3] = 1;
  const outcome = compareExact(paintExactFrame(cast, pixel => (pixel === CENTRE ? [0, 0, 255] : null)), world, cast);
  assert.equal(outcome.swapped, 1);
  assert.equal(outcome.ranked, 1);
  assert.equal(outcome.flipped, 0);
});

test('an exact frame showing a face off the ray, or a colour no face has, is not depth fighting', () => {
  const parts = [...wallWithPlaque(0.01), wallPart('far-side', 2, 2, 0, [0, 1, 0])];
  parts[2].matrix = new Float32Array([...IDENTITY.slice(0, 12), 500, 0, 0, 1]);
  const world = collectWorldTriangles(parts, () => null);
  const cast = castPixelOwners(world, CAMERA, WIDTH, HEIGHT);
  const outcome = compareExact(paintExactFrame(cast, pixel => (pixel === CENTRE ? [0, 255, 0] : pixel === CENTRE + 1 ? [7, 7, 7] : null)), world, cast);
  assert.equal(outcome.wrong, 2);
  assert.equal(outcome.offRay, 1);
  assert.equal(outcome.offRayEdge, 1, 'the middle of the plaque sits on its diagonal, a seam of the ray cast');
  assert.equal(outcome.offRayInterior, 0);
  assert.equal(outcome.offRayUnexplained, 0);
  assert.equal(outcome.flipUpperBound, 0);
  assert.equal(outcome.blended, 1);
  assert.equal(outcome.swapped, 0);
  assert.equal(outcome.flipped, 0);
});

test('an offRay pixel on a triangle edge of the ray cast is split off from one in the interior of a face', () => {
  const parts = [...wallWithPlaque(0.01), wallPart('far-side', 2, 2, 0, [0, 1, 0])];
  parts[2].matrix = new Float32Array([...IDENTITY.slice(0, 12), 500, 0, 0, 1]);
  const world = collectWorldTriangles(parts, () => null);
  const cast = castPixelOwners(world, CAMERA, WIDTH, HEIGHT);
  const seam = [...cast.owner.keys()].find(pixel => cast.owner[pixel] >= 2 && cast.owner[pixel + 1] >= 2 && cast.owner[pixel] !== cast.owner[pixel + 1]
    && cast.owner[pixel - WIDTH] >= 2 && cast.owner[pixel + WIDTH] >= 2);
  assert.ok(seam > 0, 'the plaque diagonal has a pixel whose neighbours are all plaque');
  const outcome = compareExact(paintExactFrame(cast, pixel => (pixel === seam ? [0, 255, 0] : pixel === CENTRE - 5 * WIDTH ? [0, 255, 0] : null)), world, cast);
  assert.equal(outcome.offRay, 2);
  assert.equal(outcome.offRayEdge, 1);
  assert.equal(outcome.offRayInterior, 1);
  assert.equal(outcome.offRayUnexplained, 1);
  assert.equal(outcome.flipUpperBound, 1);
});

test('an offRay pixel a few bytes from the colour expected is a rounding step of the frame, not an upper-bound flip', () => {
  const parts = [...wallWithPlaque(0.01), wallPart('neighbour-colour', 2, 2, 0, [0, 0, 0.99])];
  parts[2].matrix = new Float32Array([...IDENTITY.slice(0, 12), 500, 0, 0, 1]);
  const world = collectWorldTriangles(parts, () => null);
  const cast = castPixelOwners(world, CAMERA, WIDTH, HEIGHT);
  const outcome = compareExact(paintExactFrame(cast, pixel => (pixel === CENTRE + 4 ? [0, 0, 252] : null)), world, cast);
  assert.equal(outcome.offRayInterior, 1);
  assert.equal(outcome.offRaySmallGap, 1);
  assert.equal(outcome.offRayUnexplained, 0);
  assert.equal(outcome.flipUpperBound, 0);
});

// A wall under seven more faces, each 1 cm in front of the last: the wall is the eighth hit of every ray through the middle.
function deepStack() {
  const parts = [wallPart('wall', 12, 12, 0, RED)];
  for (let layer = 1; layer <= 7; layer++) {
    parts.push(wallPart(`layer-${layer}`, 4, 4, layer * 0.01, layer === 7 ? BLUE : [0, layer / 10, 0]));
  }
  const world = collectWorldTriangles(parts, () => null);
  return { world, cast: (hitsPerPixel) => castPixelOwners(world, CAMERA, WIDTH, HEIGHT, hitsPerPixel) };
}

test('a face deeper than the hits kept per ray is offRay, and a flip once the cast keeps enough hits', () => {
  const { world, cast: castWith } = deepStack();
  const showWall = pixel => (pixel === CENTRE + 4 ? [255, 0, 0] : null);
  const shallow = castWith(6);
  const shallowOutcome = compareExact(paintExactFrame(shallow, showWall), world, shallow);
  assert.equal(shallowOutcome.offRayInterior, 1);
  assert.equal(shallowOutcome.flipped, 0);
  assert.equal(shallowOutcome.flipUpperBound, 1);
  const deep = castWith(8);
  assert.equal(deep.hitsPerPixel, 8);
  const deepOutcome = compareExact(paintExactFrame(deep, showWall), world, deep);
  assert.equal(deepOutcome.offRay, 0);
  assert.equal(deepOutcome.flipped, 1);
  assert.equal(deepOutcome.flipUpperBound, 1);
});
