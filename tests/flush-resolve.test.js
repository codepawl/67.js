import test from 'node:test';
import assert from 'node:assert/strict';
import { flushOrderOf, MAXIMUM_FLUSH_RANK } from '../src/depth-layer.js';
import { resolveFlush } from '../src/flush-resolve.js';
import { Renderer67 } from '../src/renderer.js';
import { vertexShader } from '../src/shaders.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function quadCorners(x, z, width, depth, height) {
  return [x, height, z, x, height, z + depth, x + width, height, z + depth, x + width, height, z];
}

function geometryOf(quads) {
  const indices = [];
  for (let quad = 0; quad < quads.length; quad++) indices.push(quad * 4, quad * 4 + 1, quad * 4 + 2, quad * 4, quad * 4 + 2, quad * 4 + 3);
  return { positions: new Float32Array(quads.flat()), indices: new Uint32Array(indices) };
}

function partOf(name, quads, { matrix = IDENTITY, material = {}, ...extra } = {}) {
  return { name, geometry: geometryOf(quads), matrix: new Float32Array(matrix), material, ...extra };
}

function movedTo(x, y, z) {
  const matrix = [...IDENTITY];
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

function ranksOf(part) {
  const order = flushOrderOf(part);
  return order ? Array.from(order.triangleRanks) : null;
}

// The area a part draws: its cut geometry when it has one.
function drawnArea(part) {
  const { positions, indices } = flushOrderOf(part)?.geometry ?? part.geometry;
  let area = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const [first, second, third] = [indices[index] * 3, indices[index + 1] * 3, indices[index + 2] * 3];
    const edgeOne = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
    const edgeTwo = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
    area += Math.hypot(edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]) / 2;
  }
  return area;
}

test('the surface in front along the normal gets the higher rank, whatever the part order or size', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  const plaque = partOf('plaque', [quadCorners(1, 1, 1, 1, 0.001)]);
  assert.deepEqual(resolveFlush([wall, plaque]), { ranked: 1, leftovers: [] });
  assert.deepEqual(ranksOf(plaque), [1, 1]);
  assert.equal(flushOrderOf(wall), null);
  assert.equal(resolveFlush([plaque, wall]).ranked, 1);
  assert.deepEqual(ranksOf(plaque), [1, 1]);
  // A large sheet a millimetre in front of a small patch: the sheet is in front, so the sheet gets the rank.
  const patch = partOf('patch', [quadCorners(1, 1, 1, 1, 0)]);
  const sheet = partOf('sheet', [quadCorners(0, 0, 4, 4, 0.001)]);
  resolveFlush([patch, sheet]);
  assert.equal(flushOrderOf(patch), null);
  assert.deepEqual(ranksOf(sheet), [1, 1]);
  // Turned upside down the normal points down, and the face with the lower y is the one in front.
  const upsideDown = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 4, 1];
  const ceiling = partOf('ceiling', [quadCorners(0, 0, 4, 4, 0)], { matrix: upsideDown });
  const lamp = partOf('lamp', [quadCorners(1, 1, 1, 1, 0.001)], { matrix: upsideDown });
  resolveFlush([ceiling, lamp]);
  assert.deepEqual(ranksOf(lamp), [1, 1]);
  assert.equal(flushOrderOf(ceiling), null);
});

test('on one plane the smaller face wins, then the later one, and the face under it is cut away instead of ranked', () => {
  const kitbash = partOf('kitbash', [quadCorners(0, 0, 10, 1, 0), quadCorners(0, 0, 5, 1, 0), quadCorners(0, 0, 2, 1, 0)]);
  assert.deepEqual(resolveFlush([kitbash]), { ranked: 1, leftovers: [] });
  assert.equal(Math.max(...ranksOf(kitbash)), 2, 'the faces keep their order for the hair of overlap a cut leaves');
  assert.ok(Math.abs(drawnArea(kitbash) - 10) < 1e-3, 'the three faces draw the area of their union once');
  const twin = partOf('twin', [quadCorners(0, 0, 1, 1, 0), quadCorners(0, 0, 1, 1, 0)]);
  resolveFlush([twin]);
  assert.deepEqual(Array.from(flushOrderOf(twin).geometry.indices), [4, 5, 6, 4, 6, 7], 'the earlier twin is dropped whole');
  const tiny = partOf('tiny', [quadCorners(0, 0, 0.009, 0.009, 0), quadCorners(0, 0, 0.009, 0.009, 0)]);
  resolveFlush([tiny]);
  assert.deepEqual(ranksOf(tiny), [0, 0, 1, 1], 'a shared area under 1 cm2 is ranked, not cut');
  assert.equal(flushOrderOf(tiny).geometry, undefined);
});

