import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene } from '../src/agent-scene.js';
import { loadPhysicsEngine } from '../src/agent-physics.js';
import { startGame } from '../src/game.js';
import { gamePhysicsProblem, hasTexturedMaterial } from '../src/game-needs.js';
import { engineModuleNames, indexHtml, writeWebBuild, WEB_EXPORT_LIMITS } from '../scripts/web-export.mjs';

const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };
const STEP_MILLISECONDS = 1000 / 60;

// A crate dropped on a floor, and a pocket zone the crate must land in. The player stands off to one side.
function physicsRecipe(overrides = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'paint', translation: [0, -0.25, 0], scale: [10, 0.5, 10] },
      { id: 'hero', geometry: 'block', material: 'paint', translation: [4, 0.8, 0], scale: [0.6, 1.6, 0.6] },
      { id: 'crate', geometry: 'block', material: 'paint', translation: [0, 3, 0] },
    ],
    physics: {
      duration: 1,
      bodies: [{ node: 'floor', type: 'fixed', shape: 'box' }, { node: 'hero', type: 'kinematic', shape: 'capsule' }, { node: 'crate', shape: 'box' }],
    },
    game: {
      player: { node: 'hero', footOffset: 0.8 }, camera: 'follow', input: 'keyboard', physics: true, ground: 0,
      rules: {
        version: 1,
        zones: [{ id: 'pocket', shape: 'box', center: [0, 0.5, 0], size: [2, 2, 2] }],
        parts: [{ id: 'hero', tags: ['player'] }, { id: 'crate', tags: ['crate'] }],
        rules: [{ id: 'land', when: { type: 'enter', zone: 'pocket', tag: 'crate' }, do: [{ type: 'win' }] }],
      },
    },
    ...overrides,
  };
}

// The recipe as the MCP session exports it: normalised, with the physics section checked against its nodes.
async function exportedRecipe(overrides) {
  await loadPhysicsEngine();
  return createAgentScene(physicsRecipe(overrides)).exportRecipe();
}

function standInRenderer() {
  return { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
}

async function playFor(recipe, seconds) {
  const game = await startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => standInRenderer() });
  for (let step = 0; step < seconds * 60; step++) game.runtime.step(STEP_MILLISECONDS);
  return game;
}

function withAnimationFrameStubs() {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  };
}

test('a game with physics steps its bodies, moves their nodes and lets a rules zone see them', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await playFor(await exportedRecipe(), 2);
    assert.equal(game.physics.adapter, 'jolt');
    const crate = game.physics.getPose('crate').translation;
    assert.ok(Math.abs(crate[1] - 0.5) < 0.05, `the crate rests on the floor, y ${crate[1]}`);
    const node = game.scene.exportRecipe().nodes.find(candidate => candidate.id === 'crate');
    assert.ok(Math.abs(node.translation[1] - crate[1]) < 1e-6, 'the crate node follows its body');
    assert.equal(game.rules.state.status, 'won', 'the crate landing in the pocket zone fires the rule');
    game.dispose();
  } finally {
    restore();
  }
});

test('the same recipe plays the same physics twice', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const poses = [];
    for (let run = 0; run < 2; run++) {
      const game = await playFor(await exportedRecipe(), 1);
      poses.push(JSON.stringify(game.physics.getPose('crate')));
      game.dispose();
    }
    assert.equal(poses[0], poses[1]);
  } finally {
    restore();
  }
});

test('the kinematic player body pushes a dynamic crate', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe();
    recipe.nodes.find(node => node.id === 'crate').translation = [3, 0.5, 0];
    delete recipe.game.rules;
    const walkRight = { version: 1, samples: 120, truncated: false, events: [[1, 'keyboard/KeyA', 1]] };
    const game = await startGame({}, recipe, { replay: walkRight, showStatus: false, createRenderer: () => standInRenderer() });
    for (let step = 0; step < 120; step++) game.runtime.step(STEP_MILLISECONDS);
    assert.ok(game.physics.getPose('crate').translation[0] < 2.5, 'walking left drives the crate along');
    game.dispose();
  } finally {
    restore();
  }
});

test('a game without physics starts none and does not load the engine files', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = await exportedRecipe();
    recipe.game.physics = false;
    delete recipe.game.rules;
    const game = await startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => standInRenderer() });
    assert.equal(game.physics, null);
    game.dispose();
  } finally {
    restore();
  }
});

