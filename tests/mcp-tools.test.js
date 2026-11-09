import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: 'mesh', geometry: 'cube', material: 'blue' }],
  };
}

async function connect(context) {
  let scene;
  let closed = false;
  let calls = 0;
  const sessionId = randomUUID();
  const checkpoints = new Map();
  const status = () => ({ sessionId, revision: scene.revision, inspection: scene.inspect(), render: { backend: 'fake' } });
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe: input }) {
      calls++;
      scene = createAgentScene(input);
      return status();
    },
    async inspect({ sessionId: requested, ...options }) {
      calls++;
      assert.equal(requested, sessionId);
      return { sessionId, ...scene.inspect(options) };
    },
    async inspectMeshes({ sessionId: requested, ...options }) {
      calls++;
      assert.equal(requested, sessionId);
      return { sessionId, ...scene.inspectMeshes(options) };
    },
    async editMesh({ sessionId: requested, expectedRevision, geometry, edits, replace }) {
      calls++;
      assert.equal(requested, sessionId);
      scene.apply([{ type: 'edit-mesh', geometry, edits, ...(replace === undefined ? {} : { replace }) }], { expectedRevision });
      return { ...status(), mesh: scene.inspectMeshes({ geometries: [geometry] }).meshes[0] };
    },
    async setMeshStack({ sessionId: requested, expectedRevision, geometry, stack, apply }) {
      calls++;
      assert.equal(requested, sessionId);
      scene.apply([{ type: 'set-mesh-stack', geometry, ...(stack === undefined ? {} : { stack }), ...(apply === undefined ? {} : { apply }) }], { expectedRevision });
      return { ...status(), mesh: scene.inspectMeshes({ geometries: [geometry] }).meshes[0] };
    },
    async apply({ expectedRevision, operations }) {
      calls++;
      scene.apply(operations, { expectedRevision });
      return status();
    },
    async look({ width, height, motionTime }) {
      calls++;
      if (motionTime !== undefined) {
        scene.sampleMotion(motionTime);
      }
      return { data: png, mimeType: 'image/png', metadata: { sessionId, revision: scene.revision,
        motionTime: scene.motionTime, width, height, backend: 'fake' } };
    },
    async review({ expectedRevision, width, height, shots }) {
      calls++;
      assert.equal(expectedRevision, scene.revision);
      return { data: png, mimeType: 'image/png', metadata: { sessionId,
        sourceRevision: scene.revision, width, height, shots, backend: 'fake' } };
    },
    async checkpoint() {
      const checkpointId = randomUUID();
      checkpoints.set(checkpointId, scene.checkpoint());
      return { checkpointId, sessionId, revision: scene.revision };
    },
    async restore({ checkpointId, expectedRevision }) {
      scene.restore(checkpoints.get(checkpointId), { expectedRevision });
      return status();
    },
    async releaseCheckpoint({ checkpointId }) {
      scene.releaseCheckpoint(checkpoints.get(checkpointId));
      checkpoints.delete(checkpointId);
      return { released: true, sessionId, checkpointId };
    },
    async exportRecipe() { return { sessionId, revision: scene.revision, recipe: scene.exportRecipe() }; },
    async exportGlb({ sessionId: requested, ...options }) {
      calls++;
      assert.equal(requested, sessionId);
      return { sessionId, revision: scene.revision, bytes: 12, parts: 1, clips: 0, filename: `${randomUUID()}.glb`, options };
    },
    async dispose() {
      scene = undefined;
      return { disposed: true, sessionId };
    },
    async close() { closed = true; },
    activeSessionId() { return scene ? sessionId : null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: '67js-boundary-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, server, sessionId, calls: () => calls, closed: () => closed };
}

async function rejected(client, name, argumentsValue) {
  let result;
  try {
    result = await client.callTool({ name, arguments: argumentsValue });
  } catch (error) {
    assert.match(error.message, /invalid|validation|schema|expected|unrecognized/i);
    return;
  }
  assert.equal(result.isError, true, `${name} must reject invalid arguments`);
}

