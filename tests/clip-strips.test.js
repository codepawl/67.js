import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { compileClipStrip } from '../src/clip-strip.js';

// Strips on the real RobotExpressive clips: Walking (0.958 s) and Idle (3.333 s). Each strip is checked against the
// same pose made with plain layers, so only the timing and the fade are under test.
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const ASSET_ID = 'cd'.repeat(32);
const loadRobot = () => parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });

function clipIndex(asset, name) {
  const index = asset.animations.findIndex(animation => animation.name === name);
  assert.ok(index >= 0, `no clip ${name}`);
  return index;
}

function assetScene(asset, layers, duration = 8) {
  return createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: ASSET_ID, motion: { duration, loop: false, layers } });
}

function poseAt(asset, layers, time) {
  const scene = assetScene(asset, layers);
  scene.sampleMotion(time);
  return scene.parts.map(part => Array.from(part.matrix));
}

function assertSamePose(first, second, message) {
  const distance = Math.max(...first.flatMap((matrix, part) => matrix.map((value, index) => Math.abs(value - second[part][index]))));
  assert.ok(distance < 1e-5, `${message}: poses differ by ${distance}`);
}

function refusalMessage(asset, layer) {
  try {
    assetScene(asset, [layer]);
  } catch (error) {
    return error.message;
  }
  return assert.fail('expected the strip to be refused');
}

const unit = { start: 0, scale: 1, repeat: 1, blendIn: 0, blendOut: 0, extend: 'nothing' };

test('a strip maps motion time to clip time with start, scale and repeat', () => {
  const strip = compileClipStrip({ ...unit, start: 1, scale: 2, repeat: 2.5 }, 1);
  assert.equal(strip.clipTime(0), 0);
  assert.equal(strip.clipTime(1), 0);
  assert.equal(strip.clipTime(2), 0.5);
  assert.equal(strip.clipTime(3), 1);
  assert.equal(strip.clipTime(4), 0.5);
  assert.equal(strip.clipTime(5), 1);
  assert.equal(strip.clipTime(6), 0.5);
  assert.equal(strip.clipTime(6.5), 0.5);
  assert.equal(strip.clipTime(100), 0.5);
  assert.equal(strip.end, 6);
});

test('a strip fades in and out linearly and extends as asked', () => {
  const faded = { ...unit, start: 1, repeat: 4, blendIn: 1, blendOut: 2 };
  const nothing = compileClipStrip(faded, 1);
  const weights = [0.5, 1, 1.5, 2, 3, 4, 4.5, 5, 6].map(time => nothing.weight(time));
  assert.deepEqual(weights, [0, 0, 0.5, 1, 1, 0.5, 0.25, 0, 0]);

  const hold = compileClipStrip({ ...faded, extend: 'hold' }, 1);
  assert.equal(hold.weight(0), 0, 'a hold before the start keeps the weight the strip starts with');
  const holdForward = compileClipStrip({ ...unit, start: 1, extend: 'holdForward' }, 1);
  assert.equal(holdForward.weight(0), 0);
  assert.equal(holdForward.weight(9), 1);
  assert.equal(compileClipStrip({ ...unit, extend: 'hold' }, 1).weight(-4), 1);
});

test('a walk repeated three times crossfades into an idle', async () => {
  const asset = await loadRobot();
  const walking = clipIndex(asset, 'Walking');
  const idle = clipIndex(asset, 'Idle');
  const walkLength = asset.animations[walking].duration;
  const fade = 0.5;
  const idleStart = walkLength * 3 - fade;
  const strips = [
    { clip: walking, strip: { repeat: 3 } },
    { clip: idle, strip: { start: idleStart, blendIn: fade, repeat: 1 } },
  ];

  assertSamePose(poseAt(asset, strips, 1.3), poseAt(asset, [{ clip: walking }], 1.3), 'second walk cycle');
  assertSamePose(poseAt(asset, strips, 2.2), poseAt(asset, [{ clip: walking }], 2.2), 'last walk cycle before the fade');
  const midFade = idleStart + fade / 2;
  assertSamePose(
    poseAt(asset, strips, midFade),
    poseAt(asset, [{ clip: walking }, { clip: idle, weight: 0.5, offset: -idleStart, loop: false }], midFade),
    'halfway through the crossfade',
  );
  assertSamePose(poseAt(asset, strips, 4.5), poseAt(asset, [{ clip: idle, offset: -idleStart, loop: false }], 4.5), 'idle after the fade');
  const afterIdle = idleStart + asset.animations[idle].duration + 0.5;
  assertSamePose(poseAt(asset, strips, afterIdle), poseAt(asset, [{ clip: walking, weight: 0 }], afterIdle), 'nothing after the last strip');
});

