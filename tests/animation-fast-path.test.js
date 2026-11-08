import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGltf } from '../src/gltf.js';

async function loadRobot() {
  const bytes = await readFile(new URL('fixtures/RobotExpressive.glb', import.meta.url));
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

function poseSnapshot(parts) {
  return parts.map(part => ({ matrix: [...part.matrix], palette: part.skin ? [...part.skin.jointMatrices] : null }));
}

test('applyAnimation with checks off gives the same pose as the checked path', async () => {
  const checked = await loadRobot();
  const unchecked = await loadRobot();
  for (const time of [0, 0.35, 1.2, 2.9]) {
    for (const clip of [0, 3]) {
      checked.applyAnimation(time, clip);
      unchecked.applyAnimation(time, clip, { checks: false });
      assert.deepEqual(poseSnapshot(unchecked.parts), poseSnapshot(checked.parts));
    }
  }
});

test('applyAnimation checks option must be a boolean', async () => {
  const asset = await loadRobot();
  assert.throws(() => asset.applyAnimation(0, 0, { checks: 'no' }), /checks must be a boolean/);
});

test('the checked path stays the default after an unchecked frame', async () => {
  const asset = await loadRobot();
  asset.applyAnimation(0.5, 0, { checks: false });
  const transaction = asset.stagePose({ animation: { clip: 0, time: 0.5 } });
  transaction.discard();
  assert.ok(asset.applyAnimation(0.6, 0).length > 0);
});

test('frame after frame on one clip matches a fresh asset posed once, across clip switches and overrides', async () => {
  const running = await loadRobot();
  const steps = [[0.2, 0], [0.5, 0], [0.9, 0], [0.3, 3], [0.6, 3], [1.1, 0]];
  for (const [time, clip] of steps) {
    running.applyAnimation(time, clip, { checks: false });
    const fresh = await loadRobot();
    fresh.applyAnimation(time, clip);
    assert.deepEqual(poseSnapshot(running.parts), poseSnapshot(fresh.parts), `time ${time} clip ${clip}`);
  }
  const node = running.nodes.find(entry => entry.editable && entry.joint);
  running.stagePose({ animation: { clip: 0, time: 0.4 }, nodeOverrides: [{ id: node.id, translation: [0, 5, 0] }] }).commit();
  running.applyAnimation(0.7, 0);
  const fresh = await loadRobot();
  fresh.applyAnimation(0.7, 0);
  assert.deepEqual(poseSnapshot(running.parts), poseSnapshot(fresh.parts), 'an override is cleared by the next applyAnimation');
});
