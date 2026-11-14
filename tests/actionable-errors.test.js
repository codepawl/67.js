import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene } from '../src/agent-scene.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';
import { carAsset } from './fixtures/car-glb.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { describeReceived, invalidField, withFieldPrefix } from '../src/field-error.js';

function baseRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
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

const ASSET_ID = 'ca'.repeat(32);
const DRIVE_PATH = [[0, 0, 0], [0, 0, 12], [6, 0, 22]];

// Builds the decoded car asset, hands it to the check and releases it afterwards.
async function withCar(check) {
  const asset = await parseGltf(carAsset());
  try {
    return await check(asset);
  } finally {
    asset.dispose();
  }
}

function badAsset(change) {
  return () => withCar(asset => {
    const recipe = { format: 'crucible.asset', schemaVersion: 1, assetId: ASSET_ID };
    change(recipe);
    return createAgentAssetScene(asset, recipe);
  });
}

function badAssetApply(operation) {
  return () => withCar(asset => createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: ASSET_ID }).apply([operation], { expectedRevision: 0 }));
}

function badAssetInspect(options) {
  return () => withCar(asset => createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: ASSET_ID }).inspect(options));
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
  ['physics body mass below range', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 1, bodies: [{ node: 'body', mass: -1 }] }; }), 'physics.bodies[0].mass', '-1'],
  ['physics body type unknown', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 1, bodies: [{ node: 'body', type: 'liquid' }] }; }), 'physics.bodies[0].type', '"liquid"'],
  ['physics velocity on a fixed body', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 1, bodies: [{ node: 'body', type: 'fixed', velocity: [1, 0, 0] }] }; }), 'physics.bodies[0].velocity', '[1,0,0]'],
  ['physics joint to a node without a body', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 1, bodies: [{ node: 'body' }], joints: [{ type: 'fixed', bodyA: 'body', bodyB: 'ghost' }] }; }), 'physics.joints[0].bodyB', '"ghost"'],
  ['physics gravity with two numbers', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 1, gravity: [0, -9], bodies: [{ node: 'body' }] }; }), 'physics.gravity', '[0,-9]'],
  ['physics duration too long', badRecipe(recipe => { delete recipe.motion; recipe.physics = { duration: 99, bodies: [{ node: 'body' }] }; }), 'physics.duration', '99'],
  ['drive wheel node missing', badAsset(recipe => { recipe.motion = { drive: { path: DRIVE_PATH, speed: 3, wheels: [{ node: 'Wheel_FL' }, { node: 'Nope' }] } }; }), 'motion.drive.wheels[1].node', '"Nope"'],
  ['drive speed below zero', badAsset(recipe => { recipe.motion = { drive: { path: DRIVE_PATH, speed: -3 } }; }), 'motion.drive.speed', '-3'],
  ['drive steering unknown', badAsset(recipe => { recipe.motion = { drive: { path: DRIVE_PATH, speed: 3, steering: 'both' } }; }), 'motion.drive.steering', '"both"'],
  ['drive path with one point', badAsset(recipe => { recipe.motion = { drive: { path: [[0, 0, 0]], speed: 3 } }; }), 'motion.drive.path', '"1 points"'],
  ['drive leg with a repeated point', badAsset(recipe => { recipe.motion = { drive: { legs: [{ path: DRIVE_PATH }, { path: [[1, 0, 0], [1, 0, 0]] }], speed: 3 } }; }), 'motion.drive.legs[1].path', '"1 distinct point"'],
  ['drive leg with a bad point', badAsset(recipe => { recipe.motion = { drive: { legs: [{ path: DRIVE_PATH }, { path: [[0, 0, 0], [0, 'x', 5]] }], speed: 3 } }; }), 'motion.drive.legs[1].path[1]', '[0,"x",5]'],
  ['drive tail light signal unknown', badAsset(recipe => { recipe.motion = { drive: { path: DRIVE_PATH, speed: 3, lights: { tailLights: [{ material: 'material-1', signal: 'fog' }] } } }; }), 'motion.drive.lights.tailLights[0].signal', '"fog"'],
  ['asset root scale zero', badAsset(recipe => { recipe.root = { scale: [0, 1, 1] }; }), 'root.scale', '[0,1,1]'],
  ['asset id not hexadecimal', badAsset(recipe => { recipe.assetId = 'zz'; }), 'assetId', '"zz"'],
  ['asset material override unknown id', badAsset(recipe => { recipe.materialOverrides = [{ id: 'material-99' }]; }), 'materialOverrides[0].id', '"material-99"'],
  ['asset operation unknown type', badAssetApply({ type: 'add-node' }), 'operations[0].type', '"add-node"'],
  ['asset set-material unknown id', badAssetApply({ type: 'set-material', id: 'material-99' }), 'operations[0].id', '"material-99"'],
  ['asset inspect limit too high', badAssetInspect({ limit: 1000 }), 'limit', '1000'],
  ['placed asset id not hexadecimal', badRecipe(recipe => { recipe.nodes[1].asset = { id: 'nothex' }; }), 'nodes[1].asset.id', '"nothex"'],
  ['placed asset clip index below zero', badRecipe(recipe => { recipe.nodes[1].asset = { id: ASSET_ID, clip: { index: -1 } }; }), 'nodes[1].asset.clip.index', '-1'],
  ['placed asset material tag unknown', badRecipe(recipe => { recipe.nodes[1].asset = { id: ASSET_ID, materials: [{ name: 'Paint', tag: 'water' }] }; }), 'nodes[1].asset.materials[0].tag', '"water"'],
  ['placed asset drive forwardAxis unknown', badRecipe(recipe => { recipe.nodes[1].asset = { id: ASSET_ID, drive: { path: DRIVE_PATH, speed: 3, forwardAxis: '+y' } }; }), 'nodes[1].asset.drive.forwardAxis', '"+y"'],
  ['shrinkwrap finds no surface', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'shrinkwrap', target: { type: 'sphere', segments: 8 }, translation: [20, 0, 0], maxDistance: 1, onMiss: 'error' }] }), 'edits[0].onMiss', '"error"'],
  ['shrinkwrap mode unknown', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'shrinkwrap', target: { type: 'sphere', segments: 8 }, mode: 'wrap' }] }), 'edits[0].mode', '"wrap"'],
  ['shrinkwrap maxDistance below zero', badApply({ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'shrinkwrap', target: { type: 'sphere', segments: 8 }, maxDistance: -1 }] }), 'edits[0].maxDistance', '-1'],
];

