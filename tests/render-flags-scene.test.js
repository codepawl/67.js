// Per-node render flags (issue 606): visible keyed in a motion track, and the flags reaching the renderer parts.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { groupParts } from '../src/renderer.js';

function recipe(overrides = {}) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.2, 0.4, 0.6], emission: 0 }],
    nodes: [
      { id: 'group' },
      { id: 'first', parent: 'group', geometry: 'box', material: 'finish' },
      { id: 'second', geometry: 'box', material: 'finish', translation: [2, 0, 0] },
    ],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
    ...overrides,
  };
}

const visibleTrack = { kind: 'node', id: 'group', property: 'visible', keyframes: [
  { time: 0, value: 1 }, { time: 1, value: 0 }, { time: 2, value: 1 },
] };

function hiddenNames(scene) {
  return scene.parts.filter(part => part.visibility?.visible === false).map(part => part.name);
}

test('a visible track hides a node and its children from the keyed time, with the same parts', () => {
  const scene = createAgentScene(recipe({ motion: { duration: 2, tracks: [visibleTrack] } }));
  const parts = scene.parts;
  assert.deepEqual(hiddenNames(scene), []);
  scene.sampleMotion(1.5);
  assert.deepEqual(hiddenNames(scene), ['first']);
  scene.sampleMotion(0.5);
  assert.deepEqual(hiddenNames(scene), []);
  scene.sampleMotion(2);
  assert.deepEqual(hiddenNames(scene), []);
  scene.sampleMotion(1);
  assert.deepEqual(hiddenNames(scene), ['first']);
  assert.equal(scene.parts, parts, 'a keyed visibility is not a topology change');
});

test('a static visible:false node is hidden and a track can show it again', () => {
  const hidden = createAgentScene(recipe({ nodes: [{ id: 'only', geometry: 'box', material: 'finish', visible: false }] }));
  assert.deepEqual(hiddenNames(hidden), ['only']);
  const keyed = createAgentScene(recipe({
    nodes: [{ id: 'only', geometry: 'box', material: 'finish', visible: false }],
    motion: { duration: 1, tracks: [{ kind: 'node', id: 'only', property: 'visible', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 1 }] }] },
  }));
  assert.deepEqual(hiddenNames(keyed), ['only']);
  keyed.sampleMotion(0.75);
  assert.deepEqual(hiddenNames(keyed), []);
});

test('scenes that never use visibility add no part fields', () => {
  const scene = createAgentScene(recipe());
  for (const part of scene.parts) {
    assert.deepEqual(Object.keys(part).sort(), ['geometry', 'material', 'matrix', 'name']);
  }
});

test('shadow and composite flags reach the part and split batches', () => {
  const scene = createAgentScene(recipe({ nodes: [
    { id: 'plain', geometry: 'box', material: 'finish' },
    { id: 'blind', geometry: 'box', material: 'finish', receiveShadow: false },
    { id: 'quiet', geometry: 'box', material: 'finish', castShadow: false },
    { id: 'cut', geometry: 'box', material: 'finish', holdout: true },
    { id: 'catcher', geometry: 'box', material: 'finish', shadowCatcher: true },
    { id: 'other', geometry: 'box', material: 'finish' },
  ] }));
  const byName = new Map(scene.parts.map(part => [part.name, part]));
  assert.equal(byName.get('blind').receiveShadow, false);
  assert.equal(byName.get('quiet').castShadow, false);
  assert.equal(byName.get('cut').holdout, true);
  assert.equal(byName.get('catcher').shadowCatcher, true);
  assert.equal(byName.get('plain').holdout, undefined);
  const batches = groupParts(scene.parts).map(batch => batch.map(part => part.name).sort());
  assert.equal(batches.length, 5, 'plain and other share a batch, each flag gets its own');
  assert.ok(batches.some(names => names.join() === 'other,plain'));
});

test('flags must be booleans on mesh nodes and a node is not both holdout and catcher', () => {
  const node = fields => recipe({ nodes: [{ id: 'one', geometry: 'box', material: 'finish', ...fields }] });
  assert.throws(() => createAgentScene(node({ castShadow: 'no' })), /nodes\[0\]\.castShadow: got "no"; expected true or false/);
  assert.throws(() => createAgentScene(node({ visible: 0 })), /nodes\[0\]\.visible: got 0; expected true or false/);
  assert.throws(() => createAgentScene(node({ holdout: true, shadowCatcher: true })), /nodes\[0\]\.shadowCatcher: got true; expected false when holdout is true/);
  assert.throws(() => createAgentScene(recipe({ nodes: [{ id: 'g', holdout: true }] })), /nodes\[0\]\.holdout: got true; expected a flag on a mesh node/);
  assert.throws(() => createAgentScene(recipe({ motion: { duration: 1, tracks: [{ kind: 'node', id: 'first', property: 'visible', keyframes: [{ time: 0, value: 0.5 }] }] } })), /1 \(shown\) or 0/);
});
