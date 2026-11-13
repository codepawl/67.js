import assert from 'node:assert/strict';
import test from 'node:test';
import { createCamera } from '../src/path-tracer.js';
import * as packModule from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { loadReferenceScene } from '../bench/cycles-parity/scene-bridge.mjs';
import { applyCookOnlyFields } from '../bench/cycles-parity/cook-only-fields.mjs';
import { buildTraceSceneWithManyLights } from '../bench/cycles-parity/trace-scene-many-lights.mjs';
import { cookModule, cookTest } from './support/cook.js';

const { buildNativeInputV2, STRUCT_STRIDES_V2 } = (await cookModule()) ?? {};

const LIGHT_TYPE_AREA_RECT = 2;
const LIGHT_TYPE_AREA_DISK = 3;
const ALPHA_MODE_BLEND = 2;
const MATERIAL_FLAG_TRANSPARENT_SHADOW = 4;

function viewRecord(bytes, stride, index) {
  const offset = bytes.byteOffset + index * stride;
  return { f32: new Float32Array(bytes.buffer, offset, stride / 4), u32: new Uint32Array(bytes.buffer, offset, stride / 4) };
}

async function packReferenceScene(sceneId) {
  const { traceSource } = await loadReferenceScene(sceneId);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const camera = createCamera(traceSource.camera, 32, 18);
  const nativeInput = buildNativeInputV2(traceScene, camera, { width: 32, height: 18, bounces: 8, seed: 1, parts: traceSource.parts }, packModule);
  return { traceSource, traceScene, nativeInput };
}

const triangle = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const rectangleLight = { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 1 };

cookTest('area-shapes packs a disk, an ellipse with spread and a rectangle with spread', async () => {
  const { traceSource, traceScene, nativeInput } = await packReferenceScene('area-shapes');
  assert.deepEqual(traceScene.lights.areas.map(light => light.shape), ['disk', 'ellipse', undefined]);
  assert.equal(nativeInput.lightCount, 3);
  const [disk, ellipse, rectangle] = [0, 1, 2].map(index => viewRecord(nativeInput.lights, STRUCT_STRIDES_V2.light, index));
  assert.equal(disk.u32[3], LIGHT_TYPE_AREA_DISK);
  assert.equal(ellipse.u32[3], LIGHT_TYPE_AREA_DISK);
  assert.equal(rectangle.u32[3], LIGHT_TYPE_AREA_RECT);
  assert.equal(disk.f32[22], 0, 'no spread given: tan_half_spread stays 0');
  const ellipseSpread = traceSource.environment.areaLights[1].spread;
  const halfSpread = ellipseSpread / 2;
  assert.ok(Math.abs(ellipse.f32[22] - Math.tan(halfSpread)) < 1e-6);
  assert.ok(Math.abs(ellipse.f32[23] - 1 / (Math.tan(halfSpread) - halfSpread)) < 1e-4);
  assert.ok(rectangle.f32[22] > 0 && rectangle.f32[23] > 0);
  // Radiance is intensity over the emitting area, which for a disk or an ellipse is pi / 4 of its bounding box.
  const diskArea = Math.PI * 0.25 * 0.9 * 0.9;
  assert.ok(Math.abs(disk.f32[4] - (1.0 * 8) / diskArea) < 1e-3);
  const ellipseArea = Math.PI * 0.25 * 1.6 * 0.6;
  assert.ok(Math.abs(ellipse.f32[5] - (0.9 * 10) / ellipseArea) < 1e-3);
});

cookTest('transparent-shadow packs blended panes that let shadow rays through', async () => {
  const { traceScene, nativeInput } = await packReferenceScene('transparent-shadow');
  const blended = traceScene.materials.filter(material => material.alphaMode === 'blend');
  assert.deepEqual(blended.map(material => material.opacity).sort(), [0.4, 0.75]);
  const records = Array.from({ length: nativeInput.materialCount }, (_, index) => viewRecord(nativeInput.materials, STRUCT_STRIDES_V2.material, index));
  const blendRecords = records.filter(record => record.u32[49] === ALPHA_MODE_BLEND);
  assert.equal(blendRecords.length, 2);
  for (const record of blendRecords) {
    assert.ok(record.f32[14] === Math.fround(0.4) || record.f32[14] === Math.fround(0.75));
    assert.equal(record.u32[48] & MATERIAL_FLAG_TRANSPARENT_SHADOW, MATERIAL_FLAG_TRANSPARENT_SHADOW);
  }
});

test('opacity without alphaMode blend and rectangle lights without a shape are left as they were', () => {
  const environment = { world: true, pointLights: [], spotLights: [], areaLights: [rectangleLight] };
  const parts = [{ name: 'a', geometry: triangle, matrix: identity, material: { color: [1, 1, 1], opacity: 0.5 } }];
  const scene = applyCookOnlyFields(buildTraceScene(parts, environment), parts, environment);
  assert.equal('alphaMode' in scene.materials[0], false);
  assert.equal('opacity' in scene.materials[0], false);
  assert.equal('shape' in scene.lights.areas[0], false);
  assert.equal('spread' in scene.lights.areas[0], false);
});

test('an area light shape or spread outside the allowed values is an error that names the options', () => {
  const parts = [{ name: 'a', geometry: triangle, matrix: identity, material: { color: [1, 1, 1] } }];
  const build = light => {
    const environment = { world: true, pointLights: [], spotLights: [], areaLights: [light] };
    return applyCookOnlyFields(buildTraceScene(parts, environment), parts, environment);
  };
  assert.throws(() => build({ ...rectangleLight, shape: 'triangle' }), /rectangle, disk, ellipse/);
  assert.throws(() => build({ ...rectangleLight, spread: 4 }), /spread must be between/);
  assert.throws(() => build({ ...rectangleLight, spread: 0 }), /spread must be between/);
  assert.doesNotThrow(() => build({ ...rectangleLight, shape: 'ellipse', spread: Math.PI / 2 }));
});