test('scale stretches the clip and hold keeps its last pose', async () => {
  const asset = await loadRobot();
  const walking = clipIndex(asset, 'Walking');
  const walkLength = asset.animations[walking].duration;
  assertSamePose(
    poseAt(asset, [{ clip: walking, strip: { scale: 2 } }], 1),
    poseAt(asset, [{ clip: walking, speed: 0.5 }], 1),
    'half speed',
  );
  const held = [{ clip: walking, strip: { extend: 'hold' } }];
  const clamped = [{ clip: walking, loop: false }];
  assertSamePose(poseAt(asset, held, walkLength + 3), poseAt(asset, clamped, walkLength + 3), 'held end');
  assertSamePose(poseAt(asset, held, walkLength), poseAt(asset, clamped, walkLength), 'strip end');
  assertSamePose(poseAt(asset, [{ clip: walking, strip: { start: 2, extend: 'hold' } }], 0.5), poseAt(asset, clamped, 0), 'held start');
});

test('an add strip adds the clip change on top of the pose below', async () => {
  const asset = await loadRobot();
  const base = clipIndex(asset, 'Idle');
  const wave = clipIndex(asset, 'Wave');
  assertSamePose(
    poseAt(asset, [{ clip: base }, { clip: wave, strip: { start: 0.5, blend: 'add' } }], 1.2),
    poseAt(asset, [{ clip: base }, { clip: wave, additive: true, offset: -0.5, loop: false }], 1.2),
    'additive wave',
  );
});

test('a strip pose is the same after seeking elsewhere and back', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, [{ clip: clipIndex(asset, 'Walking'), strip: { repeat: 3, blendOut: 0.3 } }], 5);
  const read = time => {
    scene.sampleMotion(time);
    return scene.parts.map(part => Array.from(part.matrix));
  };
  const first = read(2.1);
  read(0.4);
  read(4);
  assertSamePose(first, read(2.1), 'seek');
});

test('strip input outside its bounds names the field and what to pass', async () => {
  const asset = await loadRobot();
  const clip = clipIndex(asset, 'Walking');
  const message = (strip, extra = {}) => refusalMessage(asset, { clip, ...extra, strip });
  assert.match(message({ repeat: 0 }), /repeat/);
  assert.match(message({ repeat: 1000 }), /repeat/);
  assert.match(message({ extend: 'forever' }), /motion\.layers\[0\]\.strip\.extend.*nothing, hold, holdForward/);
  assert.match(message({ blend: 'combine' }), /strip\.blend.*replace, add/);
  assert.match(message({ end: 5, repeat: 2 }), /strip\.end.*end or repeat/);
  assert.match(message({ start: 2, end: 1 }), /strip\.end.*after start 2/);
  assert.match(message({ blendIn: 0.8, blendOut: 0.5 }), /strip\.blendOut.*blendIn 0\.8/);
  assert.match(message({ scale: 0 }), /scale/);
  assert.match(message({ colour: 1 }), /colour/);
  assert.match(message({}, { speed: 2 }), /motion\.layers\[0\]\.speed.*own start, scale and repeat/);
  assert.match(message({ blend: 'add' }, { additive: false }), /additive/);
});

test('end stops the strip at a time, as a fractional repeat', async () => {
  const asset = await loadRobot();
  const walking = clipIndex(asset, 'Walking');
  const walkLength = asset.animations[walking].duration;
  const stopAt = walkLength * 1.5;
  assertSamePose(
    poseAt(asset, [{ clip: walking, strip: { end: stopAt, extend: 'hold' } }], 5),
    poseAt(asset, [{ clip: walking, loop: false, offset: -walkLength }], stopAt),
    'held half cycle',
  );
});
