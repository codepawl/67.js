import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { exposureProblems, framingProblems, lumaShares, mergeFrameDiagnostics } from '../src/frame-checks.js';
import { closedRoom, closedRoomWithoutBake } from './support/agent-bake-rooms.mjs';

function sceneWithCamera(camera) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'red', color: [0.8, 0.2, 0.2] }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'red' }],
    camera,
  };
}

function framingOf(recipe) {
  const scene = createAgentScene(recipe);
  return framingProblems({ camera: scene.camera, aspect: 1, boxes: scene.worldBounds() });
}

function kinds(problems) {
  return problems.map(problem => problem.kind);
}

test('a subject in view gives no framing warning', () => {
  assert.deepEqual(framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [0, 0, 0], fov: 45 })), []);
  assert.deepEqual(framingOf(closedRoom()), []);
});

test('a scene with no parts is an empty frame and says what to add', () => {
  const problems = framingOf({ ...sceneWithCamera({}), nodes: [] });
  assert.deepEqual(kinds(problems), ['empty-frame']);
  assert.match(problems[0].fix, /add-node/);
});

test('a camera that looks away from the subject names a camera.target and camera.eye that frame it', () => {
  const problems = framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [30, 2, -40], fov: 45 }));
  assert.deepEqual(kinds(problems), ['subject-out-of-frame']);
  assert.match(problems[0].fix, /camera\.target to \[0,0,0\].*camera\.eye to \[/);
});

test('a subject far away fills so little of the frame that it is called too small', () => {
  const problems = framingOf(sceneWithCamera({ eye: [0, 0, 400], target: [0, 0, 0], fov: 45, far: 2000 }));
  assert.deepEqual(kinds(problems), ['subject-too-small']);
});

test('hidden parts do not count and orthographic cameras are not judged', () => {
  const hidden = sceneWithCamera({ eye: [3, 2, 4], target: [0, 0, 0] });
  hidden.nodes[0].visible = false;
  assert.deepEqual(kinds(framingOf(hidden)), ['empty-frame']);
  assert.deepEqual(framingOf(sceneWithCamera({ eye: [3, 2, 4], target: [30, 2, -40], projection: 'orthographic' })), []);
});

function frameOf(luma, count = 100) {
  return new Uint8Array(count * 4).fill(luma);
}

test('exposure warns on a black or clipped frame and not on a normal one', () => {
  const black = exposureProblems({ shares: lumaShares(frameOf(0)), exposure: 1 });
  assert.deepEqual(kinds(black), ['exposure-black']);
  assert.match(black[0].fix, /effects\.exposure from 1 to 4/);
  const white = exposureProblems({ shares: lumaShares(frameOf(255)), exposure: 1 });
  assert.deepEqual(kinds(white), ['exposure-clipped']);
  assert.match(white[0].fix, /effects\.exposure from 1 to 0\.5/);
  assert.deepEqual(exposureProblems({ shares: lumaShares(frameOf(120)), exposure: 1 }), []);
  const mostlyMid = frameOf(120);
  mostlyMid.fill(255, 0, 40);
  assert.deepEqual(exposureProblems({ shares: lumaShares(mostlyMid), exposure: 1 }), []);
});

function lightMoves() {
  return closedRoom({ motion: { duration: 2, loop: false, tracks: [
    { kind: 'light', id: 'point:0', property: 'position', keyframes: [{ time: 0, value: [0, 2.7, 0] }, { time: 2, value: [1, 2.7, 0] }] },
  ] } });
}

test('an unchanged baked scene gives no stale warning at the rest pose', () => {
  assert.deepEqual(createAgentScene(closedRoom()).bakeStaleness(), []);
  const scene = createAgentScene(lightMoves());
  scene.sampleMotion(0);
  assert.deepEqual(scene.bakeStaleness(), []);
  assert.deepEqual(createAgentScene(closedRoomWithoutBake()).bakeStaleness(), []);
});

test('moving a light after a bake gives bake-stale with the fix', () => {
  const scene = createAgentScene(lightMoves());
  scene.sampleMotion(2);
  const problems = scene.bakeStaleness();
  assert.deepEqual(kinds(problems), ['bake-stale']);
  assert.match(problems[0].fix, /bake.rebake/);
  scene.sampleMotion(null);
  assert.deepEqual(scene.bakeStaleness(), []);
});

test('moving a part after a bake gives bake-stale', () => {
  const scene = createAgentScene(closedRoom({ motion: { duration: 2, loop: false, tracks: [
    { kind: 'node', id: 'block', property: 'translation', keyframes: [{ time: 0, value: [-0.7, 0.6, -0.4] }, { time: 2, value: [0.5, 0.6, -0.4] }] },
  ] } }));
  scene.sampleMotion(2);
  const problems = scene.bakeStaleness();
  assert.deepEqual(kinds(problems), ['bake-stale']);
});

test('job metrics keep one entry per warning across frames', () => {
  const metrics = {};
  const warning = { kind: 'exposure-black', target: 'effects.exposure', message: 'm', fix: 'f' };
  mergeFrameDiagnostics(metrics, [warning]);
  mergeFrameDiagnostics(metrics, [{ ...warning }]);
  mergeFrameDiagnostics(metrics, undefined);
  assert.equal(metrics.diagnostics.length, 1);
});
