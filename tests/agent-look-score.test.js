import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeRecord } from '../bench/agent-modeling/judge.mjs';
import { scoreLook, scoreSilhouette } from '../bench/agent-modeling/look.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { intersectionOverUnion, rasterizeSilhouette } from '../bench/agent-modeling/silhouette.mjs';
import { TASKS } from '../bench/agent-modeling/tasks.mjs';

const frontCamera = {
  eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'orthographic', orthographicHeight: 4,
};

function square(halfSize, centreX = 0) {
  return {
    positions: [-halfSize + centreX, -halfSize, 0, halfSize + centreX, -halfSize, 0, halfSize + centreX, halfSize, 0, -halfSize + centreX, halfSize, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

const coveredPixels = mask => mask.reduce((sum, pixel) => sum + pixel, 0);

test('the rasterizer covers the area a square takes in an orthographic view', () => {
  const mask = rasterizeSilhouette([square(1)], frontCamera, 100);
  assert.ok(Math.abs(coveredPixels(mask) - 2500) <= 200, `covered ${coveredPixels(mask)} of 10000`);
});

test('intersection over union is 1 for equal masks, 0 for disjoint masks and a fraction for partial overlap', () => {
  const left = rasterizeSilhouette([square(1, -1.5)], frontCamera, 100);
  const same = rasterizeSilhouette([square(1, -1.5)], frontCamera, 100);
  const farRight = rasterizeSilhouette([square(0.2, 1.8)], frontCamera, 100);
  const shifted = rasterizeSilhouette([square(1, -0.5)], frontCamera, 100);
  assert.equal(intersectionOverUnion(left, same), 1);
  assert.equal(intersectionOverUnion(left, farRight), 0);
  const partial = intersectionOverUnion(left, shifted);
  assert.ok(partial > 0.25 && partial < 0.45, `partial overlap ${partial}`);
  assert.equal(intersectionOverUnion(new Uint8Array(4), new Uint8Array(4)), 1);
  assert.throws(() => intersectionOverUnion(new Uint8Array(4), new Uint8Array(9)), RangeError);
});

test('every scene reference scores 1 against itself', async () => {
  for (const task of TASKS) {
    const silhouette = await scoreSilhouette(task.id, REFERENCES[task.id]);
    if (task.assets) {
      assert.equal(silhouette, null);
    } else {
      assert.equal(silhouette.mean, 1, task.id);
    }
  }
});

test('a broken table scores lower than a correct one, and each flaw lowers it', async () => {
  const widened = structuredClone(REFERENCES.table);
  widened.nodes[0].scale = [1.4, 1, 1];
  const missingLeg = structuredClone(REFERENCES.table);
  const lastLeg = missingLeg.nodes.findLastIndex(node => node.id?.includes('leg'));
  missingLeg.nodes.splice(lastLeg, 1);
  const correct = await scoreSilhouette('table', REFERENCES.table);
  const wide = await scoreSilhouette('table', widened);
  const short = await scoreSilhouette('table', missingLeg);
  assert.ok(wide.mean < correct.mean - 0.05, `widened ${wide.mean} vs ${correct.mean}`);
  assert.ok(short.mean < correct.mean, `missing leg ${short.mean} vs ${correct.mean}`);
});

test('a judge record needs four whole scores in range and keeps its criteria apart from the total', () => {
  const record = judgeRecord([3, 2, 3, 1], 'handle too thin');
  assert.deepEqual(record.criteria, { shape: 3, proportions: 2, features: 3, surface: 1 });
  assert.equal(record.total, 9);
  assert.equal(record.score, 0.75);
  assert.throws(() => judgeRecord([3, 2, 3]), RangeError);
  assert.throws(() => judgeRecord([4, 0, 0, 0]), RangeError);
  assert.throws(() => judgeRecord([1.5, 0, 0, 0]), RangeError);
});

test('a failing image step keeps the silhouette score and records imagesError', async () => {
  const failingImages = async () => {
    throw new Error('could not fetch the boolean module\nstack detail');
  };
  const look = await scoreLook('table', REFERENCES.table, { imageDirectory: 'unused', renderImages: failingImages });
  assert.equal(look.silhouette.mean, 1);
  assert.equal(look.imagesError, 'could not fetch the boolean module');
  assert.equal(look.images, undefined);
});
