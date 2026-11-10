import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeAgentBake } from '../src/agent-bake.js';
import { BAKE_PRESETS } from '../src/agent-scene-capabilities.js';
import { closedRoom, closedRoomWithoutBake, lightmapBytes } from './support/agent-bake-rooms.mjs';

test('bake presets and fields resolve to plain numbers within their ranges', () => {
  assert.deepEqual(normalizeAgentBake({ preset: 'fine' }), { ...BAKE_PRESETS.fine, probes: 'room' });
  assert.deepEqual(normalizeAgentBake({}), { ...BAKE_PRESETS.standard, probes: 'room' });
  assert.deepEqual(normalizeAgentBake({ preset: 'draft', samples: 48 }), { ...BAKE_PRESETS.draft, samples: 48, probes: 'room' });
  assert.equal(normalizeAgentBake(null), null);
});

test('bake rejects hostile and out of range fields', () => {
  const hostile = [
    { preset: 'ultra' }, { samples: 0 }, { samples: 257 }, { samples: 1e9 }, { samples: NaN }, { samples: '64' },
    { samples: 2.5 }, { bounces: 9 }, { bounces: 1.5 }, { texelsPerUnit: 0.5 }, { texelsPerUnit: 13 },
    { maxSeconds: 600 }, { unknown: 1 }, [], 'standard', JSON.parse('{"__proto__":{"samples":1}}'),
  ];
  for (const input of hostile) {
    assert.throws(() => normalizeAgentBake(input), undefined, JSON.stringify(input));
  }
});

test('a recipe bake lights the room with lightmaps and reports its time and skipped parts', () => {
  const scene = createAgentScene(closedRoom());
  const bake = scene.inspect().bake;
  assert.equal(bake.reused, false);
  assert.ok(Number.isFinite(bake.seconds) && bake.seconds >= 0);
  assert.ok(bake.texels > 0);
  assert.deepEqual(bake.skipped, []);
  const floor = scene.parts.find(part => part.name === 'floor');
  assert.ok(floor.material.emissiveMap);
  assert.equal(floor.material.color[0], 0.8);
  const bulb = scene.parts.find(part => part.name === 'bulb');
  assert.equal(bulb.material.emissiveMap, undefined);
  assert.ok(bulb.material.lightMap);
  assert.equal(bulb.material.emission, 2);
  assert.equal(createAgentScene(closedRoomWithoutBake()).parts.some(part => part.material.emissiveMap), false);
});

test('the same recipe gives the same lightmap bytes', () => {
  const first = createAgentScene(closedRoom());
  const second = createAgentScene(closedRoom());
  for (const name of ['floor', 'back', 'block']) {
    const firstBytes = lightmapBytes(first.parts.find(part => part.name === name));
    const secondBytes = lightmapBytes(second.parts.find(part => part.name === name));
    assert.ok(firstBytes.length > 0);
    assert.deepEqual(firstBytes, secondBytes);
  }
});

test('a camera edit, a motion seek and a look edit that leaves the lights reuse the bake', () => {
  const scene = createAgentScene(closedRoom({ motion: { duration: 1, tracks: [{ kind: 'node', id: 'bulb', property: 'translation', keyframes: [{ time: 0, value: [0.9, 2.5, 0.6] }, { time: 1, value: [0.9, 2.5, 0.4] }] }] } }));
  const first = scene.inspect().bake;
  const partsBefore = scene.parts.map(part => part.material.emissiveMap);
  scene.apply([{ type: 'set-camera', eye: [0.3, 1.5, 1.9] }], { expectedRevision: 0 });
  scene.sampleMotion(0.5);
  scene.apply([{ type: 'set-effects', effects: { exposure: 1.2 } }], { expectedRevision: 1 });
  const after = scene.inspect().bake;
  assert.equal(after.reused, true);
  assert.equal(after.seconds, first.seconds);
  assert.deepEqual(scene.parts.map(part => part.material.emissiveMap), partsBefore);
});

test('moving a part, changing a light or changing the bake runs it again, and clearing it removes the lightmaps', () => {
  const scene = createAgentScene(closedRoom());
  scene.apply([{ type: 'set-node', id: 'block', translation: [0.5, 0.6, -0.4] }], { expectedRevision: 0 });
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-environment', environment: { pointLights: [{ position: [0, 2.5, 0.5], intensity: 14, radius: 0.1 }] } }], { expectedRevision: 1 });
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-bake', bake: { preset: 'draft', samples: 40 } }], { expectedRevision: 2 });
  assert.equal(scene.inspect().bake.samples, 40);
  assert.equal(scene.inspect().bake.reused, false);
  scene.apply([{ type: 'set-bake', bake: null }], { expectedRevision: 3 });
  assert.equal(scene.inspect().bake, undefined);
  assert.equal(scene.parts.some(part => part.material.emissiveMap), false);
  assert.equal(scene.exportRecipe().bake, null);
});

test('a failed bake leaves the scene as it was', () => {
  const scene = createAgentScene(closedRoom());
  assert.throws(() => scene.apply([{ type: 'set-bake', bake: { samples: 5000 } }], { expectedRevision: 0 }));
  assert.equal(scene.revision, 0);
  assert.equal(scene.inspect().bake.samples, BAKE_PRESETS.draft.samples);
});

test('a bake names the local volumes it leaves out and a scene without volumes reports as before', () => {
  const plain = createAgentScene(closedRoom()).inspect().bake;
  assert.equal(plain.skippedLocalVolumes, undefined);
  assert.equal(plain.warnings, undefined);

  const recipe = closedRoom();
  recipe.environment.localVolumes = [
    { shape: 'sphere', center: [0, 1, 0], radius: 0.5, emission: [1, 0.6, 0.2] },
    { shape: 'box', center: [1, 1, 0], size: [1, 1, 1] },
  ];
  const volumed = createAgentScene(recipe).inspect().bake;
  assert.deepEqual(volumed.skippedLocalVolumes, [
    { index: 0, shape: 'sphere', emissive: true },
    { index: 1, shape: 'box', emissive: false },
  ]);
  assert.equal(volumed.warnings.length, 1);
  assert.match(volumed.warnings[0], /localVolumes\[0\] \(sphere, emissive\), environment\.localVolumes\[1\] \(box\)/);
  assert.equal(volumed.texels, plain.texels);
});
