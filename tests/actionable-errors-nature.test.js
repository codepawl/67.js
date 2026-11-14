import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';

await loadAllAgentSceneModules();

const FRAME_IDS = ['a', 'b'].map(letter => letter.repeat(64));
const GROUND = { id: 'ground', type: 'terrain', size: 60, resolution: 32, seed: 3, amplitude: 2 };

function natureRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [GROUND, { id: 'speck', type: 'box', bevel: 0 }, { id: 'sheet', type: 'grid', segments: 4 }],
    materials: [{ id: 'grass', tag: 'grass', color: [0.2, 0.4, 0.1] }, { id: 'glow', color: [1, 0.5, 0.1], emission: 4 }, { id: 'fabric', color: [0.7, 0.2, 0.2], doubleSided: true }],
    nodes: [
      { id: 'hills', geometry: 'ground', material: 'grass' },
      { id: 'sparks', geometry: 'speck', material: 'glow' },
      { id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 2, 0] },
      { id: 'forest' },
    ],
  };
}

function bad(change) {
  return () => {
    const recipe = natureRecipe();
    change(recipe);
    return createAgentScene(recipe, {}, { sequenceFrames: new Map() });
  };
}

function vegetation(value) {
  return bad(recipe => { recipe.nodes[3].vegetation = value; });
}

function particles(value) {
  return bad(recipe => { recipe.particles = value; });
}

function cloth(value) {
  return bad(recipe => { recipe.cloth = value; });
}

function sequence(value) {
  return bad(recipe => { recipe.materials[1].map = { sequence: value }; });
}

// Each case: how an agent reaches the error, the full field path it must name, the value it must echo, and the example or range.
const CASES = [
  ['vegetation species unknown', vegetation({ species: 'cactus' }), 'nodes[3].vegetation.species', '"cactus"', 'one of broadleaf'],
  ['vegetation season above one', vegetation({ species: 'broadleaf', season: 3 }), 'nodes[3].vegetation.season', '3', 'from 0 to 1'],
  ['vegetation scatter without a ground', vegetation({ species: 'broadleaf', scatter: {} }), 'nodes[3].vegetation.scatter.ground', 'undefined', 'such as "ground"'],
  ['vegetation scatter density too high', vegetation({ species: 'broadleaf', scatter: { ground: 'hills', density: 9 } }), 'nodes[3].vegetation.scatter.density', '9', 'from 0.0001 to 4'],
  ['vegetation exclusion corner as text', vegetation({ species: 'broadleaf', scatter: { ground: 'hills', exclude: [{ min: 'a', max: [1, 1] }] } }), 'nodes[3].vegetation.scatter.exclude[0].min', '"a"', '[x, z] in metres, such as [0, 0]'],
  ['vegetation scatter ground that is not terrain', vegetation({ species: 'broadleaf', scatter: { ground: 'sparks' } }), 'vegetation.scatter.ground', '"sparks"', 'terrain geometry'],
  ['wind strength above four', bad(recipe => { recipe.environment = { wind: { strength: 9 } }; }), 'environment.wind.strength', '9', 'from 0 to 4'],
  ['particle count above the limit', particles({ systems: [{ node: 'sparks', count: 2001 }] }), 'particles.systems[0].count', '2001', 'from 1 to 2000'],
  ['particle emitter shape unknown', particles({ systems: [{ node: 'sparks', emitter: { shape: 'cone' } }] }), 'particles.systems[0].emitter.shape', '"cone"', 'one of point, box'],
  ['particle node that does not exist', particles({ systems: [{ node: 'missing' }] }), 'particles.systems[0].node', '"missing"', 'the ID of a node in the recipe'],
  ['particle gravity with two numbers', particles({ systems: [{ node: 'sparks' }], gravity: [0, -9] }), 'particles.gravity', '[0,-9]', 'an array of 3 numbers'],
  ['particle lifetime range reversed', particles({ systems: [{ node: 'sparks', lifetime: [2, 1] }] }), 'particles.systems[0].lifetime', '[2,1]', '[minimum, maximum]'],
  ['particle field that does not exist', particles({ systems: [{ node: 'sparks', colour: 'red' }] }), 'particles.systems[0].colour', '"red"', 'no such field'],
  ['cloth duration above ten', cloth({ duration: 11, sheets: [{ node: 'flag' }] }), 'cloth.duration', '11', 'from 0.1 to 10'],
  ['cloth pin edge unknown', cloth({ duration: 2, sheets: [{ node: 'flag', pin: ['middle'] }] }), 'cloth.sheets[0].pin[0]', '"middle"', 'one of top, bottom'],
  ['cloth sheet node that is a group', cloth({ duration: 2, sheets: [{ node: 'forest' }] }), 'cloth.sheets[0].node', '"forest"', 'a node that draws a geometry'],
  ['cloth collider shape unknown', cloth({ duration: 2, sheets: [{ node: 'flag' }], colliders: [{ node: 'sparks', shape: 'cone' }] }), 'cloth.colliders[0].shape', '"cone"', 'one of ball, box'],
  ['cloth capsule collider without an end node', cloth({ duration: 2, sheets: [{ node: 'flag' }], colliders: [{ attach: 'sparks', shape: 'capsule', radius: 0.1 }] }), 'cloth.colliders[0].to', 'undefined', 'the ID of the node'],
  ['cloth pinTo without a pin', cloth({ duration: 2, sheets: [{ node: 'flag', pinTo: { node: 'sparks' } }] }), 'cloth.sheets[0].pinTo', '{"node":"sparks"}', 'also sets pin'],
  ['texture sequence fps above the limit', sequence({ frames: FRAME_IDS, fps: 600 }), 'materials[1].map.sequence.fps', '600', 'at most 60, such as 12'],
  ['texture sequence frame that is not an asset ID', sequence({ frames: [FRAME_IDS[0], 'not-an-id'] }), 'materials[1].map.sequence.frames[1]', '"not-an-id"', '64 hexadecimal characters'],
  ['texture sequence with one frame', sequence({ frames: [FRAME_IDS[0]], fps: 10 }), 'materials[1].map.sequence.frames', '"1 frames"', 'a list of 2 to 64'],
  ['texture sequence loop as text', sequence({ frames: FRAME_IDS, fps: 10, loop: 'yes' }), 'materials[1].map.sequence.loop', '"yes"', 'true or false'],
];