test('SDK advertises the complete strict JSON contract and truthful annotations', async context => {
  const { client } = await connect(context);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'mesh_edit', 'mesh_inspect', 'mesh_stack', 'scene_apply', 'scene_asset_catalog', 'scene_capabilities', 'scene_checkpoint', 'scene_create', 'scene_create_asset', 'scene_dispose',
    'scene_export_glb', 'scene_export_recipe', 'scene_inspect', 'scene_look', 'scene_review', 'scene_release_checkpoint', 'scene_restore',
    'scene_render_cancel', 'scene_render_release', 'scene_render_result', 'scene_render_status', 'scene_render_submit', 'scene_walkmap',
  ].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.ok(tool.description.length > 20);
  }
  const apply = tools.find(tool => tool.name === 'scene_apply');
  assert.ok(apply.inputSchema.required.includes('expectedRevision'));
  assert.equal(apply.inputSchema.properties.operations.maxItems, 256);
  assert.equal(apply.annotations.idempotentHint, false);
  const create = tools.find(tool => tool.name === 'scene_create');
  const recipeSchema = create.inputSchema.properties.recipe;
  assert.equal(recipeSchema.additionalProperties, false);
  assert.equal(recipeSchema.properties.nodes.maxItems, 4096);
  assert.equal(recipeSchema.properties.materials.maxItems, 256);
  assert.equal(recipeSchema.properties.geometries.maxItems, 256);
  // The tool lists the common fields; the strict schema still validates and scene_capabilities serves the full outline.
  assert.deepEqual(recipeSchema.properties.geometries.items.properties.type.enum, ['box', 'cylinder', 'sphere', 'torus', 'lathe', 'extrude', 'tube', 'curve', 'text', 'terrain', 'grid', 'plane', 'cone', 'icoSphere', 'circle', 'line', 'mesh']);
  assert.ok(recipeSchema.properties.environment.properties.setup);
  assert.equal(recipeSchema.properties.shadow.additionalProperties, false);
  for (const topic of ['geometries', 'environment', 'effects', 'motion', 'physics', 'cloth', 'armatures', 'materialFields', 'meshEdit', 'meshStack']) {
    const answer = (await client.callTool({ name: 'scene_capabilities', arguments: { topic } })).structuredContent;
    assert.ok(answer.fields, `${topic} has an outline of its fields`);
  }
  assert.equal((await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'meshEdit.bevel' } })).structuredContent.fields.op, '"bevel"');
  assert.equal((await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'nope' } })).isError, true);
  const look = tools.find(tool => tool.name === 'scene_look');
  assert.equal(look.annotations.readOnlyHint, true);
  assert.equal(look.inputSchema.properties.width.maximum, 1024);
  assert.ok(look.inputSchema.properties.motionTime);
});

test('GLB export takes no path or code and rejects unknown or unbounded fields before dispatch', async context => {
  const { client, sessionId, calls } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === 'scene_export_glb');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['clip', 'maxTextureSize', 'motionTime', 'sessionId']);
  assert.equal(tool.inputSchema.properties.maxTextureSize.maximum, 4096);
  const result = await client.callTool({ name: 'scene_export_glb', arguments: { sessionId, clip: 0, maxTextureSize: 512 } });
  assert.deepEqual(result.structuredContent.options, { clip: 0, maxTextureSize: 512 });
  assert.match(result.structuredContent.filename, /^[0-9a-f-]{36}\.glb$/);
  const before = calls();
  for (const invalid of [
    { sessionId, path: 'C:/out.glb' }, { sessionId, filename: 'x.glb' }, { sessionId, code: 'console.log(1)' },
    { sessionId, clip: -1 }, { sessionId, clip: 256 }, { sessionId, maxTextureSize: 4097 }, { sessionId, motionTime: -1 },
    { sessionId: 'not-a-uuid' },
  ]) await rejected(client, 'scene_export_glb', invalid);
  assert.equal(calls(), before);
});

