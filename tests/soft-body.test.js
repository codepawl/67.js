import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeCloth, createCloth } from '../src/cloth.js';
import { signedVolume } from '../src/soft-body.js';

const GROUND = { kind: 'box', center: [0, -1, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], halfExtents: [5, 1, 5] };

// A flat square sheet of (segments + 1)^2 particles lying at height `height`, `spacing` apart.
function flatSheet(segments, spacing, height) {
  const side = segments + 1;
  const positions = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      positions.set([column * spacing, height, row * spacing], (row * side + column) * 3);
    }
  }
  const triangles = [];
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const corner = row * side + column;
      triangles.push(corner, corner + side, corner + side + 1, corner, corner + side + 1, corner + 1);
    }
  }
  return { positions, triangles: Uint32Array.from(triangles), side };
}

// A closed cube surface of segments^3 lattice spacing, centred at (0, height, 0), triangles wound outward.
function cube(segments, size, height) {
  const indexOfKey = new Map();
  const positions = [];
  const vertex = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (!indexOfKey.has(key)) {
      indexOfKey.set(key, positions.length / 3);
      positions.push((x / segments - 0.5) * size, (y / segments - 0.5) * size + height, (z / segments - 0.5) * size);
    }
    return indexOfKey.get(key);
  };
  const triangles = [];
  const faces = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
  for (const [fixedAxis, uAxis, vAxis] of faces) {
    for (const fixedValue of [0, segments]) {
      for (let u = 0; u < segments; u++) {
        for (let v = 0; v < segments; v++) {
          const at = (du, dv) => {
            const point = [0, 0, 0];
            point[fixedAxis] = fixedValue;
            point[uAxis] = u + du;
            point[vAxis] = v + dv;
            return vertex(...point);
          };
          const quad = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
          const outward = fixedValue === segments;
          const order = outward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
          for (const corner of order) triangles.push(quad[corner]);
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(triangles) };
}

function frameAt(recording, frame) {
  const stride = recording.particleCount * 3;
  return recording.frames.subarray(frame * stride, (frame + 1) * stride);
}

function minimumDistance(positions, excluded) {
  let minimum = Infinity;
  const count = positions.length / 3;
  for (let first = 0; first < count; first++) {
    for (let second = first + 1; second < count; second++) {
      if (excluded.has(first * count + second)) continue;
      minimum = Math.min(minimum, Math.hypot(positions[first * 3] - positions[second * 3], positions[first * 3 + 1] - positions[second * 3 + 1], positions[first * 3 + 2] - positions[second * 3 + 2]));
    }
  }
  return minimum;
}

function gridEdges(side) {
  const joined = new Set();
  const count = side * side;
  const add = (first, second) => joined.add(Math.min(first, second) * count + Math.max(first, second));
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const corner = row * side + column;
      if (column + 1 < side) add(corner, corner + 1);
      if (row + 1 < side) add(corner, corner + side);
      if (row + 1 < side && column + 1 < side) add(corner, corner + side + 1);
    }
  }
  return joined;
}

test('a jelly cube lands on the ground, keeps its volume and comes to rest', () => {
  const body = cube(4, 0.5, 1);
  const restVolume = signedVolume(body.positions, body.triangles);
  assert.ok(restVolume > 0, 'the test cube winds outward');
  const recording = bakeCloth(body.positions, body.triangles, {
    colliders: [GROUND], softBody: { shape: 0.15, pressure: 1 }, stiffness: 0.9, bend: 0, damping: 2, frameCount: 181,
  });
  const last = frameAt(recording, 180);
  let lowest = Infinity;
  let centerY = 0;
  for (let particle = 0; particle < recording.particleCount; particle++) {
    lowest = Math.min(lowest, last[particle * 3 + 1]);
    centerY += last[particle * 3 + 1] / recording.particleCount;
  }
  assert.ok(lowest > -0.02, `the cube rests on the ground, lowest point ${lowest}`);
  assert.ok(centerY > 0.18 && centerY < 0.3, `the centre sits about half a cube above the ground, got ${centerY}`);
  const volume = signedVolume(last, body.triangles);
  assert.ok(volume > restVolume * 0.7 && volume < restVolume * 1.3, `volume ${volume} stays near ${restVolume}`);
  const before = frameAt(recording, 170);
  let drift = 0;
  for (let index = 0; index < last.length; index++) drift = Math.max(drift, Math.abs(last[index] - before[index]));
  assert.ok(drift < 0.01, `the cube is at rest, drift ${drift}`);
  const fallen = signedVolume(frameAt(recording, 0), body.triangles);
  assert.ok(fallen > 0);
});

