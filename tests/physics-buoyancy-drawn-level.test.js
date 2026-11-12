import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';

await loadPhysicsEngine({ buoyancy: true });

const SEA_NODE_HEIGHT = 2;
const SHEET_TOP = 0.5;

// A sheet made of the top face of a unit box, so it draws half a metre above its node.
function seaRecipe(ocean) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'cube', type: 'box' },
      {
        id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 },
        edits: [
          { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
          { op: 'subdivide_edges', edges: { all: true }, cuts: 8 },
          { op: 'set_position', position: { mul: [{ attr: 'position' }, [20, 1, 20]] } },
        ],
        stack: [{ op: 'ocean', windSpeed: 0.5, size: 50, seed: 4 }],
      },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'paint', translation: [0, SEA_NODE_HEIGHT, 0] },
      { id: 'crate', geometry: 'cube', material: 'paint', translation: [0, SEA_NODE_HEIGHT + SHEET_TOP + 0.4, 0] },
    ],
    physics: { duration: 10, ocean, bodies: [{ node: 'crate', density: 500, float: {} }] },
  };
}

test('without a level the sea follows its drawn surface: a crate on a sea node at y 2 settles near 2.5', () => {
  const scene = createAgentScene(seaRecipe({ geometry: 'sea' }));
  scene.sampleMotion(10);
  const crate = scene.parts.find(part => part.node === 'crate' || part.id === 'crate') ?? scene.parts[1];
  const settledHeight = crate.matrix[13];
  assert.ok(Math.abs(settledHeight - (SEA_NODE_HEIGHT + SHEET_TOP)) < 0.05, `crate centre ${settledHeight}`);
  assert.equal(scene.inspect({}).physics.warnings, undefined);
});

test('a level far from the drawn sea returns a warning naming both heights', () => {
  const scene = createAgentScene(seaRecipe({ geometry: 'sea', level: 0 }));
  const { warnings } = scene.inspect({}).physics;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /physics\.ocean\.level is 0 .* "sea" is drawn at height 2\.5/);
  const close = createAgentScene(seaRecipe({ geometry: 'sea', level: SEA_NODE_HEIGHT + SHEET_TOP + 0.02 }));
  assert.equal(close.inspect({}).physics.warnings, undefined);
});
