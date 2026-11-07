import test from 'node:test';
import assert from 'node:assert/strict';
import { carAsset } from './fixtures/car-glb.js';
import { createQueryOnlyCache, geometryOnlyGlb, loadQueryOnlyScene, QUERY_ASSET_LIMITS } from '../scripts/agent-query-asset.mjs';

test('geometryOnlyGlb keeps the geometry readable', async () => {
  const stripped = geometryOnlyGlb(Buffer.from(carAsset()));
  const scene = await loadQueryOnlyScene(stripped);
  assert.ok(scene.parts > 0);
  assert.ok(scene.triangles > 0);
  assert.ok(scene.triangles <= QUERY_ASSET_LIMITS.maxTriangles);
  scene.query.dispose();
});

test('the query-only cache walks a catalog asset, reuses its scene and replaces it for another asset', async () => {
  const cache = createQueryOnlyCache();
  let reads = 0;
  const bytes = async () => {
    reads++;
    return Buffer.from(carAsset());
  };
  const region = { min: [-3, -3], max: [3, 3], cellSize: 1, topY: 20, clearance: 1 };
  const first = await cache.walkMap({ assetId: 'a'.repeat(64), bytes, ...region });
  assert.equal(first.queryOnly, true);
  assert.equal(first.grid.length, 7);
  assert.ok(first.walkableCells > 0);
  await cache.walkMap({ assetId: 'a'.repeat(64), bytes, ...region, keepOut: 0.5, streetY: 0 });
  assert.equal(reads, 1);
  await cache.walkMap({ assetId: 'b'.repeat(64), bytes, ...region });
  assert.equal(reads, 2);
  cache.dispose();
});

test('a file that is not a GLB with a JSON chunk first is refused', () => {
  assert.throws(() => geometryOnlyGlb(Buffer.alloc(64)), /GLB/);
});
