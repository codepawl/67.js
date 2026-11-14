import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

// A subdivided box grows far past the preflight estimate, so the budget is checked again after generation.
function seaRecipe(copies) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{
      id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 },
      edits: [{ op: 'subdivide_edges', edges: { all: true }, cuts: 16 }],
      stack: [{ op: 'array', count: copies, relativeOffset: [1, 0, 0] }],
    }],
    materials: [{ id: 'water', color: [0.1, 0.3, 0.6] }],
    nodes: [{ id: 'sea', geometry: 'sea', material: 'water' }],
  };
}

function setStack(scene, revision, copies, offset) {
  scene.apply([{ type: 'set-mesh-stack', geometry: 'sea', stack: [{ op: 'array', count: copies, relativeOffset: [offset, 0, 0] }] }], { expectedRevision: revision });
}

test('re-evaluating a 70k-vertex stack 10 times in one scene stays inside the default vertex budget (#818)', () => {
  const scene = createAgentScene(seaRecipe(38));
  for (let revision = 0; revision < 10; revision += 1) {
    setStack(scene, revision, 38, 1 + (revision + 1) * 0.01);
  }
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
});

test('the vertex budget still rejects a stack that is over the limit by itself (#818)', () => {
  const scene = createAgentScene(seaRecipe(2), { maxVertices: 50_000 });
  assert.throws(() => setStack(scene, 0, 38, 1), /maxVertices/);
});

test('releasing undo history keeps the newest revisions and reports the released count (#818)', () => {
  const scene = createAgentScene(seaRecipe(38));
  let totalReleased = 0;
  for (let revision = 0; revision < 10; revision += 1) {
    setStack(scene, revision, 38, 1 + (revision + 1) * 0.01);
    totalReleased += scene.releasedRevisions;
  }
  assert.ok(totalReleased > 0, 'a 70k-vertex scene must release some undo history to stay in budget');
  assert.equal(scene.revision, 10);
  scene.restoreRevision(9, { expectedRevision: 10 });
  assert.equal(scene.revision, 11);
});

test('an edit that releases nothing reports zero released revisions (#818)', () => {
  const scene = createAgentScene(seaRecipe(2));
  setStack(scene, 0, 3, 1);
  assert.equal(scene.releasedRevisions, 0);
});
