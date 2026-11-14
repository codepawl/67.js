import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { updatePartVertices } from '../src/update-part-vertices.js';
import { isLiveClothGeometry } from '../src/agent-cloth.js';

function flagRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'grid', segments: 10 }],
    materials: [{ id: 'fabric', color: [0.7, 0.2, 0.2], doubleSided: true }],
    nodes: [{ id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 2, 0], scale: [2, 1.5, 1] }],
    cloth: { duration: 2, wind: [0, 0, 6], sheets: [{ node: 'flag', pin: ['top'] }] },
  };
}

/** A WebGL2 stand-in that counts uploads, with the part's geometry already on the card. */
function fakeRenderer(part) {
  const writes = [];
  const renderer = {
    context: {
      ARRAY_BUFFER: 34962,
      bindBuffer: () => {},
      bufferSubData: (target, offset, data) => writes.push(Array.from(data)),
    },
    shadowsDirty: false,
    partLocations: new Map([[part, { batch: { parts: [part], bounds: null }, geometry: part.geometry }]]),
    geometryBuffers: new Map([[part.geometry, new Map([['positions', 'positions'], ['normals', 'normals']])]]),
  };
  return { renderer, writes };
}

test('a cloth seek keeps the part, makes no new batch and draws the same positions as a fresh scene', () => {
  const scene = createAgentScene(flagRecipe());
  scene.sampleMotion(0.5);
  const [part] = scene.parts;
  const topologyAfterFirstSeek = scene.topologyRevision;
  const positionsAtHalf = Array.from(part.geometry.positions);
  const { renderer, writes } = fakeRenderer(part);

  scene.sampleMotion(1.2);
  assert.equal(scene.parts[0], part, 'the renderer keeps the same part');
  assert.equal(scene.parts[0].geometry, part.geometry, 'and the same geometry object');
  assert.equal(scene.topologyRevision, topologyAfterFirstSeek, 'no topology change, so no replaceParts and no new batch');
  assert.equal(isLiveClothGeometry(part.geometry), true);
  assert.notDeepEqual(Array.from(part.geometry.positions), positionsAtHalf, 'the sheet moved');

  updatePartVertices(renderer, part, part.geometry.positions, part.geometry.normals);
  assert.equal(writes.length, 2, 'one positions write and one normals write');
  assert.deepEqual(writes[0], Array.from(part.geometry.positions), 'the uploaded positions are the sampled ones');

  const fresh = createAgentScene(flagRecipe());
  fresh.sampleMotion(1.2);
  assert.deepEqual(Array.from(part.geometry.positions), Array.from(fresh.parts[0].geometry.positions), 'the same values as a scene seeked straight there');
  assert.deepEqual(Array.from(part.geometry.normals), Array.from(fresh.parts[0].geometry.normals));

  scene.sampleMotion(0.5);
  assert.deepEqual(Array.from(part.geometry.positions), positionsAtHalf, 'a seek back reproduces the earlier frame');
});

test('a scene without cloth has no live cloth geometry', () => {
  const recipe = flagRecipe();
  delete recipe.cloth;
  const scene = createAgentScene(recipe);
  assert.equal(scene.parts.some(part => isLiveClothGeometry(part.geometry)), false);
});
