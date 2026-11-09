import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createCollisionSurface, findFirstCollision } from '../src/particle-collision.js';
import { createParticleLaunches, particleStateAt } from '../src/particles.js';

// A unit box is 1 m wide; the slab is scaled to 4 m x 0.2 m x 4 m, so its top face sits at y = 0.1.
const SLAB_TOP = 0.1;

function dropRecipe(system, { colliderScale = [4, 0.2, 4], extra = {} } = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }, { id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'glow', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [
      { id: 'sparks', geometry: 'speck', material: 'glow' },
      { id: 'slab', geometry: 'block', material: 'glow', scale: colliderScale },
    ],
    particles: { systems: [{ node: 'sparks', count: 1, seed: 3, speed: 0, size: 0.04, lifetime: 6, emitter: { shape: 'point', position: [0.3, 2, 0.2] }, colliders: ['slab'], ...system }], ...extra },
  };
}

function particleCenters(scene, count = 1) {
  const positions = scene.parts.find(part => part.name === 'sparks').geometry.positions;
  const perParticle = positions.length / 3 / count;
  return Array.from({ length: count }, (unused, particle) => {
    const center = [0, 0, 0];
    for (let vertex = 0; vertex < perParticle; vertex++) {
      for (let axis = 0; axis < 3; axis++) center[axis] += positions[(particle * perParticle + vertex) * 3 + axis] / perParticle;
    }
    return center;
  });
}

function traceOf(scene, times) {
  return times.map(time => {
    scene.sampleMotion(time);
    return particleCenters(scene)[0];
  });
}

const frames = Array.from({ length: 300 }, (unused, frame) => frame / 100);

test('particles bounce off a box: they never pass through it and rise again after the hit', () => {
  const scene = createAgentScene(dropRecipe({ bounce: 0.6 }));
  const heights = traceOf(scene, frames).map(center => center[1]);
  assert.ok(Math.min(...heights) >= SLAB_TOP - 1e-3, `lowest ${Math.min(...heights)} is below the slab top`);
  const lowestIndex = heights.indexOf(Math.min(...heights.slice(0, 120)));
  const risen = Math.max(...heights.slice(lowestIndex, lowestIndex + 40));
  assert.ok(risen > heights[lowestIndex] + 0.2, 'the particle rebounds upward after landing');
  assert.ok(risen < 2, 'a bounce with 0.6 restitution does not reach the drop height');
});

test('a bounce keeps its energy ratio: the first apex is about the bounce squared of the drop height', () => {
  const scene = createAgentScene(dropRecipe({ bounce: 0.5, friction: 0 }));
  const heights = traceOf(scene, Array.from({ length: 220 }, (unused, frame) => frame / 100)).map(center => center[1] - SLAB_TOP);
  const firstApex = Math.max(...heights.slice(70, 130));
  const dropHeight = 2 - SLAB_TOP;
  assert.ok(Math.abs(firstApex / dropHeight - 0.25) < 0.05, `apex ratio ${firstApex / dropHeight}`);
});

test('without bounce a particle sticks where it lands, on the top face', () => {
  const scene = createAgentScene(dropRecipe({ bounce: 0 }));
  const [early, late] = [1.5, 5].map(time => traceOf(scene, [time])[0]);
  assert.ok(Math.abs(early[1] - SLAB_TOP) < 1e-3, `rests at ${early[1]}`);
  assert.deepEqual(late, early, 'a stuck particle does not move again');
});

test('a fast particle does not tunnel through a thin collider', () => {
  const scene = createAgentScene(dropRecipe({ speed: 300, direction: [0, -1, 0], spread: 0, bounce: 0.2 }, { colliderScale: [4, 0.01, 4] }));
  const heights = traceOf(scene, frames).map(center => center[1]);
  assert.ok(Math.min(...heights) >= 0.005 - 1e-3, `lowest ${Math.min(...heights)} went through the sheet`);
});

