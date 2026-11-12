import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, agentSceneModulesNeeded } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { PARTICLE_LIMITS, createParticleLaunches, particleStateAt } from '../src/particles.js';

function sparkRecipe(particles, extraNodes = []) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }, { id: 'sheet', type: 'grid', segments: 2 }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'glow', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [{ id: 'sparks', geometry: 'speck', material: 'glow' }, ...extraNodes],
    particles,
  };
}

const burst = { systems: [{ node: 'sparks', seed: 7, count: 50, lifetime: [0.5, 1.5], speed: [2, 5], spread: 40, size: 0.04, drag: 0.4 }] };

function particlePositions(scene, nodeId = 'sparks') {
  return Array.from(scene.parts.find(part => part.name === nodeId).geometry.positions);
}

test('a seek gives the same particles: back and forth, from the end, and in a second scene', () => {
  const scene = createAgentScene(sparkRecipe(burst));
  scene.sampleMotion(0.7);
  const first = particlePositions(scene);
  scene.sampleMotion(1.4);
  const later = particlePositions(scene);
  assert.notDeepEqual(later, first);
  scene.sampleMotion(0.7);
  assert.deepEqual(particlePositions(scene), first, 'seeking back repeats the particles');
  scene.sampleMotion(3);
  scene.sampleMotion(1.4);
  assert.deepEqual(particlePositions(scene), later, 'seeking backwards from past the end repeats an earlier time');
  const fresh = createAgentScene(sparkRecipe(burst));
  fresh.sampleMotion(0.7);
  assert.deepEqual(particlePositions(fresh), first, 'a second scene from the same recipe is identical');
});

test('a seeded emitter gives identical bytes and another seed gives different particles', () => {
  const bytesAt = (system, time) => {
    const scene = createAgentScene(sparkRecipe({ systems: [{ ...burst.systems[0], ...system }] }));
    scene.sampleMotion(time);
    const geometry = scene.parts[0].geometry;
    return Buffer.concat([geometry.positions, geometry.normals, geometry.indices].map(array => Buffer.from(array.buffer, array.byteOffset, array.byteLength)));
  };
  assert.ok(bytesAt({}, 0.9).equals(bytesAt({}, 0.9)));
  assert.ok(!bytesAt({}, 0.9).equals(bytesAt({ seed: 8 }, 0.9)));
});

test('raising the count keeps the particles that were already there', () => {
  const settings = system => ({ seed: 3, emitter: { shape: 'sphere', position: [0, 0, 0], halfExtents: [1, 1, 1], radius: 1 }, lifetime: [1, 2], speed: [1, 3], direction: [0, 1, 0], spreadRadians: 0.5, size: [0.1, 0.2], forces: { gravity: [0, -9.81, 0], wind: [0, 0, 0], drag: 0 }, ...system });
  const small = createParticleLaunches(settings({ count: 10 }));
  const large = createParticleLaunches(settings({ count: 40 }));
  assert.deepEqual(Array.from(large.origin.slice(0, 30)), Array.from(small.origin));
  assert.deepEqual(Array.from(large.velocity.slice(0, 30)), Array.from(small.velocity));
});

test('drag, wind and gravity follow the closed form, checked against small time steps', () => {
  const launches = {
    count: 1, birth: new Float64Array([0]), life: new Float64Array([10]), size: new Float64Array([1]),
    origin: new Float64Array([0, 1, 0]), velocity: new Float64Array([2, 5, -1]), landing: new Float64Array([Infinity]),
  };
  const forces = { gravity: [0, -9.81, 0], wind: [3, 0, 1], drag: 0.8, floor: undefined };
  const position = [0, 1, 0];
  const velocity = [2, 5, -1];
  const step = 1e-5;
  for (let elapsed = 0; elapsed < 2; elapsed += step) {
    for (let axis = 0; axis < 3; axis++) {
      velocity[axis] += (forces.gravity[axis] - forces.drag * (velocity[axis] - forces.wind[axis])) * step;
      position[axis] += velocity[axis] * step;
    }
  }
  const state = particleStateAt(launches, 0, forces, 'constant', 2, { position: [0, 0, 0], scale: 0 });
  state.position.forEach((value, axis) => assert.ok(Math.abs(value - position[axis]) < 1e-3, `axis ${axis}: ${value} against ${position[axis]}`));
});

