import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { evaluateForceFields, normalizeForceFields } from '../src/force-fields.js';
import { createParticleLaunches, particleStateAt } from '../src/particles.js';

const ZERO_FORCES = { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0 };

// One particle launched from `origin` with `launchVelocity`, under force fields only.
function particleAt(time, { origin = [0, 0, 0], launchVelocity = [0, 0, 0], fields }) {
  const speed = Math.hypot(...launchVelocity);
  const forces = { ...ZERO_FORCES, fields: normalizeForceFields(fields) };
  const launches = createParticleLaunches({
    count: 1, seed: 3, emitter: { shape: 'point', position: origin }, lifetime: [100, 100], speed: [speed, speed],
    direction: speed ? launchVelocity : [0, 1, 0], spreadRadians: 0, size: [1, 1], forces,
  });
  return particleStateAt(launches, 0, forces, 'constant', time, { position: [0, 0, 0], scale: 0 }).position;
}

function accelerationAt(fieldInput, position, velocity = [0, 0, 0], time = 0) {
  return evaluateForceFields(normalizeForceFields([fieldInput]), position, velocity, time, [0, 0, 0]);
}

test('wind pushes a resting particle along its direction like constant acceleration', () => {
  const position = particleAt(1, { fields: [{ type: 'wind', direction: [0, 0, 2], strength: 2 }] });
  assert.ok(Math.abs(position[2] - 1) < 0.02, `expected about 1 m, got ${position[2]}`);
  assert.equal(position[0], 0);
  assert.equal(position[1], 0);
});

test('drag slows a moving particle along the exponential path', () => {
  const position = particleAt(1, { launchVelocity: [10, 0, 0], fields: [{ type: 'drag', strength: 1 }] });
  assert.ok(Math.abs(position[0] - 10 * (1 - Math.exp(-1))) < 0.06, `expected about 6.32 m, got ${position[0]}`);
});

test('a vortex swirls a particle around its axis and keeps it at about the same radius', () => {
  const field = { type: 'vortex', axis: [0, 1, 0], strength: 4 };
  assert.deepEqual(accelerationAt(field, [1, 0, 0]).map(value => Number(value.toFixed(9)) + 0), [0, 0, -4]);
  const position = particleAt(0.5, { origin: [1, 0, 0], fields: [field] });
  assert.ok(position[2] < -0.4, 'moves in the swirl direction (axis cross offset)');
  assert.equal(position[1], 0);
});

test('a magnet pulls toward its position and a negative strength pushes away', () => {
  assert.deepEqual(accelerationAt({ type: 'magnet', position: [0, 0, 0], strength: 3 }, [2, 0, 0]).map(value => value + 0), [-3, 0, 0]);
  assert.deepEqual(accelerationAt({ type: 'magnet', position: [0, 0, 0], strength: -3 }, [2, 0, 0]).map(value => value + 0), [3, 0, 0]);
  const position = particleAt(0.5, { origin: [2, 0, 0], fields: [{ type: 'magnet', strength: 8 }] });
  assert.ok(Math.abs(position[0] - (2 - 0.5 * 8 * 0.25)) < 0.05, `expected about 1 m, got ${position[0]}`);
});

test('falloff shrinks a field with distance and radius cuts it off', () => {
  const near = accelerationAt({ type: 'wind', strength: 10, falloff: 1, radius: 5 }, [1, 0, 0])[0];
  const far = accelerationAt({ type: 'wind', strength: 10, falloff: 1, radius: 5 }, [4, 0, 0])[0];
  assert.equal(near, 10 / 2);
  assert.equal(far, 10 / 5);
  assert.equal(accelerationAt({ type: 'wind', strength: 10, falloff: 1, radius: 5 }, [6, 0, 0])[0], 0);
});

test('turbulence is smooth, bounded by its strength, changes in time and depends on the seed', () => {
  const field = { type: 'turbulence', strength: 3, scale: 0.7, rate: 1, seed: 11 };
  const here = accelerationAt(field, [0.3, 0.4, 0.5]);
  assert.deepEqual(accelerationAt(field, [0.3, 0.4, 0.5]), here, 'same seed, same value');
  assert.notDeepEqual(accelerationAt({ ...field, seed: 12 }, [0.3, 0.4, 0.5]), here);
  assert.notDeepEqual(accelerationAt(field, [0.3, 0.4, 0.5], [0, 0, 0], 0.4), here);
  const nearby = accelerationAt(field, [0.301, 0.4, 0.5]);
  assert.ok(Math.hypot(...nearby.map((value, axis) => value - here[axis])) < 0.1, 'no jumps between close points');
  for (let sample = 0; sample < 200; sample++) {
    const value = accelerationAt(field, [sample * 0.37, sample * 0.11, -sample * 0.23]);
    assert.ok(value.every(component => Math.abs(component) <= 3 + 1e-9));
  }
});