test('a face is only cut under a face that hides it from every side it shows', () => {
  const glass = partOf('glass', [quadCorners(1, 1, 1, 1, 0)], { material: { alphaMode: 'blend' } });
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  resolveFlush([wall, glass]);
  assert.equal(flushOrderOf(wall), null, 'the wall stays whole behind a blended face');
  assert.deepEqual(ranksOf(glass), [1, 1]);
  const leaf = partOf('leaf', [quadCorners(0, 0, 4, 4, 0)], { material: { doubleSided: true } });
  const patch = partOf('patch', [quadCorners(1, 1, 1, 1, 0)]);
  resolveFlush([leaf, patch]);
  assert.equal(flushOrderOf(leaf), null, 'the back of a double-sided face shows where a one-sided patch is culled');
  assert.deepEqual(ranksOf(patch), [1, 1]);
});

test('a part hidden whole keeps its geometry and is ranked under what hides it', () => {
  const lower = partOf('lower', [quadCorners(0, 0, 1, 1, 0)]);
  const upper = partOf('upper', [quadCorners(0, 0, 1, 1, 0)]);
  assert.deepEqual(resolveFlush([lower, upper]), { ranked: 1, leftovers: [] });
  assert.equal(flushOrderOf(lower), null);
  assert.deepEqual(ranksOf(upper), [1, 1]);
});

test('the ranked order holds every triangle once, sorted by rank, and leaves the geometry alone', () => {
  const kitbash = partOf('kitbash', [quadCorners(0, 0, 2, 1, 0.002), quadCorners(0, 0, 10, 1, 0), quadCorners(0, 0, 5, 1, 0.001)]);
  const original = Array.from(kitbash.geometry.indices);
  const geometry = kitbash.geometry;
  resolveFlush([kitbash]);
  const order = flushOrderOf(kitbash);
  assert.equal(kitbash.geometry, geometry);
  assert.deepEqual(Array.from(kitbash.geometry.indices), original);
  assert.deepEqual(order.ranges, [{ start: 0, count: 6, rank: 0 }, { start: 6, count: 6, rank: 1 }, { start: 12, count: 6, rank: 2 }]);
  assert.deepEqual(Array.from(order.indices), [4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 0, 1, 2, 0, 2, 3]);
});

test('a stack of 20 or 30 faces on one plane is cut down to what shows and reports nothing', () => {
  for (const depth of [20, 30]) {
    const staggered = partOf('staggered', Array.from({ length: depth }, (unused, index) => quadCorners(0, 0, depth - index, 1, 0)));
    assert.deepEqual(resolveFlush([staggered]), { ranked: 1, leftovers: [] });
    assert.ok(Math.abs(drawnArea(staggered) - depth) < 1e-2);
    const exact = partOf('exact', Array.from({ length: depth }, () => quadCorners(0, 0, 3, 2, 0)));
    assert.deepEqual(resolveFlush([exact]), { ranked: 1, leftovers: [] });
    assert.deepEqual(Array.from(flushOrderOf(exact).geometry.indices), [0, 1, 2, 0, 2, 3].map(index => index + (depth - 1) * 4), 'only the last face is drawn');
  }
});

test('a stack of 20 faces half a millimetre apart fills the 16 ranks and reports the rest as rank-overflow', () => {
  const stack = partOf('stack', Array.from({ length: 20 }, (unused, index) => quadCorners(0, 0, 20 - index, 1, index * 0.0005)));
  const { ranked, leftovers } = resolveFlush([stack]);
  assert.equal(ranked, 1);
  assert.deepEqual(leftovers, [{ reason: 'rank-overflow', part: 'stack', triangles: 8 }]);
  const ranks = ranksOf(stack);
  assert.equal(Math.max(...ranks), MAXIMUM_FLUSH_RANK);
  assert.deepEqual(ranks.slice(0, 32), Array.from({ length: 32 }, (unused, index) => index >> 1));
  const shallow = partOf('shallow', Array.from({ length: 16 }, (unused, index) => quadCorners(0, 0, 20 - index, 1, index * 0.0005)));
  assert.deepEqual(resolveFlush([shallow]).leftovers, []);
});

