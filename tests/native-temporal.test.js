import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEMPORAL_DEFAULTS, chooseNativeTemporal, createTemporalAccumulator, onlyCameraDiffers, readCameraView, temporalFrameSeed,
} from '../scripts/agent-native-temporal.mjs';

const WIDTH = 32;
const HEIGHT = 20;
const PIXEL_COUNT = WIDTH * HEIGHT;
const HALF_WIDTH = 0.8;
const HALF_HEIGHT = 0.5;
const WALL_DISTANCE = 5;
const SEED_BYTE = 28;
const KERNEL_FLAGS_BYTE = 32;
const FILM_EXPOSURE_BYTE = 288;

// A FORMAT-v2 kernel parameter block for a camera at `position` that looks down the negative z axis.
function paramsForCamera(position, { seed = 1, lensShift = [0, 0], orthographic = false, exposure = 1 } = {}) {
  const block = new Uint8Array(320);
  const view = new DataView(block.buffer);
  view.setUint32(SEED_BYTE, seed, true);
  view.setUint32(KERNEL_FLAGS_BYTE, 1 | (orthographic ? 8 : 0), true);
  [position, [0, 0, -1], [HALF_WIDTH, 0, 0], [0, HALF_HEIGHT, 0]].forEach((vector, row) => {
    vector.forEach((value, axis) => view.setFloat32(112 + row * 16 + axis * 4, value, true));
  });
  view.setFloat32(176, lensShift[0], true);
  view.setFloat32(180, lensShift[1], true);
  view.setFloat32(FILM_EXPOSURE_BYTE, exposure, true);
  return block;
}

function wallColor(worldX, worldY) {
  return [0.5 + 0.1 * worldX, 0.5 + 0.1 * worldY, 0.25];
}

// The planes a camera at `position` sees of a wall at z = -distance whose colour is a linear function of the place on it.
function wallFrame(position, { distance = WALL_DISTANCE, lensShift = [0, 0] } = {}) {
  const color = new Float32Array(PIXEL_COUNT * 3);
  const depth = new Float32Array(PIXEL_COUNT);
  const normal = new Float32Array(PIXEL_COUNT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sensorX = ((x + 0.5) / WIDTH) * 2 - 1 + 2 * lensShift[0];
      const sensorY = 1 - ((y + 0.5) / HEIGHT) * 2 + 2 * lensShift[1];
      const reach = distance + position[2];
      const worldX = position[0] + HALF_WIDTH * sensorX * reach;
      const worldY = position[1] + HALF_HEIGHT * sensorY * reach;
      const pixel = y * WIDTH + x;
      color.set(wallColor(worldX, worldY), pixel * 3);
      depth[pixel] = reach * Math.hypot(HALF_WIDTH * sensorX, HALF_HEIGHT * sensorY, 1);
      normal.set([0, 0, 1], pixel * 3);
    }
  }
  return { color, depth, normal };
}

function flatFrame(value) {
  const frame = wallFrame([0, 0, 0]);
  frame.color.fill(value);
  return frame;
}

function maximumDifference(first, second) {
  let maximum = 0;
  for (let index = 0; index < first.length; index++) {
    maximum = Math.max(maximum, Math.abs(first[index] - second[index]));
  }
  return maximum;
}

test('the first frame passes through and says the history started', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const frame = wallFrame([0, 0, 0]);
  const result = accumulator.accumulate({ ...frame, kernelParams: paramsForCamera([0, 0, 0]) });
  assert.equal(result.restarted, 'the first frame of the job');
  assert.equal(result.historyShare, 0);
  assert.deepEqual(result.color, frame.color);
  assert.notEqual(result.color, frame.color, 'the result is a new buffer');
});

