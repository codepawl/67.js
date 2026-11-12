import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
const cameraDescription = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };

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
  const first = SIZE / 2 - 2;
  for (let row = first; row < first + 4; row++) {
    for (let column = first; column < first + 4; column++) {
      sum += rgba[(row * SIZE + column) * 4 + 1];
    }
  }
  return sum / 16;
}

test('the Cycles reference script renders point and spot lights as spheres unless asked otherwise', () => {
  const source = readFileSync(new URL('../bench/cycles-parity/render-cycles.py', import.meta.url), 'utf8');
  assert.match(source, /read_flag_value\(argument_list, "--soft-falloff", "off"\)/, 'the default turns Light.use_soft_falloff off');
  assert.match(source, /light_data\.use_soft_falloff = soft_falloff_setting/, 'the setting reaches the light');
  const callCount = source.split('apply_soft_falloff_setting(').length - 1;
  assert.equal(callCount, 3, 'the definition and one call each for point lights and spot lights');
});

// A sphere light of intensity I seen from a distance d beyond its radius lights a facing diffuse surface with I / d^2, whatever
// its radius, so the floor under the lamp is albedo / pi * I / d^2 for every radius (power stays fixed as the radius grows).
for (const radius of [0, 0.18, 0.5]) {
  test(`the native cycles kernel keeps the power of a point light of radius ${radius} m`, { skip: skipWithoutAddon }, () => {
    const expected = (FLOOR_ALBEDO / Math.PI) * (LAMP_INTENSITY / (LAMP_HEIGHT * LAMP_HEIGHT));
    const measured = centreRadiance(renderFloorUnderLamp(radius));
    assert.ok(Math.abs(measured / expected - 1) < 0.03, `floor radiance ${measured} against the closed form ${expected}`);
  });
}
