import assert from 'node:assert/strict';
import test from 'node:test';

import { STRUCT_STRIDES_V2, buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { box } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/hdri.js';
import { createCamera, describeIgnoredFeatures } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const hasAddon = findNativeAddon() !== null;
const skipWithoutAddon = hasAddon ? false : 'the native addon is not built';

const LIGHT_FLAG_PORTAL = 8;
const LIGHT_FLAG_WORD_INDEX = 7;
const PORTAL_COUNT_PARAM_WORD = 76;
const SEEDS = [1, 2, 3, 4];

// The room is 4 wide, 3 high and 4 deep, its walls are 0.2 thick slabs, and its west wall has a window 2 wide and 1 high.
function slab(centerX, centerY, centerZ, sizeX, sizeY, sizeZ) {
  const matrix = new Float32Array([sizeX, 0, 0, 0, 0, sizeY, 0, 0, 0, 0, sizeZ, 0, centerX, centerY, centerZ, 1]);
  return { name: 'wall', geometry: box(0, 1), matrix, material: { color: [0.7, 0.7, 0.7] } };
}

function roomParts({ withCeiling, withOutsideBox }) {
  const parts = [
    slab(0, -0.1, 0, 4.8, 0.2, 4.8),
    slab(0, 0, -2.1, 4.8, 6, 0.2),
    slab(0, 0, 2.1, 4.8, 6, 0.2),
    slab(2.1, 0, 0, 0.2, 6, 4.8),
    slab(-2.1, 0.5, 0, 0.2, 1, 4),
    slab(-2.1, 2.5, 0, 0.2, 1, 4),
    slab(-2.1, 1.5, -1.5, 0.2, 1, 1),
    slab(-2.1, 1.5, 1.5, 0.2, 1, 1),
  ];
  if (withCeiling) parts.push(slab(0, 3.1, 0, 4.8, 0.2, 4.8));
  if (withOutsideBox) parts.push(slab(-5, 0.75, 0, 1.5, 1.5, 1.5));
  return parts;
}

function skyMap() {
  const width = 32;
  const height = 16;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const radiance = row < height / 2 ? 4 : 0.5;
    for (let column = 0; column < width; column++) data.fill(radiance, (row * width + column) * 3, (row * width + column) * 3 + 3);
  }
  return createEnvironmentMap({ width, height, data, intensity: 1 });
}

// Faces into the room (+x) and covers the window exactly, on the wall's inner plane.
const WINDOW_PORTAL = { position: [-2, 1.5, 0], direction: [1, 0, 0], up: [0, 1, 0], width: 2, height: 1, portal: true };

function buildRoomScene({ withPortal, withCeiling = true, withOutsideBox = false }) {
  const environment = { map: skyMap(), areaLights: withPortal ? [WINDOW_PORTAL] : [] };
  return buildTraceScene(roomParts({ withCeiling, withOutsideBox }), environment);
}

const ROOM_CAMERA = { eye: [1.6, 1.4, 1.7], target: [-1, 1, -0.6], fov: 70 };

function trace(scene, options) {
  const camera = createCamera(ROOM_CAMERA, options.width, options.height);
  const input = buildNativeInputV2(scene, camera, options);
  return traceNative(input, { ...options, kernel: 'cycles' });
}

function meanRgb(rgba) {
  const sum = [0, 0, 0];
  const pixelCount = rgba.length / 4;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) sum[channel] += rgba[pixel * 4 + channel];
  }
  return sum.map(value => value / pixelCount);
}

// Mean absolute difference per colour value, over every pair of the frames.
function meanSeedDifference(frames) {
  let total = 0;
  let count = 0;
  for (let first = 0; first < frames.length; first++) {
    for (let second = first + 1; second < frames.length; second++) {
      for (let index = 0; index < frames[first].length; index++) {
        if (index % 4 === 3) continue;
        total += Math.abs(frames[first][index] - frames[second][index]);
        count += 1;
      }
    }
  }
  return total / count;
}

function packRoom(areaLights) {
  const scene = buildTraceScene(roomParts({ withCeiling: true, withOutsideBox: false }), { map: skyMap(), areaLights });
  return buildNativeInputV2(scene, createCamera(ROOM_CAMERA, 8, 8), { width: 8, height: 8, samples: 1 });
}

function lightRecordWords(packed, index) {
  return new Uint32Array(packed.lights.buffer, packed.lights.byteOffset + index * STRUCT_STRIDES_V2.light, STRUCT_STRIDES_V2.light / 4);
}

test('buildTraceScene keeps a portal out of the emitting area lights and carries its rectangle', () => {
  const emitter = { position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 5 };
  const { areas, portals } = buildTraceScene(roomParts({ withCeiling: false, withOutsideBox: false }), { areaLights: [emitter, WINDOW_PORTAL] }).lights;
  assert.equal(areas.length, 1);
  assert.equal(portals.length, 1);
  assert.deepEqual(portals[0].position, [-2, 1.5, 0]);
  assert.deepEqual(portals[0].normal, [1, 0, 0]);
  assert.equal(portals[0].width, 2);
  assert.equal(portals[0].height, 1);
  assert.equal(portals[0].intensity, undefined, 'a portal has no power');
});

test('a portal must be a rect light with a size, and says what to pass instead', () => {
  assert.throws(
    () => buildTraceScene(roomParts({ withCeiling: false, withOutsideBox: false }), { areaLights: [{ ...WINDOW_PORTAL, shape: 'disk' }] }),
    /environment\.areaLights\[0\]\.portal is only supported on a rect area light, got shape "disk"/
  );
  assert.throws(
    () => buildTraceScene(roomParts({ withCeiling: false, withOutsideBox: false }), { areaLights: [{ ...WINDOW_PORTAL, width: 0 }] }),
    /portal needs a width above 0/
  );
});

