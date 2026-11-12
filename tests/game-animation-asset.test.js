import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { parseGltf } from '../src/gltf.js';
import { startGame } from '../src/game.js';
import { gameAssetIds, loadGameAssets } from '../src/game-assets.js';
import { writeWebBuild } from '../scripts/web-export.mjs';
import { MIXAMO_LIKE, UNREAL_LIKE, humanoidGlb, humanoidJoints, walkTracks } from './fixtures/humanoid-glb.js';

// A game recipe whose player is a placed catalog humanoid: the walk, run and idle clips come from another humanoid file and are
// retargeted to the player's skeleton, and the animation graph blends them by speed while the controller moves the node.

const SOURCE_ID = 'ab'.repeat(32);
const HERO_ID = 'cd'.repeat(32);
const WALK_SPEED = 1.2;
const RUN_SPEED = 2.4;
const FRAME_MILLISECONDS = 1000 / 60;
const FOOT_DRIFT_BOUND = 1e-4;
const CONTACT_HEIGHT = 1e-3;
const SETTLE_FRAMES = 30;

const SOURCE_JOINTS = humanoidJoints();
const HERO_JOINTS = humanoidJoints({ armTiltDegrees: 30 });
const parse = bytes => parseGltf(bytes, { maxVertices: 500000 });

function locomotionClips() {
  const clip = (name, duration, speed) => ({ name, duration, tracks: walkTracks(SOURCE_JOINTS, { speed, duration }) });
  return [clip('Idle', 1, 0), clip('Walk', 1, WALK_SPEED), clip('Run', 0.5, RUN_SPEED)];
}

async function loadAssets() {
  const assets = new Map();
  assets.set(assetCopyKey(SOURCE_ID, 0), await parse(humanoidGlb({ names: MIXAMO_LIKE, joints: SOURCE_JOINTS, clips: locomotionClips() })));
  assets.set(assetCopyKey(HERO_ID, 0), await parse(humanoidGlb({ names: UNREAL_LIKE, joints: HERO_JOINTS })));
  assets.set(assetCopyKey(HERO_ID, 1), await parse(humanoidGlb({ names: UNREAL_LIKE, joints: HERO_JOINTS })));
  return assets;
}

function heroAnimation(overrides = {}) {
  return {
    clips: {
      idle: { from: { asset: SOURCE_ID, clip: 0 } },
      walk: { from: { asset: SOURCE_ID, clip: 1 } },
      run: { from: { asset: SOURCE_ID, clip: 2 } },
    },
    parameters: { speed: { type: 'number' } },
    rootMotion: { bone: UNREAL_LIKE.hips },
    layers: [{
      name: 'base',
      states: [{
        name: 'move',
        blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: WALK_SPEED }, { clip: 'run', threshold: RUN_SPEED }] },
      }],
    }],
    ...overrides,
  };
}

function heroScene(assets) {
  return createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [], materials: [],
    nodes: [{ id: 'Hero', asset: { id: HERO_ID } }],
  }, {}, { assets });
}

