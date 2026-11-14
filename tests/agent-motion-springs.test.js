import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene, loadAgentSceneModules } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const FRAME = 1 / 30;

/** A hips node that slides along X, with a tail of three bones along -Z. Each bone carries a small box to read its position. */
function tailRecipe(springs, extraMotion = {}) {
  const bone = (id, parent) => ({ id, parent, translation: [0, 0, -0.3] });
  const marker = (id, parent) => ({ id: `${id}-mesh`, parent, geometry: 'box', material: 'paint', scale: [0.02, 0.02, 0.02] });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: [
      { id: 'hips', translation: [0, 1, 0] },
      bone('tail1', 'hips'), bone('tail2', 'tail1'), bone('tail3', 'tail2'), bone('tailEnd', 'tail3'),
      marker('tail3', 'tail3'), marker('tailEnd', 'tailEnd'),
      { id: 'body', parent: 'hips' },
    ],
    motion: {
      duration: 6, loop: false,
      tracks: [{ kind: 'node', id: 'hips', property: 'translation', interpolation: 'LINEAR', keyframes: [
        { time: 0, value: [0, 1, 0] }, { time: 0.5, value: [0, 1, 0] }, { time: 0.75, value: [1, 1, 0] }, { time: 6, value: [1, 1, 0] },
      ] }],
      springs,
      ...extraMotion,
    },
  };
}

const CHAIN = { bones: ['tail1', 'tail2', 'tail3'], stiffness: 2, dragForce: 0.05 };

function tipAt(scene, time) {
  scene.sampleMotion(time);
  const part = scene.parts.find(candidate => candidate.name === 'tailEnd-mesh');
  return Array.from(mat4.getTranslation(new Float64Array(3), part.matrix));
}

function playTip(scene, seconds) {
  const tips = [];
  for (let frame = 0; frame * FRAME <= seconds + 1e-9; frame++) tips.push(tipAt(scene, frame * FRAME));
  return tips;
}

test('a recipe tail lags the sliding hips, overshoots and settles, the same on every run', async () => {
  const recipe = tailRecipe({ chains: [CHAIN] });
  await loadAgentSceneModules(recipe);
  const first = playTip(createAgentScene(recipe), 6);
  const second = playTip(createAgentScene(recipe), 6);
  assert.deepEqual(second, first);
  const hipsX = time => Math.min(1, Math.max(0, (time - 0.5) / 0.25));
  const lag = first[Math.round(0.7 / FRAME)][0] - hipsX(0.7);
  assert.ok(lag < -0.05, `the tip trails the hips by ${lag}`);
  assert.ok(Math.max(...first.map(tip => tip[0])) > 1.02, 'the tip swings past the hips');
  assert.ok(Math.abs(first[first.length - 1][0] - 1) < 0.01, 'the tip settles under the hips');
});

test('the exported recipe keeps every default so a bake or an agent reads the same springs', async () => {
  const recipe = tailRecipe({ chains: [CHAIN], colliders: [{ id: 'ball', bone: 'body', radius: 0.2 }] });
  await loadAgentSceneModules(recipe);
  const exported = createAgentScene(recipe).exportRecipe().motion.springs;
  assert.deepEqual(exported.chains[0], {
    bones: ['tail1', 'tail2', 'tail3'], stiffness: 2, dragForce: 0.05, gravityPower: 0, gravityDir: [0, -1, 0], hitRadius: 0.02, tipLength: 0.07, colliders: [],
  });
  assert.deepEqual(exported.colliders[0], { id: 'ball', bone: 'body', type: 'sphere', offset: [0, 0, 0], radius: 0.2 });
});

test('a motion with only springs is valid, and a bad chain says which field to fix', async () => {
  const recipe = tailRecipe({ chains: [CHAIN] });
  recipe.motion.tracks = [];
  await loadAgentSceneModules(recipe);
  assert.doesNotThrow(() => createAgentScene(recipe));
  const bad = tailRecipe({ chains: [{ ...CHAIN, bones: ['tail1', 'tail3'] }] });
  assert.throws(() => createAgentScene(bad), /motion\.springs\.chains\[0\]\.bones\[1\]: got "tail3"; expected the child of tail1/);
});

test('a bake turns whole chains into keys that match the live springs', async () => {
  const recipe = tailRecipe({ chains: [CHAIN] });
  await loadAgentSceneModules(recipe);
  const live = createAgentScene(recipe);
  const liveTips = playTip(live, 1.9);
  const baked = createAgentScene(recipe);
  assert.throws(
    () => baked.apply([{ type: 'bake-motion', nodes: ['tail1', 'tail2'], step: FRAME }], { expectedRevision: baked.revision }),
    /spring chain.*tail3/,
  );
  baked.apply([{ type: 'bake-motion', nodes: ['tail1', 'tail2', 'tail3'], start: 0, end: 1.9, step: FRAME }], { expectedRevision: baked.revision });
  assert.equal(baked.exportRecipe().motion.springs, undefined, 'the chain is gone once its result is keys');
  const bakedTips = playTip(baked, 1.9);
  bakedTips.forEach((tip, index) => {
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(tip[axis] - liveTips[index][axis]) < 0.01, `frame ${index} axis ${axis}: ${tip[axis]} vs ${liveTips[index][axis]}`);
  });
});

test('springs are listed in scene_capabilities', () => {
  assert.match(AGENT_SCENE_CAPABILITIES.springBones, /motion\.springs/);
});