test('friction slows the particle along the surface, and a slow bounce comes to rest', () => {
  const slide = { speed: 3, direction: [1, -0.3, 0], spread: 0, bounce: 0.5 };
  const slipped = traceOf(createAgentScene(dropRecipe({ ...slide, friction: 0 })), [1.2])[0];
  const gripped = traceOf(createAgentScene(dropRecipe({ ...slide, friction: 0.9 })), [1.2])[0];
  assert.ok(gripped[0] < slipped[0] - 0.3, `friction travel ${gripped[0]} against ${slipped[0]}`);
  const settled = createAgentScene(dropRecipe({ bounce: 0.4, friction: 0.5 }));
  const [late, later] = traceOf(settled, [4, 5.5]);
  assert.deepEqual(later, late, 'the particle has come to rest');
  assert.ok(Math.abs(late[1] - SLAB_TOP) < 1e-2);
});

test('the same seed gives the same frames, forward, after seeking back and in a second scene', () => {
  const system = { count: 40, seed: 11, speed: [1, 4], spread: 60, bounce: 0.6, friction: 0.3, spin: [-300, 300], color: [[1, 0.8, 0.2], [0.8, 0.05, 0]], alpha: [1, 0], lifetime: [2, 5], emitter: { shape: 'sphere', radius: 0.3, position: [0, 1.5, 0] } };
  const scene = createAgentScene(dropRecipe(system));
  const bytesAt = time => {
    scene.sampleMotion(time);
    const geometry = scene.parts.find(part => part.name === 'sparks').geometry;
    return [Array.from(geometry.positions), Array.from(geometry.normals), Array.from(geometry.colors)];
  };
  const first = bytesAt(1.37);
  const later = bytesAt(3.1);
  assert.notDeepEqual(later[0], first[0]);
  assert.deepEqual(bytesAt(1.37), first, 'seeking back repeats the frame');
  bytesAt(5.5);
  assert.deepEqual(bytesAt(3.1), later, 'seeking back from the end repeats a later frame');
  const fresh = createAgentScene(dropRecipe(system));
  fresh.sampleMotion(3.1);
  const direct = fresh.parts.find(part => part.name === 'sparks').geometry;
  assert.deepEqual(Array.from(direct.positions), later[0], 'a jump straight to a time matches walking there');
});

test('spin turns each particle in place and never changes where it flies', () => {
  const plain = createAgentScene(dropRecipe({ count: 5, bounce: 0.5, speed: 2, spread: 40 }));
  const spinning = createAgentScene(dropRecipe({ count: 5, bounce: 0.5, speed: 2, spread: 40, spin: [200, 400] }));
  plain.sampleMotion(1.1);
  spinning.sampleMotion(1.1);
  particleCenters(plain, 5).forEach((center, index) => {
    center.forEach((value, axis) => assert.ok(Math.abs(value - particleCenters(spinning, 5)[index][axis]) < 1e-5));
  });
  const spunVertices = spinning.parts.find(part => part.name === 'sparks').geometry;
  assert.notDeepEqual(Array.from(spunVertices.positions), Array.from(plain.parts.find(part => part.name === 'sparks').geometry.positions));
  for (let offset = 0; offset < spunVertices.normals.length; offset += 3) {
    assert.ok(Math.abs(Math.hypot(...spunVertices.normals.slice(offset, offset + 3)) - 1) < 1e-4, 'rotated normals stay unit length');
  }
});

test('color and alpha follow the life: start, middle, end', () => {
  const scene = createAgentScene(dropRecipe({ lifetime: 4, color: [[1, 0.5, 0], [0, 0.5, 1]], alpha: [1, 0] }));
  const colorAt = time => {
    scene.sampleMotion(time);
    return Array.from(scene.parts.find(part => part.name === 'sparks').geometry.colors.slice(0, 3));
  };
  // Alpha multiplies the color: at 80 percent of the life the color is [0.2, 0.5, 0.8] and alpha 0.2.
  assert.deepEqual(colorAt(0).map(value => Number(value.toFixed(4))), [1, 0.5, 0]);
  assert.deepEqual(colorAt(2).map(value => Number(value.toFixed(4))), [0.25, 0.25, 0.25]);
  assert.deepEqual(colorAt(3.2).map(value => Number(value.toFixed(4))), [0.04, 0.1, 0.16]);
});