test('a particle under fields gives the same positions after any seek order', () => {
  const fields = [{ type: 'turbulence', strength: 5, seed: 4 }, { type: 'vortex', strength: 2 }];
  const first = particleAt(0.8, { launchVelocity: [1, 2, 0], fields });
  particleAt(2.5, { launchVelocity: [1, 2, 0], fields });
  assert.deepEqual(particleAt(0.8, { launchVelocity: [1, 2, 0], fields }), first);
});

test('bad fields are rejected with a clear message', () => {
  assert.throws(() => normalizeForceFields([{ type: 'gravity' }]), /type must be one of/);
  assert.throws(() => normalizeForceFields([{ type: 'wind', direction: [0, 0, 0] }]), /zero vector/);
  assert.throws(() => normalizeForceFields([{ type: 'wind', strngth: 1 }]), /unknown fields/);
  assert.throws(() => normalizeForceFields(Array.from({ length: 9 }, () => ({ type: 'drag' }))), /at most 8/);
});

function sceneWithFields(particleFields, clothFields) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }, { id: 'sheet', type: 'grid', segments: 6 }],
    materials: [{ id: 'paint', color: [1, 1, 1], doubleSided: true }],
    nodes: [
      { id: 'sparks', geometry: 'speck', material: 'paint' },
      { id: 'flag', geometry: 'sheet', material: 'paint', translation: [0, 2, 0] },
    ],
    particles: { gravity: [0, 0, 0], fields: particleFields, systems: [{ node: 'sparks', seed: 2, count: 20, lifetime: 3, speed: 1, size: 0.05 }] },
    cloth: { duration: 1, fields: clothFields, sheets: [{ node: 'flag', pin: ['top'] }] },
  };
}

function positionsOf(scene, name) {
  return Array.from(scene.parts.find(part => part.name === name).geometry.positions);
}

test('one field list moves particles and cloth, and a recipe repeats frame for frame', () => {
  const still = createAgentScene(sceneWithFields([], []));
  const blown = [{ type: 'wind', direction: [0, 0, 1], strength: 6 }, { type: 'turbulence', strength: 2, seed: 5 }];
  const first = createAgentScene(sceneWithFields(blown, blown));
  const second = createAgentScene(sceneWithFields(blown, blown));
  for (const scene of [still, first, second]) scene.sampleMotion(0.9);
  for (const name of ['sparks', 'flag']) {
    assert.notDeepEqual(positionsOf(first, name), positionsOf(still, name), `${name} is moved by the fields`);
    assert.deepEqual(positionsOf(second, name), positionsOf(first, name), `${name} repeats with the same seed`);
  }
  const flagBefore = positionsOf(first, 'flag');
  first.sampleMotion(0.3);
  first.sampleMotion(0.9);
  assert.deepEqual(positionsOf(first, 'flag'), flagBefore, 'a seek back repeats the cloth');
});

test('fields lean hair toward the push and clamp it to the strand length', () => {
  const recipe = fields => ({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'head', type: 'sphere', segments: 12, rings: 8 }, { id: 'strands', type: 'box' }],
    materials: [{ id: 'fur', color: [0.3, 0.2, 0.1] }],
    nodes: [{ id: 'head', geometry: 'head', material: 'fur' }, { id: 'fur', geometry: 'strands', material: 'fur' }],
    particles: { fields, systems: [{ type: 'hair', node: 'fur', surface: 'head', seed: 5, count: 30, length: 0.2, segments: 4 }] },
  });
  const mean = scene => positionsOf(scene, 'fur').reduce((sum, value, index) => (index % 3 === 0 ? sum + value : sum), 0);
  const calm = createAgentScene(recipe([]));
  const windy = createAgentScene(recipe([{ type: 'wind', direction: [1, 0, 0], strength: 5 }]));
  const gale = createAgentScene(recipe([{ type: 'wind', direction: [1, 0, 0], strength: 1000 }]));
  assert.ok(mean(windy) > mean(calm), 'hair leans along +x');
  assert.ok(positionsOf(gale, 'fur').every(Number.isFinite));
  assert.ok(Math.max(...positionsOf(gale, 'fur').filter((_, index) => index % 3 === 0)) < 1.5, 'a gale does not stretch strands');
});
