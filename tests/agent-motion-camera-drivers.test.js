import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';

const close = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const customRead = name => ({ custom: { node: 'lead', name } });

function recipeWith(motion) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'lead', geometry: 'box', material: 'paint', translation: [4, 0, 0] },
      { id: 'follower', geometry: 'box', material: 'paint' },
    ],
    camera: { eye: [0, 1, 8], target: [0, 0, 0], fov: 50 },
    effects: {},
    motion,
  };
}

const DOLLY = { node: 'lead', name: 'dolly', min: 0, max: 1, keys: [{ time: 0, value: 0 }, { time: 2, value: 1 }] };
const FADE = { node: 'lead', name: 'fade', min: 0, max: 1, keys: [{ time: 0, value: 0 }, { time: 1, value: 1 }, { time: 2, value: 0 }] };

function cameraMotion() {
  return {
    duration: 2,
    tracks: [{ kind: 'camera', property: 'target', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [2, 0, 0] }] }],
    properties: [DOLLY],
    drivers: [
      { target: { kind: 'camera', property: 'eye', component: 'z' }, expression: { sub: [8, { mul: [customRead('dolly'), 4] }] } },
      { target: { kind: 'camera', property: 'fov' }, expression: { sub: [50, { mul: [customRead('dolly'), 20] }] } },
    ],
  };
}

function cameraAt(scene, time) {
  scene.sampleMotion(time);
  const { eye, target, fov } = scene.camera;
  return { eye: Array.from(eye), target: Array.from(target), fov };
}

test('one property dollies the camera and narrows its fov after the camera tracks, and seek equals play', () => {
  const scene = createAgentScene(recipeWith(cameraMotion()));
  const played = [0, 0.5, 1, 1.5, 2].map(time => cameraAt(scene, time));
  close(played[2].eye[2], 6);
  close(played[2].fov, 40);
  close(played[4].eye[2], 4);
  close(played[4].fov, 30);
  close(played[2].eye[1], 1);
  close(played[2].target[0], 1);
  const seekScene = createAgentScene(recipeWith(cameraMotion()));
  assert.deepEqual(cameraAt(seekScene, 1.5), played[3]);
  assert.deepEqual(cameraAt(seekScene, 0.5), played[1]);
});

test('a camera driver without any camera track moves the recipe camera, and roll turns the up vector', () => {
  const scene = createAgentScene(recipeWith({
    duration: 2, tracks: [], properties: [DOLLY],
    drivers: [{ target: { kind: 'camera', property: 'roll' }, expression: { mul: [customRead('dolly'), Math.PI / 2] } }],
  }));
  scene.sampleMotion(0);
  close(scene.camera.up[0], 0);
  close(scene.camera.up[1], 1);
  scene.sampleMotion(2);
  close(Math.abs(scene.camera.up[0]), 1, 0.01);
  close(scene.camera.up[1], 0, 0.15);
  close(scene.camera.eye[2], 8);
});

test('a property fades a constraint in and out through its influence', () => {
  const scene = createAgentScene(recipeWith({
    duration: 2, tracks: [], properties: [FADE],
    constraints: [{ type: 'copy_location', node: 'follower', target: 'lead', influence: customRead('fade') }],
  }));
  const followerX = time => {
    scene.sampleMotion(time);
    return mat4.getTranslation(new Float64Array(3), scene.parts.find(part => part.name === 'follower').matrix)[0];
  };
  close(followerX(0), 0);
  close(followerX(0.5), 2);
  close(followerX(1), 4);
  close(followerX(1.5), 2);
  close(followerX(2), 0);
});

test('camera driver and influence errors name the field and what to pass', () => {
  const build = (drivers, extra = {}) => () => createAgentScene(recipeWith({ duration: 2, tracks: [], properties: [DOLLY], drivers, ...extra }));
  assert.throws(build([{ target: { kind: 'camera', id: 'main', property: 'fov' }, expression: 40 }]), /camera target takes no id/);
  assert.throws(build([{ target: { kind: 'camera', property: 'zoom' }, expression: 40 }]), /camera property must be one of eye, target, fov, roll/);
  assert.throws(build([{ target: { kind: 'camera', property: 'eye' }, expression: 1 }]), /camera eye needs a component/);
  assert.throws(build([{ target: { kind: 'camera', property: 'fov', component: 'x' }, expression: 40 }]), /camera fov takes no component/);
  assert.throws(
    build([{ target: { kind: 'camera', property: 'fov' }, expression: 40 }], { tracks: [{ kind: 'camera', property: 'fov', keyframes: [{ time: 0, value: 40 }, { time: 2, value: 50 }] }] }),
    error => /a track on camera already moves fov/.test(error.message) && !/undefined/.test(error.message),
  );
  assert.throws(
    () => createAgentScene(recipeWith({ duration: 2, tracks: [], constraints: [{ type: 'copy_location', node: 'follower', target: 'lead', influence: customRead('missing') }] })),
    /no custom property "missing"/,
  );
});
