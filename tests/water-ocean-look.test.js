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
  assert.match(shader, /float foamMask = clamp\(2\.0 \* \(1\.0 - vertexSkyVisibility\)/);
  assert.match(shader, /float reflectivity = \(0\.02 \+ 0\.98 \* pow\(1\.0 - cosine, 5\.0\)\)/);
  assert.match(shader, /pow\(max\(dot\(normal, halfVector\), 0\.0\), glintSharpness\)/);
  assert.match(shader, /normal = normalize\(normal \+ rippleTilt\)/);
});

test('the ocean foam of a rough sea reaches the water material as 1 - foam', () => {
  const water = createAgentScene(seaRecipe({ tag: 'water' })).parts[0].geometry;
  const foam = water.vertexGroups.foam;
  const whitecaps = foam.filter(weight => weight > 0.05).length;
  assert.ok(whitecaps > 0, 'a rough sea has vertices with foam');
  assert.ok(Math.min(...water.skyVisibility) < 0.95, 'the foam reaches the shader as a lower sky visibility');
  assert.equal(water.skyVisibility.filter(value => value < 0.95).length, whitecaps);
});

test('wind ripples break the glint into facets and the foam into streaks', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /vec2 waterDetailSlope\(/);
  assert.match(shader, /float foamBand = 0\.13 \+ 1\.5 \* fwidth\(foamDensity\)/);
  assert.match(shader, /rippleTilt\.xz \+= detailSlope/);
  assert.match(shader, /terrainNoise\(position \* wavenumber \* 0\.09/);
  assert.match(shader, /1\.0 \/ \(1\.0 \/ 500\.0 \+ 0\.35 \* waterLostVariance\)/);
  assert.match(shader, /terrainNoise\(crestPosition \* vec2\(3\.1, 14\.0\)/);
});

test('a ripple stays whole down to five pixels per wave and is gone at the two-pixel limit of the sampling', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  const fade = shader.match(/float visible = 1\.0 - smoothstep\(([\d.]+), ([\d.]+), footprint \* wavenumber/);
  assert.ok(fade, 'the detail slope fades each wave by its pixel footprint');
  const fadeStart = Number(fade[1]);
  const fadeEnd = Number(fade[2]);
  // footprint * wavenumber / 2pi is the pixel size in wavelengths: 0.2 is five pixels per wave, 0.5 is the Nyquist limit.
  assert.equal(fadeStart, 0.2, 'the fade starts at five pixels per wavelength');
  assert.equal(fadeEnd, 0.5, 'the fade ends at two pixels per wavelength, the sampling limit');
  assert.ok(fadeStart < fadeEnd, 'the fade runs from a smaller to a larger footprint');
});
