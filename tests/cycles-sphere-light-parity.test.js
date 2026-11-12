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
const CAMERA_HEIGHT = 6;
const CAMERA_FIELD_OF_VIEW_DEGREES = 30;
const PATCH_SIDE = 4;
const cameraDescription = { eye: [0, CAMERA_HEIGHT, 0], target: [0, 0, 0], up: [0, 0, -1], fov: CAMERA_FIELD_OF_VIEW_DEGREES };

function floorPart() {
  const matrix = new Float32Array([20, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 20, 0, 0, -0.05, 0, 1]);
  const material = { tag: 'surface', metallic: 0, roughness: 1, specular: 0, emission: 0, color: [FLOOR_ALBEDO, FLOOR_ALBEDO, FLOOR_ALBEDO] };
  return { name: 'floor', geometry: box(0, 1), matrix, material };
}

function renderFloorUnderLamp(radius, lampKind = 'point', lampFields = {}) {
  const environment = {
    keyColor: [0, 0, 0],
    lightDirection: [0, 1, 0],
    ambientIntensity: 0,
    fillIntensity: 0,
    pointLights: [],
    spotLights: [],
  };
  const lamp = { position: [0, LAMP_HEIGHT, 0], color: [1, 1, 1], intensity: LAMP_INTENSITY, radius, castShadow: true, ...lampFields };
  if (lampKind === 'spot') {
    environment.spotLights.push({ direction: [0, -1, 0], angle: 1.2, penumbra: 0, ...lamp });
  } else {
    environment.pointLights.push(lamp);
  }
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

function sphereIrradianceAt(distanceSquared) {
  return (LAMP_INTENSITY * LAMP_HEIGHT) / distanceSquared ** 1.5;
}

// A soft falloff light (Cycles' oriented disk of radius r, radiance I / (pi r^2)) faces the floor point at distance d, so every point
// of the disk is at t^2 = d^2 + rho^2 with the cosine d / t at the lamp. Integrating the cosine at a floor point whose normal makes
// the angle beta with the line to the lamp over the disk (the azimuth term of the floor cosine integrates to zero) gives
// E = I cos(beta) / (d^2 + r^2), with cos(beta) = h / d. It is the point light value with d^2 raised by r^2 under the cube.
function softFalloffIrradianceAt(radius) {
  return distanceSquared => (LAMP_INTENSITY * LAMP_HEIGHT) / (Math.sqrt(distanceSquared) * (distanceSquared + radius * radius));
}

// A sphere light of intensity I lights a diffuse floor point at a horizontal distance s, with every part of the sphere above
// the floor, with I * h / (h^2 + s^2)^(3/2), whatever its radius: the power stays fixed as the radius grows. The pixels the
// test averages reach about 0.5 m from the point under the lamp, where the floor is a few percent darker than at that point.
function closedFormCentreRadiance(irradianceAt = sphereIrradianceAt) {
  let sum = 0;
  const first = (SIZE - PATCH_SIDE) / 2;
  for (let row = first; row < first + PATCH_SIDE; row++) {
    for (let column = first; column < first + PATCH_SIDE; column++) {
      const distanceSquared = LAMP_HEIGHT * LAMP_HEIGHT + floorOffsetOfPixel(row) ** 2 + floorOffsetOfPixel(column) ** 2;
      sum += (FLOOR_ALBEDO / Math.PI) * irradianceAt(distanceSquared);
    }
  }
  return sum / (PATCH_SIDE * PATCH_SIDE);
}

test('the Cycles reference script follows each light softFalloff, off when absent, unless --soft-falloff overrides it', () => {
  const source = readFileSync(new URL('../bench/cycles-parity/render-cycles.py', import.meta.url), 'utf8');
  assert.match(source, /if "--soft-falloff" not in argument_list:\s+return SOFT_FALLOFF_FROM_SCENE/, 'without the flag each light follows its scene entry');
  assert.match(source, /light_data\.use_soft_falloff = light_entry\.get\("softFalloff"\) is True/, 'a light without the field is a sphere');
  assert.match(source, /read_flag_value\(argument_list, "--soft-falloff", "off"\)/, 'an explicit flag value is read');
  assert.match(source, /light_data\.use_soft_falloff = soft_falloff_setting/, 'the explicit setting reaches the light');
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

for (const lampKind of ['point', 'spot']) {
  for (const radius of [0.18, 0.5, 1]) {
    test(`the native cycles kernel lights a floor under a soft falloff ${lampKind} light of radius ${radius} m as an oriented disk`, { skip: skipWithoutAddon }, () => {
      const expected = closedFormCentreRadiance(softFalloffIrradianceAt(radius));
      const measured = centreRadiance(renderFloorUnderLamp(radius, lampKind, { softFalloff: true }));
      assert.ok(Math.abs(measured / expected - 1) < 0.03, `floor radiance ${measured} against the closed form ${expected}`);
    });
  }
}

test('a light without softFalloff stays a sphere: the floor under a 1 m lamp keeps the sphere value', { skip: skipWithoutAddon }, () => {
  const expected = closedFormCentreRadiance();
  const measured = centreRadiance(renderFloorUnderLamp(1, 'point', { softFalloff: false }));
  assert.ok(Math.abs(measured / expected - 1) < 0.03, `floor radiance ${measured} against the closed form ${expected}`);
});
