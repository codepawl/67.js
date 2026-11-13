import assert from 'node:assert/strict';
import test from 'node:test';
import { findNativeAddon, prepareCyclesInput, traceNative } from '../packages/render-native/index.mjs';
import { buildFlattenedJobNativeInput } from '../packages/render-native/job-input.mjs';
import { createCamera, describeIgnoredFeatures } from '../src/path-tracer.js';
import { BACK, ROOM_CAMERA, WINDOW, roomParts, skyMap, sphereParts, uniformSkyMap } from './helpers/camera-environment-scenes.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;

// `camera_env_scale` (byte 304) of KernelParamsV2; bytes 308 to 319 stay reserved and zero.
const CAMERA_ENV_SCALE_BYTE_OFFSET = 304;
const PARAMS_TAIL_END = 320;

const SIZE = 128;
function cameraFor(description) {
  return createCamera(description, SIZE, SIZE);
}

function packOptions(samples) {
  return { width: SIZE, height: SIZE, samples, bounces: 4, seed: 11, fireflyClamp: 0, noiseThreshold: 0 };
}

function jobInputOf(parts, environment, camera, samples = 4) {
  const scene = buildTraceScene(parts, environment);
  return buildFlattenedJobNativeInput(scene, camera, packOptions(samples), pack, resolveTexture);
}

function traceOf(parts, environment, camera, samples) {
  const input = jobInputOf(parts, environment, camera, samples);
  const options = { width: SIZE, height: SIZE, samples, maxSeconds: 120, kernel: 'cycles', noiseThreshold: 0 };
  return traceNative(prepareCyclesInput(input, options), options).rgba;
}

function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function paramsTail(input) {
  return bytesOf(input.kernelParams).subarray(CAMERA_ENV_SCALE_BYTE_OFFSET, PARAMS_TAIL_END);
}

function scaleWord(input) {
  return bytesOf(input.kernelParams).readUInt32LE(CAMERA_ENV_SCALE_BYTE_OFFSET);
}

function scaleValue(input) {
  return bytesOf(input.kernelParams).readFloatLE(CAMERA_ENV_SCALE_BYTE_OFFSET);
}

function reservedBytes(input) {
  return bytesOf(input.kernelParams).subarray(CAMERA_ENV_SCALE_BYTE_OFFSET + 4, PARAMS_TAIL_END);
}

function pixelOfWindowCorner(x, y) {
  const distance = ROOM_CAMERA.eye[2] - BACK;
  const halfExtent = distance * Math.tan((ROOM_CAMERA.fov * Math.PI) / 360);
  return { column: SIZE / 2 + (x / halfExtent) * (SIZE / 2), row: SIZE / 2 - (y / halfExtent) * (SIZE / 2) };
}

function windowPixelBox(margin) {
  const lowerLeft = pixelOfWindowCorner(WINDOW.left, WINDOW.bottom);
  const upperRight = pixelOfWindowCorner(WINDOW.right, WINDOW.top);
  return {
    columnStart: Math.ceil(lowerLeft.column + margin),
    columnStop: Math.floor(upperRight.column - margin),
    rowStart: Math.ceil(upperRight.row + margin),
    rowStop: Math.floor(lowerLeft.row - margin),
  };
}

function pixelIndex(row, column) {
  return (row * SIZE + column) * 4;
}

function insideBox(box, row, column) {
  return column >= box.columnStart && column < box.columnStop && row >= box.rowStart && row < box.rowStop;
}

function meanOver(rgba, isIncluded) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      if (!isIncluded(row, column)) continue;
      for (let channel = 0; channel < 3; channel++) sum[channel] += rgba[pixelIndex(row, column) + channel];
      count++;
    }
  }
  return { mean: sum.map(value => value / count), count };
}

function pixelsEqual(first, second, isIncluded) {
  let count = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      if (!isIncluded(row, column)) continue;
      const base = pixelIndex(row, column);
      for (let channel = 0; channel < 4; channel++) {
        assert.equal(first[base + channel], second[base + channel], `pixel row ${row} column ${column} channel ${channel}`);
      }
      count++;
    }
  }
  return count;
}