test('particles land on the floor and stay there, and never fall below it', () => {
  const scene = createAgentScene(sparkRecipe({ systems: [{ node: 'sparks', seed: 2, count: 60, lifetime: 20, speed: [2, 6], spread: 60, size: 0.02, floor: 0 }] }));
  for (const time of [0.2, 0.8, 1.5, 4, 12]) {
    scene.sampleMotion(time);
    const positions = particlePositions(scene);
    for (let offset = 1; offset < positions.length; offset += 3) {
      assert.ok(positions[offset] >= -0.021, `height ${positions[offset]} at ${time} s`);
    }
  }
  scene.sampleMotion(10);
  const settled = particlePositions(scene);
  scene.sampleMotion(14);
  assert.deepEqual(particlePositions(scene), settled, 'landed particles stay put');
});

test('rate spreads births in time and size can shrink to nothing at death', () => {
  const scene = createAgentScene(sparkRecipe({ systems: [{ node: 'sparks', count: 20, rate: 10, lifetime: 0.5, scale: 'shrink', size: 1 }] }));
  const report = scene.inspect().particles.systems[0];
  assert.equal(report.maxAlive, 5, 'a rate of 10 with a half second life keeps 5 alive');
  assert.equal(report.endsAt, 2.4);
  scene.sampleMotion(0.05);
  const vertices = particlePositions(scene);
  const span = (first, last) => Math.max(...vertices.slice(first, last)) - Math.min(...vertices.slice(first, last));
  assert.ok(span(0, 24) > 0.5, 'the first particle is born and large');
  assert.equal(span(24 * 19, 24 * 20), 0, 'the last particle is not born yet and has no size');
});

test('the node transform does not move or scale particles', () => {
  const plain = createAgentScene(sparkRecipe(burst));
  const moved = createAgentScene({ ...sparkRecipe(burst), nodes: [{ id: 'sparks', geometry: 'speck', material: 'glow', translation: [5, 2, 0], scale: [2, 2, 2] }] });
  plain.sampleMotion(0.6);
  moved.sampleMotion(0.6);
  const world = (scene, offset) => {
    const part = scene.parts[0];
    const positions = part.geometry.positions;
    return [0, 1, 2].map(axis => part.matrix[axis] * positions[offset] + part.matrix[4 + axis] * positions[offset + 1] + part.matrix[8 + axis] * positions[offset + 2] + part.matrix[12 + axis]);
  };
  for (const offset of [0, 300, 900]) {
    world(plain, offset).forEach((value, axis) => assert.ok(Math.abs(value - world(moved, offset)[axis]) < 1e-4));
  }
  const normal = moved.parts[0].geometry.normals;
  assert.ok(Math.abs(Math.hypot(normal[0], normal[1], normal[2]) - 1) < 1e-5);
});

test('a seek replaces the part, so a renderer sees a topology change', () => {
  const scene = createAgentScene(sparkRecipe(burst));
  const before = scene.topologyRevision;
  scene.sampleMotion(0.5);
  assert.ok(scene.topologyRevision > before);
  assert.equal(scene.parts[0].geometry.positions.length, 50 * 24 * 3);
});

test('the report counts particles and vertices, and a scene without particles has none', () => {
  const report = createAgentScene(sparkRecipe(burst)).inspect().particles;
  assert.ok(report.systems[0].endsAt > 1.4 && report.systems[0].endsAt <= 1.5);
  assert.equal(report.vertices, 50 * 24);
  assert.deepEqual(report.systems[0], { node: 'sparks', type: 'emitter', particles: 50, verticesPerParticle: 24, maxAlive: 50, endsAt: report.systems[0].endsAt });
  const plain = sparkRecipe(null);
  assert.equal(createAgentScene(plain).inspect().particles, undefined);
});

test('set-particles adds, changes and clears the section, and restores through a checkpoint', () => {
  const scene = createAgentScene(sparkRecipe(null));
  scene.apply([{ type: 'set-particles', particles: burst }], { expectedRevision: scene.revision });
  assert.equal(scene.inspect().particles.systems[0].particles, 50);
  scene.apply([{ type: 'set-particles', particles: { systems: [{ node: 'sparks', count: 5 }] } }], { expectedRevision: scene.revision });
  assert.equal(scene.inspect().particles.systems[0].particles, 5);
  scene.apply([{ type: 'set-particles', particles: null }], { expectedRevision: scene.revision });
  assert.equal(scene.inspect().particles, undefined);
  assert.throws(() => scene.apply([{ type: 'set-particles' }], { expectedRevision: scene.revision }), /particles: got undefined; expected a particles value/);
});