test('a still camera averages every frame it has seen, and a moving one holds the newest frame at the minimum weight', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const second = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0, 0, 0], { seed: 2 }) });
  assert.equal(second.restarted, null, 'another seed is not another scene');
  assert.equal(second.historyShare, 1);
  assert.ok(Math.abs(second.color[0] - 1 / 2) < 1e-6);
  const third = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  assert.ok(Math.abs(third.color[0] - 1 / 3) < 1e-6);
  let last = third;
  for (let frame = 0; frame < 20; frame++) {
    last = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  }
  assert.ok(Math.abs(last.color[0] - 1 / 23) < 1e-6, 'the 23 frames of a still camera count the same');
  const beforeStep = last.color[0];
  // The same wall from a camera one pixel to the side: the history is as long, and the camera moved.
  const step = accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0.25, 0, 0]) });
  const share = (step.color[0] - beforeStep) / (1 - beforeStep);
  assert.ok(Math.abs(share - TEMPORAL_DEFAULTS.minimumWeight) < 1e-4, `a long history takes ${TEMPORAL_DEFAULTS.minimumWeight} of the new frame, got ${share}`);
});

// These frames are 32 pixels wide, so a move of whole pixels turns the view by more than a film frame ever does.
const WIDE_VIEW_AGREEMENT = 0.5;

test('a camera that moves sideways finds each surface point where it was in the frame before', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, viewAgreement: WIDE_VIEW_AGREEMENT });
  accumulator.accumulate({ ...wallFrame([0, 0, 0]), kernelParams: paramsForCamera([0, 0, 0]) });
  // Three pixels right and two up on the wall, so every point that was on screen sat on a pixel centre.
  const moved = wallFrame([0.75, 0.5, 0]);
  const result = accumulator.accumulate({ ...moved, kernelParams: paramsForCamera([0.75, 0.5, 0]) });
  assert.equal(result.restarted, null);
  assert.equal(result.historyShare, ((WIDTH - 3) * (HEIGHT - 2)) / PIXEL_COUNT, 'three columns and two rows were off screen before');
  // The wall's colour is linear in its place, so history fetched at the right place equals the new frame exactly.
  assert.ok(maximumDifference(result.color, moved.color) < 1e-5);
});

test('a camera that moves forward and a shifted lens reproject as the kernel casts its rays', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, viewAgreement: WIDE_VIEW_AGREEMENT });
  const lensShift = [0.1, -0.05];
  accumulator.accumulate({ ...wallFrame([0, 0, 0], { lensShift }), kernelParams: paramsForCamera([0, 0, 0], { lensShift }) });
  const moved = wallFrame([0.1, 0, -1], { lensShift });
  const result = accumulator.accumulate({ ...moved, kernelParams: paramsForCamera([0.1, 0, -1], { lensShift }) });
  assert.equal(result.historyShare, 1, 'moving closer keeps every point on screen');
  assert.ok(maximumDifference(result.color, moved.color) < 1e-5);
});

test('history fetched at the wrong place would show: a still wall under a moved camera without reprojection differs', () => {
  const first = wallFrame([0, 0, 0]);
  // Three pixels right and two up on the wall, so every point that was on screen sat on a pixel centre.
  const moved = wallFrame([0.75, 0.5, 0]);
  assert.ok(maximumDifference(first.color, moved.color) > 0.01, 'the two frames differ pixel for pixel, so the test above proves the reprojection');
});

test('a surface seen from another side than in the frame before starts again', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0, 0, 0]) });
  // 0.25 to the side of a wall 5 away turns the view by under 3 degrees, 0.75 by more than 8.
  const smallStep = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0.25, 0, 0]) });
  assert.ok(smallStep.historyShare > 0.9, `a small step keeps the history, got ${smallStep.historyShare}`);
  const cut = accumulator.accumulate({ ...flatFrame(0.25), kernelParams: paramsForCamera([1, 0, 0]) });
  assert.equal(cut.restarted, null);
  assert.ok(cut.historyShare < 0.1, `only points far to the side were seen from nearly the same direction, got ${cut.historyShare}`);
  const centrePixel = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  assert.equal(cut.color[centrePixel * 3], 0.25, 'the middle of the picture keeps no light gathered from another side');
});