test('untouched parts keep their identity and get no order; a stale order is dropped on the next run', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  const plaque = partOf('plaque', [quadCorners(1, 1, 1, 1, 0)]);
  const far = partOf('far', [quadCorners(0, 0, 4, 4, 30)]);
  const parts = [wall, plaque, far];
  const wallGeometry = wall.geometry;
  const wallIndices = Array.from(wall.geometry.indices);
  assert.equal(resolveFlush(parts).ranked, 2);
  const cut = flushOrderOf(wall);
  assert.ok(cut.geometry, 'the wall is cut under the plaque');
  assert.ok(Math.abs(drawnArea(wall) - 15) < 1e-4);
  assert.equal(wall.geometry, wallGeometry, 'the cut geometry sits beside the part');
  assert.deepEqual(Array.from(wall.geometry.indices), wallIndices);
  assert.deepEqual(ranksOf(plaque), [1, 1]);
  assert.equal(flushOrderOf(plaque).geometry, undefined);
  assert.equal(flushOrderOf(far), null);
  assert.equal(plaque.depthLayer, undefined);
  assert.deepEqual(Object.keys(wall), ['name', 'geometry', 'matrix', 'material']);
  assert.equal(resolveFlush(parts).ranked, 2);
  assert.equal(flushOrderOf(wall), cut, 'the same cuts give the same order, so the renderer keeps its batch');
  assert.equal(resolveFlush([wall, far]).ranked, 0, 'without the plaque nothing covers the wall');
  assert.equal(flushOrderOf(wall), null);
});

test('instances that agree share one order, so they still batch; one that differs gets none', () => {
  const floor = partOf('floor', [quadCorners(0, 0, 20, 4, 0)], { material: { tag: 'floor' } });
  const tile = partOf('tile', [quadCorners(0, 0, 1, 1, 0)]);
  const onFloorOne = { ...tile, name: 'onFloorOne', matrix: new Float32Array(movedTo(1, 0.001, 1)) };
  const onFloorTwo = { ...tile, name: 'onFloorTwo', matrix: new Float32Array(movedTo(5, 0.001, 1)) };
  const lifted = { ...tile, name: 'lifted', matrix: new Float32Array(movedTo(9, 1, 1)) };
  assert.equal(resolveFlush([floor, onFloorOne, onFloorTwo, lifted]).ranked, 2);
  assert.ok(flushOrderOf(onFloorOne));
  assert.equal(flushOrderOf(onFloorOne), flushOrderOf(onFloorTwo));
  assert.equal(flushOrderOf(lifted), null);
  // Faces cut inside one geometry are the same cut in every instance, wherever it stands.
  const doubled = partOf('doubled', [quadCorners(0, 0, 2, 2, 0), quadCorners(0.5, 0.5, 1, 1, 0)]);
  const copy = { ...doubled, name: 'copy', matrix: new Float32Array(movedTo(40, 3, -7)) };
  assert.equal(resolveFlush([doubled, copy]).ranked, 2);
  assert.ok(flushOrderOf(doubled).geometry);
  assert.equal(flushOrderOf(doubled), flushOrderOf(copy));
});

test('a decal or another depthLayer already clears the pair, so no rank is spent', () => {
  const wall = partOf('wall', [quadCorners(0, 0, 4, 4, 0)]);
  const sticker = partOf('sticker', [quadCorners(1, 1, 1, 1, 0)], { decal: true });
  assert.deepEqual(resolveFlush([wall, sticker]), { ranked: 0, leftovers: [] });
});

test('what cannot be ranked is reported: double-sided gaps, parts past the budget, collapsed nodes', () => {
  const floor = partOf('floor', [quadCorners(0, 0, 2, 2, 0)]);
  const flipped = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0.001, 2, 1];
  const leaf = partOf('leaf', [quadCorners(0, 0, 2, 2, 0)], { matrix: flipped, material: { doubleSided: true } });
  const gapped = resolveFlush([floor, leaf]);
  assert.equal(gapped.ranked, 0);
  assert.equal(gapped.leftovers.length, 1);
  assert.equal(gapped.leftovers[0].reason, 'double-sided-gap');
  assert.equal(gapped.leftovers[0].part, 'leaf');
  const touching = partOf('touching', [quadCorners(0, 0, 1, 1, 0)], { matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 2, 1], material: { doubleSided: true } });
  assert.deepEqual(resolveFlush([floor, touching]), { ranked: 1, leftovers: [] }, 'on one plane the smaller face wins from either side');
  const pebble = partOf('pebble', [quadCorners(5, 5, 0.1, 0.1, 0)]);
  assert.deepEqual(resolveFlush([floor, pebble], { triangleBudget: 2 }).leftovers, [{ reason: 'unchecked', part: 'pebble', triangles: 2 }]);
  const squashed = partOf('squashed', [quadCorners(8, 8, 1, 1, 0)], { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.0001, 0, 0, 5, 0, 1] });
  assert.deepEqual(resolveFlush([squashed]).leftovers, [{ reason: 'collapsed-node', part: 'squashed', triangles: 2 }]);
});

