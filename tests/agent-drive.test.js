import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat3, quat, vec3 } from 'gl-matrix';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { createAgentScene } from '../src/agent-scene.js';
import { createAssetDrive } from '../src/agent-drive.js';
import { assetCopyKey, recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { carAsset, CAR_WHEEL_RADIUS, CAR_WHEELBASE, CAR_TRACK } from './fixtures/car-glb.js';

const CURVE = [[0, 0, 0], [0, 0, 12], [6, 0, 22], [16, 0, 26]];
const ASSET_ID = 'ca'.repeat(32);
// Part order of the fixture: body, tail lamp, then the front left, front right, rear left and rear right wheels.
const REAR_WHEEL_PARTS = [4, 5];
const TAIL_LAMP_MATERIAL = 'material-1';

const assetRecipe = drive => ({ format: '67js.asset', schemaVersion: 1, assetId: ASSET_ID, motion: { drive } });
const motionDrive = scene => scene.inspect({ kind: 'hierarchy', limit: 1 }).motionDrive;

async function withCar(run) {
  const asset = await parseGltf(carAsset());
  try {
    return await run(asset);
  } finally {
    asset.dispose();
  }
}

/** Rotation of a part's world matrix about its own x axle between two poses: how far the wheel rolled. */
function rolledAngle(before, after) {
  const rotationBefore = mat3.fromMat4(mat3.create(), before);
  const rotationAfter = mat3.fromMat4(mat3.create(), after);
  const change = mat3.multiply(mat3.create(), rotationAfter, mat3.transpose(mat3.create(), rotationBefore));
  const rotation = quat.fromMat3(quat.create(), change);
  const axis = vec3.create();
  let angle = quat.getAxisAngle(axis, rotation);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  return angle * vec3.dot(axis, [before[0], before[1], before[2]]);
}

/** Total roll of the rear wheels over [from, to], summed in small steps, as metres rolled. */
function metresRolled(scene, from, to, step = 1 / 60) {
  scene.sampleMotion(from);
  let previous = REAR_WHEEL_PARTS.map(index => Float64Array.from(scene.parts[index].matrix));
  let rolled = 0;
  for (let time = from + step; time < to + step / 2; time += step) {
    scene.sampleMotion(Math.min(time, to));
    const current = REAR_WHEEL_PARTS.map(index => Float64Array.from(scene.parts[index].matrix));
    rolled += REAR_WHEEL_PARTS.reduce((total, _, index) => total + rolledAngle(previous[index], current[index]), 0) / REAR_WHEEL_PARTS.length;
    previous = current;
  }
  return rolled * CAR_WHEEL_RADIUS;
}

test('the drive finds the wheels, reports the names it rejected and sets the motion duration from the path', async () => {
  await withCar(asset => {
    const scene = createAgentAssetScene(asset, assetRecipe({ path: CURVE, cruiseSpeed: 8 }));
    const report = motionDrive(scene);
    assert.deepEqual(report.wheels.map(wheel => wheel.nodes[0]).sort(), ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR']);
    assert.deepEqual(report.rejectedNames.map(entry => entry.name), ['Steering_Wheel_Cover']);
    assert.ok(Math.abs(report.wheelbase - CAR_WHEELBASE) < 0.01);
    assert.ok(Math.abs(report.trackWidth - CAR_TRACK) < 0.01);
    assert.ok(Math.abs(report.wheels[0].radius - CAR_WHEEL_RADIUS) < 0.01);
    assert.equal(scene.exportRecipe().motion.duration, Math.ceil(report.duration * 1000) / 1000);
  });
});

test('through a curve and a stop the rear wheels roll the distance driven, and any sampling order gives one pose', async () => {
  await withCar(asset => {
    const drive = { path: CURVE, cruiseSpeed: 8, acceleration: 3, braking: 4 };
    const scene = createAgentAssetScene(asset, assetRecipe(drive));
    const reference = createAssetDrive(asset, drive);
    const duration = scene.exportRecipe().motion.duration;
    const rolled = metresRolled(scene, 0, duration);
    const driven = reference.sample(duration).pose.distance;
    assert.ok(driven > 30, `the path is ${driven} m`);
    assert.ok(Math.abs(rolled - driven) / driven < 0.02, `rolled ${rolled} m for ${driven} m driven`);
    const snapshot = time => {
      scene.sampleMotion(time);
      return scene.parts.map(part => Array.from(part.matrix));
    };
    const middle = snapshot(duration * 0.4);
    snapshot(duration);
    snapshot(0);
    assert.deepEqual(snapshot(duration * 0.4), middle);
    scene.sampleMotion(duration);
    const end = scene.parts[0].matrix;
    assert.ok(Math.hypot(end[12] - 16, end[14] - 26) < 1.5, 'the car ends at the end of the path');
  });
});

test('a reverse leg backs up with the wheels spinning backwards', async () => {
  await withCar(asset => {
    const drive = {
      cruiseSpeed: 4, acceleration: 2, braking: 2,
      legs: [{ path: [[0, 0, 0], [0, 0, 10]] }, { path: [[0, 0, 10], [0, 0, 4]], direction: 'reverse', pause: 0.5 }],
    };
    const scene = createAgentAssetScene(asset, assetRecipe(drive));
    const reference = createAssetDrive(asset, drive);
    const duration = scene.exportRecipe().motion.duration;
    scene.sampleMotion(duration);
    assert.equal(motionDrive(scene).direction, -1);
    assert.equal(motionDrive(scene).lights.reverse, 0, 'the reverse light is off once the car has stopped');
    assert.ok(reference.sample(duration - 0.9).pose.speed < 0);
    scene.sampleMotion(duration - 0.9);
    assert.equal(motionDrive(scene).direction, -1);
    assert.equal(motionDrive(scene).lights.reverse, 1);
    const backed = metresRolled(scene, duration - 3, duration);
    const distance = reference.sample(duration).pose.distance - reference.sample(duration - 3).pose.distance;
    assert.ok(distance < -1 && backed < -1, `drove ${distance} m, rolled ${backed} m`);
    assert.ok(Math.abs(backed - distance) / Math.abs(distance) < 0.02);
    const finalPose = scene.parts[0].matrix;
    assert.ok(Math.abs(finalPose[14] - 4) < 0.3, `ends at z 4, not ${finalPose[14]}`);
  });
});

test('the brake signal is on only while the car slows, and the tail lamp glows with it', async () => {
  await withCar(asset => {
    const drive = {
      path: CURVE, cruiseSpeed: 8, acceleration: 3, braking: 4,
      lights: { tailLights: [{ material: TAIL_LAMP_MATERIAL, signal: 'brake', off: 0.2, on: 6 }], headlights: [{ id: 'left', position: [0.5, 0.6, 2], direction: [0, 0, 1] }] },
    };
    const scene = createAgentAssetScene(asset, assetRecipe(drive));
    const reference = createAssetDrive(asset, drive);
    const duration = scene.exportRecipe().motion.duration;
    const lamp = scene.parts[1].material;
    let braking = 0;
    let coasting = 0;
    for (let time = 0.1; time < duration - 0.1; time += 0.05) {
      const slowing = reference.sample(time + 0.01).pose.speed - reference.sample(time - 0.01).pose.speed;
      scene.sampleMotion(time);
      const signal = motionDrive(scene).lights.brake;
      if (slowing < -0.01) {
        braking++;
        assert.ok(signal > 0, `braking at ${time} s shows ${signal}`);
        assert.ok(Math.abs(lamp.emission - (0.2 + 5.8 * signal)) < 1e-3);
      } else if (slowing > -1e-6) {
        coasting++;
        assert.equal(signal, 0, `not braking at ${time} s shows ${signal}`);
        assert.equal(lamp.emission, 0.2);
      }
    }
    assert.ok(braking > 5 && coasting > 20, `${braking} braking and ${coasting} other samples`);
    assert.equal(motionDrive(scene).lights.headlights[0].id, 'left');
  });
});

test('a bad drive names the problem', async () => {
  await withCar(asset => {
    assert.throws(() => createAgentAssetScene(asset, assetRecipe({ path: CURVE })), /exactly one of speed/);
    assert.throws(() => createAgentAssetScene(asset, assetRecipe({ path: CURVE, speed: 3, banana: 1 })), /^TypeError: motion\.drive\.banana: got 1; expected no such field; use one of path, legs, speed/);
    assert.throws(() => createAgentAssetScene(asset, assetRecipe({ path: CURVE, speed: 3, wheels: [{ node: 'Wheel_FL' }, { node: 'Nope' }] })), /^RangeError: motion\.drive\.wheels\[1\]\.node: got "Nope"; expected the name of a node in the asset, such as/);
    assert.throws(() => createAgentAssetScene(asset, assetRecipe({ path: CURVE, speed: 3, lights: { tailLights: [{ material: 'material-99', signal: 'brake' }] } })), /^RangeError: motion\.drive\.lights\.tailLights\[0\]\.material: got "material-99"; expected the id of a material in the asset, one of /);
    assert.throws(() => createAgentAssetScene(asset, assetRecipe({ path: CURVE, speed: 3 })).apply([{ type: 'set-motion', motion: { duration: 5, drive: { legs: [{ path: CURVE, direction: 'sideways' }], speed: 3 } } }], { expectedRevision: 0 }), /^RangeError: motion[.]drive[.]legs.0.[.]direction: got "sideways"; expected one of forward, reverse/);
  });
});

const sceneRecipe = (drive, translation = [10, 0, 0]) => ({
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'ground', type: 'box' }],
  materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
  nodes: [
    { id: 'floor', geometry: 'ground', material: 'grass', scale: [60, 0.1, 60] },
    { id: 'car', translation, asset: { id: ASSET_ID, drive } },
  ],
});

