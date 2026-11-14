// CrucibleRenderer.replaceParts with retainedUnchanged builds the same batches as a full replaceParts (issue 779).
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

async function compareSlicedAndFullBatches(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const materials = [0, 1].map(index => ({ tag: 'surface', color: [index, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 }));
    const geometries = [1, 2, 3, 4].map(size => box(0, size));
    const makeWorld = () => Array.from({ length: 24 }, (_, index) => ({ name: `part ${index}`, geometry: geometries[Math.floor(index / 6)], matrix: identity(), material: materials[index % 2] }));
    const layout = (renderer) => renderer.batches.map(batch => batch.parts.map(part => part.name));
    const makeRenderer = (world, ground) => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      document.body.append(canvas);
      return new CrucibleRenderer(canvas, world.slice(0, 6), { ground, samples: 1, pixelRatio: 1 });
    };
    const results = {};
    const floorOwnGeometry = { name: 'floor', geometry: box(0, 9), matrix: identity(), material: materials[0] };
    const floorSharedGeometry = { name: 'floor', geometry: geometries[2], matrix: identity(), material: materials[0] };
    const cases = { noGround: () => false, ownGeometry: () => floorOwnGeometry, sharedGeometry: () => floorSharedGeometry };
    for (const [name, ground] of Object.entries(cases)) {
      const world = makeWorld();
      const sliced = makeRenderer(world, ground());
      const full = makeRenderer(world, ground());
      const matches = [];
      for (let end = 12; end <= world.length; end += 6) {
        sliced.replaceParts(world.slice(0, end), { retainedUnchanged: true });
        full.replaceParts(world.slice(0, end));
        matches.push(JSON.stringify(layout(sliced)) === JSON.stringify(layout(full)));
      }
      const keptState = Boolean(sliced.incrementalGrouping);
      sliced.replaceParts(world.slice(0, 18));
      full.replaceParts(world.slice(0, 18));
      results[name] = {
        matches,
        keptState,
        clearedByPlainCall: sliced.incrementalGrouping === null,
        plainCallMatches: JSON.stringify(layout(sliced)) === JSON.stringify(layout(full)),
        batchCount: sliced.batches.length,
      };
    }
    return results;
  };
  return page.evaluate(task);
}

test('replaceParts with retainedUnchanged matches a full replaceParts, with and without a floor', async (context) => {
  await withDevServerPage(context, async (page) => {
    const results = await compareSlicedAndFullBatches(page);
    for (const [name, result] of Object.entries(results)) {
      assert.deepEqual(result.matches, [true, true, true], `${name}: sliced batches differ from the full grouping`);
      assert.equal(result.keptState, true, `${name}: the grouping state is kept between slices`);
      assert.equal(result.clearedByPlainCall, true, `${name}: a call without retainedUnchanged clears the state`);
      assert.equal(result.plainCallMatches, true, `${name}: a plain call groups the whole list`);
    }
    assert.ok(results.ownGeometry.batchCount > results.noGround.batchCount, 'a floor on its own geometry is one more batch');
  });
});
