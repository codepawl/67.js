import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { closedRoomShare, CLOSED_ROOM_SHARE, CLOSED_ROOM_MAXIMUM_TRIANGLES } from '../src/closed-room.js';
import { fittedClosedRoomShare } from '../src/fitted-closed-room.js';

const WALL = 0.2;

function wall(id, translation, scale) {
  return { id, geometry: 'box', material: 'stone', translation, scale };
}

// A 10 x 6 x 10 room built from six slabs, or the same room with the roof left out.
function roomRecipe({ roof = true, bake } = {}) {
  const slabs = [
    wall('floor', [0, -3, 0], [10, WALL, 10]),
    wall('north', [0, 0, -5], [10, 6, WALL]),
    wall('south', [0, 0, 5], [10, 6, WALL]),
    wall('west', [-5, 0, 0], [WALL, 6, 10]),
    wall('east', [5, 0, 0], [WALL, 6, 10]),
  ];
  if (roof) slabs.push(wall('roof', [0, 3, 0], [10, WALL, 10]));
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: slabs,
    ...(bake ? { bake } : {}),
  };
}

function diagnosticKinds(recipe) {
  const inspection = createAgentScene(recipe).inspect();
  return (inspection.diagnostics ?? []).map(entry => entry.kind);
}

test('a closed room without a bake gets a diagnostic that names the bake', () => {
  const inspection = createAgentScene(roomRecipe()).inspect();
  const found = inspection.diagnostics.find(entry => entry.kind === 'closed-room-without-bake');
  assert.ok(found, 'expected closed-room-without-bake');
  assert.equal(found.severity, 'warning');
  assert.match(found.fix, /"bake"/);
});

test('a room with a bake, a room with its roof off and a lone solid get no closed room diagnostic', () => {
  assert.ok(!diagnosticKinds(roomRecipe({ roof: false })).includes('closed-room-without-bake'));
  const solid = { ...roomRecipe(), nodes: [wall('block', [0, 0, 0], [4, 4, 4])] };
  assert.ok(!diagnosticKinds(solid).includes('closed-room-without-bake'));
});

test('the ray test counts only inner faces: a room is closed, a solid around the centre is not', () => {
  const matrices = parts => new Map(parts.map(part => [part.name, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]));
  const triangle = (a, b, c) => ({ positions: new Float32Array([...a, ...b, ...c]), indices: new Uint32Array([0, 1, 2]) });
  // Two large triangles on opposite sides of the centre, wound to face it or to face away from it.
  const facingCentre = [
    { name: 'near', geometry: triangle([-9, -9, -5], [9, -9, -5], [0, 9, -5]) },
    { name: 'far', geometry: triangle([-9, -9, 5], [0, 9, 5], [9, -9, 5]) },
  ];
  const facingAway = [
    { name: 'near', geometry: triangle([-9, -9, -5], [0, 9, -5], [9, -9, -5]) },
    { name: 'far', geometry: triangle([-9, -9, 5], [9, -9, 5], [0, 9, 5]) },
  ];
  assert.ok(closedRoomShare(facingCentre, matrices(facingCentre)) > 0);
  assert.equal(closedRoomShare(facingAway, matrices(facingAway)), 0);
  assert.equal(closedRoomShare([], new Map()), null);
  assert.ok(CLOSED_ROOM_SHARE <= 1);
});

// A reading corner: a 5 x 3 x 4.7 room whose left wall has a window opening, with a lawn and a hedge outside the window.
function readingCornerParts() {
  const recipe = {
    ...roomRecipe(),
    nodes: [
      wall('floor', [0, -0.05, 0], [5.1, 0.1, 4.7]),
      wall('back', [0, 1.4, -2.275], [5.1, 2.8, 0.15]),
      wall('front', [0, 1.4, 2.275], [5.1, 2.8, 0.15]),
      wall('right', [2.475, 1.4, 0], [0.15, 2.8, 4.7]),
      wall('ceiling', [0, 2.875, 0], [5.1, 0.15, 4.7]),
      wall('left-below', [-2.475, 0.375, 0], [0.15, 0.75, 4.7]),
      wall('left-above', [-2.475, 2.5, 0], [0.15, 0.6, 4.7]),
      wall('left-back', [-2.475, 1.475, -1.975], [0.15, 1.45, 0.75]),
      wall('left-front', [-2.475, 1.475, 1.275], [0.15, 1.45, 2.15]),
      wall('lawn', [-10.5, -0.2, -2], [16, 0.1, 24]),
      wall('hedge', [-11.5, 0.85, -2], [1.4, 2.1, 24]),
    ],
  };
  return createAgentScene(recipe).parts;
}

