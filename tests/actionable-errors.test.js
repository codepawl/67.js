import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { describeReceived, invalidField, withFieldPrefix } from '../src/field-error.js';

function baseRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    materials: [{ id: 'plain', color: [0.5, 0.5, 0.5] }, { id: 'paint', color: [0.2, 0.4, 0.8] }],
    nodes: [{ id: 'body', geometry: 'cube', material: 'paint' }, { id: 'child', parent: 'body' }],
    motion: { duration: 1, loop: false, tracks: [{ kind: 'node', id: 'body', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] },
  };
}

function badRecipe(change) {
  return async () => {
    const recipe = baseRecipe();
    change(recipe);
    await loadAgentSceneModules(recipe);
    return createAgentScene(recipe);
  };
}

function badApply(operation) {
  return async () => {
    const recipe = baseRecipe();
    await loadAgentSceneModules(recipe);
    const scene = createAgentScene(recipe);
    await loadAgentSceneModules(operation);
    return scene.apply([operation], { expectedRevision: 0 });
  };
}

// Each case: how an agent reaches the error, the full field path it must name, and the value it must echo.
const CASES = [
  ['material emissiveColor below zero', badRecipe(recipe => { recipe.materials[1].emissiveColor = [-1, 0, 0]; }), 'materials[1].emissiveColor', '[-1,0,0]'],
  ['material opacity above one', badRecipe(recipe => { recipe.materials[0].opacity = 2; }), 'materials[0].opacity', '2'],
  ['material metallic above one', badRecipe(recipe => { recipe.materials[0].metallic = 3; }), 'materials[0].metallic', '3'],
  ['material color above one', badRecipe(recipe => { recipe.materials[1].color = [2, 0, 0]; }), 'materials[1].color', '[2,0,0]'],
  ['material roughness as text', badRecipe(recipe => { recipe.materials[0].roughness = 'rough'; }), 'materials[0].roughness', '"rough"'],
  ['material alphaMode unknown', badRecipe(recipe => { recipe.materials[0].alphaMode = 'glass'; }), 'materials[0].alphaMode', '"glass"'],
  ['material emission below zero', badRecipe(recipe => { recipe.materials[0].emission = -2; }), 'materials[0].emission', '-2'],
  ['node scale not positive', badRecipe(recipe => { recipe.nodes[0].scale = [1, 0, 1]; }), 'nodes[0].scale', '[1,0,1]'],
  ['node rotation all zero', badRecipe(recipe => { recipe.nodes[1].rotation = [0, 0, 0, 0]; }), 'nodes[1].rotation', '[0,0,0,0]'],
  ['node translation with two numbers', badRecipe(recipe => { recipe.nodes[0].translation = [1, 2]; }), 'nodes[0].translation', '[1,2]'],
  ['node parent that is not text', badRecipe(recipe => { recipe.nodes[1].parent = 7; }), 'nodes[1].parent', '7'],
  ['camera fStop out of range', badRecipe(recipe => { recipe.camera = { fStop: 100 }; }), 'camera.fStop', '100'],
  ['camera fov out of range', badRecipe(recipe => { recipe.camera = { fov: 200 }; }), 'camera.fov', '200'],
  ['camera focalLength zero', badRecipe(recipe => { recipe.camera = { focalLength: 0 }; }), 'camera.focalLength', '0'],
  ['camera eye with one number', badRecipe(recipe => { recipe.camera = { eye: [1] }; }), 'camera.eye', '[1]'],
  ['point light intensity below zero', badRecipe(recipe => { recipe.environment = { pointLights: [{ position: [0, 1, 0], intensity: -1 }] }; }), 'environment.pointLights[0].intensity', '-1'],
  ['spot light angle too wide', badRecipe(recipe => { recipe.environment = { spotLights: [{ position: [0, 1, 0], direction: [0, -1, 0], angle: 5 }] }; }), 'environment.spotLights[0].angle', '5'],
  ['area light width zero', badRecipe(recipe => { recipe.environment = { areaLights: [{ position: [0, 1, 0], direction: [0, -1, 0], width: 0, height: 1 }] }; }), 'environment.areaLights[0].width', '0'],
  ['second point light position short', badRecipe(recipe => { recipe.environment = { pointLights: [{ position: [0, 1, 0] }, { position: [0, 1] }] }; }), 'environment.pointLights[1].position', '[0,1]'],
  ['fog density too high', badRecipe(recipe => { recipe.environment = { fogDensity: 99 }; }), 'environment.fogDensity', '99'],
  ['fog color above one', badRecipe(recipe => { recipe.environment = { fogColor: [0.2, 4, 0.2] }; }), 'environment.fogColor[1]', '4'],
  ['sun direction all zero', badRecipe(recipe => { recipe.environment = { lightDirection: [0, 0, 0] }; }), 'environment.lightDirection', '[0,0,0]'],
  ['view transform unknown', badRecipe(recipe => { recipe.environment = { viewTransform: 'filmic' }; }), 'environment.viewTransform', '"filmic"'],
  ['bake preset unknown', badRecipe(recipe => { recipe.bake = { preset: 'ultra' }; }), 'bake.preset', '"ultra"'],
  ['bake gridFog as text', badRecipe(recipe => { recipe.bake = { irradianceGrid: true, gridFog: 'yes' }; }), 'bake.gridFog', '"yes"'],
  ['mesh edit subdivide levels too high', badRecipe(recipe => { recipe.geometries[1].edits = [{ op: 'subdivide', levels: 9 }]; }), 'geometries[1].edits[0].levels', '9'],
  ['mesh edit bevel segments too high', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'bevel', edges: { all: true }, width: 0.1, segments: 40 }] }), 'edits[0].segments', '40'],
  ['mesh edit array count zero', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'array', count: 0 }] }), 'edits[0].count', '0'],
  ['mesh edit unknown op', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'knife' }] }), 'edits[0].op', '"knife"'],
  ['mesh edit offset as text', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'extrude_face_region', select: { all: true }, offset: 'far' }] }), 'edits[0].offset', '"far"'],
  ['motion scale keyframe not positive', badRecipe(recipe => { recipe.motion.tracks[0] = { kind: 'node', id: 'body', property: 'scale', keyframes: [{ time: 0, value: [1, 1, 1] }, { time: 1, value: [0, 1, 1] }] }; }), 'motion.tracks[0].keyframes[1].value', '[0,1,1]'],
  ['motion keyframe time past the duration', badRecipe(recipe => { recipe.motion.tracks[0].keyframes[0].time = 5; }), 'motion.tracks[0].keyframes[0].time', '5'],
  ['motion duration too long', badRecipe(recipe => { recipe.motion.duration = 100; }), 'motion.duration', '100'],
  ['motion loop as text', badRecipe(recipe => { recipe.motion.loop = 'yes'; }), 'motion.loop', '"yes"'],
  ['motion interpolation unknown', badRecipe(recipe => { recipe.motion.tracks[0].interpolation = 'BOUNCE'; }), 'motion.tracks[0].interpolation', '"BOUNCE"'],
];

