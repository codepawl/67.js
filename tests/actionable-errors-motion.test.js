import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { createBranchStore } from '../src/agent-branches.js';
import { describeReceived } from '../src/field-error.js';
import { parseGltf } from '../src/gltf.js';
import { MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints, walkTracks } from './fixtures/humanoid-glb.js';

await loadAllAgentSceneModules();

// Validation errors of the motion group: a field path, the value received and what is accepted with an example or range.

function sceneRecipe(change) {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'plain', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'body', geometry: 'cube', material: 'plain' },
      { id: 'arm', geometry: 'cube', material: 'plain', parent: 'body' },
      { id: 'group' },
    ],
    motion: { duration: 1, tracks: [{ kind: 'node', id: 'body', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] },
  };
  change(recipe);
  return () => createAgentScene(recipe);
}

const track = extra => ({ kind: 'node', id: 'body', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }], ...extra });
const withTracks = tracks => recipe => { recipe.motion.tracks = tracks; };
const withRelations = relations => recipe => { recipe.nodes[1].relations = relations; };
const attach = { kind: 'attach', to: 'body', side: '+x' };

const ASSET_ID = 'ef'.repeat(32);
const robotBytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

async function crowdScene(crowd) {
  const parse = () => parseGltf(robotBytes.buffer.slice(robotBytes.byteOffset, robotBytes.byteOffset + robotBytes.byteLength), { maxVertices: 500000 });
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await parse()], [assetCopyKey(ASSET_ID, 1), await parse()]]);
  return createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [{ id: 'floor', geometry: 'ground', material: 'grass' }, { id: 'people', asset: { id: ASSET_ID, crowd } }],
  }, {}, { assets });
}

const SOURCE_ID = 'ab'.repeat(32);
const TARGET_ID = 'cd'.repeat(32);

async function layerScene(layers) {
  const parse = bytes => parseGltf(bytes, { maxVertices: 500000 });
  const sourceJoints = humanoidJoints();
  const clips = [{ name: 'Walk', duration: 1, tracks: walkTracks(sourceJoints) }];
  const source = await parse(humanoidGlb({ names: MIXAMO_LIKE, joints: sourceJoints, clips }));
  const asset = await parse(humanoidGlb({ names: UNREAL_LIKE, joints: humanoidJoints(), face: true }));
  const recipe = { format: '67js.asset', schemaVersion: 1, assetId: TARGET_ID, motion: { duration: 1, layers } };
  return createAgentAssetScene(asset, recipe, { sources: { [SOURCE_ID]: source } });
}

const fromSource = extra => ({ from: { asset: SOURCE_ID, clip: 0 }, ...extra });

function inspectPath(path) {
  return () => {
    const scene = createAgentScene({
      format: '67js.scene', schemaVersion: 1,
      geometries: [{ id: 'ground', type: 'box' }],
      materials: [{ id: 'grass', color: [0.3, 0.6, 0.2] }],
      nodes: [{ id: 'ground', geometry: 'ground', material: 'grass', scale: [40, 0.1, 40] }],
    });
    return scene.inspect({ path: { ground: 'ground', from: [-15, -15], to: [15, 15], ...path } });
  };
}

function forkInput() {
  return { recipe: { nodes: [] }, baseRecipe: { nodes: [] }, operations: [], baseRevision: 0 };
}

