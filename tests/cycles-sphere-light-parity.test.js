import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildNativeInput, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;
const SIZE = 16;
const FLOOR_ALBEDO = 0.8;
const LAMP_HEIGHT = 2;
const LAMP_INTENSITY = 8;
const CAMERA_HEIGHT = 6;
const CAMERA_FIELD_OF_VIEW_DEGREES = 30;
const PATCH_SIDE = 4;
const cameraDescription = { eye: [0, CAMERA_HEIGHT, 0], target: [0, 0, 0], up: [0, 0, -1], fov: CAMERA_FIELD_OF_VIEW_DEGREES };

function floorPart() {
  const matrix = new Float32Array([20, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 20, 0, 0, -0.05, 0, 1]);
  const material = { tag: 'surface', metallic: 0, roughness: 1, specular: 0, emission: 0, color: [FLOOR_ALBEDO, FLOOR_ALBEDO, FLOOR_ALBEDO] };
  return { name: 'floor', geometry: box(0, 1), matrix, material };
}

function renderFloorUnderLamp(radius) {
  const environment = {
    keyColor: [0, 0, 0],
    lightDirection: [0, 1, 0],
    ambientIntensity: 0,
    fillIntensity: 0,
    pointLights: [{ position: [0, LAMP_HEIGHT, 0], color: [1, 1, 1], intensity: LAMP_INTENSITY, radius, castShadow: true }],
  };
  const scene = buildTraceScene([floorPart()], environment);
  const camera = createCamera(cameraDescription, SIZE, SIZE);
  const input = buildNativeInput(scene, camera, { width: SIZE, height: SIZE, samples: 256, bounces: 2, seed: 1 }, pack);
  return traceNative(input, { width: SIZE, height: SIZE, samples: 256, bounces: 2, kernel: 'cycles' }).rgba;
}

function centreRadiance(rgba) {
  let sum = 0;
  const first = (SIZE - PATCH_SIDE) / 2;
  for (let row = first; row < first + PATCH_SIDE; row++) {
    for (let column = first; column < first + PATCH_SIDE; column++) {
      sum += rgba[(row * SIZE + column) * 4 + 1];
    }
  }
  return sum / (PATCH_SIDE * PATCH_SIDE);
}

// Where the centre of a pixel column or row lands on the floor, in metres from the point under the lamp.
function floorOffsetOfPixel(pixelIndex) {
  const halfExtent = CAMERA_HEIGHT * Math.tan((CAMERA_FIELD_OF_VIEW_DEGREES * Math.PI) / 360);
  return (((pixelIndex + 0.5) / SIZE) * 2 - 1) * halfExtent;
}

// A sphere light of intensity I lights a diffuse floor point at a horizontal distance s, with every part of the sphere above
// the floor, with I * h / (h^2 + s^2)^(3/2), whatever its radius: the power stays fixed as the radius grows. The pixels the
// test averages reach about 0.5 m from the point under the lamp, where the floor is a few percent darker than at that point.
function closedFormCentreRadiance() {
  let sum = 0;
  const first = (SIZE - PATCH_SIDE) / 2;
  for (let row = first; row < first + PATCH_SIDE; row++) {
    for (let column = first; column < first + PATCH_SIDE; column++) {
      const distanceSquared = LAMP_HEIGHT * LAMP_HEIGHT + floorOffsetOfPixel(row) ** 2 + floorOffsetOfPixel(column) ** 2;
      sum += ((FLOOR_ALBEDO / Math.PI) * LAMP_INTENSITY * LAMP_HEIGHT) / distanceSquared ** 1.5;
    }
  }
  return sum / (PATCH_SIDE * PATCH_SIDE);
}

test('the Cycles reference script renders point and spot lights as spheres unless asked otherwise', () => {
  const source = readFileSync(new URL('../bench/cycles-parity/render-cycles.py', import.meta.url), 'utf8');
  assert.match(source, /read_flag_value\(argument_list, "--soft-falloff", "off"\)/, 'the default turns Light.use_soft_falloff off');
  assert.match(source, /light_data\.use_soft_falloff = soft_falloff_setting/, 'the setting reaches the light');
  const callCount = source.split('apply_soft_falloff_setting(').length - 1;
  assert.equal(callCount, 3, 'the definition and one call each for point lights and spot lights');
});

for (const radius of [0, 0.18, 0.5]) {
  test(`the native cycles kernel keeps the power of a point light of radius ${radius} m`, { skip: skipWithoutAddon }, () => {
    const expected = closedFormCentreRadiance();
    const measured = centreRadiance(renderFloorUnderLamp(radius));
    assert.ok(Math.abs(measured / expected - 1) < 0.03, `floor radiance ${measured} against the closed form ${expected}`);
  });
}

// Boxes of the lamp scenes that overlap or share a coplanar front face made Cook and Cycles disagree by a column of pixels
// on the shade (#1070), so the scenes must be made of boxes that only touch.
function boxBounds(part) {
  const matrix = part.matrix;
  return [0, 1, 2].map((axis) => ({ low: matrix[12 + axis] - matrix[axis * 5] / 2, high: matrix[12 + axis] + matrix[axis * 5] / 2 }));
}

function boxesOverlapInVolume(firstBounds, secondBounds) {
  const overlapPerAxis = [0, 1, 2].map((axis) => Math.min(firstBounds[axis].high, secondBounds[axis].high) - Math.max(firstBounds[axis].low, secondBounds[axis].low));
  return overlapPerAxis.every((overlap) => overlap > 1e-9);
}

test('the shade of the lamp scenes is built from boxes that do not overlap', () => {
  const workDirectory = mkdtempSync(join(tmpdir(), 'sphere-light-scenes-'));
  try {
    const baseScenePath = join(workDirectory, 'base.json');
    const roomParts = Array.from({ length: 5 }, (_, index) => ({ name: `room-${index}`, geometry: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100 * index, 0, 0, 1], material: 0 }));
    writeFileSync(baseScenePath, JSON.stringify({ id: 'base', parts: roomParts, environment: {} }));
    execFileSync('node', [fileURLToPath(new URL('../bench/cycles-parity/make-sphere-light-scenes.mjs', import.meta.url)), baseScenePath, workDirectory], { stdio: 'ignore' });
    for (const sceneName of ['enclosed-r0.18', 'enclosed-hidden-r0.18', 'poking-r0.18', 'poking-hidden-r0.18']) {
      const scene = JSON.parse(readFileSync(join(workDirectory, 'scenes', `${sceneName}.json`), 'utf8'));
      const shadeParts = scene.parts.filter((part) => part.name.startsWith('shade-'));
      assert.equal(shadeParts.length, 5, `${sceneName} has a lid and four walls`);
      for (let first = 0; first < shadeParts.length; first++) {
        for (let second = first + 1; second < shadeParts.length; second++) {
          const overlaps = boxesOverlapInVolume(boxBounds(shadeParts[first]), boxBounds(shadeParts[second]));
          assert.equal(overlaps, false, `${sceneName}: ${shadeParts[first].name} and ${shadeParts[second].name} overlap`);
        }
      }
    }
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
});