// A message is actionable when it gives a way to fix the input: a range, a list of choices or an example.
const ACCEPTED = /such as|\bfrom -?[\d.e]+ to -?[\d.e]+|one of |true or false|above \d|\bor more\b/;

assert.ok(CASES.length >= 20, 'the walk covers at least 20 bad inputs');

for (const [label, trigger, path, received] of CASES) {
  test(`error for ${label} names the field, the value and what is accepted`, async () => {
    let message;
    try {
      await trigger();
    } catch (error) {
      message = error.message;
    }
    assert.ok(message, `${label} must throw`);
    assert.ok(message.includes(path), `path ${path} missing in: ${message}`);
    assert.ok(message.includes(`got ${received}`), `received value ${received} missing in: ${message}`);
    assert.match(message, /expected /, `no expectation in: ${message}`);
    assert.match(message, ACCEPTED, `no example or range in: ${message}`);
  });
}

test('a long received value is cut so the message stays short', () => {
  const shown = describeReceived('x'.repeat(500));
  assert.ok(shown.length <= 40);
  assert.ok(shown.endsWith('...'));
  assert.equal(describeReceived(undefined), 'undefined');
  assert.equal(describeReceived([1, 2]), '[1,2]');
  const circular = {};
  circular.self = circular;
  assert.equal(describeReceived(circular), '[object Object]');
});

test('withFieldPrefix puts the list position before a field path and leaves other errors alone', () => {
  assert.throws(() => withFieldPrefix('lights[3]', () => { throw invalidField('color', [2], 'three numbers'); }), /^RangeError: lights\[3\]\.color: got \[2\]/);
  assert.throws(() => withFieldPrefix('lights[3]', () => { throw new RangeError('Plain failure.'); }), /^RangeError: Plain failure\.$/);
});

test('a schema error through the MCP layer names the field path and the value received', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { createAgentMcpServer } = await import('../scripts/mcp-server.mjs');
  const server = createAgentMcpServer({ async close() {}, activeSessionId() { return null; } });
  const client = new Client({ name: 'actionable-errors-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const recipe = { format: '67js.scene', schemaVersion: 1, materials: [{ id: 'paint', color: [0.5, 0.5, 2] }], nodes: [] };
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /recipe\.materials\.0\.color\.2: Too big: expected number to be <=1 \(got 2\)/);
  } finally {
    await client.close();
  }
});