test('a jelly ball falls as fast as free fall, then flattens and bulges on impact with its volume kept', async () => {
  const { icoSphere } = await import('../src/geometry.js');
  const { weldVertices } = await import('../src/cloth.js');
  const geometry = icoSphere(2);
  const lifted = Float32Array.from(geometry.positions, (value, index) => (index % 3 === 1 ? value * 0.5 + 1.4 : value * 0.5));
  const welded = weldVertices(lifted, geometry.indices);
  const particles = new Float32Array(welded.representatives.length * 3);
  welded.representatives.forEach((vertex, particle) => particles.set(lifted.subarray(vertex * 3, vertex * 3 + 3), particle * 3));
  const restVolume = signedVolume(particles, welded.triangles);
  const recording = bakeCloth(particles, welded.triangles, { colliders: [GROUND], softBody: { shape: 0.03, pressure: 1 }, bend: 0, damping: 0.3, frameCount: 61 });
  const measure = frame => {
    const state = frameAt(recording, frame);
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    state.forEach((value, index) => {
      low[index % 3] = Math.min(low[index % 3], value);
      high[index % 3] = Math.max(high[index % 3], value);
    });
    return { bottom: low[1], height: high[1] - low[1], width: high[0] - low[0], volume: signedVolume(state, welded.triangles) / restVolume };
  };
  // Free fall from a ball bottom at 0.9 m reaches the floor (thickness 0.01) at about 0.43 s, frame 26.
  assert.ok(measure(24).bottom > 0.05, 'still falling two frames before contact');
  assert.ok(measure(26).bottom < 0.011, 'touches the floor at frame 26');
  const impact = measure(29);
  assert.ok(impact.height < 0.9, `height ${impact.height} m flattens below 0.9 m`);
  assert.ok(impact.width > 1.005, `width ${impact.width} m bulges past 1 m`);
  assert.ok(Math.abs(impact.volume - 1) < 0.02, `volume ratio ${impact.volume} stays at 1`);
});

test('pressure keeps a jelly full while a soft body without it collapses further', () => {
  const body = cube(4, 0.5, 1);
  const settle = softBody => {
    const recording = bakeCloth(body.positions, body.triangles, { colliders: [GROUND], softBody, bend: 0, damping: 2, frameCount: 121 });
    return signedVolume(frameAt(recording, 120), body.triangles);
  };
  const inflated = settle({ shape: 0, pressure: 1.2 });
  const flat = settle({ shape: 0, pressure: 0 });
  assert.ok(inflated > flat, `pressure ${inflated} holds more volume than none ${flat}`);
});

test('pinned particles hold and a stiffness group makes its half stretch more', () => {
  const sheet = flatSheet(10, 0.1, 2);
  const side = sheet.side;
  const pinned = [];
  const weights = new Float64Array(side * side);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      if (row === 0) pinned.push(row * side + column);
      weights[row * side + column] = column < side / 2 ? 1 : 0.05;
    }
  }
  const recording = bakeCloth(sheet.positions, sheet.triangles, { pinned, stiffnessWeights: weights, stiffness: 0.9, bend: 0, frameCount: 121 });
  const last = frameAt(recording, 120);
  for (const particle of pinned) {
    for (let axis = 0; axis < 3; axis++) assert.equal(last[particle * 3 + axis], sheet.positions[particle * 3 + axis], 'a pinned particle never moves');
  }
  const meanLength = columns => {
    let total = 0;
    let count = 0;
    for (let row = 0; row + 1 < side; row++) {
      for (const column of columns) {
        const upper = row * side + column;
        const lower = upper + side;
        total += Math.hypot(last[upper * 3] - last[lower * 3], last[upper * 3 + 1] - last[lower * 3 + 1], last[upper * 3 + 2] - last[lower * 3 + 2]);
        count++;
      }
    }
    return total / count;
  };
  const stiff = meanLength([0, 1, 2, 3]);
  const limp = meanLength([7, 8, 9, 10]);
  assert.ok(limp - 0.1 > (stiff - 0.1) * 3, `the limp half stretches (${limp}) well beyond the stiff half (${stiff})`);
});

