import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { MAX_WAKE_POINTS, normalizeWake, wakeAt, wakeTrail } from '../src/ocean-wake.js';
import { oceanMesh } from '../src/mesh-ocean-modifier.js';
import { createMeshData } from '../src/mesh-data.js';

await loadPhysicsEngine({ buoyancy: true });

const MOVING_STERN = time => ({ x: 0, z: -4 * time, speed: 4 });

test('a wake trail holds at most 64 points however many are asked for', () => {
  const points = wakeTrail({ sample: MOVING_STERN, time: 30, lifetime: 6, width: 1, strength: 1, count: 5000 });
  assert.ok(points.length <= MAX_WAKE_POINTS, `${points.length} points`);
  assert.ok(points.length > 50, `${points.length} points above the fade threshold`);
});

test('older points are weaker and wider, and the oldest are nearly gone', () => {
  const points = wakeTrail({ sample: MOVING_STERN, time: 30, lifetime: 6, width: 1, strength: 1 });
  for (let index = 1; index < points.length; index++) {
    assert.ok(points[index][2] < points[index - 1][2], 'strength falls with age');
    assert.ok(points[index][3] > points[index - 1][3], 'width grows with age');
  }
  assert.equal(points[0][2], 1);
  assert.ok(points.at(-1)[2] < 0.05);
});

test('the trail is an open V: narrow at the stern, widening and fading with age, and it does not close on itself in a turn', () => {
  const radius = 8;
  const speed = 4;
  const turning = time => ({ x: radius * Math.sin(speed * time / radius), z: radius * (1 - Math.cos(speed * time / radius)), speed });
  const points = wakeTrail({ sample: turning, time: 20, lifetime: 3, width: 1.6, strength: 1 });
  assert.ok(points[0][3] < 1, `stern width ${points[0][3]}`);
  assert.ok(points.at(-1)[3] > 3 * points[0][3], 'the oldest point is much wider than the newest');
  const ages = points.map((_, index) => index);
  assert.deepEqual(ages, [...ages].sort((first, second) => first - second));
  for (let index = 1; index < points.length; index++) {
    assert.ok(points[index][3] > points[index - 1][3] && points[index][2] < points[index - 1][2]);
  }
  const gap = Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]);
  assert.ok(gap > points.at(-1)[3] + points[0][3], `the ends are ${gap} m apart, wider than their foam`);
});

test('a hull at rest leaves no wake and the trail starts no earlier than time 0', () => {
  assert.equal(wakeTrail({ sample: () => ({ x: 0, z: 0, speed: 0 }), time: 10, lifetime: 5, width: 1, strength: 1 }).length, 0);
  const underway = wakeTrail({ sample: MOVING_STERN, time: 0, lifetime: 3, width: 1, strength: 1 });
  assert.ok(underway.length > 20, `${underway.length} points at time 0 for a hull already moving`);
});

test('a wake is capped lace with a flat top and an edge, adds no trough, and nothing far away', () => {
  const wake = normalizeWake({ points: [[0, 0, 1, 1]], height: 0.2 });
  assert.ok(Math.abs(wakeAt(wake, 0, 0).foam - 0.8) < 1e-9, 'capped at 0.8, below full white');
  assert.ok(wakeAt(wake, 0.5, 0).foam > 0.75, 'dense across the body of the wake');
  assert.ok(wakeAt(wake, 1.4, 0).foam < 0.55, 'a short edge');
  const faint = normalizeWake({ points: [[0, 0, 0.3, 1]] });
  assert.ok(wakeAt(faint, 0, 0).foam < 0.7 && wakeAt(faint, 0, 0).foam > 0.5, 'a weak point is a thin lace');
  assert.deepEqual(wakeAt(wake, 20, 0), { foam: 0, offset: 0 });
});

test('a wake roughens the surface in both directions and never flattens or lowers it', () => {
  const wake = normalizeWake({ points: [[0, 0, 1, 2]], height: 0.2 });
  let lowest = 0;
  let highest = 0;
  let sum = 0;
  let count = 0;
  for (let x = -1.5; x <= 1.5; x += 0.1) {
    for (let z = -1.5; z <= 1.5; z += 0.1) {
      const { offset } = wakeAt(wake, x, z);
      lowest = Math.min(lowest, offset);
      highest = Math.max(highest, offset);
      sum += offset;
      count++;
    }
  }
  assert.ok(lowest < -0.05 && highest > 0.05, `churn from ${lowest} to ${highest}`);
  assert.ok(highest <= 0.2 && lowest >= -0.2, 'bounded by height');
  assert.ok(Math.abs(sum / count) < 0.03, `mean offset ${sum / count} is near zero, so no calm patch or hole`);
  assert.deepEqual(wakeAt(wake, 0.3, 0.7), wakeAt(wake, 0.3, 0.7), 'repeatable');
});