function sharedMatrices(parts) {
  return new Map(parts.map(part => [part.name, part.matrix]));
}

test('a room with a window opening and a garden outside still counts as closed', () => {
  const parts = readingCornerParts();
  assert.ok(fittedClosedRoomShare(parts, sharedMatrices(parts)) >= CLOSED_ROOM_SHARE);
});

test('open ground with the same garden and no walls does not count as closed', () => {
  const parts = readingCornerParts().filter(part => ['floor', 'lawn', 'hedge'].includes(part.name));
  assert.ok(fittedClosedRoomShare(parts, sharedMatrices(parts)) < CLOSED_ROOM_SHARE);
});

test('a prop heavier than the triangle budget does not stop a room from counting as closed', () => {
  const propTriangles = CLOSED_ROOM_MAXIMUM_TRIANGLES + 1000;
  const positions = new Float32Array(propTriangles * 9);
  const indices = new Uint32Array(propTriangles * 3);
  for (let triangle = 0; triangle < propTriangles; triangle++) {
    const x = -1 + (triangle % 100) * 0.001;
    positions.set([x, 0, 0, x + 0.001, 0, 0, x, 0.001, 0], triangle * 9);
    indices.set([triangle * 3, triangle * 3 + 1, triangle * 3 + 2], triangle * 3);
  }
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const prop = { name: 'scanned-prop', geometry: { positions, indices }, matrix: identity };
  const parts = [...readingCornerParts(), prop];
  assert.ok(fittedClosedRoomShare(parts, sharedMatrices(parts)) >= CLOSED_ROOM_SHARE);
  assert.equal(closedRoomShare([prop], sharedMatrices([prop])), null);
});

test('the closed room diagnostic disappears once the recipe asks for a bake', async () => {
  const recipe = roomRecipe({ bake: { preset: 'draft' } });
  await loadAgentSceneModules(recipe);
  assert.ok(!diagnosticKinds(recipe).includes('closed-room-without-bake'));
});

// A lone mug on a saucer with a torus handle, the mug lathed with its faces turned inward, so a ray from the middle of the
// scene's bounds starts inside it and sees only inner faces.
function mugRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'mugBody', type: 'lathe', profile: [[0, 1], [0.45, 1], [0.45, 0], [0, 0]], segments: 24 },
      { id: 'saucerShape', type: 'lathe', profile: [[0, 0.04], [0.85, 0.06], [0.95, 0.12], [1, 0.12], [0.9, 0.05], [0, 0]], segments: 24 },
      { id: 'handleShape', type: 'torus', segments: 16, sides: 8 },
    ],
    materials: [{ id: 'ceramic', color: [0.9, 0.9, 0.9] }],
    nodes: [
      { id: 'saucer', geometry: 'saucerShape', material: 'ceramic' },
      { id: 'mug', geometry: 'mugBody', material: 'ceramic', translation: [0, 0.12, 0] },
      { id: 'handle', geometry: 'handleShape', material: 'ceramic', translation: [0.55, 0.5, 0], scale: [0.25, 0.25, 0.25] },
    ],
  };
}

test('a lone mug on a saucer is not a closed room, though the middle of its bounds is inside the mug (#1197)', async () => {
  await loadAgentSceneModules(mugRecipe());
  assert.ok(!diagnosticKinds(mugRecipe()).includes('closed-room-without-bake'));
});

test('a closed room built as one inward shell part (round or four-sided) still gets the diagnostic (#1197)', async () => {
  for (const segments of [24, 4]) {
    const recipe = mugRecipe();
    recipe.geometries[0].segments = segments;
    recipe.nodes = [{ id: 'shell', geometry: 'mugBody', material: 'ceramic', scale: [10, 6, 10] }];
    await loadAgentSceneModules(recipe);
    assert.ok(diagnosticKinds(recipe).includes('closed-room-without-bake'), `segments ${segments}`);
  }
});

test('a closed room with a prop at its centre still gets the diagnostic from a free origin (#1197)', () => {
  const recipe = roomRecipe();
  recipe.nodes.push(wall('table', [0, -2, 0], [2, 2, 2]));
  assert.ok(diagnosticKinds(recipe).includes('closed-room-without-bake'));
});
