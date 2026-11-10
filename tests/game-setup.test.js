import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { normalizeGameSetup, GAME_CAMERAS, GAME_INPUT_PRESETS, GAME_CONTROLLERS, GAME_SETUP_LIMITS } from '../src/game-setup.js';
import { writeWebBuild, engineModuleNames, indexHtml, WEB_EXPORT_LIMITS } from '../scripts/web-export.mjs';

const NODE_IDS = new Set(['creature', 'coin-1']);
const RULES = {
  version: 1,
  variables: { score: 0 },
  zones: [{ id: 'goal-zone', shape: 'box', center: [0, 1, -6], size: [2, 4, 2] }],
  parts: [{ id: 'creature', tags: ['player'] }],
  rules: [{ when: { type: 'enter', zone: 'goal-zone', tag: 'player' }, do: [{ type: 'win' }] }],
};

function recipeWith(game) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'creature', geometry: 'block', material: 'paint' }, { id: 'coin-1', geometry: 'block', material: 'paint' }],
    ...(game ? { game } : {}),
  };
}

test('a minimal setup gets its defaults', () => {
  const setup = normalizeGameSetup({ player: { node: 'creature' } }, NODE_IDS);
  assert.deepEqual(setup, {
    player: { node: 'creature', controller: 'character', walkSpeed: 3, runSpeed: 6, jumpSpeed: 7, footOffset: 0 },
    camera: 'follow', input: 'keyboard', physics: false, ground: 0,
  });
});

test('each bad field names itself and says what to pass', () => {
  const player = { node: 'creature' };
  const unknownZone = { version: 1, rules: [{ when: { type: 'enter', zone: 'nowhere', tag: 'player' }, do: [] }] };
  const cases = [
    [{}, /player must be an object/],
    [{ player: { node: 'creatur' } }, /player\.node names "creatur".*Use one of: creature, coin-1/],
    [{ player, camera: 'orbit' }, /camera is "orbit". Use one of: follow, first-person, top-down/],
    [{ player, input: 'mouse' }, /input is "mouse". Use one of: keyboard, gamepad, touch/],
    [{ player: { ...player, controller: 'car' } }, /player\.controller is "car". Use one of: character/],
    [{ player: { ...player, walkSpeed: 101 } }, /player\.walkSpeed must be a number from 0 to 100/],
    [{ player: { ...player, jumpSpeed: Infinity } }, /player\.jumpSpeed must be a number/],
    [{ player, physics: 'yes' }, /physics must be true or false/],
    [{ player, ground: 1e9 }, /ground must be a number/],
    [{ player, script: 'alert(1)' }, /script is not a field. Use one of: player, camera, input, physics, ground, rules/],
    [{ player, rules: unknownZone }, /Game setup rules: Game rules/],
    [{ player, rules: { ...RULES, parts: [{ id: 'coin-1', tags: ['coin'] }], rules: [] } }, /rules\.parts has no part "creature"/],
  ];
  for (const [game, pattern] of cases) assert.throws(() => normalizeGameSetup(game, NODE_IDS), pattern, JSON.stringify(game).slice(0, 80));
});

test('the rules document keeps its written form and its limits apply', () => {
  const setup = normalizeGameSetup({ player: { node: 'creature' }, rules: RULES }, NODE_IDS);
  assert.deepEqual(setup.rules, RULES);
  const tooMany = { ...RULES, variables: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`v${index}`, 0])) };
  assert.throws(() => normalizeGameSetup({ player: { node: 'creature' }, rules: tooMany }, NODE_IDS), /Game setup rules/);
});

test('a scene recipe holds the game, checks it against its nodes, and removing the player node fails', () => {
  const scene = createAgentScene(recipeWith({ player: { node: 'creature', footOffset: 0.5 }, rules: RULES }));
  assert.equal(scene.exportRecipe().game.player.footOffset, 0.5);
  assert.throws(() => scene.apply([{ type: 'remove-node', id: 'creature' }], { expectedRevision: scene.revision }), /player\.node names "creature"/);
  scene.apply([{ type: 'set-game', game: null }], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().game, undefined);
  scene.apply([{ type: 'set-game', game: { player: { node: 'coin-1' } } }], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().game.player.node, 'coin-1');
  assert.throws(() => createAgentScene(recipeWith({ player: { node: 'ghost' } })), /player\.node names "ghost"/);
});