test('the capabilities describe the limits that the validator enforces', () => {
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.particles.limits, { maxSystems: 4, maxParticlesPerSystem: 2000, maxParticles: 4000, maxVertices: PARTICLE_LIMITS.maxVertices, maxLifetime: 60 });
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-particles'));
  assert.deepEqual(agentSceneModulesNeeded({ particles: { systems: [] } }), ['particles']);
});

test('hostile input is rejected with the limit in the message', () => {
  const system = overrides => ({ systems: [{ node: 'sparks', ...overrides }] });
  const bad = (particles, pattern, nodes) => assert.throws(() => createAgentScene(sparkRecipe(particles, nodes)), pattern);
  bad(system({ count: 2001 }), /systems\[0\]\.count: got 2001; expected a whole number from 1 to 2000/);
  bad(system({ count: 1e9 }), /\.count: got .*; expected a whole number from 1 to 2000/);
  bad(system({ count: 0 }), /\.count: got .*; expected a whole number from 1 to 2000/);
  bad(system({ count: 1.5 }), /\.count: got .*; expected a whole number from 1 to 2000/);
  bad(system({ count: Infinity }), /finite|count|speed|direction|rate/);
  bad(system({ count: '10' }), /\.count: got .*; expected a whole number from 1 to 2000/);
  bad(system({ seed: -1 }), /\.seed: got .*; expected a whole number from 0 to 4294967295/);
  bad(system({ seed: 2 ** 32 }), /\.seed: got .*; expected a whole number from 0 to 4294967295/);
  bad(system({ seed: 1.5 }), /\.seed: got .*; expected a whole number from 0 to 4294967295/);
  bad(system({ lifetime: 0 }), /\.lifetime: got .*; expected a number from 0\.01 to 60/);
  bad(system({ lifetime: 1e9 }), /\.lifetime: got .*; expected a number from 0\.01 to 60/);
  bad(system({ lifetime: [2, 1] }), /\.(lifetime|length): got \[.*; expected \[minimum, maximum\] with the minimum not above the maximum/);
  bad(system({ lifetime: [1, 2, 3] }), /\.lifetime: got \[1,2,3\]; expected a number or \[minimum, maximum\]/);
  bad(system({ speed: NaN }), /finite|count|speed|direction|rate/);
  bad(system({ speed: -1 }), /\.speed: got -1; expected a number from 0 to 1000/);
  bad(system({ size: 0 }), /\.size: got .*; expected a number from 0\.0001 to 100/);
  bad(system({ size: 1e30 }), /\.size: got .*; expected a number from 0\.0001 to 100/);
  bad(system({ rate: 0 }), /\.rate: got 0; expected a number from 0\.01 to 200000/);
  bad(system({ rate: Infinity }), /finite|count|speed|direction|rate/);
  bad(system({ spread: 181 }), /\.spread: got 181; expected a number from 0 to 180/);
  bad(system({ drag: -1 }), /\.drag: got .*; expected a number from 0 to 100/);
  bad(system({ drag: 1e9 }), /\.drag: got .*; expected a number from 0 to 100/);
  bad(system({ floor: 1e9 }), /\.floor: got 1000000000; expected a number from -10000 to 10000/);
  bad(system({ direction: [0, 0, 0] }), /\.direction: got \[0,0,0\]; expected a direction that is not the zero vector/);
  bad(system({ direction: [1, 2] }), /\.direction: got \[1,2\]; expected an array of 3 numbers/);
  bad(system({ direction: [1, 2, NaN] }), /finite|count|speed|direction|rate/);
  bad(system({ scale: 'huge' }), /\.scale: got "huge"; expected one of constant, shrink, grow/);
  bad(system({ emitter: { shape: 'cone' } }), /\.emitter\.shape: got "cone"; expected one of point, box, sphere, disc/);
  bad(system({ emitter: { radius: -1 } }), /\.emitter\.radius: got -1; expected a number from 0 to 10000/);
  bad(system({ emitter: { position: [1e9, 0, 0] } }), /\.emitter\.position\[0\]: got 1000000000; expected a number from -10000 to 10000/);
  bad(system({ emitter: { jet: true } }), /\.emitter\.jet: got true; expected no such field/);
  bad(system({ colour: 'red' }), /\.colour: got "red"; expected no such field/);
  bad({ systems: [{ node: 'sparks' }], extra: 1 }, /particles\.extra: got 1; expected no such field/);
  bad({ systems: [] }, /particles\.systems: got \[\]; expected at least one system/);
  bad({ systems: 'many' }, /particles\.systems: got "many"; expected an array of at most 4 entries/);
  bad({ systems: Array.from({ length: 5 }, () => ({ node: 'sparks' })) }, /particles\.systems: got "5 entries"; expected an array of at most 4 entries/);
  bad({ systems: [{ node: 'sparks' }, { node: 'sparks' }] }, /particles\.systems\[1\]\.node: got "sparks"; expected a node that particles uses once/);
  bad({ gravity: [0, -1e9, 0], systems: [{ node: 'sparks' }] }, /particles\.gravity\[1\]: got -1000000000; expected a number from -1000 to 1000/);
  bad({ wind: [1000, 0, 0], systems: [{ node: 'sparks' }] }, /particles\.wind\[0\]: got 1000; expected a number from -100 to 100/);
  bad(system({ node: 'missing' }), /\.node: got .*; expected the ID of a node in the recipe/);
  bad(system({ node: '__proto__' }), /\.node: got .*; expected the ID of a node in the recipe/);
  bad(null === 0 ? null : JSON.parse('{"systems":[{"node":"sparks","__proto__":{"count":5}}]}'), /Invalid JSON key|Unknown or unsupported/);
  bad('systems', /particles: got "systems"; expected a plain object/);
});

test('total particles and total vertices are bounded across systems', () => {
  const nodes = ['b', 'c', 'd'].map(id => ({ id, geometry: 'speck', material: 'glow' }));
  const systems = ['sparks', 'b', 'c'].map(node => ({ node, count: 1500 }));
  assert.throws(() => createAgentScene(sparkRecipe({ systems }, nodes)), /particles\.systems: got "4500 particles in total"; expected counts that add up to at most 4000/);
  const heavy = sparkRecipe({ systems: [{ node: 'sparks', count: 10 }] });
  heavy.nodes[0].geometry = 'ball';
  heavy.particles.systems[0].count = 40;
  assert.throws(() => createAgentScene(heavy), /particles\.systems: got "\d+ vertices on node sparks"; expected shape vertices times count of at most 100000/);
});

test('a particle node cannot carry motion or physics, or be a cloth sheet', () => {
  const withMotion = sparkRecipe(burst);
  withMotion.motion = { duration: 1, loop: false, tracks: [{ id: 'sparks', kind: 'node', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] };
  assert.throws(() => createAgentScene(withMotion), /particles\.systems\[0\]\.node: got "sparks"; expected a node that stays where it is/);
  const withCloth = sparkRecipe(burst);
  withCloth.cloth = { duration: 1, sheets: [{ node: 'sparks' }] };
  assert.throws(() => createAgentScene(withCloth), /used twice|cloth/i);
  const child = sparkRecipe(burst, [{ id: 'kid', geometry: 'speck', material: 'glow', parent: 'sparks' }]);
  child.particles.systems[0].node = 'kid';
  assert.throws(() => createAgentScene(child), /root node/);
});

test('a large burst seeks statelessly in fixed buffers, and a huge time is only a dead system', () => {
  const nodes = ['b'].map(id => ({ id, geometry: 'speck', material: 'glow' }));
  const scene = createAgentScene(sparkRecipe({ wind: [2, 0, 0], systems: [
    { node: 'sparks', count: 2000, floor: 0, drag: 0.3, lifetime: [1, 3], speed: [1, 8], spread: 180 },
    { node: 'b', count: 2000, rate: 400, lifetime: 3, drag: 0.3, emitter: { shape: 'box' } },
  ] }, nodes));
  // A seek computes each particle from its launch and the time alone, so its work is the particle count and never
  // grows with the seeks before it: the same time gives the same result after any history, in buffers of one size.
  const bothSystems = () => [...particlePositions(scene), ...particlePositions(scene, 'b')];
  scene.sampleMotion(0.3);
  const firstSeek = bothSystems();
  const bufferSizes = new Set();
  for (const time of [1, 2, 3.7]) {
    scene.sampleMotion(time);
    bufferSizes.add(bothSystems().length);
  }
  scene.sampleMotion(0.3);
  assert.deepEqual(bothSystems(), firstSeek);
  assert.equal(bufferSizes.size, 1, 'the particle buffers keep one size across seeks');
  scene.sampleMotion(3600);
  assert.ok(particlePositions(scene).every(Number.isFinite));
  assert.throws(() => scene.sampleMotion(3601), /time: got 3601; expected null or a number of seconds/);
});

test('the particle code stays unloaded for a scene without particles', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createAgentScene } from './src/agent-scene.js';
    import { agentSceneModuleLoaded } from './src/agent-scene-modules.js';
    createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [{ id: 'cube', type: 'box' }], materials: [{ id: 'paint' }], nodes: [{ id: 'part', geometry: 'cube', material: 'paint' }] });
    console.log(agentSceneModuleLoaded('particles'));
  `], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.stdout.trim(), 'false', result.stderr);
});

function hairRecipe(system, surfaceTranslation = [0, 0, 0]) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'head', type: 'sphere', segments: 12, rings: 8 }, { id: 'strands', type: 'box' }],
    materials: [{ id: 'fur', color: [0.3, 0.2, 0.1] }],
    nodes: [
      { id: 'head', geometry: 'head', material: 'fur', translation: surfaceTranslation, scale: [0.5, 0.5, 0.5] },
      { id: 'fur', geometry: 'strands', material: 'fur' },
    ],
    particles: { wind: [1, 0, 0], systems: [{ type: 'hair', node: 'fur', surface: 'head', seed: 5, count: 200, length: [0.1, 0.2], segments: 4, ...system }] },
  };
}

function worldVertices(scene, nodeId) {
  const part = scene.parts.find(candidate => candidate.name === nodeId);
  const positions = part.geometry.positions;
  const result = [];
  for (let offset = 0; offset < positions.length; offset += 3) {
    result.push([0, 1, 2].map(axis => part.matrix[axis] * positions[offset] + part.matrix[4 + axis] * positions[offset + 1] + part.matrix[8 + axis] * positions[offset + 2] + part.matrix[12 + axis]));
  }
  return result;
}

test('hair grows from the surface, outward, and seeks deterministically', () => {
  const scene = createAgentScene(hairRecipe({}, [0, 1, 0]));
  const root = worldVertices(scene, 'fur');
  const ringsPerStrand = 5;
  const verticesPerStrand = ringsPerStrand * 3;
  assert.equal(root.length, 200 * verticesPerStrand);
  for (let strand = 0; strand < 200; strand++) {
    const first = root[strand * verticesPerStrand];
    const distanceFromCentre = Math.hypot(first[0], first[1] - 1, first[2]);
    assert.ok(distanceFromCentre > 0.44 && distanceFromCentre < 0.51, `root ${distanceFromCentre} sits on the faceted sphere of radius 0.5`);
    const tip = root[strand * verticesPerStrand + verticesPerStrand - 1];
    assert.ok(Math.hypot(tip[0], tip[1] - 1, tip[2]) > 0.55, 'the tip is outside the surface');
  }
  scene.sampleMotion(0.4);
  const first = Array.from(scene.parts[1].geometry.positions);
  scene.sampleMotion(2);
  scene.sampleMotion(0.4);
  assert.deepEqual(Array.from(scene.parts[1].geometry.positions), first);
  assert.deepEqual(createAgentScene(hairRecipe({}, [0, 1, 0])).parts[1].geometry.positions, createAgentScene(hairRecipe({}, [0, 1, 0])).parts[1].geometry.positions);
  const another = createAgentScene(hairRecipe({ seed: 6 }, [0, 1, 0]));
  assert.notDeepEqual(another.parts[1].geometry.positions, createAgentScene(hairRecipe({}, [0, 1, 0])).parts[1].geometry.positions);
});

test('hair droops toward gravity and sways with time only when asked', () => {
  const tipHeight = (system, time) => {
    const scene = createAgentScene(hairRecipe(system));
    scene.sampleMotion(time);
    const vertices = worldVertices(scene, 'fur');
    return vertices.filter((_, index) => index % 15 === 14).reduce((sum, vertex) => sum + vertex[1], 0);
  };
  assert.ok(tipHeight({ droop: 3 }, 0) < tipHeight({ droop: 0 }, 0), 'droop lowers the tips');
  const stiff = createAgentScene(hairRecipe({}));
  stiff.sampleMotion(0.3);
  const stillA = Array.from(stiff.parts[1].geometry.positions);
  stiff.sampleMotion(0.9);
  assert.deepEqual(Array.from(stiff.parts[1].geometry.positions), stillA, 'without sway a strand never moves');
  const swaying = createAgentScene(hairRecipe({ sway: 0.05, swayRate: 1 }));
  swaying.sampleMotion(0.25);
  const left = Array.from(swaying.parts[1].geometry.positions);
  swaying.sampleMotion(0.75);
  assert.notDeepEqual(Array.from(swaying.parts[1].geometry.positions), left);
});

test('hair triangles face outward and the report counts strands', () => {
  const scene = createAgentScene(hairRecipe({ droop: 0, lean: 0 }));
  const geometry = scene.parts[1].geometry;
  const positions = geometry.positions;
  const indices = geometry.indices;
  for (let corner = 0; corner < 60; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(offset => indices[corner + offset] * 3);
    const edgeOne = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
    const edgeTwo = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
    const face = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const normal = [0, 1, 2].map(axis => geometry.normals[first + axis]);
    assert.ok(face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2] > 0, 'winding follows the vertex normal');
  }
  assert.deepEqual(scene.inspect().particles.systems[0], { node: 'fur', type: 'hair', surface: 'head', strands: 200, segments: 4, verticesPerStrand: 15 });
});

test('hostile hair input is rejected', () => {
  const bad = (system, pattern) => assert.throws(() => createAgentScene(hairRecipe(system)), pattern);
  bad({ surface: 'missing' }, /particles\.systems\[0\]\.surface: got "missing"; expected the ID of a node in the recipe/);
  bad({ surface: 'fur' }, /\.surface: got "fur"; expected a node other than the hair node/);
  bad({ segments: 9 }, /\.segments: got 9; expected a whole number from 1 to 8/);
  bad({ segments: 0 }, /\.segments: got 0; expected a whole number from 1 to 8/);
  bad({ count: 2001 }, /\.count: got .*; expected a whole number from 1 to 2000/);
  bad({ length: 0 }, /\.length: got 0; expected a number from 0\.001 to 100/);
  bad({ length: [3, 1] }, /\.(lifetime|length): got \[.*; expected \[minimum, maximum\] with the minimum not above the maximum/);
  bad({ width: 100 }, /\.width: got 100; expected a number from 0\.0001 to 10/);
  bad({ droop: -1 }, /\.droop: got -1; expected a number from 0 to 10/);
  bad({ sway: 11 }, /\.sway: got 11; expected a number from 0 to 10/);
});

test('hair limits the vertices it draws, and an empty surface is refused', () => {
  const crowded = hairRecipe({ count: 2000, segments: 8 });
  crowded.particles.systems.push({ type: 'hair', node: 'extra', surface: 'head', count: 2000, segments: 8 });
  crowded.nodes.push({ id: 'extra', geometry: 'strands', material: 'fur' });
  assert.throws(() => createAgentScene(crowded), /particles\.systems: got "\d+ vertices on node extra"; expected shape vertices times count of at most 100000/);
  const flat = hairRecipe({});
  flat.nodes[0].scale = [0, 0, 0];
  assert.throws(() => createAgentScene(flat), /no triangle with area|scale/);
});

test('a spinning system keeps every vertex finite once its first particle has died', () => {
  const recipe = sparkRecipe({ systems: [{ node: 'sparks', seed: 7, count: 40, rate: 40, lifetime: [0.2, 0.4], speed: [1, 2], spin: [10, 200], size: 0.05 }] });
  const scene = createAgentScene(recipe);
  for (const time of [0, 0.1, 0.5, 1, 1.5]) {
    scene.sampleMotion(time);
    const geometry = scene.parts.find(part => part.name === 'sparks').geometry;
    for (const values of [geometry.positions, geometry.normals]) {
      assert.ok(values.every(Number.isFinite), `a vertex is not finite at ${time} s`);
    }
  }
});