test('review SDK exposes one image and rejects unknown or unbounded shot fields before dispatch', async context => {
  const { client, sessionId, calls } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === 'scene_review');
  assert.equal(tools.length, 23);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.shots.maxItems, 4);
  assert.equal(tool.inputSchema.properties.shots.items.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.shots.items.properties.camera.additionalProperties, false);
  const input = { sessionId, expectedRevision: 0, shots: [{ label: 'Front', camera: { eye: [4, 2, 1] } }, {}] };
  const result = await client.callTool({ name: 'scene_review', arguments: input });
  assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(result.structuredContent.sourceRevision, 0);
  assert.equal(result.structuredContent.width, 384);
  assert.ok(!JSON.stringify(result.structuredContent).includes(png));
  const before = calls();
  for (const invalid of [
    { ...input, width: 481 }, { ...input, shots: [] }, { ...input, shots: Array(5).fill({}) },
    { ...input, code: 'console.log(1)' }, { ...input, shots: [{ camera: { projection: 'fisheye' } }] },
    { ...input, shots: [{ animation: { clip: 0, time: 0, url: 'https://example.com' } }] },
    { ...input, shots: [{ label: 'x'.repeat(49) }] }, { ...input, shots: [{ motionTime: -1 }] },
    { ...input, shots: [{ rendererTime: 3601 }] }, { ...input, expectedRevision: -1 },
  ]) await rejected(client, 'scene_review', invalid);
  assert.equal(calls(), before);
});

test('branch names and labels are bounded in every tool schema and rejected before dispatch', async context => {
  const { client, sessionId, calls } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const { tools } = await client.listTools();
  const schema = name => tools.find(tool => tool.name === name).inputSchema;
  assert.equal(tools.length, 23, 'branches add fields, not tools');
  const pattern = '^[a-z][a-z0-9_-]{0,23}$';
  assert.equal(schema('scene_apply').properties.branch.pattern, pattern);
  assert.equal(schema('scene_restore').properties.branch.pattern, pattern);
  assert.equal(schema('scene_review').properties.shots.items.properties.branch.pattern, pattern);
  assert.equal(schema('scene_look').properties.labels.type, 'boolean');
  assert.equal(schema('scene_review').properties.labels.type, 'boolean');
  assert.ok(!schema('scene_restore').required.includes('checkpointId'));
  const operations = [{ type: 'set-material', id: 'light', color: [1, 1, 1] }];
  const before = calls();
  for (const hostile of ['', 'Warm', '1warm', 'a'.repeat(25), '../x', 'a b', 'a\nb', 'https://example.com/x', '__proto__ ', 'a;rm', 7, null]) {
    await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, branch: hostile, operations });
    await rejected(client, 'scene_review', { sessionId, expectedRevision: 0, shots: [{ branch: hostile }] });
    await rejected(client, 'scene_restore', { sessionId, expectedRevision: 0, branch: hostile });
  }
  await rejected(client, 'scene_look', { sessionId, labels: 'yes' });
  await rejected(client, 'scene_review', { sessionId, expectedRevision: 0, labels: 1, shots: [{}] });
  assert.equal(calls(), before);
});

test('SDK rejects unknown fields, missing revisions, invalid vectors and oversized inputs before runtime dispatch', async context => {
  const boundary = await connect(context);
  const { client, sessionId } = boundary;
  await rejected(client, 'scene_capabilities', { javascript: 'process.exit()' });
  await rejected(client, 'scene_render_submit', { sessionId, settings: { kind: 'video', width: 320, height: 320 } });
  await rejected(client, 'scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: 320, height: 320, output: '../video.mp4' } });
  await rejected(client, 'scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: 320, height: 320, fps: 31 } });
  await rejected(client, 'scene_render_result', { jobId: '../video.mp4' });
  await rejected(client, 'scene_inspect', { sessionId: 'not-a-uuid' });
  await rejected(client, 'scene_look', { sessionId, width: 1025 });
  await rejected(client, 'scene_look', { sessionId, motionTime: -1 });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-motion' }] });
  await rejected(client, 'scene_asset_catalog', { path: 'C:/private/file.glb' });
  await rejected(client, 'scene_create_asset', { recipe: { format: '67js.asset', schemaVersion: 1, assetId: '../file.glb' } });
  await rejected(client, 'scene_create_asset', { recipe: { format: '67js.asset', schemaVersion: 1, assetId: 'a'.repeat(64), root: { javascript: 'run' } } });
  await rejected(client, 'scene_look', { sessionId, file: 'out.png' });
  await rejected(client, 'scene_restore', { sessionId, checkpointId: randomUUID() });
  await rejected(client, 'scene_apply', { sessionId, operations: [{ type: 'set-camera' }] });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [] });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: Array.from({ length: 257 }, () => ({ type: 'set-camera' })) });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-node', id: 'mesh', translation: [1, 2] }] });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), url: 'https://example.com/model' } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), geometries: [{ id: 'box', type: 'box', parameters: {} }] } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), geometries: [{ id: 'sphere', type: 'sphere', segments: 2049 }] } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), nodes: Array.from({ length: 4097 }, () => ({ id: 'node' })) } });
  assert.equal(boundary.calls(), 0);
});