test('scene_capabilities topic game lists the names the validator accepts', () => {
  const topic = GAME_CAPABILITIES;
  assert.deepEqual(topic.cameras, GAME_CAMERAS);
  assert.deepEqual(Object.keys(topic.inputPresets), GAME_INPUT_PRESETS);
  assert.ok(GAME_CONTROLLERS.every(name => topic.fields.includes(name)));
  assert.ok(topic.fields.includes(`0-${GAME_SETUP_LIMITS.maxSpeed} m/s`));
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-game'));
  // The example in the topic is a valid operation on a scene that has its player node.
  const scene = createAgentScene({ ...recipeWith(), nodes: [{ id: 'creature', geometry: 'block', material: 'paint' }] });
  scene.apply([structuredClone(topic.example)], { expectedRevision: scene.revision });
  assert.equal(scene.exportRecipe().game.camera, 'follow');
});

async function fakeBuild() {
  const build = await mkdtemp(join(tmpdir(), '67js-fake-build-'));
  await writeFile(join(build, 'game.js'), 'import { a } from "./chunk-a.js";\nconst lazy = () => import("./chunk-b.js");\n');
  await writeFile(join(build, 'chunk-a.js'), 'export const a = 1; throw new Error("add import \'./not-a-file.js\'");');
  await writeFile(join(build, 'chunk-b.js'), 'import "./chunk-a.js";');
  await writeFile(join(build, 'unused.js'), 'export {};');
  return build;
}

test('the web export copies only the engine modules the entry reaches and writes a runnable folder', async () => {
  const build = await fakeBuild();
  assert.deepEqual(await engineModuleNames(build), ['chunk-a.js', 'chunk-b.js', 'game.js']);
  const out = join(await mkdtemp(join(tmpdir(), '67js-web-out-')), 'site');
  const summary = await writeWebBuild({ recipe: recipeWith({ player: { node: 'creature' } }), buildDirectory: build, outputDirectory: out, title: 'A <b>"game"</b>' });
  assert.deepEqual((await readdir(out)).sort(), ['engine', 'game.json', 'index.html']);
  assert.deepEqual((await readdir(join(out, 'engine'))).sort(), ['chunk-a.js', 'chunk-b.js', 'game.js']);
  assert.equal(summary.files, 5);
  assert.equal(JSON.parse(await readFile(join(out, 'game.json'), 'utf8')).game.player.node, 'creature');
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.match(html, /<title>A &#60;b&#62;&#34;game&#34;&#60;\/b&#62;<\/title>/);
  assert.match(html, /import \{ startGame \} from '\.\/engine\/game\.js'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(indexHtml('x'), /replay/);
});

test('the web export refuses what it cannot play and says how to fix it', async () => {
  const build = await fakeBuild();
  const out = () => mkdtemp(join(tmpdir(), '67js-web-refuse-'));
  const game = { player: { node: 'creature' } };
  await assert.rejects(async () => writeWebBuild({ recipe: recipeWith(), buildDirectory: build, outputDirectory: await out() }), /no game.*set-game/);
  await assert.rejects(async () => writeWebBuild({ recipe: recipeWith({ ...game, physics: true }), buildDirectory: build, outputDirectory: await out() }), /Set game\.physics to false/);
  const placed = recipeWith(game);
  placed.nodes.push({ id: 'tree', asset: { id: 'a'.repeat(64) } });
  await assert.rejects(async () => writeWebBuild({ recipe: placed, buildDirectory: build, outputDirectory: await out() }), /procedural scenes only/);
  await assert.rejects(async () => writeWebBuild({ recipe: recipeWith(game), buildDirectory: await mkdtemp(join(tmpdir(), '67js-empty-build-')), outputDirectory: await out() }), /game\.js is missing.*build:lib/);
  const big = await fakeBuild();
  await writeFile(join(big, 'chunk-a.js'), `${'/'.repeat(WEB_EXPORT_LIMITS.maxEngineBytes)}\nexport {};`);
  await assert.rejects(async () => writeWebBuild({ recipe: recipeWith(game), buildDirectory: big, outputDirectory: await out() }), /above the \d+ byte limit/);
});
