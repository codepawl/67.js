import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHarness } from './support/preview-harness.mjs';
import { carAsset } from './fixtures/car-glb.js';

test('walkMap on an imported asset returns a grid and reuses the cached query', async () => {
  const { preview } = previewHarness();
  const sessionId = 'walkmap-asset';
  await preview.createAsset({
    sessionId, recipe: { format: '67js.asset', schemaVersion: 1, assetId: 'cd'.repeat(32) },
    data: Buffer.from(carAsset()).toString('base64'), backend: 'cpu', memoryBudgetMiB: 64,
  });
  const region = { sessionId, min: [-3, -3], max: [3, 3], cellSize: 1, topY: 20, clearance: 1 };
  const result = await preview.walkMap(region);
  assert.equal(result.grid.length, 7);
  assert.ok(result.grid.every(row => row.length === 7));
  assert.ok(result.walkableCells > 0);
  assert.equal(result.skippedParts, 0);
  const listed = await preview.walkMap({ ...region, includeCells: true });
  assert.equal(listed.cells.length, listed.surfaceCells);
  await assert.rejects(async () => preview.walkMap({ ...region, max: [3000, 3000] }), /maxCells/);
});