test('mesh_inspect reports polygon counts, tags and lint for recipe geometries', async context => {
  const { client, sessionId } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: {
    ...recipe(),
    geometries: [
      { id: 'cube', type: 'box', bevel: 0 },
      { id: 'cable', type: 'tube', path: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], radius: 0.05 },
    ],
  } } });
  const result = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId } });
  assert.equal(result.isError, undefined);
  const [cube, cable] = result.structuredContent.meshes;
  assert.equal(cube.geometry, 'cube');
  assert.equal(cube.ok, true);
  assert.deepEqual(cube.faces, { triangles: 0, quads: 6, ngons: 0 });
  assert.equal(cube.tags.top, 1);
  assert.deepEqual(cube.problems, []);
  assert.equal(cable.parts.closed, 0, 'an uncapped tube is open');
  assert.equal(cable.problems[0].kind, 'boundary-edge');
  assert.ok(JSON.stringify(result.structuredContent).length < 4096, 'default report stays compact');
  const one = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId, geometries: ['cube'] } });
  assert.equal(one.structuredContent.meshes.length, 1);
  const singular = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId, geometry: 'cube' } });
  assert.deepEqual(singular.structuredContent.meshes.map(mesh => mesh.geometry), ['cube']);
  const missing = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId, geometries: ['nope'] } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /geometries: got "nope"; expected one of cube, cable/);
  await rejected(client, 'mesh_inspect', { sessionId, geometries: [] });
  await rejected(client, 'mesh_inspect', { sessionId, geometries: Array.from({ length: 17 }, (_, index) => `g${index}`) });
  await rejected(client, 'mesh_inspect', { sessionId, path: '../file' });
});

test('mesh_edit builds a mesh from a base and an edit log through the SDK', async context => {
  const { client, sessionId } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: {
    ...recipe(),
    geometries: [{ id: 'cube', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
      { op: 'inset_region', select: { tag: 'top' }, thickness: 0.1, name: 'lid' },
    ] }],
  } } });
  const edited = await client.callTool({ name: 'mesh_edit', arguments: { sessionId, expectedRevision: 0, geometry: 'cube',
    edits: [{ op: 'extrude_face_region', select: { tag: 'lid.cap' }, offset: 0.25, name: 'knob' }] } });
  assert.equal(edited.isError, undefined, edited.content?.[0]?.text);
  const { revision, mesh } = edited.structuredContent;
  assert.equal(revision, 1);
  assert.equal(mesh.ok, true);
  assert.equal(mesh.parts.closed, 1);
  assert.deepEqual(mesh.edits.map(result => result.tags), [{ 'lid.cap': 1, 'lid.rim': 4 }, { 'knob.cap': 1, 'knob.side': 4 }]);
  assert.equal(mesh.bounds.max[1], 0.75);
  const empty = await client.callTool({ name: 'mesh_edit', arguments: { sessionId, expectedRevision: 1, geometry: 'cube',
    edits: [{ op: 'delete', select: { normal: [0, 1, 0], maxAngle: 0, faces: [] } }] } });
  assert.equal(empty.isError, true);
  const none = await client.callTool({ name: 'mesh_edit', arguments: { sessionId, expectedRevision: 1, geometry: 'cube',
    edits: [{ op: 'delete', select: { tag: 'lid.rim' } }, { op: 'delete', select: { tag: 'lid.rim' } }] } });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /Unknown tag lid\.rim|selects no faces/);
  const exported = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId } });
  assert.equal(exported.structuredContent.recipe.geometries[0].edits.length, 2, 'failed edits leave the log unchanged');
  const replaced = await client.callTool({ name: 'mesh_edit', arguments: { sessionId, expectedRevision: 1, geometry: 'cube', replace: true,
    edits: [{ op: 'extrude_individual', select: { tag: 'side' }, offset: 0.1 }] } });
  assert.equal(replaced.structuredContent.mesh.edits.length, 1);
  await rejected(client, 'mesh_edit', { sessionId, expectedRevision: 2, geometry: 'cube', edits: [{ op: 'knife', select: { all: true } }] });
  await rejected(client, 'mesh_edit', { sessionId, expectedRevision: 2, geometry: 'cube', edits: [] });
  await rejected(client, 'mesh_edit', { sessionId, expectedRevision: 2, geometry: 'cube', edits: [{ op: 'translate', offset: [0, 1, 0], code: 'run()' }] });
});

