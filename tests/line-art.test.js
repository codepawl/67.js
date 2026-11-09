import test from 'node:test';
import assert from 'node:assert/strict';
import { LINE_ART_DEFAULTS, LINE_ART_LIMITS, resolveLineArt, installLineArt } from '../src/line-art.js';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { createFragmentShader } from '../src/shaders.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { materialLayerState, MATERIAL_LAYER_STATE_LENGTH } from '../src/material-layers.js';

const BASE_RECIPE = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }],
  materials: [{ id: 'gray', color: [0.5, 0.5, 0.5] }],
  nodes: [{ id: 'block', geometry: 'box', material: 'gray' }],
};

test('an empty lines object resolves to the documented defaults', () => {
  const lines = resolveLineArt({});
  assert.deepEqual(lines, { ...LINE_ART_DEFAULTS, color: [...LINE_ART_DEFAULTS.color] });
  assert.equal(lines.polylines, undefined);
});

test('lines fields are checked with messages that name the field', () => {
  assert.throws(() => resolveLineArt({ width: 0 }), /lines\.width must be a number between 0\.25 and 16/);
  assert.throws(() => resolveLineArt({ color: [1, 1] }), /lines\.color must be three/);
  assert.throws(() => resolveLineArt({ creaseAngle: 200 }), /lines\.creaseAngle/);
  assert.throws(() => resolveLineArt({ boundaries: 'yes' }), /lines\.boundaries must be true or false/);
  assert.throws(() => resolveLineArt({ colour: [0, 0, 0] }), /unknown field: colour/);
  assert.throws(() => resolveLineArt([]), /lines must be a JSON object/);
});

test('polylines take defaults from the outline settings and are bounded', () => {
  const lines = resolveLineArt({ width: 3, color: [1, 0, 0], polylines: [{ points: [[0, 0, 0], [1, 1, 1]] }, { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true, depthTest: false, width: 6 }] });
  assert.deepEqual(lines.polylines[0], { points: [[0, 0, 0], [1, 1, 1]], color: [1, 0, 0], width: 3, depthTest: true, closed: false });
  assert.equal(lines.polylines[1].width, 6);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0]] }] }), /needs 2 to 256 points/);
  assert.throws(() => resolveLineArt({ polylines: [{ points: [[0, 0, 0], [1, 0, 0]], dashed: true }] }), /unknown field: dashed/);
  const tooMany = Array.from({ length: LINE_ART_LIMITS.maxPolylines + 1 }, () => ({ points: [[0, 0, 0], [1, 0, 0]] }));
  assert.throws(() => resolveLineArt({ polylines: tooMany }), /at most 64 polylines/);
  const longLine = { points: Array.from({ length: 256 }, (_, index) => [index, 0, 0]) };
  assert.throws(() => resolveLineArt({ polylines: Array.from({ length: 17 }, () => longLine) }), /limit is 4096/);
});

test('the recipe markers load the line art module, and the recipe keeps the resolved lines', async () => {
  const recipe = { ...BASE_RECIPE, environment: { lines: { width: 2 } } };
  assert.ok(agentSceneModulesNeeded(recipe).includes('lineArt'));
  assert.ok(agentSceneModulesNeeded({ ...BASE_RECIPE, materials: [{ id: 'gray', toon: 3 }] }).includes('lineArt'));
  assert.ok(!agentSceneModulesNeeded(BASE_RECIPE).includes('lineArt'));
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  assert.equal(scene.environment.lines.width, 2);
  assert.deepEqual(scene.environment.lines.color, [...LINE_ART_DEFAULTS.color]);
  assert.equal(createAgentScene(BASE_RECIPE).environment.lines, undefined);
});

test('a recipe edit with lines null removes the outlines', async () => {
  const recipe = { ...BASE_RECIPE, environment: { lines: {} } };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  scene.apply([{ type: 'set-environment', environment: { lines: { width: 4 } } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.lines.width, 4);
  scene.apply([{ type: 'set-environment', environment: { lines: null } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.lines, undefined);
});

test('a material toon value is a layer field with its own range and shows in the batching state', async () => {
  const recipe = { ...BASE_RECIPE, materials: [{ id: 'gray', color: [0.5, 0.5, 0.5], toon: 3 }] };
  await loadAgentSceneModules(recipe);
  assert.equal(createAgentScene(recipe).parts[0].material.toon, 3);
  assert.throws(() => createAgentScene({ ...recipe, materials: [{ id: 'gray', toon: 9 }] }), /toon must be between 0 and 8/);
  const state = materialLayerState({ tag: 'surface', toon: 4 });
  assert.equal(state.length, MATERIAL_LAYER_STATE_LENGTH);
  assert.equal(state[22], 4);
  assert.equal(materialLayerState({ tag: 'surface' })[22], 0);
});

test('the toon feature splices its light steps into illuminate, and no other shader mentions it', () => {
  const toonShader = createFragmentShader(['toon']);
  assert.match(toonShader, /float toonLight\(float light\)/);
  assert.match(toonShader, /normalLight = toonLight\(normalLight\);/);
  assert.doesNotMatch(createFragmentShader([]), /toonLight/);
});

test('scene_capabilities names the field and the guide', () => {
  assert.equal(AGENT_SCENE_CAPABILITIES.lineArt.field, 'environment.lines');
  assert.equal(AGENT_SCENE_CAPABILITIES.lineArt.note, 'docs/line-art.md');
  for (const field of [...Object.keys(LINE_ART_DEFAULTS), 'polylines']) assert.ok(AGENT_SCENE_CAPABILITIES.lineArt.fields.includes(field), `${field} missing`);
  assert.ok(AGENT_SCENE_CAPABILITIES.materialLayers.toon.note);
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.materialLayers.toon.range, [0, 8]);
});

test('installLineArt needs render passes first and leaves a frame without lines untouched', () => {
  assert.throws(() => installLineArt({ postStages: [], render() {} }), /installRenderPasses/);
  const drawn = [];
  const renderer = { postStages: [], passSupport: {}, render: frame => drawn.push(frame), rebuildMainProgram() {} };
  installLineArt(renderer);
  const frame = { eye: [0, 0, 5] };
  renderer.render(frame);
  assert.deepEqual(drawn, [frame]);
  assert.equal(renderer.postStages.length, 1);
  assert.equal(installLineArt(renderer), renderer);
});

test('the MCP scene_create schema accepts lines (or null) and a material toon', async () => {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; } });
  const client = new Client({ name: '67js-line-art-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const outline = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'environment' } })).structuredContent.fields;
  assert.match(JSON.stringify(outline['lines?']), /null/);
  const material = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields' } })).structuredContent.fields;
  assert.ok(material['toon?']);
  await client.close();
  await server.close();
});

test('the addon finds the toon uniforms after the main program is rebuilt', () => {
  const located = [];
  const context = {
    getUniformLocation: (program, name) => {
      located.push(`${program}:${name}`);
      return name;
    },
    useProgram() {},
    uniform1f() {},
  };
  const renderer = {
    postStages: [], passSupport: {}, render() {}, program: 'first', uniforms: {}, context,
    rebuildMainProgram() { this.program = 'rebuilt'; },
  };
  installLineArt(renderer);
  assert.deepEqual(located, ['first:materialToon', 'first:toonDefault']);
  renderer.rebuildMainProgram();
  assert.equal(renderer.uniforms.materialToon, 'materialToon');
  assert.ok(located.includes('rebuilt:toonDefault'));
});
