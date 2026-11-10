import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, agentSceneModulesNeeded } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { bakeCloth, sampleClothFrames, weldVertices, CLOTH_LIMITS } from '../src/cloth.js';

function flagRecipe(cloth, extraNodes = [], segments = 12) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'sheet', type: 'grid', segments },
      { id: 'ball', type: 'sphere' },
      { id: 'slab', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'fabric', color: [0.7, 0.2, 0.2], doubleSided: true }, { id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 2, 0], scale: [2, 1.5, 1] },
      ...extraNodes,
    ],
    cloth,
  };
}

const hangingFlag = { duration: 2, sheets: [{ node: 'flag', pin: ['top'] }] };

function clothPositions(scene, nodeId = 'flag') {
  return Array.from(scene.parts.find(part => part.name === nodeId).geometry.positions);
}

function worldY(scene, nodeId, localY) {
  const matrix = scene.parts.find(part => part.name === nodeId).matrix;
  return matrix[5] * localY + matrix[13];
}

test('the same time gives the same cloth positions, and a seek backwards reproduces them', () => {
  const scene = createAgentScene(flagRecipe({ ...hangingFlag, wind: [0, 0, 6] }));
  scene.sampleMotion(1.3);
  const first = clothPositions(scene);
  scene.sampleMotion(0.4);
  const earlier = clothPositions(scene);
  assert.notDeepEqual(earlier, first);
  scene.sampleMotion(1.3);
  assert.deepEqual(clothPositions(scene), first, 'seeking back to the same time repeats the positions');
  scene.sampleMotion(2);
  scene.sampleMotion(0.4);
  assert.deepEqual(clothPositions(scene), earlier, 'seeking backwards from the end repeats the earlier frame');
  const fresh = createAgentScene(flagRecipe({ ...hangingFlag, wind: [0, 0, 6] }));
  fresh.sampleMotion(1.3);
  assert.deepEqual(clothPositions(fresh), first, 'a second scene from the same recipe bakes identical frames');
});

test('time zero is the rest sheet, null restores it and a seek counts as a topology change', () => {
  const scene = createAgentScene(flagRecipe(hangingFlag));
  const restGeometry = scene.parts[0].geometry;
  const initialTopology = scene.topologyRevision;
  scene.sampleMotion(1);
  assert.notEqual(scene.parts[0].geometry, restGeometry);
  assert.ok(scene.topologyRevision > initialTopology, 'renderers must swap the deformed part');
  scene.sampleMotion(0);
  assert.equal(scene.parts[0].geometry, restGeometry);
  scene.sampleMotion(1);
  scene.sampleMotion(null);
  assert.equal(scene.parts[0].geometry, restGeometry);
  scene.sampleMotion(1);
  scene.sampleMotion(99);
  const held = clothPositions(scene);
  scene.sampleMotion(2);
  assert.deepEqual(clothPositions(scene), held, 'cloth holds its last frame after its duration');
});

test('pinned particles stay put while the rest of the sheet falls and hangs below the pins', () => {
  const scene = createAgentScene(flagRecipe(hangingFlag));
  scene.sampleMotion(2);
  const positions = clothPositions(scene);
  let topY = -Infinity;
  let bottomY = Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    topY = Math.max(topY, positions[index + 1]);
    bottomY = Math.min(bottomY, positions[index + 1]);
  }
  assert.ok(Math.abs(topY - 0.5) < 1e-4, `the pinned top row did not move, got ${topY}`);
  assert.ok(bottomY < -0.1 && bottomY > -0.75, `the free edge hangs, got ${bottomY}`);
  assert.ok(worldY(scene, 'flag', topY) > 2.7, 'pinned row stays at its authored height');
});

