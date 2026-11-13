import assert from 'node:assert/strict';
import test from 'node:test';

import { cookModule, cookTest } from './support/cook.js';
import { normalizeAgentLook } from '../src/agent-look.js';
import { box } from '../src/geometry.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

const cook = await cookModule();
const { STRUCT_STRIDES_V2, buildNativeInput, buildNativeInputV2, upgradeNativeInputV1ToV2 } = cook ?? {};

const LIGHT_FLAG_SOFT_FALLOFF = 32;
const LIGHT_FLAG_WORD_INDEX = 7;
const LIGHT_TEXEL_FLOATS = 24;
const SOFT_FALLOFF_FLOAT_INDEX = 22;

function floorPart() {
  const matrix = new Float32Array([4, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 4, 0, 0, -0.05, 0, 1]);
  return { name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } };
}

function lampEnvironment(softFalloffByLamp) {
  const [pointField, spotField, zeroRadiusField, falseField] = softFalloffByLamp;
  return {
    keyColor: [0, 0, 0],
    lightDirection: [0, 1, 0],
    pointLights: [
      { position: [0, 2, 0], color: [1, 1, 1], intensity: 5, radius: 0.3, ...pointField },
      { position: [1, 2, 0], color: [1, 1, 1], intensity: 5, radius: 0, ...zeroRadiusField },
      { position: [2, 2, 0], color: [1, 1, 1], intensity: 5, radius: 0.3, ...falseField },
    ],
    spotLights: [
      { position: [0, 3, 1], direction: [0, -1, 0], angle: 0.6, penumbra: 0.2, color: [1, 1, 1], intensity: 8, radius: 0.2, ...spotField },
    ],
  };
}

function viewLightRecord(v2, index) {
  const offset = v2.lights.byteOffset + index * STRUCT_STRIDES_V2.light;
  return new Uint32Array(v2.lights.buffer, offset, STRUCT_STRIDES_V2.light / 4);
}

function packedLightFlags(v2) {
  return [0, 1, 2, 3].map(index => viewLightRecord(v2, index)[LIGHT_FLAG_WORD_INDEX]);
}

const cameraDescription = { eye: [0, 1, 6], target: [0, 0, 0], fov: 45 };
const optionsOfPack = { width: 8, height: 8, samples: 1 };

cookTest('a point or spot light with a radius and softFalloff true sets the soft falloff flag of its v2 light record', () => {
  const scene = buildTraceScene([floorPart()], lampEnvironment([{ softFalloff: true }, { softFalloff: true }, { softFalloff: true }, { softFalloff: false }]));
  const v2 = buildNativeInputV2(scene, createCamera(cameraDescription, 8, 8), optionsOfPack);
  const flags = packedLightFlags(v2);
  assert.equal(flags[0] & LIGHT_FLAG_SOFT_FALLOFF, LIGHT_FLAG_SOFT_FALLOFF, 'the point light with a radius');
  assert.equal(flags[1] & LIGHT_FLAG_SOFT_FALLOFF, 0, 'a point light with radius 0 stays a delta light');
  assert.equal(flags[2] & LIGHT_FLAG_SOFT_FALLOFF, 0, 'softFalloff false keeps the sphere');
  assert.equal(flags[3] & LIGHT_FLAG_SOFT_FALLOFF, LIGHT_FLAG_SOFT_FALLOFF, 'the spot light with a radius');
});

cookTest('a scene without softFalloff packs the same light flags as one that sets it to false', () => {
  const without = buildTraceScene([floorPart()], lampEnvironment([{}, {}, {}, {}]));
  const withFalse = buildTraceScene([floorPart()], lampEnvironment([{ softFalloff: false }, { softFalloff: false }, { softFalloff: false }, { softFalloff: false }]));
  const camera = createCamera(cameraDescription, 8, 8);
  const flagsWithout = packedLightFlags(buildNativeInputV2(without, camera, optionsOfPack));
  const flagsWithFalse = packedLightFlags(buildNativeInputV2(withFalse, camera, optionsOfPack));
  assert.deepEqual(flagsWithFalse, flagsWithout);
  for (const flags of flagsWithout) {
    assert.equal(flags & LIGHT_FLAG_SOFT_FALLOFF, 0);
  }
});