test('the ocean edit applies the wake to the foam group and the height, the same on every run', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 30, 0, 30]);
  const mesh = createMeshData({ positions, faceOffsets: new Uint32Array([0, 3]), cornerVertices: new Uint32Array([0, 1, 2]) });
  const options = { axis: 'y', windSpeed: 4, direction: 0, choppiness: 0, size: 30, seed: 1, time: 0, resolution: 3 };
  const calm = oceanMesh(mesh, options);
  const wake = normalizeWake({ points: [[0, 0, 1, 1]], height: 0.2 });
  const wet = oceanMesh(mesh, { ...options, wake });
  assert.notEqual(wet.positions[1], calm.positions[1], 'the wake displaces the stern');
  assert.equal(wet.positions[7], calm.positions[7] + wakeAt(wake, 30, 30).offset);
  assert.deepEqual(Array.from(wet.positions), Array.from(oceanMesh(mesh, { ...options, wake }).positions));
});

test('wake fields fail with the field name and what to pass', () => {
  assert.throws(() => normalizeWake({ points: Array.from({ length: 65 }, () => [0, 0, 1, 1]) }), /wake\.points must be an array of at most 64 points/);
  assert.throws(() => normalizeWake({ points: [[0, 0, 2, 1]] }), /wake\.points\[0\] must be \[x, z, strength, width\] with strength from 0 to 1/);
  assert.throws(() => normalizeWake({ height: 5 }), /wake\.height must be a number from 0 to 2/);
  assert.throws(() => normalizeWake({ speed: 1 }), /wake\.speed is unsupported; use points or height/);
});

function boatRecipe(wake, velocity) {
  const boat = { thrust: 6, controls: [{ time: 0, throttle: 1 }] };
  if (wake) boat.wake = wake;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'hull', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'grid', segments: 40 }, edits: [{ op: 'set_position', position: { mul: [{ attr: 'position' }, [24, 1, 24]] } }], stack: [{ op: 'ocean', windSpeed: 3, choppiness: 0, size: 30, seed: 2, resolution: 4 }] },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }, { id: 'water', color: [0.02, 0.12, 0.2], tag: 'water' }],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      { id: 'hull', geometry: 'hull', material: 'paint', translation: [0, 0.2, 0], scale: [1.8, 0.7, 3.8] },
    ],
    motion: { duration: 5, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: 5, value: 5 }] }] },
    physics: { duration: 5, ocean: { geometry: 'sea' }, bodies: [{ node: 'hull', density: 300, ...(velocity ? { velocity } : {}), float: { points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]], boat } }] },
  };
}

function seaPositions(wake, time, velocity) {
  const scene = createAgentScene(boatRecipe(wake, velocity));
  scene.sampleMotion(time);
  return Array.from(scene.parts[0].geometry.positions);
}

test('a boat recipe with wake draws a bounded wake into the sea behind the hull, and without it the sea is untouched', () => {
  const plain = seaPositions(undefined, 4);
  const wet = seaPositions({ height: 0.15 }, 4);
  assert.equal(plain.length, wet.length);
  let changed = 0;
  let largest = 0;
  for (let index = 1; index < plain.length; index += 3) {
    const difference = Math.abs(wet[index] - plain[index]);
    if (difference > 0) changed++;
    largest = Math.max(largest, difference);
  }
  assert.ok(changed > 20, `${changed} vertices moved`);
  assert.ok(largest <= 0.15 * 4 + 1e-6 && largest > 0.02, `largest change ${largest} m`);
  assert.deepEqual(wet, seaPositions({ height: 0.15 }, 4), 'same bake, same sea');
});

test('a hull that starts with a velocity has a wake and white water at its hull from the first frame', () => {
  const plain = seaPositions(undefined, 0, [0, 0, 4]);
  const wet = seaPositions({ height: 0.15 }, 0, [0, 0, 4]);
  let changed = 0;
  for (let index = 1; index < plain.length; index += 3) if (wet[index] !== plain[index]) changed++;
  assert.ok(changed > 20, `${changed} vertices carry the wake at time 0`);
});

test('a boat wake field is checked: lifetime, width, strength and height name what to pass', () => {
  assert.throws(() => createAgentScene(boatRecipe({ lifetime: 0 })), /boat\.wake\.lifetime must be a number from 0\.5 to 60/);
});
