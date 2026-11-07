import test from 'node:test';
import assert from 'node:assert/strict';
import { carAsset } from './fixtures/car-glb.js';
import { geometryOnlyGlb } from '../scripts/agent-query-asset.mjs';
import { createQueryOnlyCache } from '../scripts/agent-walkmap.js';
import { parseGltf } from '../src/gltf.js';

const region = { min: [-3, -3], max: [3, 3], cellSize: 1, topY: 20, clearance: 1 };

test('the query-only cache asks for the file once, walks it and replaces it for another asset', async () => {
  const cache = createQueryOnlyCache(parseGltf);
  const bytes = new Uint8Array(geometryOnlyGlb(Buffer.from(carAsset())));
  const first = { assetId: 'a'.repeat(64), ...region };
  assert.deepEqual(await cache.walkMap(first), { needsData: true });
  const result = await cache.walkMap({ ...first, bytes });
  assert.equal(result.queryOnly, true);
  assert.equal(result.grid.length, 7);
  assert.ok(result.walkableCells > 0);
  assert.ok(result.triangles > 0);
  const guarded = await cache.walkMap({ ...first, keepOut: 0.5, streetY: 0 });
  assert.equal(guarded.queryOnly, true);
  assert.deepEqual(await cache.walkMap({ assetId: 'b'.repeat(64), ...region }), { needsData: true });
  cache.dispose();
});

test('a file that is not a GLB with a JSON chunk first is refused', () => {
  assert.throws(() => geometryOnlyGlb(Buffer.alloc(64)), /GLB/);
});