test('mesh_stack sets, changes and applies a modifier stack through the SDK', async context => {
  const { client, sessionId } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: {
    ...recipe(),
    geometries: [{ id: 'cube', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'translate', offset: [0.5, 0, 0] }] }],
  } } });
  const set = await client.callTool({ name: 'mesh_stack', arguments: { sessionId, expectedRevision: 0, geometry: 'cube',
    stack: [{ op: 'mirror', axis: 'x' }, { op: 'array', count: 3, relativeOffset: [0, 0, 1.5] }] } });
  assert.equal(set.isError, undefined, set.content?.[0]?.text);
  assert.equal(set.structuredContent.mesh.parts.count, 3);
  assert.deepEqual(set.structuredContent.mesh.stack.map(node => node.op), ['mirror', 'array']);
  const applied = await client.callTool({ name: 'mesh_stack', arguments: { sessionId, expectedRevision: 1, geometry: 'cube', apply: 1 } });
  assert.equal(applied.isError, undefined, applied.content?.[0]?.text);
  const exported = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId } });
  assert.deepEqual(exported.structuredContent.recipe.geometries[0].edits.map(edit => edit.op), ['translate', 'mirror']);
  await rejected(client, 'mesh_stack', { sessionId, expectedRevision: 2, geometry: 'cube', stack: [{ op: 'extrude_individual', offset: 1 }] });
  await rejected(client, 'mesh_stack', { sessionId, expectedRevision: 2, geometry: 'cube', stack: [{ op: 'array', count: 1000 }] });
});

test('real SDK round trip authors motion, seeks without revisions and rejects unknown track fields', async context => {
  const { client, sessionId } = await connect(context);
  const motion = { duration: 1, tracks: [{ kind: 'node', id: 'mesh', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] };
  await client.callTool({ name: 'scene_create', arguments: { recipe: { ...recipe(), motion } } });
  for (const motionTime of [1, 0.2, 0, null]) {
    const looked = await client.callTool({ name: 'scene_look', arguments: { sessionId, motionTime } });
    assert.equal(looked.isError, undefined);
    assert.equal(looked.structuredContent.revision, 0);
    assert.equal(looked.structuredContent.motionTime, motionTime);
  }
  const exported = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId } });
  assert.equal(exported.structuredContent.recipe.motion.tracks[0].property, 'translation');
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-motion',
    motion: { ...motion, tracks: [{ ...motion.tracks[0], javascript: 'run()' }] } }] });
  const cleared = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: 0,
    operations: [{ type: 'set-motion', motion: null }] } });
  assert.equal(cleared.structuredContent.revision, 1);
});