test('a physics game without a body list, with joints or with an unsupported shape says what to change', () => {
  assert.match(gamePhysicsProblem({}), /no physics section with bodies.*set-physics/);
  assert.match(gamePhysicsProblem(physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'crate', type: 'dynamic', shape: 'box' }], joints: [{ type: 'fixed' }] } })), /no joints or ragdolls/);
  assert.match(gamePhysicsProblem(physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'floor', type: 'fixed', shape: 'trimesh' }] } })), /Body "floor" has shape trimesh.*shape "box"/);
  assert.equal(gamePhysicsProblem(physicsRecipe()), null);
});

test('the page may only load the physics engine from its own origin', async () => {
  const recipe = await exportedRecipe();
  const previous = globalThis.location;
  globalThis.location = { href: 'http://example.test/index.html', origin: 'http://example.test' };
  try {
    await assert.rejects(
      startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, physicsUrl: 'https://evil.test/jolt-physics.wasm.js', createRenderer: () => standInRenderer() }),
      /physicsUrl must be on the page's own origin/,
    );
  } finally {
    globalThis.location = previous;
  }
});

async function physicsBuild() {
  const build = await mkdtemp(join(tmpdir(), 'crucible-physics-build-'));
  await writeFile(join(build, 'game.js'), 'import { a } from "./chunk-a.js";\nconst physics = () => import("./game-physics-abc123.js");\nconst swap = () => import("./replace-textured-parts.js");\n');
  await writeFile(join(build, 'chunk-a.js'), 'export const a = 1;');
  await writeFile(join(build, 'game-physics-abc123.js'), 'import "./physics-runtime.js";');
  await writeFile(join(build, 'physics-runtime.js'), 'export {};');
  await writeFile(join(build, 'replace-textured-parts.js'), 'export {};');
  return build;
}

test('the web export bundles the physics engine and its wasm beside the page only for a physics game', async () => {
  const build = await physicsBuild();
  assert.deepEqual(await engineModuleNames(build), ['chunk-a.js', 'game.js']);
  assert.deepEqual(await engineModuleNames(build, { physics: true, textured: true }), ['chunk-a.js', 'game-physics-abc123.js', 'game.js', 'physics-runtime.js', 'replace-textured-parts.js']);

  const plain = join(await mkdtemp(join(tmpdir(), 'crucible-web-plain-')), 'site');
  await writeWebBuild({ recipe: physicsRecipe({ game: { ...physicsRecipe().game, physics: false } }), buildDirectory: build, outputDirectory: plain });
  assert.deepEqual((await readdir(join(plain, 'engine'))).sort(), ['chunk-a.js', 'game.js']);
  await assert.rejects(access(join(plain, 'engine', 'physics')));

  const withPhysics = join(await mkdtemp(join(tmpdir(), 'crucible-web-physics-')), 'site');
  const summary = await writeWebBuild({ recipe: physicsRecipe(), buildDirectory: build, outputDirectory: withPhysics });
  assert.deepEqual((await readdir(join(withPhysics, 'engine', 'physics'))).sort(), ['jolt-physics.wasm.js', 'jolt-physics.wasm.wasm']);
  assert.ok(summary.bytes > 1024 * 1024 && summary.bytes < WEB_EXPORT_LIMITS.maxEngineBytes, `physics export bytes ${summary.bytes}`);
  const html = await (await import('node:fs/promises')).readFile(join(withPhysics, 'index.html'), 'utf8');
  assert.match(html, /const physicsUrl = "\.\/engine\/physics\/jolt-physics\.wasm\.js";/);
  assert.match(html, /startGame\(canvas, recipe, \{ replay, assetUrls, physicsUrl \}\)/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(indexHtml('plain'), /physicsUrl/);
});

test('the web export refuses physics it cannot play before it writes anything', async () => {
  const build = await physicsBuild();
  const recipe = physicsRecipe({ physics: { duration: 1, bodies: [{ node: 'crate', shape: 'box' }], joints: [{ type: 'fixed', bodyA: 'crate', bodyB: 'floor' }] } });
  await assert.rejects(writeWebBuild({ recipe, buildDirectory: build, outputDirectory: join(await mkdtemp(join(tmpdir(), 'crucible-web-refuse-')), 'site') }), /no joints or ragdolls/);
});

test('only a recipe with a pattern or a map is textured', () => {
  assert.equal(hasTexturedMaterial(physicsRecipe()), false);
  assert.equal(hasTexturedMaterial({ materials: [{ id: 'm', pattern: { type: 'bricks' } }] }), true);
  assert.equal(hasTexturedMaterial({ materials: [{ id: 'm', normalMap: 'x' }] }), true);
});
