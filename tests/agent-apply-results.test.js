import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHarness } from './support/preview-harness.mjs';

const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box' }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
  nodes: [{ id: 'mesh', geometry: 'cube', material: 'blue' }],
};

function createSession(sessionId) {
  const { preview } = previewHarness();
  preview.create({ recipe, sessionId, backend: 'cpu', memoryBudgetMiB: 64 });
  return preview;
}

test('the preview answers a 3-operation batch with results and a diff, and flags the no-op', () => {
  const preview = createSession('three');
  const answer = preview.apply({ sessionId: 'three', expectedRevision: 0, operations: [
    { type: 'set-node', id: 'mesh', translation: [1, 0, 0] },
    { type: 'set-material', id: 'blue', color: [0.1, 0.3, 0.8] },
    { type: 'add-material', material: { id: 'red', color: [1, 0, 0] } },
  ] });
  assert.deepEqual(answer.results, [
    { i: 0, op: 'set-node', target: 'mesh', changed: 'translation' },
    { i: 1, op: 'set-material', target: 'blue', warning: 'no change, values already set' },
    { i: 2, op: 'add-material', target: 'red', changed: 'added material' },
  ]);
  assert.deepEqual(answer.diff, { nodes: { changed: ['mesh'] }, materials: { added: ['red'] } });
});

test('a 20-operation batch adds under 2 KB to the answer', () => {
  const preview = createSession('twenty');
  const operations = [];
  for (let index = 0; index < 20; index += 1) {
    operations.push({ type: 'set-node', id: 'mesh', translation: [index + 1, 0, 0], scale: [1, 1, 1] });
  }
  const { results, diff, omittedResults } = preview.apply({ sessionId: 'twenty', expectedRevision: 0, operations });
  assert.equal(results.length, 20);
  assert.equal(omittedResults, undefined);
  const bytes = JSON.stringify({ results, diff }).length;
  assert.ok(bytes < 2048, `${bytes} bytes`);
});