test('stretch stays bounded under gravity and wind', () => {
  const recording = bakeSheet({ wind: [0, 0, 8], frames: 121, pinned: 'top' });
  const { positions, triangles } = recording.rest;
  const last = new Float32Array(recording.result.particleCount * 3);
  sampleClothFrames(recording.result, 2, last);
  let longest = 0;
  for (let corner = 0; corner < triangles.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = triangles[corner + side] * 3;
      const second = triangles[corner + (side + 1) % 3] * 3;
      const restLength = Math.hypot(positions[first] - positions[second], positions[first + 1] - positions[second + 1], positions[first + 2] - positions[second + 2]);
      const length = Math.hypot(last[first] - last[second], last[first + 1] - last[second + 1], last[first + 2] - last[second + 2]);
      longest = Math.max(longest, length / restLength);
    }
  }
  assert.ok(longest < 1.25, `edges stretch at most 25 percent, got ${longest}`);
});

test('wind pushes the sheet along the wind and a calm sheet stays in its plane', () => {
  const calm = createAgentScene(flagRecipe(hangingFlag));
  const windy = createAgentScene(flagRecipe({ ...hangingFlag, wind: [0, 0, 8] }));
  calm.sampleMotion(1.5);
  windy.sampleMotion(1.5);
  const depth = scene => {
    const positions = clothPositions(scene);
    let total = 0;
    for (let index = 2; index < positions.length; index += 3) total += positions[index];
    return total / (positions.length / 3);
  };
  assert.ok(Math.abs(depth(calm)) < 1e-3, 'no wind, no sideways drift');
  assert.ok(depth(windy) > 0.05, `wind along +z pushes the sheet, got ${depth(windy)}`);
});

test('a sheet dropped on a ball drapes over it and never enters it', () => {
  const recipe = flagRecipe(
    { duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'ball', shape: 'ball' }] },
    [{ id: 'ball', geometry: 'ball', material: 'stone', translation: [0, 0, 0], scale: [0.5, 0.5, 0.5] }],
  );
  recipe.nodes[0] = { id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [1.6, 1.6, 1] };
  const scene = createAgentScene(recipe);
  scene.sampleMotion(2);
  const matrix = scene.parts[0].matrix;
  const localPositions = clothPositions(scene);
  let nearest = Infinity;
  let lowest = Infinity;
  for (let index = 0; index < localPositions.length; index += 3) {
    const x = matrix[0] * localPositions[index] + matrix[4] * localPositions[index + 1] + matrix[8] * localPositions[index + 2] + matrix[12];
    const y = matrix[1] * localPositions[index] + matrix[5] * localPositions[index + 1] + matrix[9] * localPositions[index + 2] + matrix[13];
    const z = matrix[2] * localPositions[index] + matrix[6] * localPositions[index + 1] + matrix[10] * localPositions[index + 2] + matrix[14];
    nearest = Math.min(nearest, Math.hypot(x, y, z));
    lowest = Math.min(lowest, y);
  }
  assert.ok(nearest > 0.5 - 0.01, `no particle is inside the ball, nearest ${nearest}`);
  assert.ok(lowest < 0.4, `the edges fall past the ball's equator, lowest ${lowest}`);
});

test('a box collider acts as a floor the sheet stops on', () => {
  const recipe = flagRecipe(
    { duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'floor' }] },
    [{ id: 'floor', geometry: 'slab', material: 'stone', translation: [0, 0.5, 0], scale: [8, 0.2, 8] }],
  );
  recipe.nodes[0] = { id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 2, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [1, 1, 1] };
  const scene = createAgentScene(recipe);
  scene.sampleMotion(2);
  const matrix = scene.parts[0].matrix;
  const positions = clothPositions(scene);
  let lowest = Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    lowest = Math.min(lowest, matrix[1] * positions[index] + matrix[5] * positions[index + 1] + matrix[9] * positions[index + 2] + matrix[13]);
  }
  assert.ok(lowest >= 0.6 - 1e-3, `the sheet rests on the floor top at 0.6, lowest ${lowest}`);
});

test('the report lists particles, pinned count and final bounds', () => {
  const scene = createAgentScene(flagRecipe(hangingFlag));
  const report = scene.inspect().cloth;
  assert.equal(report.sheets[0].node, 'flag');
  assert.equal(report.sheets[0].particles, 13 * 13);
  assert.equal(report.sheets[0].pinned, 13);
  assert.equal(report.frames, 121);
  assert.equal(createAgentScene({ ...flagRecipe(null) }).inspect().cloth, undefined);
});

