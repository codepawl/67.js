import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene } from '../src/agent-scene.js';

// Golden positions come from scripts/blender-cloth.py (Blender's cloth solver, default stiffness, same mass per area).
const golden = JSON.parse(readFileSync(new URL('./fixtures/blender/cloth-golden.json', import.meta.url), 'utf8'));
const SEGMENTS = golden.segments;
const BALL_RADIUS = 0.4;

function recipe(nodes, cloth) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'grid', segments: SEGMENTS }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'paint', color: [1, 1, 1] }],
    nodes, cloth,
  };
}

function worldPositions(scene) {
  const part = scene.parts[0];
  const positions = part.geometry.positions;
  const matrix = part.matrix;
  const points = [];
  for (let index = 0; index < positions.length; index += 3) {
    points.push([0, 1, 2].map(axis => matrix[axis] * positions[index] + matrix[4 + axis] * positions[index + 1] + matrix[8 + axis] * positions[index + 2] + matrix[12 + axis]));
  }
  return points;
}

function meanDistance(ours, theirs) {
  const total = ours.reduce((sum, point, index) => sum + Math.hypot(...point.map((value, axis) => value - theirs[index][axis])), 0);
  return total / ours.length;
}

test('a hanging sheet ends where Blender hangs it, within 1 percent of the sheet height', () => {
  const scene = createAgentScene(recipe(
    [{ id: 'flag', geometry: 'sheet', material: 'paint', translation: [0, 2, 0], scale: [2, 1.5, 1] }],
    { duration: golden.seconds, sheets: [{ node: 'flag', pin: ['top'] }] },
  ));
  scene.sampleMotion(golden.seconds);
  const ours = worldPositions(scene);
  const theirs = golden.cases['hanging-flag'].positions;
  assert.ok(meanDistance(ours, theirs) / 1.5 < 0.01, 'mean vertex distance to the Blender bake');
  assert.ok(Math.abs(Math.min(...ours.map(point => point[1])) - Math.min(...theirs.map(point => point[1]))) < 0.01, 'free edge height');
});

function stretchAndArea(points, restLength) {
  const at = (row, column) => points[row * (SEGMENTS + 1) + column];
  let longest = 0;
  let area = 0;
  for (let row = 0; row <= SEGMENTS; row++) {
    for (let column = 0; column <= SEGMENTS; column++) {
      for (const [rowStep, columnStep] of [[0, 1], [1, 0]]) {
        if (row + rowStep > SEGMENTS || column + columnStep > SEGMENTS) continue;
        const other = at(row + rowStep, column + columnStep);
        longest = Math.max(longest, Math.hypot(...at(row, column).map((value, axis) => value - other[axis])) / restLength);
      }
      if (row < SEGMENTS && column < SEGMENTS) {
        const corner = at(row, column);
        const right = at(row, column + 1);
        const below = at(row + 1, column);
        const diagonal = at(row + 1, column + 1);
        for (const [first, second, third] of [[corner, right, below], [right, diagonal, below]]) {
          const u = second.map((value, axis) => value - first[axis]);
          const v = third.map((value, axis) => value - first[axis]);
          area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
        }
      }
    }
  }
  return { longest, areaRatio: area / (SHEET_SIZE * SHEET_SIZE) };
}

const SHEET_SIZE = 1.6;

function drapeScene(seconds) {
  return createAgentScene(recipe(
    [{ id: 'sheet', geometry: 'sheet', material: 'paint', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [SHEET_SIZE, SHEET_SIZE, 1] },
      { id: 'ball', geometry: 'ball', material: 'paint', scale: [BALL_RADIUS, BALL_RADIUS, BALL_RADIUS] }],
    { duration: seconds, sheets: [{ node: 'sheet' }], colliders: [{ node: 'ball', shape: 'ball' }] },
  ));
}

test('the draped sheet stays within 10 percent of its rest edge lengths and 5 percent of its rest area', () => {
  const scene = drapeScene(4);
  for (const time of [1, 2, 4]) {
    scene.sampleMotion(time);
    const { longest, areaRatio } = stretchAndArea(worldPositions(scene), SHEET_SIZE / SEGMENTS);
    assert.ok(longest < 1.1, `longest edge at ${time} s is ${longest} times its rest length`);
    assert.ok(Math.abs(areaRatio - 1) < 0.05, `area at ${time} s is ${areaRatio} times its rest area`);
  }
});

// Blender's air damping of 0.1 on this 3 g particle is a drag of 5.4 per second (1.0 would be 54, measured from the
// terminal speed of a falling sheet), so the sheet takes that damping here; the defaults differ by a factor of 180.
const MATCHED_DAMPING = 5.4;

test('with the drag matched, the sheet falls and lands like the Blender bake, then drapes more slowly in Blender', () => {
  const bake = golden.cases['drape-over-ball'];
  assert.equal(bake.framesSimulated, 481);
  const scene = createAgentScene(recipe(
    [{ id: 'sheet', geometry: 'sheet', material: 'paint', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [SHEET_SIZE, SHEET_SIZE, 1] },
      { id: 'ball', geometry: 'ball', material: 'paint', scale: [BALL_RADIUS, BALL_RADIUS, BALL_RADIUS] }],
    { duration: 2, sheets: [{ node: 'sheet', damping: MATCHED_DAMPING }], colliders: [{ node: 'ball', shape: 'ball' }] },
  ));
  for (const [time, frame] of [[0.25, '16'], [0.5, '31']]) {
    scene.sampleMotion(time);
    const distance = meanDistance(worldPositions(scene), bake.history[frame]) / SHEET_SIZE;
    assert.ok(distance < 0.1, `at ${time} s the mean vertex distance is ${distance} of the sheet size`);
  }
  const blender = stretchAndArea(bake.positions, SHEET_SIZE / SEGMENTS);
  assert.ok(blender.longest < 1.1, 'Blender stretches little too, so stiffness is not the difference');
});

test('a sheet dropped on a ball stays outside it in Crucible and in Blender, though the drape shapes differ', () => {
  const scene = createAgentScene(recipe(
    [{ id: 'sheet', geometry: 'sheet', material: 'paint', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [1.6, 1.6, 1] },
      { id: 'ball', geometry: 'ball', material: 'paint', scale: [BALL_RADIUS, BALL_RADIUS, BALL_RADIUS] }],
    { duration: golden.seconds, sheets: [{ node: 'sheet' }], colliders: [{ node: 'ball', shape: 'ball' }] },
  ));
  scene.sampleMotion(golden.seconds);
  const nearest = points => Math.min(...points.map(point => Math.hypot(...point)));
  assert.ok(nearest(worldPositions(scene)) > BALL_RADIUS - 0.01, 'no Crucible particle inside the ball');
  assert.ok(nearest(golden.cases['drape-over-ball'].positions) > BALL_RADIUS - 0.03, 'no Blender vertex inside the ball');
});
