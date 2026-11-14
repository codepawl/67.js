import assert from 'node:assert/strict';
import test from 'node:test';
import { cookModule, cookTest } from './support/cook.js';
import { exportNativeSceneTables, NATIVE_JOB_MAXIMUM_LIGHTS } from '../scripts/native-bake-page.js';
import { withinDrawnLightLimits } from '../src/drawn-light-lists.js';
import { MAX_AREA_LIGHTS, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from '../src/light-limits.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, MAX_NATIVE_TRACE_LIGHTS, MAX_TRACE_LIGHTS, refuseLocalVolumes, resolveTexture } from '../src/path-tracer-scene.js';

const jobInputModule = await cookModule('job-input');
const packInputModule = await cookModule('pack-input');
const { buildFlattenedJobNativeInput, buildJobNativeInput } = jobInputModule ?? {};
const { buildNativeInput } = packInputModule ?? {};

const FLOOR = {
  positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
};

function floorParts(material = { color: [0.8, 0.8, 0.8] }) {
  return [{ name: 'floor', geometry: FLOOR, material }];
}

function areaLights(count) {
  return Array.from({ length: count }, (_, index) => ({ position: [index - count / 2, 3, 0], direction: [0, -1, 0], width: 0.5, height: 0.5, color: [1, 1, 1], intensity: 5 }));
}

function pointLights(count) {
  return Array.from({ length: count }, (_, index) => ({ position: [index * 0.01, 2, 0], color: [1, 1, 1], intensity: 1 }));
}

test('the CPU and WebGL bound is still 32 lights with its old message', () => {
  assert.equal(MAX_TRACE_LIGHTS, 32);
  assert.throws(() => buildTraceScene(floorParts(), { pointLights: pointLights(17), areaLights: areaLights(16) }),
    { name: 'RangeError', message: 'A path trace takes at most 32 point, spot and area lights.' });
});

test('the native option takes more area lights than a drawn frame, and more lights than 32 in all', () => {
  assert.equal(NATIVE_JOB_MAXIMUM_LIGHTS, MAX_NATIVE_TRACE_LIGHTS);
  const nineAreas = buildTraceScene(floorParts(), { areaLights: areaLights(MAX_AREA_LIGHTS + 2) }, { maximumLights: MAX_NATIVE_TRACE_LIGHTS });
  assert.equal(nineAreas.lights.areas.length, 9);
  const many = buildTraceScene(floorParts(), { pointLights: pointLights(40), areaLights: areaLights(20) }, { maximumLights: MAX_NATIVE_TRACE_LIGHTS });
  assert.equal(many.lights.points.length + many.lights.areas.length, 60);
});

test('a portal does not count as a light', () => {
  const lights = [...areaLights(2), { ...areaLights(1)[0], portal: true }];
  const scene = buildTraceScene(floorParts(), { areaLights: lights }, { maximumLights: 2 });
  assert.equal(scene.lights.areas.length, 2);
  assert.equal(scene.lights.portals.length, 1);
});

test('above the native bound the message says how many lights are too many and what to do', () => {
  assert.throws(() => buildTraceScene(floorParts(), { areaLights: areaLights(12) }, { maximumLights: 10 }),
    { name: 'RangeError', message: /A native path trace takes at most 10 point, spot and area lights, got 12 \(2 too many\)\. Drop lights, or give the extra emitters as meshes with an emissive material/ });
});

test('a bad maximumLights is refused so a typo cannot lift the bound', () => {
  for (const value of [0, 1.5, MAX_NATIVE_TRACE_LIGHTS + 1, '64']) {
    assert.throws(() => buildTraceScene(floorParts(), {}, { maximumLights: value }),
      { name: 'RangeError', message: /maximumLights is an integer from 1 to 256 for the native path tracer/ });
  }
});

test('light linking is refused when a kind of light has more lights than mask bits, and kept when every kind fits', () => {
  const linked = floorParts({ color: [0.8, 0.8, 0.8], lightMask: 1 });
  assert.throws(() => buildTraceScene(linked, { areaLights: areaLights(MAX_AREA_LIGHTS + 1) }, { maximumLights: MAX_NATIVE_TRACE_LIGHTS }),
    { name: 'RangeError', message: /Light linking .* here "floor"\) needs at most 7 areaLights, got 8: each linked light keeps one mask bit\. Remove the links, or keep areaLights to 7\./ });
  assert.throws(() => buildTraceScene(linked, { pointLights: pointLights(MAX_POINT_LIGHTS + 1) }, { maximumLights: MAX_NATIVE_TRACE_LIGHTS }),
    /needs at most 16 pointLights, got 17/);
  const withinEveryKind = { pointLights: pointLights(MAX_POINT_LIGHTS), spotLights: [], areaLights: areaLights(MAX_AREA_LIGHTS) };
  assert.equal(MAX_SPOT_LIGHTS, 8);
  assert.equal(buildTraceScene(linked, withinEveryKind, { maximumLights: MAX_NATIVE_TRACE_LIGHTS }).lights.areas.length, 7);
  const unlinked = floorParts({ color: [0.8, 0.8, 0.8], lightMask: -1 });
  assert.equal(buildTraceScene(unlinked, { areaLights: areaLights(9) }, { maximumLights: MAX_NATIVE_TRACE_LIGHTS }).lights.areas.length, 9);
});

cookTest('the native export packs nine area lights for the cycles kernel', () => {
  const camera = createCamera({ eye: [0, 2, 6], target: [0, 0, 0], fov: 50 }, 16, 16);
  const exported = exportNativeSceneTables({
    parts: floorParts(), environment: { areaLights: areaLights(9) }, camera, options: { width: 16, height: 16, bounces: 2, seed: 1 }, kernel: 'cycles', instancing: false,
    transport: 'chunks',
    modules: { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack },
  });
  assert.equal(exported.counts.lightCount, 9);
});

test('the renderer of a traced page gets the first lights of each kind that fit, and a fitting environment unchanged', () => {
  const fitting = { areaLights: areaLights(7), keyColor: [1, 1, 1] };
  assert.equal(withinDrawnLightLimits(fitting), fitting);
  const environment = { areaLights: areaLights(9), pointLights: pointLights(20), spotLights: [], keyColor: [1, 1, 1] };
  const drawn = withinDrawnLightLimits(environment);
  assert.deepEqual(drawn.areaLights, environment.areaLights.slice(0, 7));
  assert.equal(drawn.pointLights.length, 16);
  assert.equal(drawn.spotLights, environment.spotLights);
  assert.deepEqual(drawn.keyColor, [1, 1, 1]);
  assert.equal(environment.areaLights.length, 9, 'the traced environment keeps every light');
});