cookTest('the v1 light table carries softFalloff in the third float of the last texel and is unchanged without it', () => {
  const camera = createCamera(cameraDescription, 8, 8);
  const soft = buildNativeInput(buildTraceScene([floorPart()], lampEnvironment([{ softFalloff: true }, { softFalloff: true }, {}, {}])), camera, optionsOfPack, pack);
  const plain = buildNativeInput(buildTraceScene([floorPart()], lampEnvironment([{}, {}, {}, {}])), camera, optionsOfPack, pack);
  const softValue = index => soft.lights[index * LIGHT_TEXEL_FLOATS + SOFT_FALLOFF_FLOAT_INDEX];
  const plainValue = index => plain.lights[index * LIGHT_TEXEL_FLOATS + SOFT_FALLOFF_FLOAT_INDEX];
  assert.deepEqual([softValue(0), softValue(1), softValue(2), softValue(3)], [1, 0, 0, 1]);
  assert.deepEqual([plainValue(0), plainValue(1), plainValue(2), plainValue(3)], [0, 0, 0, 0]);
  const withFalseFlag = buildNativeInput(buildTraceScene([floorPart()], lampEnvironment([{ softFalloff: false }, {}, {}, {}])), camera, optionsOfPack, pack);
  assert.deepEqual(Array.from(withFalseFlag.lights), Array.from(plain.lights));
});

cookTest('the flag survives the upgrade of v1 tables to the v2 input of a flattened scene', () => {
  const camera = createCamera(cameraDescription, 8, 8);
  const scene = buildTraceScene([floorPart()], lampEnvironment([{ softFalloff: true }, { softFalloff: true }, {}, {}]));
  const upgraded = upgradeNativeInputV1ToV2(buildNativeInput(scene, camera, optionsOfPack, pack), optionsOfPack);
  const flags = packedLightFlags(upgraded);
  assert.equal(flags[0] & LIGHT_FLAG_SOFT_FALLOFF, LIGHT_FLAG_SOFT_FALLOFF);
  assert.equal(flags[1] & LIGHT_FLAG_SOFT_FALLOFF, 0);
  assert.equal(flags[2] & LIGHT_FLAG_SOFT_FALLOFF, 0);
  assert.equal(flags[3] & LIGHT_FLAG_SOFT_FALLOFF, LIGHT_FLAG_SOFT_FALLOFF);
});

test('buildTraceScene rejects a softFalloff that is not true or false and says what to pass', () => {
  for (const badValue of ['yes', 1, null]) {
    const pointEnvironment = { pointLights: [{ position: [0, 2, 0], color: [1, 1, 1], intensity: 1, radius: 0.2, softFalloff: badValue }] };
    assert.throws(() => buildTraceScene([floorPart()], pointEnvironment), /environment\.pointLights\[0\]\.softFalloff must be true .* or false .*Leave it out/);
    const spotEnvironment = { spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], angle: 0.5, color: [1, 1, 1], intensity: 1, radius: 0.2, softFalloff: badValue }] };
    assert.throws(() => buildTraceScene([floorPart()], spotEnvironment), /environment\.spotLights\[0\]\.softFalloff must be true .* or false/);
  }
});

test('a scene recipe accepts softFalloff on point and spot lights only as a boolean and drops false', () => {
  const { environment } = normalizeAgentLook({ environment: {
    pointLights: [{ position: [0, 2, 0], radius: 0.2, softFalloff: true }, { position: [1, 2, 0], softFalloff: false }],
    spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], softFalloff: true }],
  } });
  assert.equal(environment.pointLights[0].softFalloff, true);
  assert.equal(Object.hasOwn(environment.pointLights[1], 'softFalloff'), false);
  assert.equal(environment.spotLights[0].softFalloff, true);
  assert.throws(() => normalizeAgentLook({ environment: { pointLights: [{ position: [0, 2, 0], softFalloff: 'on' }] } }), /softFalloff.*true .*or false/);
  assert.throws(() => normalizeAgentLook({ environment: { spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], softFalloff: 1 }] } }), /softFalloff.*true .*or false/);
});