test('cameraIntensity is carried to the trace scene and stays out of a scene that does not set it', () => {
  const map = skyMap(1);
  assert.equal('cameraIntensity' in buildTraceScene(roomParts(1), { map }).environment, false);
  assert.equal(buildTraceScene(roomParts(1), { map, cameraIntensity: 0.2 }).environment.cameraIntensity, 0.2);
  assert.equal(buildTraceScene(roomParts(1), { map, cameraIntensity: 0 }).environment.cameraIntensity, 0);
});

test('cameraIntensity is checked at the public boundary and the error says what to pass', () => {
  const map = skyMap(1);
  for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.2', null]) {
    assert.throws(() => buildTraceScene(roomParts(1), { map, cameraIntensity: bad }), /environment\.cameraIntensity must be a finite number of 0 or more/);
  }
  assert.throws(() => buildTraceScene(roomParts(1), { cameraIntensity: 0.2 }), /environment\.cameraIntensity needs environment\.map/);
});

test('the packed word holds the camera factor, and only it differs from a pack without the field', () => {
  const camera = cameraFor(ROOM_CAMERA);
  const plain = jobInputOf(roomParts(1), { map: skyMap(1) }, camera);
  const withField = jobInputOf(roomParts(1), { map: skyMap(1), cameraIntensity: 0.2 }, camera);
  assert.equal(scaleWord(plain), 0, 'a scene without the field leaves the word zero');
  assert.equal(bytesOf(plain.kernelParams).length, 320);
  const absentBytes = bytesOf(plain.kernelParams);
  const fieldBytes = bytesOf(withField.kernelParams);
  assert.equal(Buffer.compare(absentBytes.subarray(0, CAMERA_ENV_SCALE_BYTE_OFFSET), fieldBytes.subarray(0, CAMERA_ENV_SCALE_BYTE_OFFSET)), 0, 'no earlier word moves');
  assert.equal(scaleValue(withField), Math.fround(0.2));
  assert.deepEqual([...reservedBytes(withField)], new Array(12).fill(0), 'bytes 308 to 319 stay reserved');
  assert.equal(Buffer.compare(bytesOf(plain.instances), bytesOf(withField.instances)), 0);
  assert.equal(Buffer.compare(bytesOf(plain.materials), bytesOf(withField.materials)), 0);
  assert.equal(Buffer.compare(bytesOf(plain.environmentTexels), bytesOf(withField.environmentTexels)), 0, 'the map and its tables are the same');
});

test('the word is the factor on the lighting intensity, a signed zero for a black view, and an absolute strength when the lighting is off', () => {
  const camera = cameraFor(ROOM_CAMERA);
  const brighter = jobInputOf(roomParts(1), { map: skyMap(2), cameraIntensity: 0.5 }, camera);
  assert.equal(scaleValue(brighter), 0.25);
  const black = jobInputOf(roomParts(1), { map: skyMap(1), cameraIntensity: 0 }, camera);
  assert.equal(scaleWord(black), 0x80000000, 'zero is a black view (-0.0), not "absent"');
  const equal = jobInputOf(roomParts(1), { map: skyMap(1.5), cameraIntensity: 1.5 }, camera);
  assert.equal(scaleValue(equal), 1);
  const lightingOff = jobInputOf(roomParts(1), { map: skyMap(0), cameraIntensity: 0.3 }, camera);
  assert.equal(scaleValue(lightingOff), -Math.fround(0.3), 'a negative word is an absolute strength');
  const lightingOffBlack = jobInputOf(roomParts(1), { map: skyMap(0), cameraIntensity: 0 }, camera);
  assert.equal(scaleWord(lightingOffBlack), 0x80000000);
});

test('the CPU, WebGL and WebGPU tracers report that they ignore cameraIntensity; the native cycles kernel does not', () => {
  const environment = { map: skyMap(1), cameraIntensity: 0.2 };
  const parts = roomParts(1);
  for (const backend of ['cpu', 'gpu', 'webgpu']) {
    assert.ok(describeIgnoredFeatures(parts, environment, backend).some(note => note.startsWith('cameraIntensity is ignored')), backend);
  }
  assert.ok(!describeIgnoredFeatures(parts, environment, 'native', { kernelMaterials: true }).some(note => note.includes('cameraIntensity')));
  assert.ok(!describeIgnoredFeatures(parts, { map: skyMap(1) }, 'cpu').some(note => note.includes('cameraIntensity')));
});

