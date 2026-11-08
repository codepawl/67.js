import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { coplanarLayers, findCoplanarOverlaps, coplanarOverlapDiagnostics, installCoplanarDiagnostics, resolveCoplanarParts, resolveFlushParts } from '../src/coplanar-overlap.js';
import { depthLayerOf, MAXIMUM_DEPTH_LAYER } from '../src/depth-layer.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { frameDiagnostics } from '../src/frame-diagnostics.js';
import { groupParts, Renderer67 } from '../src/renderer.js';
import { resolveEffects } from '../src/effects.js';

await loadAgentSceneModules({ environment: { resolveCoplanar: 'offset' } });

function node(id, translation, scale, extra = {}) {
  return { id, geometry: 'box', material: 'paint', translation, scale, ...extra };
}

function recipe(nodes, environment) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes,
    ...(environment ? { environment } : {}),
  };
}

function coplanarWarnings(nodes, environment) {
  const inspection = createAgentScene(recipe(nodes, environment)).inspect();
  return (inspection.diagnostics ?? []).filter(entry => entry.kind === 'coplanar-overlap');
}

// The wall's front face is at z = 0.1; the sign shares that face and sits inside the wall's outline.
const wall = node('wall', [0, 0, 0], [10, 4, 0.2]);
const sign = node('sign', [0, 0, 0], [1, 0.5, 0.2]);

test('a sign flush with a wall is reported with both parts, the area and a fix', () => {
  const warnings = coplanarWarnings([wall, sign]);
  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.deepEqual(warning.parts, ['sign', 'wall']);
  assert.match(warning.message, /sign and wall/);
  assert.ok(warning.area > 0.45 && warning.area < 1.1, `shared area ${warning.area}`);
  assert.match(warning.fix, /decal: true/);
  assert.match(warning.fix, /resolveCoplanar/);
  assert.match(warning.fix, /along its normal/);
});

test('two boxes that share a visible top face are reported', () => {
  const warnings = coplanarWarnings([node('big', [0, 0, 0], [2, 1, 2]), node('small', [0.5, 0, 0], [1, 1, 1])]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].parts, ['small', 'big']);
});

test('a box resting on a floor is quiet', () => {
  assert.deepEqual(coplanarWarnings([node('floor', [0, 0, 0], [10, 0.2, 10]), node('crate', [0, 0.6, 0], [1, 1, 1])]), []);
});

test('boxes that only touch along an edge or side by side are quiet', () => {
  assert.deepEqual(coplanarWarnings([node('left', [-0.5, 0, 0], [1, 1, 1]), node('right', [0.5, 0, 0], [1, 1, 1])]), []);
  assert.deepEqual(coplanarWarnings([node('first', [0, 0, 0], [1, 1, 1]), node('second', [1, 1, 0], [1, 1, 1])]), []);
});

test('a gap of half a millimetre still fights, a gap of five millimetres does not', () => {
  assert.equal(coplanarWarnings([wall, node('near', [0, 0, 0.0005], [1, 0.5, 0.2])]).length, 1);
  assert.deepEqual(coplanarWarnings([wall, node('clear', [0, 0, 0.005], [1, 0.5, 0.2])]), []);
});

test('decal, depthLayer and resolveCoplanar all silence the pair without moving geometry', () => {
  assert.deepEqual(coplanarWarnings([wall, { ...sign, decal: true }]), []);
  assert.deepEqual(coplanarWarnings([wall, { ...sign, depthLayer: 2 }]), []);
  const scene = createAgentScene(recipe([wall, sign], { resolveCoplanar: 'offset' }));
  const [wallPart, signPart] = ['wall', 'sign'].map(name => scene.parts.find(part => part.name === name));
  assert.equal(depthLayerOf(wallPart), 0);
  assert.equal(depthLayerOf(signPart), 1);
  assert.deepEqual(Array.from(signPart.matrix), Array.from(createAgentScene(recipe([wall, sign])).parts.find(part => part.name === 'sign').matrix));
  assert.deepEqual((scene.inspect().diagnostics ?? []).filter(entry => entry.kind === 'coplanar-overlap'), []);
});

