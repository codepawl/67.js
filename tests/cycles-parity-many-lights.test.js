import assert from 'node:assert/strict';
import test from 'node:test';
import { createCamera } from '../src/path-tracer.js';
import * as packModule from '../src/path-tracer-gpu-pack.js';
import { MAX_TRACE_LIGHTS } from '../src/path-tracer-scene.js';
import { buildNativeInputV2 } from '../packages/render-native/index.mjs';
import { loadReferenceScene } from '../bench/cycles-parity/scene-bridge.mjs';
import { buildTraceSceneWithManyLights } from '../bench/cycles-parity/trace-scene-many-lights.mjs';

const SCENE_ID = 'many-lights-500';
const POINT_LIGHT_COUNT = 200;
const SPOT_LIGHT_COUNT = 150;
const EMISSIVE_QUAD_COUNT = 100;
const EMISSIVE_TRIANGLE_COUNT = 50;

test('many-lights-500 holds 500 lights placed from a fixed seed', async () => {
  const first = await loadReferenceScene(SCENE_ID);
  const second = await loadReferenceScene(SCENE_ID);
  const { pointLights, spotLights } = first.rawScene.environment;
  const emitters = first.rawScene.parts.filter(entry => entry.material.emission > 0);
  assert.equal(pointLights.length, POINT_LIGHT_COUNT);
  assert.equal(spotLights.length, SPOT_LIGHT_COUNT);
  assert.equal(emitters.length, EMISSIVE_QUAD_COUNT + EMISSIVE_TRIANGLE_COUNT);
  assert.deepEqual(second.rawScene.environment.pointLights, pointLights);
  assert.deepEqual(second.rawScene.environment.spotLights, spotLights);
  assert.deepEqual(second.rawScene.parts.map(entry => [...entry.matrix]), first.rawScene.parts.map(entry => [...entry.matrix]));
});

test('buildTraceSceneWithManyLights joins chunks beyond the trace light limit and leaves small scenes alone', async () => {
  const { traceSource } = await loadReferenceScene(SCENE_ID);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  assert.ok(POINT_LIGHT_COUNT + SPOT_LIGHT_COUNT > MAX_TRACE_LIGHTS);
  assert.equal(traceScene.lights.points.length, POINT_LIGHT_COUNT);
  assert.equal(traceScene.lights.spots.length, SPOT_LIGHT_COUNT);
  assert.equal(traceScene.lights.areas.length, 0);
  assert.deepEqual(traceScene.lights.points[199].position, traceSource.environment.pointLights[199].position);
  assert.deepEqual(traceScene.lights.spots[149].direction.map(value => Number(value.toFixed(6))), (() => {
    const direction = traceSource.environment.spotLights[149].direction;
    const length = Math.hypot(...direction);
    return direction.map(value => Number((value / length).toFixed(6)));
  })());
  const smallEnvironment = { ...traceSource.environment, pointLights: traceSource.environment.pointLights.slice(0, 3), spotLights: [] };
  const smallScene = buildTraceSceneWithManyLights(traceSource.parts, smallEnvironment);
  assert.equal(smallScene.lights.points.length, 3);
  assert.equal(smallScene.lights.points[2].bit, 3);
});

test('many-lights-500 packs for the cycles kernel with a light tree over 350 lights and 200 emissive triangles', async () => {
  const { traceSource } = await loadReferenceScene(SCENE_ID);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const camera = createCamera(traceSource.camera, 64, 36);
  const nativeInput = buildNativeInputV2(traceScene, camera, { width: 64, height: 36, bounces: 8, seed: 1, parts: traceSource.parts }, packModule);
  assert.equal(nativeInput.lightCount, POINT_LIGHT_COUNT + SPOT_LIGHT_COUNT);
  assert.equal(nativeInput.emissiveTriangleCount, EMISSIVE_QUAD_COUNT * 2 + EMISSIVE_TRIANGLE_COUNT);
  assert.ok(nativeInput.lightTreeNodeCount > 1);
});