test('a sheet folded over itself does not pass through itself with self collision', () => {
  const sheet = flatSheet(10, 0.1, 0.02);
  const side = sheet.side;
  const edgeColumn = [];
  for (let row = 0; row < side; row++) edgeColumn.push(row * side + side - 1);
  const joined = gridEdges(side);
  const fold = selfCollision => {
    const cloth = createCloth(sheet.positions, sheet.triangles, { colliders: [GROUND], selfCollision, bend: 0.3, damping: 1 });
    const rest = Float64Array.from(sheet.positions);
    const move = (liftHeight, targetX) => {
      for (const particle of edgeColumn) cloth.pin(particle, [targetX, liftHeight, rest[particle * 3 + 2]]);
      cloth.step(1 / 60);
    };
    for (let frame = 1; frame <= 20; frame++) move(0.02 + 0.2 * (frame / 20), 1);
    // Carry the free edge back over the sheet to a point above its near half.
    for (let frame = 1; frame <= 50; frame++) move(0.22, 1 - 0.85 * (frame / 50));
    for (const particle of edgeColumn) cloth.unpin(particle);
    for (let frame = 0; frame < 120; frame++) cloth.step(1 / 60);
    return Float32Array.from(cloth.positions);
  };
  const withContact = fold(true);
  const without = fold(null);
  const radiusDiameter = 0.1 * 0.9;
  const gap = minimumDistance(withContact, joined);
  const gapWithout = minimumDistance(without, joined);
  assert.ok(gap > radiusDiameter * 0.8, `layers stay apart with self collision, closest pair ${gap}`);
  assert.ok(gapWithout < radiusDiameter * 0.5, `without it the layers interpenetrate, closest pair ${gapWithout}`);
});

test('the same input bakes the same frames', () => {
  const body = cube(3, 0.5, 0.6);
  const options = { colliders: [GROUND], softBody: { shape: 0.2, pressure: 1 }, selfCollision: true, frameCount: 40 };
  const first = bakeCloth(body.positions, body.triangles, options);
  const second = bakeCloth(body.positions, body.triangles, options);
  assert.deepEqual(first.frames, second.frames);
});

test('invalid soft body and self collision input names the field and the fix', () => {
  const sheet = flatSheet(4, 0.1, 1);
  assert.throws(() => createCloth(sheet.positions, sheet.triangles, { softBody: { pressure: 1 } }), /closed mesh.*set pressure to 0/s);
  assert.throws(() => createCloth(sheet.positions, sheet.triangles, { selfCollision: { radius: 0.2 } }), /selfCollision\.radius.*half the shortest edge/s);
  assert.throws(() => createCloth(sheet.positions, sheet.triangles, { softBody: { shape: 2, pressure: 0 } }), /softBody\.shape/);
  assert.throws(() => createCloth(sheet.positions, sheet.triangles, { stiffnessWeights: [1, 1] }), /stiffnessWeights.*one 0 to 1 weight per particle/s);
});

test('a recipe sheet takes softBody and a stiffness group and bakes them', async () => {
  await import('./support/load-agent-scene-modules.mjs');
  const { createAgentScene } = await import('../src/agent-scene.js');
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'jelly', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'vertex_group', name: 'soft', weight: 0.2 }] },
      { id: 'floor', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'gel', color: [0.2, 0.8, 0.4] }, { id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'cube', geometry: 'jelly', material: 'gel', translation: [0, 1, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.5, 0], scale: [6, 1, 6] },
    ],
    cloth: {
      duration: 1.5,
      sheets: [{ node: 'cube', softBody: { shape: 0.2, pressure: 1 }, stiffnessGroup: 'soft' }],
      colliders: [{ node: 'ground', shape: 'box' }],
    },
  };
  const scene = createAgentScene(recipe);
  scene.sampleMotion(1.5);
  const positions = scene.parts.find(part => part.name === 'cube').geometry.positions;
  let lowest = Infinity;
  for (let index = 1; index < positions.length; index += 3) lowest = Math.min(lowest, positions[index] * 0.5 + 1);
  assert.ok(lowest > -0.05 && lowest < 0.1, `the jelly sits on the ground, lowest point ${lowest}`);
  const badPressure = structuredClone(recipe);
  badPressure.cloth.sheets[0].softBody = { pressure: 9 };
  assert.throws(() => createAgentScene(badPressure), /softBody\.pressure/);
  const badGroup = structuredClone(recipe);
  badGroup.cloth.sheets[0].stiffnessGroup = 'missing';
  assert.throws(() => createAgentScene(badGroup).sampleMotion(1), /stiffnessGroup.*vertex group/s);
});
