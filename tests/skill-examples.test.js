import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAgentScene } from '../src/agent-scene.js';
import { parseRadianceHdr } from '../src/hdri.js';
import { parseCube } from '../src/view-transform.js';
import {
  BUNDLED_CUBE_LOOK_NAMES, BUNDLED_ENVIRONMENT_NAMES, registerCatalogEnvironment, registerCatalogLook,
} from '../src/look-catalog.js';

// The build-67js-scene skill teaches agents the scene_apply tool by example. Every json block in these references that
// carries an `operations` list must keep applying to a fresh scene, so an API change fails here instead of misleading an agent.
const referenceNames = ['look', 'light', 'camera', 'film-and-animation'];

const shippedFile = (name, extension) => readFile(new URL(`../assets/looks/${name}.${extension}`, import.meta.url));
for (const name of BUNDLED_ENVIRONMENT_NAMES) registerCatalogEnvironment(name, parseRadianceHdr(await shippedFile(name, 'hdr')));
for (const name of BUNDLED_CUBE_LOOK_NAMES) registerCatalogLook(name, parseCube((await shippedFile(name, 'cube')).toString('utf8')));

function baseRecipe({ depthOfField }) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'paint', color: [0.4, 0.6, 0.8] }],
    nodes: [
      { id: 'body', geometry: 'cube', material: 'paint' },
      { id: 'lid', geometry: 'cube', material: 'paint', translation: [0, 1, 0] },
    ],
    environment: { pointLights: [{ position: [0, 2, 0], intensity: 4 }] },
    ...(depthOfField ? { effects: { depthOfField: { blur: 0.4, focusDistance: 4 } } } : {}),
  };
}

for (const name of referenceNames) {
  const url = new URL(`../skills/build-67js-scene/references/${name}.md`, import.meta.url);
  const text = await readFile(url, 'utf8');
  const blocks = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  const applyBlocks = blocks.filter(block => Array.isArray(block.operations));
  const createBlocks = blocks.filter(block => block.recipe !== undefined);

  test(`skill reference ${name} has scene_apply examples to check`, () => {
    assert.ok(applyBlocks.length >= 3);
  });

  createBlocks.forEach((block, index) => {
    test(`skill reference ${name}, scene_create example ${index + 1} builds`, () => {
      createAgentScene(block.recipe);
    });
  });

  applyBlocks.forEach((block, index) => {
    test(`skill reference ${name}, example ${index + 1} applies to a fresh scene`, () => {
      // A camera f-stop and an effect blur are exclusive, so f-stop examples start without the effect.
      const depthOfField = !JSON.stringify(block).includes('fStop');
      const scene = createAgentScene(baseRecipe({ depthOfField }));
      scene.apply(block.operations, { expectedRevision: scene.revision });
    });
  });
}
