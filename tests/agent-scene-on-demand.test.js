import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';

// These run in clean child processes: the test script preloads every module into its own process.
function runInCleanProcess(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const MESH_RECIPE = `{
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'block', type: 'mesh', base: { type: 'box' }, edits: [{ op: 'flip_normals' }] }],
  materials: [{ id: 'paint' }],
  nodes: [{ id: 'part', geometry: 'block', material: 'paint' }],
}`;

test('a recipe with only primitives needs no on-demand module', () => {
  const needed = agentSceneModulesNeeded({
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'paint', color: [1, 0, 0] }],
    nodes: [{ id: 'part', geometry: 'cube', material: 'paint' }],
  });
  assert.deepEqual(needed, []);
});

test('markers name the module a recipe needs', () => {
  assert.deepEqual(agentSceneModulesNeeded({ geometries: [{ id: 'g', type: 'mesh' }] }), ['mesh']);
  assert.deepEqual(agentSceneModulesNeeded({ geometries: [{ id: 'g', type: 'lathe' }] }), ['modeling']);
  assert.deepEqual(agentSceneModulesNeeded({ motion: { tracks: [] } }), ['motion']);
  assert.deepEqual(agentSceneModulesNeeded({ materials: [{ id: 'm', metallic: 0.9 }] }), ['reflections']);
  assert.deepEqual(agentSceneModulesNeeded({ materials: [{ id: 'm', metallic: 1 }] }), ['reflections']);
  assert.deepEqual(agentSceneModulesNeeded({ materials: [{ id: 'm', metallic: 0 }, { id: 'n', metallic: 0.2 }] }), []);
  assert.deepEqual(agentSceneModulesNeeded({ materials: [{ id: 'm', pattern: { type: 'bricks' } }] }), ['patterns']);
});

test('a primitive recipe runs without loading any module', () => {
  const output = runInCleanProcess(`
    import { createAgentScene, agentSceneModulesNeeded } from './src/agent-scene.js';
    import { agentSceneModuleLoaded } from './src/agent-scene-modules.js';
    const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'cube', type: 'box' }], materials: [{ id: 'paint' }], nodes: [{ id: 'part', geometry: 'cube', material: 'paint' }] };
    const scene = createAgentScene(recipe);
    console.log(JSON.stringify({ parts: scene.parts.length, needed: agentSceneModulesNeeded(recipe), loaded: ['mesh', 'modeling', 'motion', 'patterns'].filter(agentSceneModuleLoaded) }));
  `);
  assert.deepEqual(output, { parts: 1, needed: [], loaded: [] });
});

test('a mesh recipe says which call loads the mesh code, and runs once it is loaded', () => {
  const output = runInCleanProcess(`
    import { createAgentScene, loadAgentSceneModules } from './src/agent-scene.js';
    const recipe = ${MESH_RECIPE};
    let message = '';
    try {
      createAgentScene(recipe);
    } catch (error) {
      message = error.message;
    }
    await loadAgentSceneModules(recipe);
    console.log(JSON.stringify({ message, parts: createAgentScene(recipe).parts.length }));
  `);
  assert.match(output.message, /loadAgentSceneModules/);
  assert.equal(output.parts, 1);
});