test('node decal and depthLayer are validated', () => {
  assert.throws(() => createAgentScene(recipe([wall, { ...sign, decal: 'yes' }])), /decal must be boolean/);
  assert.throws(() => createAgentScene(recipe([wall, { ...sign, depthLayer: 9 }])), /depthLayer must be within 0 and 4/);
  assert.throws(() => createAgentScene(recipe([wall], { resolveCoplanar: true })), /resolveCoplanar/);
});

test('renderer diagnostics carry the same warning, and a decal batches apart from its wall', () => {
  const scene = createAgentScene(recipe([wall, sign]));
  const renderer = installCoplanarDiagnostics({});
  const batches = [{ parts: scene.parts }];
  const coplanarProblems = renderer.coplanarDiagnostics(batches);
  assert.equal(renderer.coplanarDiagnostics(batches), coplanarProblems, 'the same layout is checked once');
  const problems = frameDiagnostics({ world: false, depth: true, effects: resolveEffects({}), coplanarProblems });
  assert.deepEqual(problems.map(problem => problem.kind), ['coplanar-overlap']);
  const resolved = resolveCoplanarParts(scene.parts);
  assert.equal(groupParts(scene.parts).length, 1);
  assert.equal(groupParts(resolved).length, 2);
});

test('the polygon offset is scoped to the layer and switched off for layer 0', () => {
  const calls = [];
  const context = {
    POLYGON_OFFSET_FILL: 'fill',
    enable: capability => calls.push(['enable', capability]),
    disable: capability => calls.push(['disable', capability]),
    polygonOffset: (factor, units) => calls.push(['offset', factor, units]),
  };
  const fake = { context };
  Renderer67.prototype.applyDepthLayer.call(fake, 2);
  Renderer67.prototype.applyDepthLayer.call(fake, 0);
  assert.deepEqual(calls, [['enable', 'fill'], ['offset', -2, -8], ['disable', 'fill']]);
});

test('the check is bounded: a work budget ends the sweep and says so', () => {
  const scene = createAgentScene(recipe([wall, sign]));
  const result = findCoplanarOverlaps(scene.parts, { workBudget: 0 });
  assert.equal(result.truncated, true);
  assert.deepEqual(coplanarOverlapDiagnostics({ overlaps: [], truncated: true }), []);
});

// A grid of `cells` x `cells` quads on the plane y = height, spanning `size` metres, as one part.
function gridPart(name, size, cells, height) {
  const positions = [];
  const indices = [];
  for (let row = 0; row <= cells; row++) {
    for (let column = 0; column <= cells; column++) positions.push(column * size / cells, height, row * size / cells);
  }
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const corner = row * (cells + 1) + column;
      indices.push(corner, corner + cells + 1, corner + 1, corner + 1, corner + cells + 1, corner + cells + 2);
    }
  }
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { name, geometry: { positions: new Float32Array(positions), indices: new Uint32Array(indices) }, matrix, material: {} };
}

test('a flush pair of finely tessellated parts is found, with no cap on the triangles tested', () => {
  const road = gridPart('road', 20, 40, 0);
  const marking = gridPart('marking', 10, 30, 0.0004);
  const crowd = Array.from({ length: 60 }, (unused, index) => gridPart(`filler${index}`, 20, 40, 5 + index));
  const { overlaps, truncated } = findCoplanarOverlaps([...crowd, road, marking]);
  assert.equal(truncated, false);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].smaller.name, 'marking');
  assert.ok(overlaps[0].area > 90);
});

function movedPart(part, name, x, z) {
  const matrix = new Float32Array(part.matrix);
  matrix[12] = x;
  matrix[14] = z;
  return { ...part, name, matrix };
}

test('one large part against many small flush parts finds every pair within a small work budget', () => {
  const floor = gridPart('floor', 100, 200, 0);
  const tile = gridPart('tile', 1, 1, 0.0005);
  const tiles = Array.from({ length: 300 }, (unused, index) => movedPart(tile, `tile${index}`, (index % 20) * 4 + 1, Math.floor(index / 20) * 4 + 1));
  const { overlaps, truncated, work } = findCoplanarOverlaps([floor, ...tiles]);
  assert.equal(truncated, false);
  assert.equal(overlaps.length, 300);
  assert.ok(overlaps.every(overlap => overlap.larger.name === 'floor'));
  assert.ok(work < 1_000_000);
});