function setGame(scene, game) {
  scene.apply([{ type: 'set-game', game }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

const standInRenderer = () => ({ render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} });

async function startRecipe(recipe, assets, replay) {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const game = await startGame({}, recipe, { replay, assets, showStatus: false, createRenderer: standInRenderer });
  return {
    game,
    finish() {
      game.dispose();
      globalThis.requestAnimationFrame = previous.request;
      globalThis.cancelAnimationFrame = previous.cancel;
    },
  };
}

function soleParts(game, asset) {
  return ['sole_left', 'sole_right'].map(name => {
    const index = asset.parts.findIndex(part => part.name === name);
    assert.ok(index >= 0, `no part ${name}`);
    return game.scene.parts.find(part => part.name === `Hero/${index}`);
  });
}

test('a recipe validates an asset character animation at the boundary and names the fix', async () => {
  const assets = await loadAssets();
  const scene = heroScene(assets);
  const attempt = animation => () => scene.apply([{ type: 'set-game', game: { player: { node: 'Hero', animation } } }], { expectedRevision: scene.revision });
  assert.throws(attempt(heroAnimation({ clips: { walk: { from: { asset: 'nope', clip: 0 } } } })), /clips\.walk\.from\.asset is "nope"\. Pass a catalog asset id of 64 hexadecimal/);
  assert.throws(attempt(heroAnimation({ clips: { walk: { from: { clip: -1 } } } })), /clips\.walk\.from\.clip must be the index of a clip/);
  assert.throws(attempt(heroAnimation({ clips: { walk: { tracks: [] } } })), /clips\.walk\.tracks is not a field\. Use one of: from, loop, scale/);
  const recipe = setGame(scene, { player: { node: 'Hero', walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED, animation: heroAnimation() } });
  assert.deepEqual(recipe.game.player.animation.drive, { speed: 'intentSpeed' });
  assert.deepEqual(recipe.game.player.animation.clips.walk, { from: { asset: SOURCE_ID, clip: 1 }, loop: true });
});

test('starting the game says which asset or clip is missing', async () => {
  const assets = await loadAssets();
  const recipe = setGame(heroScene(assets), { player: { node: 'Hero', animation: heroAnimation({ clips: { idle: { from: { asset: SOURCE_ID, clip: 7 } } }, layers: [{ name: 'base', states: [{ name: 'idle', clip: 'idle' }] }] }) } });
  await assert.rejects(startRecipe(recipe, assets, { version: 1, samples: 1, events: [] }), /clips\.idle\.from\.clip is 7, but asset abababababab has 3 clips\. Use an index from 0 to 2/);
  const withoutSource = new Map(assets);
  withoutSource.delete(assetCopyKey(SOURCE_ID, 0));
  const walkRecipe = setGame(heroScene(assets), { player: { node: 'Hero', animation: heroAnimation() } });
  await assert.rejects(startRecipe(walkRecipe, withoutSource, { version: 1, samples: 1, events: [] }), /needs catalog asset abababababab, which the host did not load/);
});

test('a retargeted character blends idle, walk and run by speed and a planted foot stays put', async () => {
  const assets = await loadAssets();
  const recipe = setGame(heroScene(assets), { player: { node: 'Hero', walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED, animation: heroAnimation() } });
  const replay = { version: 1, samples: 600, events: [[1, 'keyboard/KeyW', 1]] };
  const { game, finish } = await startRecipe(recipe, assets, replay);
  try {
    const soles = soleParts(game, assets.get(assetCopyKey(HERO_ID, 0)));
    const contacts = soles.map(() => null);
    const drifts = [];
    for (let frame = 0; frame < 480; frame++) {
      game.runtime.step(FRAME_MILLISECONDS);
      if (frame < SETTLE_FRAMES) continue;
      soles.forEach((sole, index) => {
        const world = [sole.matrix[12], sole.matrix[13], sole.matrix[14]];
        if (world[1] > CONTACT_HEIGHT) {
          contacts[index] = null;
          return;
        }
        contacts[index] ??= { anchor: world, drift: 0 };
        contacts[index].drift = Math.max(contacts[index].drift, Math.hypot(world[0] - contacts[index].anchor[0], world[2] - contacts[index].anchor[2]));
        drifts.push(contacts[index].drift);
      });
    }
    assert.ok(game.controller.state.position[2] < -5, `the player walked forward, z ${game.controller.state.position[2]}`);
    assert.ok(drifts.length > 100, `feet were planted for ${drifts.length} samples`);
    assert.ok(Math.max(0, ...drifts) < FOOT_DRIFT_BOUND, `worst planted foot drift ${Math.max(0, ...drifts)} m`);
  } finally {
    finish();
  }
});

test('the web export carries the placed assets and the page loads them by URL', async () => {
  const sourceBytes = humanoidGlb({ names: MIXAMO_LIKE, joints: SOURCE_JOINTS, clips: locomotionClips() });
  const heroBytes = humanoidGlb({ names: UNREAL_LIKE, joints: HERO_JOINTS });
  const recipe = setGame(heroScene(await loadAssets()), { player: { node: 'Hero', walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED, animation: heroAnimation() } });
  assert.deepEqual(gameAssetIds(recipe).sort(), [HERO_ID, SOURCE_ID].sort());

  const directory = await mkdtemp(join(tmpdir(), '67js-asset-export-'));
  const buildDirectory = join(directory, 'build');
  await mkdir(buildDirectory);
  await writeFile(join(buildDirectory, 'game.js'), 'export const startGame = () => {};');
  try {
    await assert.rejects(writeWebBuild({ recipe, buildDirectory, outputDirectory: join(directory, 'refused') }), /needs the bytes of the catalog assets placed by Hero/);
    const assetBytes = new Map([[HERO_ID, Buffer.from(heroBytes)], [SOURCE_ID, Buffer.from(sourceBytes)]]);
    const summary = await writeWebBuild({ recipe, buildDirectory, outputDirectory: join(directory, 'built'), assets: assetBytes });
    const page = await readFile(join(directory, 'built', 'index.html'), 'utf8');
    assert.ok(page.includes(`"${HERO_ID}":"./assets/${HERO_ID}.glb"`));
    assert.equal((await readFile(join(directory, 'built', 'assets', `${SOURCE_ID}.glb`))).byteLength, sourceBytes.byteLength);
    assert.ok(summary.bytes > sourceBytes.byteLength + heroBytes.byteLength);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const urls = { [HERO_ID]: 'hero.glb', [SOURCE_ID]: 'source.glb' };
  const files = { 'hero.glb': heroBytes, 'source.glb': sourceBytes };
  const loaded = await loadGameAssets(recipe, urls, async url => files[url]);
  assert.deepEqual([...loaded.keys()].sort(), [assetCopyKey(HERO_ID, 0), assetCopyKey(HERO_ID, 1), assetCopyKey(SOURCE_ID, 0)].sort());
  await assert.rejects(loadGameAssets(recipe, { [HERO_ID]: 'hero.glb' }, async () => files['hero.glb']), /assetUrls has no URL for it/);
});
