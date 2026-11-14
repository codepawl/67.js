import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

function stillLife(chromeRoughness = 0.05, extraEnvironment = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'ball', type: 'sphere' }],
    materials: [
      { id: 'floor', color: [0.6, 0.6, 0.65], roughness: 0.9 },
      { id: 'chrome', color: [0.95, 0.95, 0.95], metallic: 1, roughness: chromeRoughness },
    ],
    nodes: [
      { id: 'ground', geometry: 'box', material: 'floor', translation: [0, -0.05, 0], scale: [6, 0.1, 6] },
      { id: 'ball', geometry: 'ball', material: 'chrome', translation: [0, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
    camera: { eye: [0, 1.2, 3], target: [0, 0.5, 0], fov: 50, near: 0.05, far: 20 },
    environment: extraEnvironment,
  };
}

test('a smooth metal part gets its own reflection probe without any field', () => {
  const scene = createAgentScene(stillLife());
  const reflections = scene.inspect().reflections;
  assert.equal(reflections.placed, 1);
  assert.equal(reflections.partsWithProbe, 1);
  const byName = new Map(scene.parts.map(part => [part.name, part]));
  assert.ok(byName.get('ball').material.environmentProbe);
  assert.equal(byName.get('ground').material.environmentProbe, undefined);
});

test('a scene with no reflective part reports nothing and keeps its parts untouched', () => {
  const rough = createAgentScene(stillLife(0.9));
  assert.equal(rough.inspect().reflections, undefined);
  assert.ok(rough.parts.every(part => part.material.environmentProbe === undefined));
});

test('environment.objectReflections false turns the probes off', () => {
  const scene = createAgentScene(stillLife(0.05, { objectReflections: false }));
  assert.equal(scene.inspect().reflections, undefined);
  assert.ok(scene.parts.every(part => part.material.environmentProbe === undefined));
  assert.throws(() => createAgentScene(stillLife(0.05, { objectReflections: 'no' })), /environment\.objectReflections: got "no"; expected true or false/);
});

test('an edit that changes nothing the probe sees keeps the traced probe', () => {
  const scene = createAgentScene(stillLife());
  const before = scene.parts.find(part => part.name === 'ball').material.environmentProbe;
  scene.apply([{ type: 'set-environment', environment: { objectReflections: true } }], { expectedRevision: scene.inspect().revision });
  assert.equal(scene.parts.find(part => part.name === 'ball').material.environmentProbe, before);
});
