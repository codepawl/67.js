import test from 'node:test';
import assert from 'node:assert/strict';
import './support/load-agent-scene-modules.mjs';
import { previewHarness } from './support/preview-harness.mjs';

test('walkMap works on a procedural recipe scene and marks its box as an obstacle', async () => {
  const { preview } = previewHarness();
  const sessionId = 'walkmap-recipe';
  preview.create({
    sessionId, backend: 'cpu', memoryBudgetMiB: 64,
    recipe: {
      format: '67js.scene', schemaVersion: 1,
      geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
      materials: [{ id: 'paint', color: [0.4, 0.5, 0.6] }],
      nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }],
    },
  });
  const region = { sessionId, min: [-2, -2], max: [2, 2], cellSize: 1, topY: 20, clearance: 1 };
  const plain = await preview.walkMap(region);
  assert.equal(plain.grid.length, 5);
  assert.ok(plain.surfaceCells > 0);
  assert.equal(plain.skippedParts, 0);
  const guarded = await preview.walkMap({ ...region, keepOut: 0.5, streetY: -0.5 });
  assert.equal(guarded.grid[2][2], 'x', 'the cube is not walkable');
});