// A message is actionable when it gives a way to fix the input: a range, a list of choices or an example.
const ACCEPTED = /such as|\bfrom -?[\d.e]+ to -?[\d.e]+|one of |true or false|above \d|\bor more\b/;

assert.ok(CASES.length >= 50, 'the walk covers at least 50 bad inputs');

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
    const recipe = { format: 'crucible.scene', schemaVersion: 1, materials: [{ id: 'paint', color: [0.5, 0.5, 2] }], nodes: [] };
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /recipe\.materials\.0\.color\.2: Too big: expected number to be <=1 \(got 2\)/);
  } finally {
    await client.close();
  }
});

// The guard: these files hold the validators an agent reaches through recipes and operations (physics, drive, asset,
// placed asset, imported mesh edits, shrinkwrap). A throw in them reports through invalidField, which names the path,
// the value and what is accepted. The throws listed here stay raw on purpose: whole-input size limits, host wiring and
// engine invariants no recipe field can fix. A new raw throw fails this test until it uses invalidField or is listed.
const RAW_THROWS_LEFT = {
  'src/agent-physics.js': [
],
  'src/agent-drive-schema.js': [
],
  'src/agent-drive.js': [
],
  'src/agent-asset.js': [
    "'Asset recipe JSON exceeds 1 MiB. Reduce",
    "'Asset recipe JSON nesting exceeds 64 le",
    "'Asset recipe JSON exceeds 1 MiB.');",
    "'Asset recipe requires finite, acyclic J",
    "'Asset recipe arrays must be ordinary bo",
    "'Asset recipe objects must be plain JSON",
    "'Invalid asset recipe JSON key.');",
    "'Asset recipe accessors and hidden field",
    "'Asset recipe arrays must be dense witho",
    "'Asset recipe arrays cannot contain trai",
    "'Asset recipe JSON exceeds 1 MiB.');",
    "'Asset world/skin matrix products exceed",
    "'Asset world geometry bounds exceed Floa",
    "'createAgentAssetScene requires a decode",
    "'This file has no meshes, so there is no",
    "'Asset budgets allow 4096 parts, 4096 ma",
    "'The asset has no authored motion or phy",
    "'Decoded part membership must remain fix",
    "'Decoded resources and retained adapter ",
    "'Asset root/world matrices must remain f",
  ],
  'src/agent-asset-mesh.js': [
    "failureMessage(record, error));",
    "`${entry.id}: ${error.message}`);",
  ],
  'src/agent-scene-assets.js': [
    "'This recipe places a crowd, which loads",
    "'This recipe places catalog assets, whic",
    "`A scene places at most ${ASSET_PLACEMEN",
    "`Asset ${assetId.slice(0, 12)} copy ${co",
    "`Placed assets expand to ${generatedNode",
    "'This recipe drives a placed asset, whic",
  ],
  'src/vehicle.js': [
    "'findWheelCandidates needs an array of n",
    "'parts must be a non-empty array of part",
    "`Part ${index} needs a 16-value matrix.`",
    "'graph must be a scene graph with nodes.",
    "'asset must be a loadGltf result with no",
    "'createVehicleRig needs exactly one of p",
    "'groundHeight must return a finite numbe",
    "'driveAlongPath needs a rig from createV",
    "'Sample time must be finite.');",
    "'groundHeight must be a function (x, z) ",
    "'pose must come from drive.sample for th",
    "`Tail light ${id} part needs a material ",
    "'pose must come from drive.sample for th",
    "`This rig was built from ${rig.kind}, no",
    "`Imported node ${entry.label} has an aut",
  ],
  'src/mesh-shrinkwrap.js': [
],
};
const THROW_PATTERN = /throw new (?:Range|Type)?Error\((.{0,40})/;

for (const [file, listed] of Object.entries(RAW_THROWS_LEFT)) {
  test(`${file} adds no raw throw that lacks a field path and an expectation`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/);
    const found = lines.map(line => line.match(THROW_PATTERN)?.[1]).filter(Boolean);
    assert.deepEqual(found, listed, `${file}: report agent input mistakes with invalidField(path, value, expected) from src/field-error.js; list a throw here only when no input field can cause it`);
  });
}
