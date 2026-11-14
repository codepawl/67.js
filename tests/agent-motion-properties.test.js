import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { eulerFromQuaternion, quaternionFromEuler } from '../src/rotation-euler.js';

const DEGREES = Math.PI / 180;

function rigRecipe(motion, nodes = []) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      { id: 'face', type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 2 }, shapeKeys: [{ name: 'lift', offsets: [{ select: { tag: 'top' }, offset: [0, 0.5, 0] }] }] },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'lid', geometry: 'box', material: 'paint' },
      { id: 'head', geometry: 'face', material: 'paint' },
      ...nodes.map(node => ({ geometry: 'box', material: 'paint', ...node })),
    ],
    environment: { pointLights: [{ position: [0, 3, 0], color: [1, 0.5, 0.25], intensity: 4 }] },
    effects: {},
    motion,
  };
}

const OPEN = { node: 'lid', name: 'open', min: 0, max: 1, keys: [{ time: 0, value: 0 }, { time: 2, value: 1 }] };
const part = (scene, name) => scene.parts.find(candidate => candidate.name === name);
const worldEuler = (scene, name) => eulerFromQuaternion(mat4.getRotation(new Float64Array(4), part(scene, name).matrix)).map(radians => radians / DEGREES);
const worldPosition = (scene, name) => Array.from(mat4.getTranslation(new Float64Array(3), part(scene, name).matrix));
const close = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

function sampledAt(recipe, time) {
  const scene = createAgentScene(recipe);
  scene.sampleMotion(time);
  return scene;
}

test('one custom property opens a lid, dims a light and lifts a shape key', () => {
  const recipe = rigRecipe({
    duration: 2, tracks: [], properties: [OPEN],
    drivers: [
      { target: { kind: 'node', id: 'lid', property: 'rotation', component: 'x' }, expression: { mul: [{ custom: { node: 'lid', name: 'open' } }, 90] } },
      { target: { kind: 'light', id: 'point:0', property: 'intensity' }, expression: { sub: [1, { custom: { node: 'lid', name: 'open' } }] } },
      { target: { kind: 'morph', id: 'lift', property: 'weight' }, expression: { custom: { node: 'lid', name: 'open' } } },
    ],
  });
  const half = sampledAt(recipe, 1);
  close(worldEuler(half, 'lid')[0], 45, 1e-3);
  close(half.environment.pointLights[0].intensity, 0.5);
  close(Array.from(part(half, 'head').morph.weights)[0], 0.5);
  const open = sampledAt(recipe, 2);
  close(worldEuler(open, 'lid')[0], 90, 1e-3);
  close(open.environment.pointLights[0].intensity, 0);
  close(Array.from(part(open, 'head').morph.weights)[0], 1);
  const closed = sampledAt(recipe, 0);
  close(worldEuler(closed, 'lid')[0], 0, 1e-3);
  close(closed.environment.pointLights[0].intensity, 1);
});

test('vector and colour properties are read one component at a time and stay inside their range', () => {
  const properties = [
    { node: 'lid', name: 'offset', kind: 'vector', value: [1, 2, 3], min: -10, max: 10 },
    { node: 'lid', name: 'tint', kind: 'color', keys: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [1, 0.8, 0.25] }] },
  ];
  const scene = sampledAt(rigRecipe({
    duration: 2, tracks: [], properties,
    drivers: [
      { target: { kind: 'node', id: 'lid', property: 'translation', component: 'y' }, expression: { custom: { node: 'lid', name: 'offset', component: 'z' } } },
      { target: { kind: 'light', id: 'point:0', property: 'color', component: 'y' }, expression: { custom: { node: 'lid', name: 'tint', component: 'y' } } },
    ],
  }), 1);
  close(worldPosition(scene, 'lid')[1], 3);
  close(scene.environment.pointLights[0].color[1], 0.4);
  assert.deepEqual([scene.environment.pointLights[0].color[0], scene.environment.pointLights[0].color[2]], [1, 0.25]);
  const outOfRange = properties.map(property => ({ ...property }));
  outOfRange[0].value = [11, 0, 0];
  assert.throws(() => createAgentScene(rigRecipe({ duration: 2, tracks: [], properties: outOfRange, drivers: [{ target: { kind: 'node', id: 'lid', property: 'translation', component: 'x' }, expression: 1 }] })), /Motion property 0 value/);
});

test('a property lives on a bone as well as on a node', () => {
  const recipe = rigRecipe({
    duration: 1, tracks: [],
    properties: [{ node: 'rig_arm', name: 'bend', min: 0, max: 1, value: 0.5 }],
    drivers: [{ target: { kind: 'node', id: 'lid', property: 'translation', component: 'x' }, expression: { custom: { node: 'rig_arm', name: 'bend' } } }],
  }, [{ id: 'rig_arm' }]);
  close(worldPosition(sampledAt(recipe, 0), 'lid')[0], 0.5);
});

