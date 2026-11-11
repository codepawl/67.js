import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { loopedClipTime } from '../src/hero-lab/loop/clip-time.js';
import { patrolLegTime, patrolTurnAmount, readClipChannels, readGlb, sampleChannel } from '../scripts/hero-clip-loop.mjs';

const CHIPFAB_GLB = new URL('../public/showcase/chipfab/scene.glb', import.meta.url);
const LEG_SECONDS = 12;
const CORNER_SECONDS = 0.5;
const FRAME_SECONDS = 1 / 30;
const ENGINEER_COUNT = 4;
const SKINS_PER_ENGINEER = 2;
const LIMITS = { maxBytes: 64 * 1024 * 1024, maxVertices: 4_000_000, maxParts: 20_000, maxTexturePixels: 512 * 1024 * 1024, maxTextureImagePixels: 100_000_000 };

async function loadChipfab() {
  // Node has no image decoder, so the test stubs createImageBitmap and only the geometry and the clip are real.
  globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
  const buffer = readFileSync(CHIPFAB_GLB);
  return parseGltf(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), LIMITS);
}

function maximumDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  return largest;
}

function engineerSkins(asset) {
  return Array.from({ length: ENGINEER_COUNT }, (_, engineer) => asset.skins[engineer * SKINS_PER_ENGINEER]);
}

function jointPosition(skin, jointName) {
  // The importer names the joints of the second engineer onward with a numeric suffix (foot_l_1).
  const index = skin.joints.findIndex(joint => joint.name.replace(/_\d+$/, '') === jointName);
  assert.ok(index >= 0, `the skin has a ${jointName} joint`);
  return Array.from(skin.jointWorldMatrices.slice(index * 16 + 12, index * 16 + 15));
}

test('loopedClipTime plays a clip again from its start instead of stopping on its last pose', () => {
  assert.equal(loopedClipTime(0, 24), 0);
  assert.equal(loopedClipTime(5.5, 24), 5.5);
  assert.ok(Math.abs(loopedClipTime(24 + 3, 24) - 3) < 1e-9);
  assert.ok(Math.abs(loopedClipTime(24 * 7 + 11, 24) - 11) < 1e-9);
  assert.ok(loopedClipTime(1e6, 24) < 24);
  assert.equal(loopedClipTime(10, 0), 0);
  assert.equal(loopedClipTime(Number.NaN, 24), 0);
});

test('a patrol goes out and back at walking pace, slows to a stop at each end and repeats without a jump', () => {
  const period = 2 * LEG_SECONDS;
  let previous = patrolLegTime(0, LEG_SECONDS, CORNER_SECONDS);
  for (let step = 1; step <= period * 60 * 3; step++) {
    const phase = step / 60;
    const position = patrolLegTime(phase, LEG_SECONDS, CORNER_SECONDS);
    assert.ok(position >= 0 && position <= LEG_SECONDS, `position ${position} stays on the leg`);
    assert.ok(Math.abs(position - previous) <= 1 / 60 + 1e-9, `position never moves faster than the one-way clip at ${phase}`);
    previous = position;
  }
  assert.ok(Math.abs(patrolLegTime(3.3, LEG_SECONDS, CORNER_SECONDS) - patrolLegTime(3.3 + period, LEG_SECONDS, CORNER_SECONDS)) < 1e-9);
  assert.ok(Math.abs(patrolLegTime(LEG_SECONDS + 0.0001, LEG_SECONDS, CORNER_SECONDS) - patrolLegTime(LEG_SECONDS - 0.0001, LEG_SECONDS, CORNER_SECONDS)) < 1e-6, 'it stops at the far end');
  assert.ok(patrolLegTime(LEG_SECONDS / 2, LEG_SECONDS, CORNER_SECONDS) < patrolLegTime(LEG_SECONDS / 2 + 1, LEG_SECONDS, CORNER_SECONDS), 'outbound goes forward');
  assert.ok(patrolLegTime(LEG_SECONDS + 3, LEG_SECONDS, CORNER_SECONDS) > patrolLegTime(LEG_SECONDS + 4, LEG_SECONDS, CORNER_SECONDS), 'the way back goes backward');
});

test('a patrol turns an engineer around while it is slow, and not on the legs', () => {
  assert.equal(patrolTurnAmount(5, LEG_SECONDS, CORNER_SECONDS), 0);
  assert.equal(patrolTurnAmount(LEG_SECONDS + 5, LEG_SECONDS, CORNER_SECONDS), 1);
  assert.ok(Math.abs(patrolTurnAmount(LEG_SECONDS, LEG_SECONDS, CORNER_SECONDS) - 0.5) < 1e-9);
  assert.ok(Math.abs(patrolTurnAmount(0, LEG_SECONDS, CORNER_SECONDS) - 0.5) < 1e-9);
  let previous = patrolTurnAmount(0, LEG_SECONDS, CORNER_SECONDS);
  for (let step = 1; step <= 2 * LEG_SECONDS * 60 * 2; step++) {
    const amount = patrolTurnAmount(step / 60, LEG_SECONDS, CORNER_SECONDS);
    assert.ok(Math.abs(amount - previous) < 0.05, `the turn is smooth at ${step / 60}`);
    previous = amount;
  }
});