function recordingContext() {
  const calls = [];
  const context = {
    POLYGON_OFFSET_FILL: 'fill', TRIANGLES: 'triangles', UNSIGNED_INT: 'uint',
    enable: capability => calls.push(['enable', capability]),
    disable: capability => calls.push(['disable', capability]),
    polygonOffset: (factor, units) => calls.push(['offset', factor, units]),
    uniform3f: (location, x, y, z) => calls.push(['bias', x, y, z]),
    uniform4fv: (location, value) => calls.push(['clipPerMetre', Array.from(value)]),
    drawElementsInstanced: (mode, count, type, offset, instances) => calls.push(['draw', count, offset, instances]),
  };
  return { calls, context };
}

test('a depth rank is a metric bias plus a slope-only offset, switched off for rank 0, mirrored for reversed depth', () => {
  const { calls, context } = recordingContext();
  const fake = { context, uniforms: {} };
  Renderer67.prototype.applyDepthRank.call(fake, 2);
  Renderer67.prototype.applyDepthRank.call(fake, 0);
  Renderer67.prototype.applyDepthRank.call(fake, 16, 1);
  assert.deepEqual(calls, [
    ['bias', 2e-4, 2 * 2 ** -19, -2 * 2 ** -22], ['enable', 'fill'], ['offset', -2 / 64, 0],
    ['bias', 0, 0, 0], ['disable', 'fill'],
    ['bias', 16e-4, 16 * 2 ** -19, 0], ['enable', 'fill'], ['offset', 0.25, 0],
  ]);
});

test('a ranked batch draws one range per rank above its own layer and ends on the layer', () => {
  const { calls, context } = recordingContext();
  const fake = { context, uniforms: {}, applyDepthRank: Renderer67.prototype.applyDepthRank };
  const ranges = [{ start: 0, count: 6, rank: 0 }, { start: 6, count: 12, rank: 3 }];
  Renderer67.prototype.drawFlushRanges.call(fake, { depthLayer: 1 }, ranges, 5);
  assert.deepEqual(calls.filter(call => call[0] === 'draw'), [['draw', 6, 0, 5], ['draw', 12, 24, 5]]);
  assert.deepEqual(calls.filter(call => call[0] === 'bias').map(call => Math.round(call[1] / 1e-4)), [16, 19, 16]);
});

test('the bias moves depth to where the point would be that much closer to the eye, and nothing else', () => {
  const near = 0.1;
  const far = 1000;
  // A camera at the origin looking down -z: view is the identity, forward is [0, 0, -1].
  const view = IDENTITY;
  const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
  const { calls, context } = recordingContext();
  Renderer67.prototype.setFlushProjection.call({ context, uniforms: {}, view }, perspective);
  const clipPerMetre = calls[0][1];
  const clip = point => [0, 1, 2, 3].map(row => perspective[row] * point[0] + perspective[4 + row] * point[1] + perspective[8 + row] * point[2] + perspective[12 + row]);
  const point = [3, -2, -250];
  const shift = 16 * (1e-4 + 2 ** -19 * 250);
  const position = clip(point);
  const lifted = position.map((value, row) => value - shift * clipPerMetre[row]);
  const biasedDepth = lifted[2] / lifted[3];
  const closer = clip([point[0], point[1], point[2] + shift]);
  assert.ok(Math.abs(biasedDepth - closer[2] / closer[3]) < 1e-9);
  assert.ok(biasedDepth < position[2] / position[3], 'standard depth shrinks toward the eye');
  const source = vertexShader;
  assert.match(source, /uniform vec3 flushBias;\s+uniform vec4 clipPerMetre;/);
  assert.match(source, /gl_Position = viewProjection \* world;\s+\/\/[^\n]*\n[^\n]*\n\s+if \(flushBias != vec3\(0\.0\)\) \{\s+vec4 lifted = gl_Position - \(flushBias\.x \+ flushBias\.y \* gl_Position\.w\) \* clipPerMetre;\s+gl_Position\.z = \(lifted\.z \/ lifted\.w \+ flushBias\.z\) \* gl_Position\.w;/);
});