test('a window drawn at 0.2 leaves every pixel that does not see the sky through the glass byte for byte', { skip: skipWithoutAddon, timeout: 600000 }, context => {
  const camera = cameraFor(ROOM_CAMERA);
  const samples = 256;
  const reference = traceOf(roomParts(1), { map: skyMap(1) }, camera, samples);
  const dimmed = traceOf(roomParts(1), { map: skyMap(1), cameraIntensity: 0.2 }, camera, samples);

  const guardedBox = windowPixelBox(-4);
  const outsideWindow = (row, column) => !insideBox(guardedBox, row, column);
  const compared = pixelsEqual(reference, dimmed, outsideWindow);
  assert.ok(compared > SIZE * SIZE * 0.5, `a large wall region was compared (${compared} pixels)`);

  const innerBox = windowPixelBox(3);
  const inWindow = (row, column) => insideBox(innerBox, row, column);
  const full = meanOver(reference, inWindow);
  const scaled = meanOver(dimmed, inWindow);
  assert.ok(full.count > 100, `the window region holds pixels (${full.count})`);
  for (let channel = 0; channel < 3; channel++) {
    const ratio = scaled.mean[channel] / full.mean[channel];
    assert.ok(Math.abs(ratio - 0.2) < 0.002, `window mean ratio in channel ${channel} is ${ratio}`);
  }
  context.diagnostic(`byte-identical pixels ${compared}, window pixels ${full.count}, window mean ratio ${scaled.mean.map((value, channel) => value / full.mean[channel])}`);
});

// The ball is about 49 pixels in radius at this size: the object region stays inside it, the sky region outside it.
test('an open scene scales the sky pixels by the factor and leaves the object pixels byte for byte', { skip: skipWithoutAddon, timeout: 600000 }, context => {
  const camera = cameraFor({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 30 });
  const samples = 64;
  const reference = traceOf(sphereParts(), { map: uniformSkyMap(1) }, camera, samples);
  const halved = traceOf(sphereParts(), { map: uniformSkyMap(1), cameraIntensity: 0.5 }, camera, samples);
  const centreDistance = (row, column) => Math.hypot(row + 0.5 - SIZE / 2, column + 0.5 - SIZE / 2);
  const objectPixels = pixelsEqual(reference, halved, (row, column) => centreDistance(row, column) < SIZE * 0.3);
  assert.ok(objectPixels > 200, `object pixels compared: ${objectPixels}`);
  let skyPixels = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      if (centreDistance(row, column) < SIZE * 0.42) continue;
      const base = pixelIndex(row, column);
      for (let channel = 0; channel < 3; channel++) {
        const expected = reference[base + channel] * 0.5;
        assert.ok(Math.abs(halved[base + channel] - expected) <= 1e-5 * Math.max(1, expected), `sky pixel row ${row} column ${column}`);
      }
      skyPixels++;
    }
  }
  assert.ok(skyPixels > 4000, `sky pixels compared: ${skyPixels}`);
  context.diagnostic(`object pixels byte-identical ${objectPixels}, sky pixels at 0.5 of the reference ${skyPixels}`);
});

test('a camera strength equal to the lighting intensity is the same image as leaving the field out', { skip: skipWithoutAddon, timeout: 600000 }, () => {
  const camera = cameraFor(ROOM_CAMERA);
  const samples = 32;
  const reference = traceOf(roomParts(1.45), { map: skyMap(1.5) }, camera, samples);
  const equal = traceOf(roomParts(1.45), { map: skyMap(1.5), cameraIntensity: 1.5 }, camera, samples);
  assert.equal(Buffer.compare(Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength), Buffer.from(equal.buffer, equal.byteOffset, equal.byteLength)), 0);
});