test('real SDK calls preserve atomic revisions, checkpoints, recipe snapshots and PNG content', async context => {
  const boundary = await connect(context);
  const { client, sessionId } = boundary;
  const call = (name, argumentsValue = {}) => client.callTool({ name, arguments: argumentsValue });
  const capabilities = await call('scene_capabilities');
  assert.equal(capabilities.structuredContent.format, '67js.scene');
  const created = await call('scene_create', { recipe: recipe() });
  assert.equal(created.structuredContent.sessionId, sessionId);
  const revision = created.structuredContent.revision;
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const edited = await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-node', id: 'mesh', translation: [1, 2, 3] }] });
  assert.equal(edited.structuredContent.revision, revision + 1);
  const stale = await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-node', id: 'mesh', translation: [9, 9, 9] }] });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /expectedRevision/);
  const inspected = await call('scene_inspect', { sessionId, includeBounds: true });
  assert.equal(inspected.structuredContent.revision, revision + 1);
  assert.ok(inspected.structuredContent.nodes[0].bounds);
  const image = await call('scene_look', { sessionId });
  assert.deepEqual(image.content[0], { type: 'image', data: png, mimeType: 'image/png' });
  assert.equal(Buffer.from(image.content[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(JSON.parse(image.content[1].text), image.structuredContent);
  assert.equal(image.structuredContent.width, 768);
  assert.equal(image.structuredContent.height, 512);
  assert.equal(Object.hasOwn(image.structuredContent, 'data'), false);
  const restored = await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision + 1 });
  assert.equal(restored.structuredContent.revision, revision + 2);
  const exported = await call('scene_export_recipe', { sessionId });
  assert.deepEqual(exported.structuredContent.recipe.nodes[0].translation, [0, 0, 0]);
  assert.deepEqual(JSON.parse(exported.content[0].text), exported.structuredContent);
  assert.equal((await call('scene_release_checkpoint', { sessionId, checkpointId: checkpoint.checkpointId })).structuredContent.released, true);
  const released = await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision + 2 });
  assert.equal(released.isError, true);
  assert.match(released.content[0].text, /checkpointId: got .*expected a checkpointId that scene_checkpoint returned and you have not released/);
  assert.equal((await call('scene_dispose', { sessionId })).structuredContent.disposed, true);
  await boundary.server.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(boundary.closed(), true);
});

test('SDK stdio EOF closes the runtime without launching a scene', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createAgentMcpServer({ async close() { resolveClosed(); } });
  await server.connect(new StdioServerTransport(input, output));
  input.end();
  await closed;
  assert.equal(output.readableLength, 0);
  await server.close();
  input.destroy();
  output.destroy();
});