for (const [name, trigger, path, received, expectation] of CASES) {
  test(`${name} names ${path}, the value and what is accepted`, () => {
    assert.throws(trigger, error => {
      assert.ok(error.message.includes(`${path}: got ${received}; expected `), `message was: ${error.message}`);
      assert.ok(error.message.includes(expectation), `message was: ${error.message}`);
      return true;
    });
  });
}

// The guard: these files hold the nature validators an agent reaches through recipes (vegetation, particles and hair,
// cloth, image sequences). A throw in them reports through invalidField, which names the path, the value and what is
// accepted. A throw listed here stays raw on purpose: host wiring no recipe field can fix. A new raw throw fails this
// test until it uses invalidField or is listed.
const RAW_THROWS_LEFT = {
  'src/agent-vegetation.js': [],
  'src/agent-particles.js': [],
  'src/agent-cloth.js': [],
  'src/agent-texture-sequence.js': [
    "`Material ${materialId}: image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`",
  ],
  'src/agent-recipe-checks.js': [],
};
const THROW_PATTERN = /throw new (?:Range|Type)?Error\((.{0,40})/;

for (const [file, listed] of Object.entries(RAW_THROWS_LEFT)) {
  test(`${file} adds no raw throw that lacks a field path and an expectation`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/);
    const found = lines.map(line => line.match(THROW_PATTERN)?.[1]).filter(Boolean);
    assert.deepEqual(found, listed.map(text => text.slice(0, 40)), `${file}: report agent input mistakes with invalidField(path, value, expected) from src/field-error.js; list a throw here only when no input field can cause it`);
  });
}