// Each case: how an agent reaches the error, the field path it must name and the value it must echo.
const CASES = [
  // src/agent-motion.js
  ['motion track on an unknown node', sceneRecipe(withTracks([track({ id: 'ghost' })])), 'motion.tracks[0].id', '"ghost"'],
  ['motion sun track with an ID', sceneRecipe(withTracks([track({ kind: 'sun', id: 'x', property: 'intensity', keyframes: [{ time: 0, value: 1 }] })])), 'motion.tracks[0].id', '"x"'],
  ['motion light track that does not exist', sceneRecipe(withTracks([track({ kind: 'light', id: 'point:9', property: 'intensity', keyframes: [{ time: 0, value: 1 }] })])), 'motion.tracks.id', '"point:9"'],
  ['motion keyframe tangent without CUBICSPLINE', sceneRecipe(withTracks([track({ keyframes: [{ time: 0, value: [0, 0, 0], inTangent: [0, 0, 0] }] })])), 'motion.tracks[0].keyframes[0].inTangent', '[0,0,0]'],
  ['motion IK solver of an unknown type', sceneRecipe(recipe => { recipe.motion.ik = [{ type: 'fabrik', target: [0, 0, 0] }]; }), 'motion.ik[0].type', '"fabrik"'],
  ['motion IK aim without a joint', sceneRecipe(recipe => { recipe.motion.ik = [{ type: 'aim', target: [0, 0, 0] }]; }), 'motion.ik[0].joint', 'undefined'],
  ['motion with nothing to play', sceneRecipe(recipe => { recipe.motion = { duration: 1 }; }), 'motion', '{"duration":1}'],

  // src/agent-relations.js
  ['relation of an unknown kind', sceneRecipe(withRelations([{ ...attach, kind: 'weld' }])), 'nodes[1].relations[0].kind', '"weld"'],
  ['relation with a bad side', sceneRecipe(withRelations([{ ...attach, side: '+w' }])), 'nodes[1].relations[0].side', '"+w"'],
  ['relation to its own node', sceneRecipe(withRelations([{ ...attach, to: 'arm' }])), 'nodes[1].relations[0].to', '"arm"'],
  ['relation to a group', sceneRecipe(withRelations([{ ...attach, to: 'group' }])), 'nodes[1].relations[0].to', '"group"'],
  ['relation offset out of range', sceneRecipe(withRelations([{ ...attach, offset: 1e12 }])), 'nodes[1].relations[0].offset', '1000000000000'],

  // src/agent-branches.js
  ['branch name with capitals', () => createBranchStore().fork('Bad Name', forkInput()), 'branch', '"Bad Name"'],
  ['branch that is not known', () => createBranchStore().get('missing'), 'branch', '"missing"'],
  ['ninth branch', () => {
    const store = createBranchStore();
    for (let index = 0; index < 9; index++) store.fork(`b${index}`, forkInput());
  }, 'branch', '"b8"'],

  // src/agent-navigation.js
  ['path with both seconds and speed', inspectPath({ seconds: 2, speed: 1 }), 'path.speed', '1'],
  ['path with an unknown field', inspectPath({ bogus: 1 }), 'path.bogus', '1'],
  ['path avoid that is not a list', inspectPath({ avoid: 'rock' }), 'path.avoid', '"rock"'],
  ['path radius out of range', inspectPath({ radius: 0 }), 'path.radius', '0'],

  // src/agent-crowd.js
  ['crowd with an unknown field', () => crowdScene({ count: 4, bogus: 1 }), 'crowd.bogus', '1'],
  ['crowd count of zero', () => crowdScene({ count: 0 }), 'crowd.count', '0'],
  ['crowd layout that does not exist', () => crowdScene({ count: 4, layout: 'ring' }), 'crowd.layout', '"ring"'],
  ['crowd clip beyond the clip list', () => crowdScene({ count: 4, clip: 99 }), 'clip', '99'],

  // src/agent-clip-layers.js
  ['layer from an asset that is not loaded', () => layerScene([{ from: { asset: 'ee'.repeat(32), clip: 0 } }]), 'motion.layers[0].from.asset', describeReceived('ee'.repeat(32))],
  ['layer clip beyond the clip list', () => layerScene([fromSource({ from: { asset: SOURCE_ID, clip: 5 } })]), 'motion.layers[0].from.clip', '5'],
  ['layer with both from and clip', () => layerScene([fromSource({ clip: 0 })]), 'motion.layers[0].from', describeReceived({ asset: SOURCE_ID, clip: 0 })],
  ['layer flag that is not boolean', () => layerScene([fromSource({ loop: 'yes' })]), 'motion.layers[0].loop', '"yes"'],
  ['layer mask without joints', () => layerScene([fromSource({ mask: { joints: [] } })]), 'motion.layers[0].mask.joints', '[]'],
  ['layer mask on an unknown node', () => layerScene([fromSource({ mask: { joints: ['nowhere'] } })]), 'motion.layers[0].mask.joints', '"nowhere"'],
];

const ACCEPTED = /such as|\bfrom -?[\d.e]+ to -?[\d.e]+|one of |true or false|above \d|\bor more\b/;

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

// The guard: these files hold validators an agent reaches through motion, relations, branches, path queries and crowds.
// A throw in them reports through invalidField, which names the path, the value and what is accepted. The throws listed
// here stay raw on purpose (engine invariants no recipe field can fix). A new raw throw fails this test until it uses
// invalidField or is listed.
const RAW_THROWS_LEFT = {
  'src/agent-motion.js': [
    '`Motion ik produced an invalid rotation ',
  ],
  'src/agent-clip-layers.js': [],
  'src/agent-relations.js': [],
  'src/agent-branches.js': [],
  'src/agent-navigation.js': [],
  'src/agent-crowd.js': [],
};
const THROW_PATTERN = /throw new (?:Range|Type)?Error\((.{0,40})/;

for (const [file, listed] of Object.entries(RAW_THROWS_LEFT)) {
  test(`${file} adds no raw throw that lacks a field path and an expectation`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/);
    const found = lines.map(line => line.match(THROW_PATTERN)?.[1]).filter(Boolean);
    assert.deepEqual(found, listed, `${file}: report agent input mistakes with invalidField(path, value, expected) from src/field-error.js; list a throw here only when no input field can cause it`);
  });
}
