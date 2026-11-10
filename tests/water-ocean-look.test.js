import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { defaultSmoothAngle, OCEAN_SMOOTH_ANGLE_DEFAULT } from '../src/agent-mesh.js';
import { MESH_SMOOTH_ANGLE_DEFAULT } from '../src/agent-scene-capabilities.js';
import { createFragmentShader } from '../src/shaders.js';
import '../src/world-material-shader.js';

function seaRecipe({ tag, smoothAngle, inStack = false }) {
  const edits = [
    { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
    { op: 'subdivide_edges', edges: { all: true }, cuts: 4 },
    { op: 'subdivide', levels: 2 },
    { op: 'set_position', position: { mul: [{ attr: 'position' }, [100, 1, 100]] } },
  ];
  const ocean = { op: 'ocean', windSpeed: 16, choppiness: 1.5, size: 50, seed: 3, resolution: 3 };
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: inStack ? edits : [...edits, ocean], stack: inStack ? [ocean] : [], ...(smoothAngle === undefined ? {} : { smoothAngle }) }],
    materials: [{ id: 'surface', color: [0.1, 0.2, 0.3], ...(tag ? { tag } : {}) }],
    nodes: [{ id: 'sea', geometry: 'sea', material: 'surface' }],
  };
}

test('a water part of an ocean mesh carries 1 - foam in its sky visibility channel', () => {
  const water = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const foam = water.vertexGroups.foam;
  assert.ok(foam.some(weight => weight > 0.05), 'the sea folds somewhere');
  assert.equal(water.skyVisibility.length, foam.length);
  assert.ok(water.skyVisibility.every((value, index) => Math.abs(value - (1 - foam[index])) < 1e-6));
});

test('a part that is not water keeps its geometry untouched', () => {
  const plain = createAgentScene(seaRecipe({})).parts[0].geometry;
  assert.equal(plain.skyVisibility, undefined);
});

test('ocean output smooths over 180 degrees unless the recipe says otherwise', () => {
  assert.equal(defaultSmoothAngle([{ op: 'ocean' }], []), OCEAN_SMOOTH_ANGLE_DEFAULT);
  assert.equal(defaultSmoothAngle([], [{ op: 'ocean' }]), 180);
  assert.equal(defaultSmoothAngle([{ op: 'subdivide' }], []), MESH_SMOOTH_ANGLE_DEFAULT);
  const defaulted = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const stacked = createAgentScene(seaRecipe({ tag: 'water', inStack: true })).parts[0].geometry;
  const split = createAgentScene(seaRecipe({ tag: 'water', smoothAngle: 0 })).parts[0].geometry;
  assert.equal(defaulted.positions.length, stacked.positions.length, 'edit and stack give the same welded render mesh');
  assert.ok(split.positions.length > defaulted.positions.length, 'an explicit smoothAngle is still honoured');
});

test('the water shader reads the foam mask, a fresnel sky and a sun glint', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /waterFoam = smoothstep\(0\.15, 0\.85, clamp\(1\.0 - vertexSkyVisibility/);
  assert.match(shader, /float reflectivity = \(0\.02 \+ 0\.98 \* pow\(1\.0 - cosine, 5\.0\)\)/);
  assert.match(shader, /pow\(max\(dot\(normal, halfVector\), 0\.0\), 900\.0\)/);
  assert.match(shader, /normal = normalize\(normal \+ rippleTilt\)/);
});