test('a system without color or alpha writes no vertex colors', () => {
  const scene = createAgentScene(dropRecipe({ bounce: 0.5 }));
  scene.sampleMotion(1);
  assert.equal(scene.parts.find(part => part.name === 'sparks').geometry.colors, undefined);
});

test('collision input is validated and the capabilities describe it', () => {
  const rejects = (system, pattern) => assert.throws(() => createAgentScene(dropRecipe(system)), pattern);
  rejects({ bounce: 1.5 }, /bounce/);
  rejects({ friction: -1 }, /friction/);
  rejects({ colliders: ['ghost'] }, /particles\.systems\[0\]\.colliders\[0\]: got "ghost"; expected the ID of a node in the recipe/);
  rejects({ colliders: ['sparks'] }, /particles\.systems\[0\]\.colliders: got \["sparks"\]; expected node IDs other than the system/);
  rejects({ colliders: 'slab' }, /colliders/);
  rejects({ alpha: [0, 2] }, /alpha/);
  rejects({ alpha: 'clear' }, /alpha/);
  rejects({ color: [1, 1, 1] }, /vector|3 numbers|color/i);
  rejects({ color: [[1, 1, 1]] }, /color/);
  rejects({ spin: 'fast' }, /spin/);
  const recipe = dropRecipe({});
  recipe.particles.systems.push({ node: 'slab', colliders: ['slab'] });
  assert.throws(() => createAgentScene(recipe));
  assert.match(AGENT_SCENE_CAPABILITIES.particles.collision, /colliders/);
  assert.doesNotMatch(AGENT_SCENE_CAPABILITIES.particles.notes, /No collision/);
});

test('a collider system node of another system and too many triangles are refused', () => {
  const recipe = dropRecipe({});
  recipe.nodes.push({ id: 'dust', geometry: 'speck', material: 'glow' });
  recipe.particles.systems.push({ node: 'dust', count: 1, colliders: ['sparks'] });
  assert.throws(() => createAgentScene(recipe), /particle system node/);
  const dense = dropRecipe({});
  dense.geometries.push({ id: 'ball', type: 'sphere', segments: 64 });
  dense.nodes[1].geometry = 'ball';
  assert.throws(() => createAgentScene(dense), /triangles/);
});

test('the collision surface reports the nearest face and skips meshes the path cannot reach', () => {
  const quad = (height, size) => ({
    positions: Float64Array.from([-size, height, -size, size, height, -size, size, height, size, -size, height, size]),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
  });
  const surface = createCollisionSurface([quad(0, 1), quad(5, 1), quad(0, 0.1)]);
  assert.equal(surface.triangleCount, 6);
  const contact = { fraction: Infinity, normal: [0, 0, 0], onFloor: false };
  assert.equal(findFirstCollision(surface, [0.5, 3, 0.5], [0.5, -1, 0.5], contact), true);
  assert.ok(Math.abs(contact.fraction - 0.75) < 1e-12 && contact.normal[1] === 1, 'hits the quad at y 0 from above');
  contact.fraction = Infinity;
  assert.equal(findFirstCollision(surface, [0.5, 4, 0.5], [0.5, 3, 0.5], contact), false, 'a path between the two layers');
  contact.fraction = Infinity;
  assert.equal(findFirstCollision(surface, [9, 3, 9], [9, -1, 9], contact), false, 'a path far to the side');
  contact.fraction = Infinity;
  assert.equal(findFirstCollision(surface, [0.5, 1, 0.5], [1.5, 1, 0.5], contact), false, 'a path parallel to the faces');
  assert.equal(findFirstCollision(surface, [0.5, -1, 0.5], [0.5, 3, 0.5], contact), true);
  assert.equal(contact.normal[1], -1, 'the normal faces the side the particle came from');
});

