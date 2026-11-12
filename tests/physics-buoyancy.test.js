import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bakePhysicsScene, loadPhysicsEngine, planPhysicsScene } from '../src/physics.js';
import { seaHeightAt, normalizeOcean } from '../src/physics-buoyancy.js';

const CALM_SEA = { windSpeed: 0.5, size: 50, seed: 4 };
const FRAMES_PER_SECOND = 60;

function crateDefinition({ density = 500, ocean = CALM_SEA, float = {}, translation = [0, 0.4, 0], halfExtents = [0.5, 0.5, 0.5] } = {}) {
  return {
    ocean,
    bodies: [{ name: 'crate', translation, float }],
    colliders: [{ name: 'crate', body: 'crate', shape: 'cuboid', halfExtents, density }],
  };
}

function bake(definition, seconds) {
  return bakePhysicsScene(definition, { frameCount: Math.round(seconds * FRAMES_PER_SECOND) + 1 });
}

function bodyHeight(scene, time) {
  return scene.sample(time)[1];
}

function digest(scene, seconds) {
  const hash = createHash('sha256');
  for (let frame = 0; frame <= seconds * FRAMES_PER_SECOND; frame++) {
    hash.update(Buffer.from(scene.sample(frame / FRAMES_PER_SECOND).buffer.slice(0)));
  }
  return hash.digest('hex');
}

test.before(() => loadPhysicsEngine());

test('a box of density 500 on a calm sea settles at half its height under water', () => {
  const scene = bake(crateDefinition(), 20);
  const settledHeight = bodyHeight(scene, 20);
  const surface = seaHeightAt(normalizeOcean(CALM_SEA), 0, 0, 20);
  const submergedDepth = surface - (settledHeight - 0.5);
  assert.ok(Math.abs(submergedDepth - 0.5) <= 0.5 * 0.05, `submerged ${submergedDepth} m of a 1 m box`);
});

test('the submerged depth follows the density: 250 sinks a quarter, 750 sinks three quarters', () => {
  for (const [density, expected] of [[250, 0.25], [750, 0.75]]) {
    const scene = bake(crateDefinition({ density }), 20);
    const surface = seaHeightAt(normalizeOcean(CALM_SEA), 0, 0, 20);
    const submergedDepth = surface - (bodyHeight(scene, 20) - 0.5);
    assert.ok(Math.abs(submergedDepth - expected) <= expected * 0.05, `density ${density} sank ${submergedDepth}`);
  }
});

test('a body on a rough sea follows the wave height over time', () => {
  const rough = { windSpeed: 9, size: 60, seed: 2, choppiness: 0 };
  const scene = bake(crateDefinition({ ocean: rough, density: 400, translation: [0, 0, 0], halfExtents: [0.6, 0.6, 0.6] }), 12);
  const sea = normalizeOcean(rough);
  const heights = [];
  const waves = [];
  for (let time = 4; time <= 12; time += 0.25) {
    heights.push(bodyHeight(scene, time));
    waves.push(seaHeightAt(sea, scene.sample(time)[0], scene.sample(time)[2], time));
  }
  const meanHeight = heights.reduce((total, value) => total + value, 0) / heights.length;
  const meanWave = waves.reduce((total, value) => total + value, 0) / waves.length;
  let covariance = 0;
  let heightVariance = 0;
  let waveVariance = 0;
  heights.forEach((height, index) => {
    covariance += (height - meanHeight) * (waves[index] - meanWave);
    heightVariance += (height - meanHeight) ** 2;
    waveVariance += (waves[index] - meanWave) ** 2;
  });
  assert.ok(waveVariance > 0.01, 'the sea moves');
  assert.ok(covariance / Math.sqrt(heightVariance * waveVariance) > 0.8, 'the body rises and falls with the surface');
});

test('a tilted hull rolls back upright with points spread across it', () => {
  const definition = crateDefinition({
    float: { points: [[-1, 0, -0.5], [1, 0, -0.5], [-1, 0, 0.5], [1, 0, 0.5]] },
    halfExtents: [1, 0.25, 0.5], density: 400, translation: [0, 0, 0],
  });
  definition.bodies[0].rotation = [Math.sin(0.25), 0, 0, Math.cos(0.25)];
  const scene = bake(definition, 15);
  const rotation = scene.sample(15).slice(3, 7);
  assert.ok(Math.abs(rotation[0]) < 0.03, `roll ${rotation[0]} settled`);
});

test('the bake is identical across runs and changes with the sea seed', () => {
  const rough = { windSpeed: 8, size: 60, seed: 7 };
  const first = digest(bake(crateDefinition({ ocean: rough }), 4), 4);
  const second = digest(bake(crateDefinition({ ocean: rough }), 4), 4);
  const otherSeed = digest(bake(crateDefinition({ ocean: { ...rough, seed: 8 } }), 4), 4);
  assert.equal(first, second);
  assert.notEqual(first, otherSeed);
});

test('a body without float ignores the sea', () => {
  const definition = crateDefinition();
  delete definition.bodies[0].float;
  const scene = bake(definition, 1);
  assert.ok(bodyHeight(scene, 1) < 0.4, 'it falls');
});

test('float and ocean fields name the field and what to pass', () => {
  const plan = definition => () => planPhysicsScene(definition, { frameCount: 2 });
  assert.throws(plan(crateDefinition({ float: { drag: -1 } })), /body crate\.float\.drag must be a number from 0 to 100/);
  assert.throws(plan(crateDefinition({ float: { bogus: 1 } })), /float\.bogus is unsupported; use one of drag, angularDrag, points/);
  assert.throws(plan(crateDefinition({ float: { points: [] } })), /float\.points must be 1 to 16 points/);
  assert.throws(plan(crateDefinition({ float: { points: Array(17).fill([0, 0, 0]) } })), /1 to 16 points/);
  assert.throws(plan(crateDefinition({ float: { points: [[0, 0]] } })), /float\.points\[0\] must be \[x, y, z\]/);
  assert.throws(plan(crateDefinition({ ocean: { windSpeed: 0 } })), /ocean\.windSpeed must be a number above 0 to 60/);
  assert.throws(plan(crateDefinition({ ocean: { waterDensity: 0 } })), /ocean\.waterDensity must be a number from 1 to 20000/);
  assert.throws(plan(crateDefinition({ ocean: { resolution: 17 } })), /ocean\.resolution must be an integer from 1 to 16/);
  assert.throws(plan(crateDefinition({ ocean: { windy: 1 } })), /ocean\.windy is unsupported/);
  const noOcean = crateDefinition();
  delete noOcean.ocean;
  assert.throws(plan(noOcean), /floats but the definition has no ocean/);
  const fixedFloater = crateDefinition();
  fixedFloater.bodies[0].type = 'fixed';
  assert.throws(plan(fixedFloater), /only floats when dynamic/);
});

test('the wave work of a long bake with many points is bounded', () => {
  const definition = crateDefinition({ ocean: { resolution: 16 }, float: { points: Array(16).fill([0, 0, 0]) } });
  assert.throws(() => planPhysicsScene(definition, { frameCount: 3601 }), /wave evaluations, over the limit/);
});
