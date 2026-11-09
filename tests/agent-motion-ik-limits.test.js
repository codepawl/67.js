import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';

const SEGMENT_MATERIALS = [{ id: 'paint', color: [0.6, 0.6, 0.6] }];

/** A planar arm along +x: shoulder at (0, 1, 0), 0.5 m to the elbow, 0.4 m to the tip. */
function armRecipe(motion) {
  const nodes = [
    { id: 'base', translation: [0, 1, 0] },
    { id: 'shoulder', parent: 'base' },
    { id: 'elbow', parent: 'shoulder', translation: [0.5, 0, 0] },
    { id: 'tip', parent: 'elbow', translation: [0.4, 0, 0], geometry: 'box', material: 'paint', scale: [0.03, 0.03, 0.03] },
  ];
  return { format: '67js.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials: SEGMENT_MATERIALS, nodes, motion };
}

const arm = extra => ({ type: 'two-bone', root: 'shoulder', middle: 'elbow', end: 'tip', target: [0.3, 1.5, 0.2], pole: [0, 3, 0], ...extra });
const reportFor = ik => createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [ik] })).inspect().motionIk[0];

test('motionIk reports the poses a joint limit changed', () => {
  const free = reportFor(arm({}));
  assert.deepEqual(free.limited, []);
  const limited = reportFor(arm({ limits: { middle: { z: [-5, 5] } } }));
  assert.equal(limited.reached, false);
  assert.ok(limited.limited.length >= 1);
  assert.equal(limited.limited[0].joint, 'elbow');
  assert.equal(limited.limited[0].axis, 'z');
  assert.equal(typeof limited.limited[0].atTime, 'number');
});

test('a deliberately wrong pole produces a warning while IK still reports reached', () => {
  const natural = reportFor(arm({ bendToward: [0, 1, 0] }));
  assert.deepEqual(natural.warnings, []);
  const wrong = reportFor(arm({ pole: [0, -3, 0], bendToward: [0, 1, 0] }));
  assert.equal(wrong.reached, true);
  assert.deepEqual(wrong.warnings.map(warning => warning.code), ['wrong-bend']);
  assert.match(wrong.warnings[0].message, /elbow/);
});

test('a target at full reach warns about hyperextension', () => {
  const report = reportFor(arm({ target: [0.9, 1, 0] }));
  assert.ok(report.warnings.some(warning => warning.code === 'hyperextended'));
});

test('limits and bendToward are validated', () => {
  const build = ik => createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [ik] }));
  assert.throws(() => build(arm({ limits: { tip: { z: [0, 1] } } })), /Unknown or unsupported/);
  assert.throws(() => build(arm({ limits: { middle: { z: [10, -10] } } })), /min first/);
  assert.throws(() => build(arm({ limits: { middle: { w: [0, 1] } } })), /Unknown or unsupported/);
  assert.throws(() => build(arm({ bendToward: [0, 1] })), /an array of 3 numbers/);
});

const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const ASSET_ID = 'ab'.repeat(32);

function robotScene(motion) {
  const asset = parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  return asset.then(loaded => ({ loaded, scene: createAgentAssetScene(loaded, { format: '67js.asset', schemaVersion: 1, assetId: ASSET_ID, motion }) }));
}

function translationOf({ loaded, scene }, name) {
  const index = loaded.parts.findIndex(part => part.name === name);
  return Array.from(mat4.getTranslation(new Float64Array(3), scene.parts[index].matrix));
}

test('constraints move parts of an imported character, and a seek equals play', async () => {
  const constrained = await robotScene({ duration: 1, tracks: [], constraints: [{ type: 'copy_location', node: 'node-38', target: 'node-18' }] });
  const plain = await robotScene({ duration: 1, tracks: [], constraints: [{ type: 'limit_location', node: 'node-12', y: [-100, 100] }] });
  plain.scene.sampleMotion(0);
  constrained.scene.sampleMotion(0);
  const armRight = translationOf(constrained, 'ArmR');
  const armLeft = translationOf(constrained, 'ArmL');
  armRight.forEach((value, index) => assert.ok(Math.abs(value - armLeft[index]) < 1e-4, `${armRight} vs ${armLeft}`));
  const unconstrainedGap = translationOf(plain, 'ArmR').map((value, index) => Math.abs(value - translationOf(plain, 'ArmL')[index]));
  assert.ok(Math.max(...unconstrainedGap) > 1e-2, 'the arms are apart without the constraint');
  constrained.scene.sampleMotion(0.7);
  constrained.scene.sampleMotion(0);
  assert.deepEqual(translationOf(constrained, 'ArmR'), armRight);
});
