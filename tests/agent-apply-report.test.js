import test from 'node:test';
import assert from 'node:assert/strict';
import { describeApplication } from '../src/agent-apply-report.js';

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'paint', color: [0.2, 0.4, 0.6], roughness: 0.5 }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'paint', translation: [0, 0, 0] }],
    camera: { position: [0, 1, 5], fov: 45 },
    environment: { exposure: 1 },
  };
}

// The report works on recipes, so each test builds the "after" recipe by hand.
function report(operations, after) {
  return describeApplication(recipe(), after, operations);
}

test('a mixed batch gets one entry per operation and a diff of IDs', () => {
  const after = recipe();
  after.nodes[0].translation = [1, 0, 0];
  after.materials.push({ id: 'glass', color: [1, 1, 1] });
  after.geometries.length = 0;
  const result = report([
    { type: 'set-node', id: 'cube', translation: [1, 0, 0] },
    { type: 'add-material', material: { id: 'glass', color: [1, 1, 1] } },
    { type: 'remove-geometry', id: 'box' },
    { type: 'set-camera', fov: 60 },
  ], after);
  assert.deepEqual(result.results, [
    { i: 0, op: 'set-node', target: 'cube', changed: 'translation' },
    { i: 1, op: 'add-material', target: 'glass', changed: 'added material' },
    { i: 2, op: 'remove-geometry', target: 'box', changed: 'removed geometry' },
    { i: 3, op: 'set-camera', target: 'camera', changed: 'fov' },
  ]);
  assert.deepEqual(result.diff, {
    nodes: { changed: ['cube'] },
    materials: { added: ['glass'] },
    geometries: { removed: ['box'] },
  });
});

test('an operation that sets the values already there is a warning', () => {
  const result = report([
    { type: 'set-material', id: 'paint', color: [0.2, 0.4, 0.6], roughness: 0.5 },
    { type: 'set-environment', environment: { exposure: 1 } },
    { type: 'set-material', id: 'paint', roughness: 0.9 },
    { type: 'set-material', id: 'paint', roughness: 0.9 },
  ], recipe());
  assert.equal(result.results[0].warning, 'no change, values already set');
  assert.equal(result.results[1].warning, 'no change, values already set');
  assert.equal(result.results[2].changed, 'roughness');
  assert.equal(result.results[3].warning, 'no change, values already set');
  assert.deepEqual(result.diff, {});
});

test('a 20-operation batch stays under 2 KB and a larger one says how many entries were cut', () => {
  const operations = [];
  const after = recipe();
  for (let index = 0; index < 20; index += 1) {
    operations.push({ type: 'set-node', id: 'cube', translation: [index + 1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  }
  after.nodes[0].translation = [20, 0, 0];
  const twenty = report(operations, after);
  assert.equal(twenty.results.length, 20);
  assert.ok(JSON.stringify(twenty).length < 2048, `${JSON.stringify(twenty).length} bytes`);

  const extra = { type: 'set-node', id: 'cube', translation: [20, 0, 0] };
  const cut = report([...operations, extra, extra], after);
  assert.equal(cut.results.length, 20);
  assert.equal(cut.omittedResults, 2);
  assert.equal(cut.omittedWarnings, 2);
});

test('the diff caps a long ID list', () => {
  const after = recipe();
  const operations = [];
  for (let index = 0; index < 12; index += 1) {
    after.nodes.push({ id: `n${index}` });
    operations.push({ type: 'add-node', node: { id: `n${index}` } });
  }
  const result = report(operations, after);
  assert.equal(result.diff.nodes.added.length, 9);
  assert.equal(result.diff.nodes.added.at(-1), '+4 more');
});