test('branches off leaves the branch field and the variants advice out of the schemas', async context => {
  const server = createAgentMcpServer({ async close() {}, activeSessionId() { return null; } }, { branches: false });
  const client = new Client({ name: '67js-branches-off-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  for (const toolName of ['scene_apply', 'scene_restore', 'scene_review']) {
    const tool = tools.find(candidate => candidate.name === toolName);
    assert.ok(!JSON.stringify(tool.inputSchema).includes('"branch"'), `${toolName} must not offer a branch`);
  }
  const restore = tools.find(candidate => candidate.name === 'scene_restore');
  assert.ok(restore.inputSchema.required.includes('checkpointId'));
  assert.ok(!client.getInstructions().includes('branch'));
});

test('relations off leaves the relations field and the relations capabilities out', async context => {
  const runtime = { async close() {}, activeSessionId() { return null; }, async capabilities() { return { scene: { relations: { kinds: {} }, rigging: {} } }; } };
  const clients = {};
  for (const relations of [true, false]) {
    const server = createAgentMcpServer(runtime, { relations });
    const client = new Client({ name: `67js-relations-${relations}-test`, version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    context.after(async () => {
      await client.close();
      await server.close();
    });
    clients[relations] = client;
  }
  for (const toolName of ['scene_create', 'scene_apply']) {
    const schemaOf = async relations => JSON.stringify((await clients[relations].listTools()).tools.find(candidate => candidate.name === toolName).inputSchema);
    assert.ok((await schemaOf(true)).includes('"relations"'), `${toolName} offers relations by default`);
    assert.ok(!(await schemaOf(false)).includes('"relations"'), `${toolName} must not offer relations`);
  }
  const sceneTopicsOf = async relations => (await clients[relations].callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent.topics.scene;
  assert.ok((await sceneTopicsOf(true)).includes('relations'));
  assert.ok(!(await sceneTopicsOf(false)).includes('relations'));
  assert.ok((await sceneTopicsOf(false)).includes('rigging'));
});

test('SDK dynamic batches create resources, reject dangling edits, and restore scene membership', async context => {
  const { client, sessionId } = await connect(context);
  const call = (name, argumentsValue) => client.callTool({ name, arguments: argumentsValue });
  await call('scene_create', { recipe: { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] } });
  const initial = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const added = await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'add-geometry', geometry: { id: 'cube', type: 'box' } },
    { type: 'add-material', material: { id: 'paint', color: [0.2, 0.6, 0.8] } },
    { type: 'add-node', node: { id: 'group' } },
    { type: 'add-node', node: { id: 'mesh', parent: 'group', geometry: 'cube', material: 'paint' } },
  ] });
  assert.equal(added.isError, undefined);
  assert.equal(added.structuredContent.inspection.counts.parts, 1);
  const invalid = await call('scene_apply', { sessionId, expectedRevision: 1, operations: [{ type: 'remove-geometry', id: 'cube' }] });
  assert.equal(invalid.isError, true);
  const inspected = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(inspected.revision, 1);
  assert.equal(inspected.counts.geometries, 1);
  const restored = await call('scene_restore', { sessionId, checkpointId: initial.checkpointId, expectedRevision: 1 });
  assert.equal(restored.structuredContent.inspection.counts.parts, 0);
  assert.equal(restored.structuredContent.inspection.counts.geometries, 0);
});

test('a tool that takes a sessionId defaults to the active scene, and still rejects a session that is not active', async context => {
  const { client, sessionId } = await connect(context);
  const { tools } = await client.listTools();
  for (const tool of tools.filter(candidate => candidate.inputSchema.properties?.sessionId)) {
    assert.ok(!tool.inputSchema.required?.includes('sessionId'), `${tool.name} must not require sessionId`);
  }
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const inspected = await client.callTool({ name: 'scene_inspect', arguments: {} });
  assert.equal(inspected.isError, undefined);
  assert.equal(inspected.structuredContent.sessionId, sessionId);
  const checkpoint = await client.callTool({ name: 'scene_checkpoint', arguments: {} });
  assert.equal(checkpoint.isError, undefined);
  await rejected(client, 'scene_inspect', { sessionId: 'not-a-uuid' });
  const invalid = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: 'not-a-uuid' } }).catch(error => error);
  assert.match(String(invalid.message ?? invalid.content?.[0]?.text), /Leave it out/);
});

test('scene_apply names the fix when the fields of set-node are wrapped in a node key', async context => {
  const { client } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const wrapped = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0,
    operations: [{ type: 'set-node', node: { id: 'mesh', translation: [1, 0, 0] } }] } }).catch(error => error);
  assert.match(String(wrapped.message ?? wrapped.content?.[0]?.text), /Move the fields of node up one level/);
});

test('scene_create accepts a recipe with no materials list', async context => {
  const { client } = await connect(context);
  const minimal = recipe();
  delete minimal.materials;
  delete minimal.nodes[0].material;
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: minimal } });
  assert.equal(created.isError, undefined);
});

test('a failed scene_create says the scene was not created and what to do, so the agent retries instead of inspecting', async context => {
  const { client } = await connect(context);
  const broken = recipe();
  broken.nodes[0].geometry = 'nothing';
  const result = await client.callTool({ name: 'scene_create', arguments: { recipe: broken } });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /No scene was created/);
  assert.match(text, /call scene_create again/);
  const inspected = await client.callTool({ name: 'scene_inspect', arguments: { ids: ['mesh'] } });
  assert.equal(inspected.isError, true);
  assert.doesNotMatch(inspected.content[0].text, /No scene was created/);
});