test('a placed car drives its path in the placement frame, with its own decoded copy', async () => {
  const drive = { path: [[0, 0, 0], [0, 0, 8], [4, 0, 14]], cruiseSpeed: 6 };
  const needs = recipeAssetNeeds(sceneRecipe(drive));
  assert.deepEqual(needs, [{ id: ASSET_ID, copies: 2 }]);
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(carAsset())], [assetCopyKey(ASSET_ID, 1), await parseGltf(carAsset())]]);
  try {
    const scene = createAgentScene(sceneRecipe(drive), {}, { assets });
    const body = () => scene.parts.find(part => part.name === 'car/0').matrix;
    scene.sampleMotion(0);
    assert.ok(Math.abs(body()[12] - 10) < 0.2, 'the car starts at its placement');
    scene.sampleMotion(60);
    assert.ok(Math.abs(body()[12] - 14) < 0.5 && Math.abs(body()[14] - 14) < 0.5, `ends at ${body()[12]}, ${body()[14]}`);
    const placed = scene.inspect({}).assets[0];
    assert.equal(placed.drive.wheels.length, 4);
    assert.deepEqual(placed.drive.rejectedNames.map(entry => entry.name), ['Steering_Wheel_Cover']);
    assert.equal(placed.drive.lights.brake, 0);
    assert.throws(() => createAgentScene(sceneRecipe({ ...drive, lights: { tailLights: [{ material: 'm', signal: 'brake' }] } }), {}, { assets }), /tail lights glow only in an asset recipe/);
  } finally {
    for (const asset of assets.values()) asset.dispose();
  }
});
