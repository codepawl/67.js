import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { quaternionFromEuler } from '../src/rotation-euler.js';

// tests/fixtures/blender/constraints.json holds Blender 5.2's evaluated world matrix of the constrained node in each case
// (scripts/blender-constraints-golden.py). Crucible builds the same nodes, applies the same constraint and must land on the same
// matrix. Coordinates are shared as they are; track_to is given worldUp [0, 0, 1] because Blender's up is Z.

const golden = JSON.parse(readFileSync(new URL('./fixtures/blender/constraints.json', import.meta.url), 'utf8'));
const TOLERANCE = 2e-4;

function eulerQuaternion(degrees) {
  return Array.from(quaternionFromEuler(new Float64Array(4), ...degrees.map(angle => angle * Math.PI / 180)));
}

function recipeFor(testCase) {
  const nodes = testCase.nodes.map(node => ({
    id: node.id, geometry: 'box', material: 'paint',
    ...(node.parent ? { parent: node.parent } : {}),
    translation: node.translation ?? [0, 0, 0],
    rotation: eulerQuaternion(node.rotation ?? [0, 0, 0]),
  }));
  const tracks = [];
  if (testCase.pose) {
    tracks.push({ kind: 'node', id: testCase.pose.id, property: 'translation', keyframes: [{ time: 0, value: testCase.pose.translation }] });
    tracks.push({ kind: 'node', id: testCase.pose.id, property: 'rotation', keyframes: [{ time: 0, value: eulerQuaternion(testCase.pose.rotation) }] });
  }
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes, motion: { duration: 1, tracks, constraints: [testCase.constraint] },
  };
}

test('the fixture was recorded by Blender 5.2 and covers the required constraints', () => {
  assert.match(golden.blender, /^5\.2/);
  const types = new Set(golden.cases.map(testCase => testCase.constraint.type));
  for (const required of ['copy_rotation', 'limit_rotation', 'track_to', 'child_of']) {
    assert.ok(types.has(required), `${required} is in the fixture`);
  }
});

for (const testCase of golden.cases) {
  test(`${testCase.name} matches Blender's world matrix`, () => {
    const scene = createAgentScene(recipeFor(testCase));
    scene.sampleMotion(0);
    const owner = scene.parts.find(part => part.name === testCase.constraint.node);
    testCase.expectedOwnerWorld.forEach((expected, index) => {
      assert.ok(Math.abs(owner.matrix[index] - expected) <= TOLERANCE,
        `${testCase.name} matrix[${index}] ${owner.matrix[index]} vs Blender ${expected}\n${Array.from(owner.matrix).map(value => value.toFixed(4))}\n${testCase.expectedOwnerWorld.map(value => value.toFixed(4))}`);
    });
  });
}
