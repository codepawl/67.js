import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { fitSettingsToBudget } from '../src/agent-bake.js';
import { estimateBake } from '../src/light-bake.js';
import { BAKE_PRESETS, BAKE_PRESET_PATH_WORK } from '../src/agent-scene-capabilities.js';
import { closedRoom, clothRoom } from './support/agent-bake-rooms.mjs';

test('a cloth sheet is skipped by the bake and still has no lightmap after a seek past t=0', () => {
  const scene = createAgentScene(clothRoom());
  const skipped = scene.inspect().bake.skipped.find(entry => entry.name === 'flag');
  assert.ok(skipped);
  assert.match(skipped.reason, /cloth/);
  scene.sampleMotion(1);
  const flag = scene.parts.find(part => part.name === 'flag');
  assert.equal(flag.material.lightMap, undefined);
  assert.equal(flag.material.emissiveMap, undefined);
  for (const part of scene.parts) {
    assert.ok(!part.material.lightMap || part.geometry.lightUvs, `${part.name} has a light map without lightUvs`);
  }
  assert.ok(scene.parts.find(part => part.name === 'floor').material.emissiveMap);
});

test('a bake places a room probe unless bake.probes is false', () => {
  const withProbe = createAgentScene(closedRoom()).inspect().bake;
  assert.equal(withProbe.probes.placed.length, 1);
  const optedOut = createAgentScene(closedRoom({ bake: { preset: 'draft', probes: false } })).inspect().bake;
  assert.equal(optedOut.probes, false);
});


function syntheticPlan(partAreas) {
  return {
    settings: { maxResolution: 512 },
    entries: partAreas.map(area => ({ area, unwrapped: { utilization: 1 } })),
    lights: { pointLights: [{}], spotLights: [], areaLights: [], sun: false },
  };
}

function pathWork(plan, settings) {
  return estimateBake(plan, settings).texels * settings.samples * settings.bounces;
}

test('a preset on a hall too large for its floor gives up bounces before it refuses, and says what it did', () => {
  const hall = syntheticPlan(Array.from({ length: 160 }, () => 900));
  const floorWork = pathWork(hall, { ...BAKE_PRESETS.standard, samples: 16, texelsPerUnit: 1 });
  assert.ok(floorWork > BAKE_PRESET_PATH_WORK, 'the hall must not fit at the floor with every bounce');
  const { used, reduced, reduction } = fitSettingsToBudget(hall, { ...BAKE_PRESETS.standard, probes: 'room' });
  assert.equal(reduced, true);
  assert.ok(used.bounces < BAKE_PRESETS.standard.bounces);
  assert.ok(pathWork(hall, used) <= BAKE_PRESET_PATH_WORK);
  assert.match(reduction, /bounces 3/);
  assert.match(reduction, new RegExp(`bounces ${used.bounces}`));
  assert.match(reduction, /explicit samples, bounces and texelsPerUnit/);
});

test('a preset keeps its bounces when only samples and density need to shrink, and is silent when it fits', () => {
  const room = syntheticPlan(Array.from({ length: 56 }, () => 9));
  const { used, reduced, reduction } = fitSettingsToBudget(room, { ...BAKE_PRESETS.standard, probes: 'room' });
  assert.equal(reduced, true);
  assert.equal(used.bounces, BAKE_PRESETS.standard.bounces);
  assert.match(reduction, /too large/);
  const small = fitSettingsToBudget(syntheticPlan([4]), { ...BAKE_PRESETS.standard, probes: 'room' });
  assert.deepEqual([small.reduced, small.reduction], [false, null]);
});

test('a scene too large for one bounce at the floor is still refused, with the budget in the message', () => {
  const impossible = syntheticPlan(Array.from({ length: 2000 }, () => 900));
  assert.throws(() => fitSettingsToBudget(impossible, { ...BAKE_PRESETS.draft, probes: 'room' }), /preset budget/);
});