test('thousands of parts that touch no common plane cost no part-pair work', () => {
  const crowd = Array.from({ length: 3000 }, (unused, index) => movedPart(gridPart('box', 1, 1, 0.1 * (index % 700)), `crowd${index}`, (index % 60) * 0.5, Math.floor(index / 60) * 0.5));
  const flush = movedPart(gridPart('box', 1, 1, 0.0004), 'flushWithFirst', 0, 0);
  const { overlaps, truncated, work } = findCoplanarOverlaps([...crowd, flush]);
  assert.equal(truncated, false);
  assert.ok(overlaps.some(overlap => overlap.smaller.name === 'flushWithFirst' || overlap.larger.name === 'flushWithFirst'));
  assert.ok(work < 1_000_000);
});

test('hundreds of copies parked at one spot cost two parts, not every pair among them', () => {
  const mote = gridPart('mote', 1, 1, 0);
  const parked = Array.from({ length: 600 }, (unused, index) => ({ ...mote, name: `mote${index}` }));
  const { overlaps, truncated, work } = findCoplanarOverlaps(parked);
  assert.equal(truncated, false);
  assert.equal(overlaps.length, 1);
  assert.ok(work < 100);
});

test('flush parts get a layer beside the part, so the part objects and updateParts keep working', () => {
  const road = gridPart('roadTwo', 4, 4, 0);
  const marking = gridPart('markingTwo', 2, 2, 0.00005);
  const far = gridPart('farAway', 4, 4, 30);
  assert.equal(resolveFlushParts([road, marking, far]), 1);
  assert.equal(depthLayerOf(marking), 1);
  assert.equal(depthLayerOf(road), 0);
  assert.equal(depthLayerOf(far), 0);
  assert.equal(marking.depthLayer, undefined);
});

test('faces that share only an edge or a seam are not pairs, and a sliver under the minimum area is ignored', () => {
  const left = gridPart('left', 2, 2, 0);
  const right = movedPart(gridPart('right', 2, 2, 0), 'right', 2, 0);
  assert.deepEqual(findCoplanarOverlaps([left, right]).overlaps, []);
  const cornerOnly = movedPart(gridPart('cornerOnly', 2, 2, 0), 'cornerOnly', 2, 2);
  assert.deepEqual(findCoplanarOverlaps([left, cornerOnly]).overlaps, []);
  const sliver = movedPart(gridPart('sliver', 2, 2, 0), 'sliver', 1.99999, 0);
  assert.deepEqual(findCoplanarOverlaps([left, sliver]).overlaps, []);
  assert.equal(resolveFlushParts([left, right, cornerOnly]), 0);
});

test('two parts that really share area are a pair with that area', () => {
  const base = gridPart('base', 4, 1, 0);
  const overlapping = movedPart(gridPart('overlapping', 4, 1, 0), 'overlapping', 3, 0);
  const { overlaps } = findCoplanarOverlaps([base, overlapping]);
  assert.equal(overlaps.length, 1);
  assert.ok(Math.abs(overlaps[0].area - 4) < 1e-6);
});

test('resolveFlushParts leaves exactly flush pairs to the depth buffer; coplanarLayers still layers them', () => {
  const road = gridPart('roadExact', 4, 4, 0);
  const marking = gridPart('markingExact', 2, 2, 0);
  assert.equal(resolveFlushParts([road, marking]), 0);
  assert.equal(coplanarLayers(findCoplanarOverlaps([road, marking]).overlaps).get(marking), 1);
  assert.equal(resolveFlushParts([road, marking], { minimumGap: 0 }), 1, 'the renderer passes a gap of 0 when reversedDepth is false');
  assert.equal(depthLayerOf(marking), 1);
});

test('layers settle in chains and never pile up on the top layer', () => {
  const big = gridPart('chainBig', 10, 1, 0);
  const middle = gridPart('chainMiddle', 5, 1, 0);
  const small = gridPart('chainSmall', 2, 1, 0);
  const layers = coplanarLayers(findCoplanarOverlaps([small, middle, big]).overlaps);
  assert.equal(layers.get(middle), 1);
  assert.equal(layers.get(small), 2);
  const stack = Array.from({ length: 8 }, (unused, index) => gridPart(`stack${index}`, 10 - index, 1, 0));
  const stackLayers = coplanarLayers(findCoplanarOverlaps(stack).overlaps);
  for (const layer of stackLayers.values()) assert.ok(layer <= MAXIMUM_DEPTH_LAYER);
});
