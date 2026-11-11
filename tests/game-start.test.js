import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { startGame } from '../src/game.js';

const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };

function gameRecipe() {
  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'creature', geometry: 'block', material: 'paint' }],
  });
  scene.apply([{ type: 'set-game', game: { player: { node: 'creature' } } }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

function standInRenderer() {
  const renderer = {
    disposeCalls: 0,
    render() {},
    resize() {},
    updateParts() {},
    replaceParts() {},
    dispose() { renderer.disposeCalls++; },
  };
  return renderer;
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

test('disposing a started game disposes its renderer exactly once', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const renderer = standInRenderer();
    const game = await startGame({}, gameRecipe(), { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => renderer });
    assert.equal(renderer.disposeCalls, 0);
    game.dispose();
    game.dispose();
    assert.equal(renderer.disposeCalls, 1);
  } finally {
    restore();
  }
});

test('a start that fails after the renderer exists disposes the renderer and rethrows', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const renderer = standInRenderer();
    const badReplay = { version: 1, samples: 0, events: 'not a list' };
    await assert.rejects(
      startGame({}, gameRecipe(), { replay: badReplay, showStatus: false, createRenderer: () => renderer }),
      /replaySource needs a recording/,
    );
    assert.equal(renderer.disposeCalls, 1);
  } finally {
    restore();
  }
});

test('a vehicle game starts a vehicle controller with a chase camera', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const recipe = gameRecipe();
    recipe.game = { ...recipe.game, player: { ...recipe.game.player, controller: 'vehicle', maximumSpeed: 30 }, camera: 'chase' };
    const game = await startGame({}, recipe, { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => standInRenderer() });
    assert.equal(typeof game.controller.state.forwardSpeed, 'number');
    game.dispose();
  } finally {
    restore();
  }
});