test('cloth recipes need the cloth module and plain recipes do not', () => {
  assert.deepEqual(agentSceneModulesNeeded(flagRecipe(hangingFlag)), ['cloth']);
  assert.deepEqual(agentSceneModulesNeeded(flagRecipe(null)), []);
});

test('set-cloth edits the section, null clears it and the recipe round trips', () => {
  const scene = createAgentScene(flagRecipe(null));
  assert.throws(() => scene.sampleMotion(1), /no motion, physics, cloth, particles/);
  scene.apply([{ type: 'set-cloth', cloth: hangingFlag }], { expectedRevision: scene.revision });
  scene.sampleMotion(1);
  const exported = scene.exportRecipe();
  assert.equal(exported.cloth.sheets[0].node, 'flag');
  const again = createAgentScene(exported);
  again.sampleMotion(1);
  assert.deepEqual(clothPositions(again), clothPositions(scene));
  scene.apply([{ type: 'set-cloth', cloth: null }], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().cloth, null);
  assert.equal(scene.parts[0].geometry.positions.length, createAgentScene(flagRecipe(null)).parts[0].geometry.positions.length);
});

test('editing a scene while the cloth is posed returns the rest sheet and tells renderers', () => {
  const scene = createAgentScene(flagRecipe(hangingFlag));
  scene.sampleMotion(1);
  const topology = scene.topologyRevision;
  scene.apply([{ type: 'set-material', id: 'fabric', roughness: 0.4 }], { expectedRevision: scene.revision });
  assert.ok(scene.topologyRevision > topology);
  assert.equal(scene.parts[0].geometry.positions.length, 13 * 13 * 3);
});

test('hostile cloth sections are rejected before any solver runs', () => {
  const bad = (cloth, pattern, nodes) => assert.throws(() => createAgentScene(flagRecipe(cloth, nodes)), pattern);
  bad({ duration: 2, sheets: [] }, /cloth\.sheets: got \[\]; expected at least one sheet/);
  bad({ duration: 0, sheets: [{ node: 'flag' }] }, /cloth\.duration: got 0; expected a number from 0\.1 to 10/);
  bad({ duration: 11, sheets: [{ node: 'flag' }] }, /cloth\.duration: got 11; expected a number from 0\.1 to 10/);
  bad({ duration: 2, sheets: [{ node: 'missing' }] }, /cloth\.sheets\[0\]\.node: got "missing"; expected the ID of a node in the recipe/);
  bad({ duration: 2, sheets: [{ node: 'flag' }, { node: 'flag' }] }, /cloth\.sheets\[1\]\.node: got "flag"; expected a node that cloth uses once/);
  bad({ duration: 2, sheets: [{ node: 'flag', stiffness: 2 }] }, /cloth\.sheets\[0\]\.stiffness: got 2; expected a number from 0\.01 to 1/);
  bad({ duration: 2, sheets: [{ node: 'flag', density: 0 }] }, /cloth\.sheets\[0\]\.density: got 0; expected a number from 0\.01 to 10/);
  bad({ duration: 2, sheets: [{ node: 'flag', pin: ['middle'] }] }, /cloth\.sheets\[0\]\.pin\[0\]: got "middle"; expected one of top, bottom/);
  bad({ duration: 2, sheets: [{ node: 'flag', surprise: 1 }] }, /cloth\.sheets\[0\]\.surprise: got 1; expected no such field/);
  bad({ duration: 2, surprise: 1, sheets: [{ node: 'flag' }] }, /cloth\.surprise: got 1; expected no such field/);
  bad({ duration: 2, wind: [0, 0, NaN], sheets: [{ node: 'flag' }] }, /finite/);
  bad({ duration: 2, wind: [0, 0, 1e9], sheets: [{ node: 'flag' }] }, /cloth\.wind\[2\]: got 1000000000; expected a number from -100 to 100/);
  bad({ duration: 2, gravity: [0, -Infinity, 0], sheets: [{ node: 'flag' }] }, /finite/);
  bad({ duration: 2, sheets: Array.from({ length: 9 }, () => ({ node: 'flag' })) }, /cloth\.sheets: got "9 entries"; expected an array of at most 8 entries/);
  bad({ duration: 2, sheets: [{ node: 'flag' }], colliders: Array.from({ length: 17 }, () => ({ node: 'flag' })) }, /cloth\.colliders: got "17 entries"; expected an array of at most 16 entries/);
  bad({ duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'flag' }] }, /cloth\.colliders\[0\]\.node: got "flag"; expected a node that cloth uses once/);
  bad({ duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'stone', shape: 'cone' }] }, /cloth\.colliders\[0\]\.shape: got "cone"; expected one of ball, box/, [{ id: 'stone', geometry: 'ball', material: 'stone' }]);
  bad({ duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'child' }] }, /cloth\.colliders\[0\]\.node: got "child"; expected a root node with no parent/, [{ id: 'child', parent: 'flag', geometry: 'ball', material: 'stone' }]);
  bad('cloth', /cloth: got "cloth"; expected a plain object/);
  bad({ duration: 2, sheets: 'flag' }, /cloth\.sheets: got "flag"; expected an array/);
});