test('a pixel that shows another surface than the frame before starts again', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const next = flatFrame(0);
  const nearerPixel = 5 * WIDTH + 7;
  const turnedPixel = 9 * WIDTH + 11;
  const missedPixel = 12 * WIDTH + 3;
  next.depth[nearerPixel] *= 0.5;
  next.normal.set([1, 0, 0], turnedPixel * 3);
  next.depth[missedPixel] = 0;
  const result = accumulator.accumulate({ ...next, kernelParams });
  assert.equal(result.color[nearerPixel * 3], 0, 'a nearer surface has no history');
  assert.equal(result.color[turnedPixel * 3], 0, 'a surface facing another way has no history');
  assert.equal(result.color[missedPixel * 3], 0, 'a ray that hit nothing has no history');
  assert.ok(Math.abs(result.color[0] - 0.5) < 1e-6, 'the other pixels blend');
  assert.equal(result.historyShare, (PIXEL_COUNT - 3) / PIXEL_COUNT);
});

test('the whole image starts again when the scene, the light or the render settings changed', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const changedScene = accumulator.accumulate({ ...flatFrame(0), kernelParams, sceneChanged: true });
  assert.equal(changedScene.restarted, 'the scene changed since the frame before');
  assert.equal(changedScene.color[0], 0);
  const brighter = accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0, 0, 0], { exposure: 2 }) });
  assert.equal(brighter.restarted, 'the light or the render settings changed since the frame before');
  assert.equal(brighter.color[0], 1);
  const orthographic = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0, 0, 0], { exposure: 2, orthographic: true }) });
  assert.equal(orthographic.restarted, 'an orthographic camera is not reprojected');
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  accumulator.restart('a new shot began');
  const afterCut = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  assert.equal(afterCut.restarted, 'a new shot began');
  assert.equal(afterCut.color[0], 0);
});

test('onlyCameraDiffers ignores the camera, the seed and the tile origin and nothing else', () => {
  const base = paramsForCamera([0, 0, 0]);
  assert.equal(onlyCameraDiffers(base, paramsForCamera([4, 5, 6], { seed: 99, lensShift: [0.2, 0.1], orthographic: true })), true);
  const otherTile = Uint8Array.from(base);
  otherTile[312] = 7;
  assert.equal(onlyCameraDiffers(base, otherTile), true);
  const otherFlag = Uint8Array.from(base);
  otherFlag[KERNEL_FLAGS_BYTE] |= 2;
  assert.equal(onlyCameraDiffers(base, otherFlag), false);
  const otherBounces = Uint8Array.from(base);
  otherBounces[48] = 3;
  assert.equal(onlyCameraDiffers(base, otherBounces), false);
});

test('readCameraView reads the camera the kernel reads', () => {
  const camera = readCameraView(paramsForCamera([1, 2, 3], { lensShift: [0.25, -0.5] }));
  assert.deepEqual(camera.position, [1, 2, 3]);
  assert.deepEqual(camera.forward, [0, 0, -1]);
  assert.ok(Math.abs(camera.rightSquaredLength - HALF_WIDTH * HALF_WIDTH) < 1e-6);
  assert.deepEqual(camera.lensShift, [0.25, -0.5]);
  assert.equal(camera.orthographic, false);
});

test('wrong input is refused with what to pass instead', () => {
  assert.throws(() => createTemporalAccumulator({ width: 0, height: 4 }), /`width` and `height` must be whole numbers of at least 1/);
  assert.throws(() => createTemporalAccumulator({ width: 4, height: 4, minimumWeight: 0 }), /`minimumWeight` must be a number above 0 and at most 1/);
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const frame = wallFrame([0, 0, 0]);
  assert.throws(() => accumulator.accumulate({ ...frame, color: new Float32Array(4), kernelParams: paramsForCamera([0, 0, 0]) }), /`color` must be a Float32Array of 1920 floats \(3 per pixel\)/);
  assert.throws(() => accumulator.accumulate({ ...frame, kernelParams: new Uint8Array(16) }), /`kernelParams` must be the 320 byte FORMAT-v2 block/);
});

test('each frame of a blended job gets its own seed, and the switch reads the environment', () => {
  assert.equal(temporalFrameSeed(7, 0), 7);
  assert.equal(temporalFrameSeed(7, 5), 12);
  assert.equal(temporalFrameSeed(undefined, 3), 3);
  assert.equal(temporalFrameSeed(4294967295, 2), 1);
  assert.equal(chooseNativeTemporal({}), true);
  assert.equal(chooseNativeTemporal({ JS67_NATIVE_TEMPORAL: 'off' }), false);
});
