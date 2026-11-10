import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createFragmentShader, createVertexShader } from '../src/shaders.js';
import { normalizeMaterialWear, packSurfaceMasks, unpackSurfaceMask, WEAR_LIMITS } from '../src/material-wear.js';

const WEAR = { mask: 'edge', dirt: { mask: 'cavity' } };

function recipeWith(material = {}) {
  return {
    format: '67js.scene',
    schemaVersion: 1,
    geometries: [{
      id: 'hatch',
      type: 'mesh',
      base: { type: 'box', bevel: 0, subdivisions: 1 },
      edits: [
        { op: 'subdivide_edges', edges: { all: true }, cuts: 3 },
        { op: 'inset_region', select: { tag: 'top' }, thickness: 0.18, depth: -0.14 },
        { op: 'vertex_group', name: 'edge', measure: 'edge', angle: 45 },
        { op: 'vertex_group', name: 'cavity', measure: 'occlusion', rays: 8, seed: 3 },
      ],
    }],
    materials: [{ id: 'paint', color: [0.7, 0.05, 0.05], roughness: 0.5, ...material }],
    nodes: [{ id: 'hatch', geometry: 'hatch', material: 'paint' }],
  };
}

test('normalizeMaterialWear fills the defaults and freezes the result', () => {
  const wear = normalizeMaterialWear(WEAR);
  assert.equal(wear.threshold, 0.5);
  assert.equal(wear.metal.metallic, 1);
  assert.equal(wear.metal.roughness, 0.3);
  assert.equal(wear.dirt.roughness, 0.9);
  assert.ok(Object.isFrozen(wear) && Object.isFrozen(wear.metal) && Object.isFrozen(wear.dirt));
});

test('normalizeMaterialWear says what to pass', () => {
  assert.throws(() => normalizeMaterialWear({}), /wear\.mask: got .*vertex group/);
  assert.throws(() => normalizeMaterialWear({ mask: 'edge', softness: 0 }), /wear\.softness: .*0\.001 to 0\.5/);
  assert.throws(() => normalizeMaterialWear({ mask: 'edge', metal: { color: [2, 0, 0] } }), /wear\.metal\.color: .*three numbers from 0 to 1/);
  assert.throws(() => normalizeMaterialWear({ mask: 'edge', dirt: {} }), /wear\.dirt\.mask/);
  assert.throws(() => normalizeMaterialWear({ mask: 'edge', paint: 1 }), /wear\.paint: .*one of the fields/);
});

test('packed masks round-trip within one quantization step and stay above sky visibility', () => {
  const weights = Float32Array.from([0, 0.25, 0.5, 1]);
  const geometry = { vertexGroups: { edge: weights, cavity: Float32Array.from([1, 0.5, 0.125, 0]) } };
  const packed = packSurfaceMasks(geometry, normalizeMaterialWear(WEAR), 'hatch');
  packed.forEach((value, vertex) => {
    assert.ok(value >= 2, 'a packed value never reads as sky visibility');
    const { wear, dirt } = unpackSurfaceMask(value);
    assert.ok(Math.abs(wear - weights[vertex]) <= 1 / WEAR_LIMITS.levels);
    assert.ok(Math.abs(dirt - geometry.vertexGroups.cavity[vertex]) <= 1 / WEAR_LIMITS.levels);
  });
});

test('a material with wear gets surfaceMasks in its part, deterministically; one without keeps its geometry', () => {
  const first = createAgentScene(recipeWith({ wear: WEAR }));
  const second = createAgentScene(recipeWith({ wear: WEAR }));
  const masks = first.parts[0].geometry.surfaceMasks;
  assert.ok(masks instanceof Float32Array);
  assert.equal(masks.length, first.parts[0].geometry.positions.length / 3);
  assert.ok(masks.some(value => unpackSurfaceMask(value).wear === 1), 'the box folds are worn');
  assert.ok(masks.some(value => unpackSurfaceMask(value).dirt > 0), 'the cavities hold dirt');
  assert.deepEqual(Buffer.from(masks.buffer), Buffer.from(second.parts[0].geometry.surfaceMasks.buffer));
  const plain = createAgentScene(recipeWith());
  assert.equal(plain.parts[0].geometry.surfaceMasks, undefined);
  assert.equal(plain.parts[0].material.wear, undefined);
});

test('a wear mask that is not a vertex group of the mesh names the groups that exist', () => {
  assert.throws(() => createAgentScene(recipeWith({ wear: { mask: 'rust' } })), /wear\.mask: got "rust".*known groups: edge, cavity/);
  assert.throws(() => createAgentScene(recipeWith({ wear: { mask: 'edge', dirt: { mask: 'mud' } } })), /wear\.dirt\.mask: got "mud".*known groups: edge, cavity/);
});

test('the shader carries the wear term only when the feature is on', () => {
  const withWear = ['vertexColors', 'surfaceWear'];
  assert.match(createVertexShader(withWear), /#define SURFACE_WEAR/);
  assert.doesNotMatch(createVertexShader(['vertexColors']), /#define SURFACE_WEAR/);
  assert.match(createFragmentShader(withWear), /#define USES_SURFACE_WEAR \(wearEnabled > 0\.5\)/);
  assert.match(createFragmentShader(['vertexColors']), /#define USES_SURFACE_WEAR false/);
});

test('the shader breaks the wear edge with noise, darkens the layer under dirt and keeps no clear coat on worn or dirty pixels', () => {
  const shader = createFragmentShader(['vertexColors', 'surfaceWear']);
  assert.match(shader, /float wearBreak = 0\.65 \* wearNoise\(worldPosition \* 48\.0\)/);
  assert.match(shader, /smoothstep\(wearShape\.y - wearShape\.z, wearShape\.y \+ wearShape\.z, vertexWear\.x \* \(0\.55 \+ 0\.9 \* wearBreak\)\)/);
  assert.match(shader, /color = mix\(color, mix\(color \* 0\.35, wearDirt\.rgb, 0\.6\), dirty\);/);
  assert.match(shader, /metallic \*= 1\.0 - dirty;/);
  assert.match(shader, /coatKept \*= 1\.0 - dirty;/);
  assert.match(shader, /uniform vec4 wearDirt;/);
});
