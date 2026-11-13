import assert from 'node:assert/strict';
import test from 'node:test';
import { findNativeAddon, prepareCyclesInput, traceNative } from '../packages/render-native/index.mjs';
import { buildFlattenedJobNativeInput } from '../packages/render-native/job-input.mjs';
import { createCamera, describeIgnoredFeatures } from '../src/path-tracer.js';
import { BACK, ROOM_CAMERA, WINDOW, roomParts, skyMap, sphereParts, uniformSkyMap } from './helpers/camera-environment-scenes.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;

// `camera_env_color` (bytes 304 to 315) and `camera_env_enabled` (316) of KernelParamsV2.
const CAMERA_ENV_COLOR_BYTE_OFFSET = 304;
const CAMERA_ENV_ENABLED_BYTE_OFFSET = 316;
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
  return bytesOf(input.kernelParams).subarray(CAMERA_ENV_COLOR_BYTE_OFFSET, PARAMS_TAIL_END);
}

function tailFloats(input) {
  const tail = Uint8Array.from(paramsTail(input));
  const view = new DataView(tail.buffer);
  return { color: [0, 4, 8].map(offset => view.getFloat32(offset, true)), enabled: view.getUint32(12, true) };
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

test('the packed words hold the camera strength, and only they differ from a pack without the field', () => {
  const camera = cameraFor(ROOM_CAMERA);
  const plain = jobInputOf(roomParts(1), { map: skyMap(1) }, camera);
  const withField = jobInputOf(roomParts(1), { map: skyMap(1), cameraIntensity: 0.2 }, camera);
  const absentBytes = bytesOf(plain.kernelParams);
  assert.deepEqual(tailFloats(plain), { color: [0, 0, 0], enabled: 0 }, 'a scene without the field leaves the tail zero');
  const fieldBytes = bytesOf(withField.kernelParams);
  assert.equal(Buffer.compare(absentBytes.subarray(0, CAMERA_ENV_COLOR_BYTE_OFFSET), fieldBytes.subarray(0, CAMERA_ENV_COLOR_BYTE_OFFSET)), 0, 'no earlier word moves');
  const packed = tailFloats(withField);
  assert.equal(packed.enabled, 1);
  assert.deepEqual(packed.color, [0.2, 0.2, 0.2].map(Math.fround));
  assert.equal(Buffer.compare(bytesOf(plain.instances), bytesOf(withField.instances)), 0);
  assert.equal(Buffer.compare(bytesOf(plain.materials), bytesOf(withField.materials)), 0);
  assert.equal(Buffer.compare(bytesOf(plain.environmentTexels), bytesOf(withField.environmentTexels)), 0, 'the map and its tables are the same');
  assert.equal(fieldBytes.readUInt32LE(CAMERA_ENV_ENABLED_BYTE_OFFSET), 1);
});

test('the strength is absolute, in the units of the map intensity, also with a dark or black lighting intensity', () => {
  const camera = cameraFor(ROOM_CAMERA);
  const brighter = tailFloats(jobInputOf(roomParts(1), { map: skyMap(2), cameraIntensity: 0.5 }, camera));
  assert.deepEqual(brighter.color, [0.5, 0.5, 0.5]);
  const lightingOff = tailFloats(jobInputOf(roomParts(1), { map: skyMap(0), cameraIntensity: 0.3 }, camera));
  assert.deepEqual(lightingOff.color, [0.3, 0.3, 0.3].map(Math.fround));
  assert.equal(lightingOff.enabled, 1);
  const black = tailFloats(jobInputOf(roomParts(1), { map: skyMap(1), cameraIntensity: 0 }, camera));
  assert.deepEqual(black, { color: [0, 0, 0], enabled: 1 }, 'zero is a black view, not "absent"');
  const equal = tailFloats(jobInputOf(roomParts(1), { map: skyMap(1.5), cameraIntensity: 1.5 }, camera));
  assert.deepEqual(equal.color, [1.5, 1.5, 1.5]);
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

test('a window drawn at 0.2 leaves every pixel that does not see the sky through the glass byte for byte', { skip: skipWithoutAddon, timeout: 600000 }, () => {
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
});

test('an open scene scales the sky pixels by the factor and leaves the object pixels byte for byte', { skip: skipWithoutAddon, timeout: 600000 }, () => {
  const camera = cameraFor({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 30 });
  const samples = 64;
  const reference = traceOf(sphereParts(), { map: uniformSkyMap(1) }, camera, samples);
  const halved = traceOf(sphereParts(), { map: uniformSkyMap(1), cameraIntensity: 0.5 }, camera, samples);
  const centreDistance = (row, column) => Math.hypot(row + 0.5 - SIZE / 2, column + 0.5 - SIZE / 2);
  const objectPixels = pixelsEqual(reference, halved, (row, column) => centreDistance(row, column) < 0.8 * SIZE * 0.19);
  assert.ok(objectPixels > 200, `object pixels compared: ${objectPixels}`);
  let skyPixels = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      if (centreDistance(row, column) < SIZE * 0.3) continue;
      const base = pixelIndex(row, column);
      for (let channel = 0; channel < 3; channel++) {
        const expected = reference[base + channel] * 0.5;
        assert.ok(Math.abs(halved[base + channel] - expected) <= 1e-5 * Math.max(1, expected), `sky pixel row ${row} column ${column}`);
      }
      skyPixels++;
    }
  }
  assert.ok(skyPixels > 5000, `sky pixels compared: ${skyPixels}`);
});

test('a camera strength equal to the lighting intensity is the same image as leaving the field out', { skip: skipWithoutAddon, timeout: 600000 }, () => {
  const camera = cameraFor(ROOM_CAMERA);
  const samples = 32;
  const reference = traceOf(roomParts(1.45), { map: skyMap(1.5) }, camera, samples);
  const equal = traceOf(roomParts(1.45), { map: skyMap(1.5), cameraIntensity: 1.5 }, camera, samples);
  assert.equal(Buffer.compare(Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength), Buffer.from(equal.buffer, equal.byteOffset, equal.byteLength)), 0);
});