test('particle and frame limits reject oversized bakes with a clear error', () => {
  const huge = flagRecipe({ duration: 10, sheets: [{ node: 'flag' }] }, [], 64);
  assert.throws(() => createAgentScene(huge), /solver operations|particle positions/);
  assert.throws(() => bakeCloth(new Float64Array(3 * (CLOTH_LIMITS.maxParticles + 1)), new Uint32Array([0, 1, 2]), { frameCount: 2 }), /particles/);
  const bounded = flagRecipe({ duration: 1, sheets: [{ node: 'flag' }] }, [], 64);
  assert.ok(createAgentScene(bounded).parts.length === 1, 'a 64 by 64 grid for one second fits');
});

test('a cloth node cannot also carry motion or a physics body', () => {
  const withMotion = flagRecipe(hangingFlag);
  withMotion.motion = { duration: 1, loop: false, tracks: [{ kind: 'node', id: 'flag', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 2, 0] }, { time: 1, value: [1, 2, 0] }] }] };
  assert.throws(() => createAgentScene(withMotion), /cloth\.sheets\[0\]\.node: got "flag"; expected a node that stays where it is/);
});

test('welding joins vertices at one position so a seam cannot tear', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const welded = weldVertices(positions, new Uint32Array([0, 1, 2, 3, 4, 5]));
  assert.equal(welded.representatives.length, 4);
  assert.equal(welded.particleOfVertex[1], welded.particleOfVertex[3]);
  assert.equal(welded.triangles.length, 6);
});

test('capabilities describe cloth limits that match the solver', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.cloth.limits.maxParticles, CLOTH_LIMITS.maxParticles);
  assert.equal(AGENT_SCENE_CAPABILITIES.cloth.limits.substeps, CLOTH_LIMITS.substeps);
  assert.equal(AGENT_SCENE_CAPABILITIES.cloth.limits.iterations, CLOTH_LIMITS.iterations);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-cloth'));
  assert.ok(AGENT_SCENE_CAPABILITIES.geometryTypes.includes('grid'));
});

function bakeSheet({ wind, frames, pinned }) {
  const segments = 8;
  const positions = [];
  for (let row = 0; row <= segments; row++) {
    for (let column = 0; column <= segments; column++) {
      positions.push(column / segments - 0.5, 2 - row / segments, 0);
    }
  }
  const triangles = [];
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const first = row * (segments + 1) + column;
      const below = first + segments + 1;
      triangles.push(first, first + 1, below, first + 1, below + 1, below);
    }
  }
  const rest = { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles) };
  const topRow = pinned === 'top' ? Array.from({ length: segments + 1 }, (_, column) => column) : [];
  const result = bakeCloth(rest.positions, rest.triangles, { wind, pinned: topRow, frameCount: frames });
  return { rest, result };
}

test('the solver is bit-exact between runs', () => {
  const first = bakeSheet({ wind: [1, 0, 4], frames: 61, pinned: 'top' }).result.frames;
  const second = bakeSheet({ wind: [1, 0, 4], frames: 61, pinned: 'top' }).result.frames;
  assert.deepEqual(Buffer.from(first.buffer), Buffer.from(second.buffer));
});