test('a floor bounce needs no collider, and the closed form still serves a free fall', () => {
  const forces = { gravity: [0, -9.81, 0], wind: [0, 0, 0], fields: [], drag: 0, floor: 0, bounce: 0.5, friction: 0 };
  const settings = { count: 1, seed: 1, emitter: { shape: 'point', position: [0, 2, 0], halfExtents: [0, 0, 0], radius: 0 }, lifetime: [5, 5], speed: [0, 0], direction: [0, 1, 0], spreadRadians: 0, size: [1, 1], forces };
  const launches = createParticleLaunches(settings);
  assert.ok(launches.track, 'bounce uses the stepped integrator');
  const state = { position: [0, 0, 0], scale: 0 };
  let apex = 0;
  for (let time = 0.7; time < 1.2; time += 0.01) apex = Math.max(apex, particleStateAt(launches, 0, forces, 'constant', time, state).position[1]);
  assert.ok(Math.abs(apex / 2 - 0.25) < 0.05, `apex ${apex}`);
  const free = createParticleLaunches({ ...settings, forces: { ...forces, bounce: 0 } });
  assert.equal(free.track, undefined);
  assert.equal(particleStateAt(free, 0, { ...forces, bounce: 0 }, 'constant', 3, state).position[1], 0, 'lands on the floor in closed form');
});

test('stepping from birth every frame stays cheap enough for long lives, and playback continues from the last frame', () => {
  const system = { count: 500, seed: 5, speed: [2, 6], spread: 50, bounce: 0.6, friction: 0.2, lifetime: 20, emitter: { shape: 'sphere', radius: 0.5, position: [0, 2, 0] } };
  const scene = createAgentScene(dropRecipe(system));
  const start = performance.now();
  for (let frame = 0; frame <= 120; frame++) scene.sampleMotion(frame / 6);
  const playback = performance.now() - start;
  const cold = createAgentScene(dropRecipe(system));
  const coldStart = performance.now();
  cold.sampleMotion(20 - 0.01);
  const coldSeek = performance.now() - coldStart;
  assert.ok(playback < 20000 && coldSeek < 20000, `playback ${playback.toFixed(0)} ms for 121 frames, cold seek to the end ${coldSeek.toFixed(0)} ms`);
});

test('Coulomb friction stops a slider after about v squared over two mu g, and a settled particle stops turning', () => {
  const forces = { gravity: [0, -9.81, 0], wind: [0, 0, 0], fields: [], drag: 0, floor: 0, bounce: 0.3, friction: 0.5 };
  const settings = { count: 1, seed: 1, emitter: { shape: 'point', position: [0, 0.0005, 0], halfExtents: [0, 0, 0], radius: 0 }, lifetime: [8, 8], speed: [3, 3], direction: [1, 0, 0], spreadRadians: 0, size: [1, 1], spin: [400, 400], forces };
  const launches = createParticleLaunches(settings);
  const state = { position: [0, 0, 0], scale: 0 };
  const [early, late] = [3, 6].map(time => {
    particleStateAt(launches, 0, forces, 'constant', time, state);
    return { x: state.position[0], angle: state.angle };
  });
  assert.ok(early.x > 0.8 && early.x < 1, `slid ${early.x} m, expected about 0.9`);
  assert.deepEqual(late, early, 'the slider is at rest and no longer turns');
});

test('the default bounce with colliders reads as debris', () => {
  const heights = traceOf(createAgentScene(dropRecipe({})), frames).map(center => center[1]);
  const rise = Math.max(...heights.slice(65, 100)) - SLAB_TOP;
  assert.ok(rise > 0 && rise < 0.3, `default bounce rebounds ${rise} m from a 1.9 m drop`);
});