test('the chip fab clip is a patrol long enough to loop and its last pose is its first', async () => {
  const asset = await loadChipfab();
  assert.equal(asset.animations.length, 1, 'one merged clip moves the whole scene');
  const duration = asset.animations[0].duration;
  assert.ok(duration >= 2 * LEG_SECONDS - 1e-6, `the clip lasts ${duration} s, two legs of ${LEG_SECONDS} s`);
  asset.applyAnimation(0, 0);
  const firstPose = asset.parts.map(part => Float32Array.from(part.matrix));
  const firstPalettes = asset.skins.map(skin => Float32Array.from(skin.jointMatrices));
  asset.applyAnimation(duration, 0);
  asset.parts.forEach((part, index) => assert.ok(maximumDifference(part.matrix, firstPose[index]) < 1e-3, `${part.name} is back where it started`));
  asset.skins.forEach((skin, index) => assert.ok(maximumDifference(skin.jointMatrices, firstPalettes[index]) < 1e-3, 'every skeleton is back in its first pose'));
});

test('nothing in the chip fab jumps from one frame to the next, including across the loop seam', async () => {
  const asset = await loadChipfab();
  const duration = asset.animations[0].duration;
  const framesPerSecond = 30;
  let previous = null;
  let largestStep = 0;
  for (let frame = 0; frame <= duration * framesPerSecond * 2; frame++) {
    asset.applyAnimation(loopedClipTime(frame / framesPerSecond, duration), 0);
    const positions = asset.parts.map(part => [part.matrix[12], part.matrix[13], part.matrix[14]]);
    if (previous) positions.forEach((position, index) => { largestStep = Math.max(largestStep, Math.hypot(position[0] - previous[index][0], position[1] - previous[index][1], position[2] - previous[index][2])); });
    previous = positions;
  }
  assert.ok(largestStep < 0.25, `the fastest part moves ${largestStep.toFixed(3)} m in one frame`);
});

test('every engineer keeps walking through the first, second and third pass of the clip', async () => {
  const asset = await loadChipfab();
  const duration = asset.animations[0].duration;
  const skins = engineerSkins(asset);
  let slowestChange = Infinity;
  for (let time = 0; time < duration * 3; time += 0.37) {
    asset.applyAnimation(loopedClipTime(time, duration), 0);
    const before = skins.map(skin => Float32Array.from(skin.jointMatrices));
    asset.applyAnimation(loopedClipTime(time + 0.1, duration), 0);
    skins.forEach((skin, index) => { slowestChange = Math.min(slowestChange, maximumDifference(skin.jointMatrices, before[index])); });
  }
  assert.ok(slowestChange > 0.005, `an engineer's joints moved only ${slowestChange} in 0.1 s at some time`);
});

test('an engineer faces the way it walks, on the way out and on the way back', async () => {
  const { json, binary } = readGlb(readFileSync(CHIPFAB_GLB));
  const channels = readClipChannels(json, binary, json.animations[0]);
  const duration = Math.max(...channels.map(channel => channel.times.at(-1)));
  for (let engineer = 0; engineer < ENGINEER_COUNT; engineer++) {
    const name = `engineer_${engineer}`;
    const translation = channels.find(channel => channel.nodeName === name && channel.path === 'translation');
    const rotation = channels.find(channel => channel.nodeName === name && channel.path === 'rotation');
    assert.ok(rotation, `${name} has a rotation, so it does not walk sideways`);
    let checked = 0;
    for (let time = 0; time < duration; time += 0.25) {
      const from = sampleChannel(translation, time);
      const to = sampleChannel(translation, time + 0.1);
      const speed = Math.hypot(to[0] - from[0], to[2] - from[2]) / 0.1;
      if (speed < 0.5) continue;
      const [x, y, z, w] = sampleChannel(rotation, time);
      // The model faces +Z; this is +Z turned by the rotation.
      const forward = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
      const alignment = (forward[0] * (to[0] - from[0]) + forward[2] * (to[2] - from[2])) / (speed * 0.1);
      assert.ok(alignment > 0.98, `${name} faces away from its path at ${time} s (alignment ${alignment.toFixed(2)})`);
      checked++;
    }
    assert.ok(checked > 40, `${name} was checked on both legs`);
  }
});

test('a planted foot of an engineer does not skate across the floor', async () => {
  const asset = await loadChipfab();
  const skins = engineerSkins(asset);
  for (const [engineer, skin] of skins.entries()) {
    let slideSum = 0;
    let slideCount = 0;
    let previous = null;
    for (let time = 1; time <= 10; time += FRAME_SECONDS) {
      asset.applyAnimation(time, 0);
      const feet = { left: jointPosition(skin, 'foot_l'), right: jointPosition(skin, 'foot_r') };
      if (previous) {
        for (const side of ['left', 'right']) {
          if (feet[side][1] > 0.12 || previous[side][1] > 0.12) continue;
          slideSum += Math.hypot(feet[side][0] - previous[side][0], feet[side][2] - previous[side][2]) / FRAME_SECONDS;
          slideCount++;
        }
      }
      previous = feet;
    }
    assert.ok(slideCount > 100, `engineer ${engineer} has frames with a planted foot`);
    assert.ok(slideSum / slideCount < 0.3, `engineer ${engineer} planted foot slides at ${(slideSum / slideCount).toFixed(2)} m/s`);
  }
});

test('an engineer swings its arms while it walks', async () => {
  const asset = await loadChipfab();
  const skin = asset.skins[0];
  const wristHeights = [];
  const hip = [];
  for (let time = 1; time <= 2.4; time += FRAME_SECONDS) {
    asset.applyAnimation(time, 0);
    const wrist = jointPosition(skin, 'hand_l');
    const pelvis = jointPosition(skin, 'pelvis');
    wristHeights.push(Math.hypot(wrist[0] - pelvis[0], wrist[2] - pelvis[2]));
    hip.push(pelvis[1]);
  }
  assert.ok(Math.max(...wristHeights) - Math.min(...wristHeights) > 0.1, 'the hand moves back and forth beside the body');
});