test('distance and rotation difference variables read world poses', () => {
  const recipe = rigRecipe({
    duration: 2,
    tracks: [
      { kind: 'node', id: 'a', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [3, 0, 0] }] },
      { kind: 'node', id: 'b', property: 'rotation', keyframes: [{ time: 0, value: Array.from(quaternionFromEuler(new Float64Array(4), 0, 0, 0)) }, { time: 1, value: Array.from(quaternionFromEuler(new Float64Array(4), 0, 60 * DEGREES, 0)) }] },
    ],
    drivers: [
      { target: { kind: 'node', id: 'lid', property: 'translation', component: 'x' }, expression: { distance: { from: 'a', to: 'c' } } },
      { target: { kind: 'node', id: 'lid', property: 'translation', component: 'y' }, expression: { rotationDifference: { from: 'b', to: 'c' } } },
    ],
  }, [{ id: 'a' }, { id: 'b' }, { id: 'c', translation: [0, 4, 0] }]);
  const scene = sampledAt(recipe, 1);
  close(worldPosition(scene, 'lid')[0], Math.hypot(1.5, 4));
  close(worldPosition(scene, 'lid')[1], 60, 1e-2);
});

test('the same time gives the same pose, and a seek equals play', () => {
  const recipe = rigRecipe({
    duration: 2, tracks: [], properties: [OPEN],
    drivers: [{ target: { kind: 'node', id: 'lid', property: 'rotation', component: 'x' }, expression: { mul: [{ custom: { node: 'lid', name: 'open' } }, 90] } }],
  });
  const played = createAgentScene(recipe);
  [0, 1.5, 0.25, 2, 0.75].forEach(time => played.sampleMotion(time));
  const sought = sampledAt(recipe, 0.75);
  assert.deepEqual(Array.from(part(played, 'lid').matrix), Array.from(part(sought, 'lid').matrix));
});

test('property and driver errors name the field and what to pass', () => {
  const build = (properties, expression = 1) => createAgentScene(rigRecipe({
    duration: 1, tracks: [], properties,
    drivers: [{ target: { kind: 'node', id: 'lid', property: 'translation', component: 'x' }, expression }],
  }));
  assert.throws(() => build([{ node: 'missing', name: 'open' }]), /Motion property 0 node.*node or bone ID/);
  assert.throws(() => build([{ node: 'lid', name: '' }]), /Motion property 0 name/);
  assert.throws(() => build([{ node: 'lid', name: 'open', kind: 'matrix' }]), /Motion property 0 kind.*number, vector, color/);
  assert.throws(() => build([{ node: 'lid', name: 'open', min: 1, max: 0 }]), /below max/);
  assert.throws(() => build([{ node: 'lid', name: 'open', value: 0, keys: [{ time: 0, value: 0 }] }]), /left out when keys are given/);
  assert.throws(() => build([{ node: 'lid', name: 'open', keys: [{ time: 1, value: 0 }, { time: 1, value: 1 }] }]), /rising times/);
  assert.throws(() => build([{ node: 'lid', name: 'open' }, { node: 'lid', name: 'open' }]), /no other property/);
  assert.throws(() => build(Array.from({ length: 33 }, (_, index) => ({ node: 'lid', name: `p${index}` }))), /bounded dense array/);
  assert.throws(() => build([{ node: 'lid', name: 'open' }], { custom: { node: 'lid', name: 'shut' } }), /no custom property "shut".*open/);
  assert.throws(() => build([{ node: 'lid', name: 'open' }], { custom: { node: 'lid', name: 'open', component: 'x' } }), /takes no component/);
  assert.throws(() => build([{ node: 'lid', name: 'tint', kind: 'color' }], { custom: { node: 'lid', name: 'tint' } }), /component must be x, y or z/);
  assert.throws(() => build([], { distance: { from: 'lid', to: 'nowhere' } }), /not in this scene/);
  assert.throws(() => build([], { distance: [1, 2] }), /plain object/);
  assert.throws(() => build([{ node: 'lid', name: 'open', code: 'x' }]), /Unknown or unsupported/);
});

test('light and morph driver targets are checked against the scene', () => {
  const build = target => createAgentScene(rigRecipe({ duration: 1, tracks: [], drivers: [{ target, expression: 0.5 }] }));
  assert.throws(() => build({ kind: 'light', id: 'point:3', property: 'intensity' }), /light was not found.*point:0/);
  assert.throws(() => build({ kind: 'light', id: 'point:0', property: 'position' }), /property must be one of intensity, color/);
  assert.throws(() => build({ kind: 'light', id: 'point:0', property: 'color' }), /needs a component/);
  assert.throws(() => build({ kind: 'morph', id: 'nope', property: 'weight' }), /morph was not found.*lift/);
  assert.throws(() => build({ kind: 'morph', id: 'lift', property: 'weight', component: 'x' }), /takes no component/);
  assert.throws(() => build({ kind: 'sun', id: 'x', property: 'intensity' }), /node, material, light, morph or camera/);
  const clash = rigRecipe({
    duration: 1, tracks: [{ kind: 'light', id: 'point:0', property: 'intensity', keyframes: [{ time: 0, value: 1 }] }],
    drivers: [{ target: { kind: 'light', id: 'point:0', property: 'intensity' }, expression: 1 }],
  });
  assert.throws(() => createAgentScene(clash), /a track on light point:0 already moves/);
  const tooBright = rigRecipe({ duration: 1, tracks: [], drivers: [{ target: { kind: 'morph', id: 'lift', property: 'weight' }, expression: 2 }] });
  assert.throws(() => createAgentScene(tooBright).sampleMotion(0), /morph weight from 0 to 1/);
});

test('the capabilities list the property limits', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.motionDrivers.maxProperties, 32);
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.motionDrivers.targets, ['node', 'material', 'light', 'morph', 'camera']);
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.motionDrivers.variables, ['time', 'node', 'custom', 'distance', 'rotationDifference']);
});