test('the v2 packer appends a portal record after the emitters and counts it apart', () => {
  const emitter = { position: [0, 2.9, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 5 };
  const packed = packRoom([WINDOW_PORTAL, emitter]);
  assert.equal(packed.lightCount, 1, 'the portal is not an emitter');
  assert.equal(packed.portalCount, 1);
  assert.equal(new Uint32Array(packed.kernelParams.buffer, packed.kernelParams.byteOffset)[PORTAL_COUNT_PARAM_WORD], 1);
  assert.equal(packed.lightTreeEmitterCount, 1, 'the light tree holds the emitter only');
  assert.equal(lightRecordWords(packed, 0)[LIGHT_FLAG_WORD_INDEX] & LIGHT_FLAG_PORTAL, 0);
  const portalRecord = lightRecordWords(packed, 1);
  assert.equal(portalRecord[LIGHT_FLAG_WORD_INDEX], LIGHT_FLAG_PORTAL);
  assert.deepEqual(Array.from(new Float32Array(portalRecord.buffer, portalRecord.byteOffset, 3)), [-2, 1.5, 0]);
  assert.deepEqual(Array.from(new Float32Array(portalRecord.buffer, portalRecord.byteOffset + 16, 3)), [0, 0, 0], 'radiance');
});

test('a scene with only a portal has no emitters and no light tree', () => {
  const packed = packRoom([WINDOW_PORTAL]);
  assert.equal(packed.lightCount, 0);
  assert.equal(packed.portalCount, 1);
  assert.equal(packed.lightTreeNodeCount, 0);
  assert.equal(lightRecordWords(packed, 0)[LIGHT_FLAG_WORD_INDEX], LIGHT_FLAG_PORTAL);
});

test('the v2 packer rejects a disk portal', () => {
  const scene = buildTraceScene(roomParts({ withCeiling: false, withOutsideBox: false }), {});
  scene.lights.areas.push({ bit: 26, shape: 'disk', portal: true, position: [0, 1, 0], normal: [1, 0, 0], width: 1, height: 1 });
  assert.throws(() => buildNativeInputV2(scene, createCamera(ROOM_CAMERA, 8, 8), { width: 8, height: 8, samples: 1 }), /needs a rect light/);
});

test('the CPU and WebGL tracers are told that a portal draws nothing, the native kernel is not', () => {
  const environment = { areaLights: [WINDOW_PORTAL] };
  assert.match(describeIgnoredFeatures([], environment, 'cpu').join(' '), /Light portals .* are ignored/);
  assert.doesNotMatch(describeIgnoredFeatures([], environment, 'native', { kernelMaterials: true }).join(' '), /portal/);
  assert.doesNotMatch(describeIgnoredFeatures([], { areaLights: [] }, 'cpu').join(' '), /portal/);
});

test('a portal keeps the mean of a room lit through a window', { skip: skipWithoutAddon }, t => {
  const common = { width: 48, height: 32, samples: 2048, samplesPerDispatch: 64, seed: 7 };
  const without = meanRgb(trace(buildRoomScene({ withPortal: false }), common).rgba);
  const withPortal = meanRgb(trace(buildRoomScene({ withPortal: true }), common).rgba);
  t.diagnostic(`mean ${withPortal.map((value, channel) => (value / without[channel]).toFixed(4)).join(' ')} (portal over no portal, per channel)`);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(without[channel] > 0.05, `channel ${channel} is lit`);
    assert.ok(Math.abs(withPortal[channel] / without[channel] - 1) < 0.01, `channel ${channel}: ${withPortal[channel]} with a portal against ${without[channel]} without`);
  }
});

test('a portal cuts the change between seeds of a frozen camera by at least 4 times', { skip: skipWithoutAddon }, t => {
  const common = { width: 48, height: 32, samples: 64, samplesPerDispatch: 64 };
  const framesOf = withPortal => SEEDS.map(seed => trace(buildRoomScene({ withPortal }), { ...common, seed }).rgba);
  const differenceWithout = meanSeedDifference(framesOf(false));
  const differenceWith = meanSeedDifference(framesOf(true));
  const ratio = differenceWithout / differenceWith;
  t.diagnostic(`mean seed difference ${differenceWithout.toFixed(5)} without, ${differenceWith.toFixed(5)} with a portal, ratio ${ratio.toFixed(2)}`);
  assert.ok(ratio >= 4, `seed difference fell ${ratio.toFixed(2)} times (${differenceWithout} to ${differenceWith})`);
});

test('a portal does not darken sky seen directly or an object outside the window', { skip: skipWithoutAddon }, t => {
  const common = { width: 48, height: 32, samples: 2048, samplesPerDispatch: 64, seed: 11 };
  const without = meanRgb(trace(buildRoomScene({ withPortal: false, withCeiling: false, withOutsideBox: true }), common).rgba);
  const withPortal = meanRgb(trace(buildRoomScene({ withPortal: true, withCeiling: false, withOutsideBox: true }), common).rgba);
  t.diagnostic(`open scene mean ${withPortal.map((value, channel) => (value / without[channel]).toFixed(4)).join(' ')} (portal over no portal, per channel)`);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(withPortal[channel] / without[channel] - 1) < 0.015, `channel ${channel}: ${withPortal[channel]} with a portal against ${without[channel]} without`);
  }
});
