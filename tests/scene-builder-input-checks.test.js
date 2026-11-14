import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { text } from '../src/text-geometry.js';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeFilmTimeline } from '../src/film-timeline.js';
import { compileAgentMotion } from '../src/agent-motion.js';
import { createRecipeTerrain, terrainVertexEstimate, TERRAIN_LIMITS } from '../src/agent-terrain.js';

function recipeWith(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5], roughness: 0.5, metallic: 0.5 }],
    nodes: [{ id: 'block', geometry: 'box', material: 'grey' }],
    camera: { eye: [0, 1, 6], target: [0, 0, 0], fov: 40 },
    ...extra,
  };
}

test('text names the character and the ASCII limit for glyphs the font lacks', () => {
  for (const content of ['Café', 'Hello\tWorld', 'Xin chào', 'Ñé漢', '😀']) {
    assert.throws(() => text(content), error => error instanceof RangeError
      && /has no glyph for/.test(error.message)
      && /printable ASCII only/.test(error.message), content);
  }
  assert.throws(() => text('Café'), /Font ".*" has no glyph for "é"/);
  assert.throws(() => text('toString'.replace('t', '\u0000')), RangeError);
  assert.ok(text('Hello').positions.length > 0);
});

test('a recipe with text outside ASCII gives the same error through the scene', () => {
  const recipe = recipeWith({ geometries: [{ id: 'label', type: 'text', text: 'Café' }], nodes: [{ id: 'block', geometry: 'label', material: 'grey' }] });
  assert.throws(() => createAgentScene(recipe), /has no glyph for "é"[\s\S]*printable ASCII only/);
});

test('a timeline of shots whose float sum overshoots the motion by rounding is accepted', () => {
  const motion = { duration: 0.3, tracks: [{ kind: 'node', id: 'block', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 0.3, value: [1, 0, 0] }] }] };
  const shots = ['a', 'b', 'c'].map(name => ({ name, duration: 0.1 }));
  assert.doesNotThrow(() => normalizeFilmTimeline({ shots }, recipeWith({ motion })));
  assert.doesNotThrow(() => createAgentScene(recipeWith({ motion, timeline: { shots } })));
  const tooLong = [...shots, { name: 'd', duration: 0.1 }];
  assert.throws(() => normalizeFilmTimeline({ shots: tooLong }, recipeWith({ motion })), /reads motion up to/);
});

const materialTrack = (property, extra = {}) => ({
  kind: 'material', id: 'grey', property, keyframes: [{ time: 0, value: 0.2 }, { time: 1, value: 0.8 }], ...extra,
});
const motionOf = tracks => ({ duration: 1, tracks });

test('a visible track must be STEP', () => {
  const visible = interpolation => ({ kind: 'node', id: 'block', property: 'visible', interpolation, keyframes: [{ time: 0, value: 1 }, { time: 1, value: 0 }] });
  for (const interpolation of ['LINEAR', 'SMOOTH']) {
    assert.throws(() => compileAgentMotion(motionOf([visible(interpolation)]), recipeWith()),
      error => error instanceof RangeError && /motion\.tracks\[0\]\.interpolation: got "[A-Z]+"; expected STEP/.test(error.message));
  }
  assert.doesNotThrow(() => compileAgentMotion(motionOf([visible(undefined)]), recipeWith()));
  assert.doesNotThrow(() => compileAgentMotion(motionOf([visible('STEP')]), recipeWith()));
});

test('modifiers and extrapolation that leave a property range are refused when the motion is set', () => {
  const generator = { type: 'generator', coefficients: [0, 1], additive: true };
  const cases = [
    ['a generator pushes roughness past 1', materialTrack('roughness', { modifiers: [generator] }), /material\.roughness: got [\d.]+; expected numbers from 0 to 1[\s\S]*motion time/],
    ['linear extrapolation pushes metallic past 1', { ...materialTrack('metallic', { extrapolation: 'linear' }), keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 0.9 }] }, /material\.metallic: got [\d.]+[\s\S]*motion time/],
    ['linear extrapolation pushes camera fov past 180', { kind: 'camera', property: 'fov', extrapolation: 'linear', keyframes: [{ time: 0, value: 40 }, { time: 0.5, value: 170 }] }, /field of view.*motion time/],
  ];
  for (const [label, track, message] of cases) {
    assert.throws(() => compileAgentMotion(motionOf([track]), recipeWith()), message, label);
  }
  assert.doesNotThrow(() => compileAgentMotion(motionOf([materialTrack('roughness')]), recipeWith()));
});

test('terrain seed must be a whole number inside the documented range', () => {
  const [minimum, maximum] = TERRAIN_LIMITS.seed;
  for (const seed of [2.5, 4294967297, maximum + 1, minimum - 1, Number.NaN, '3']) {
    assert.throws(() => terrainVertexEstimate({ seed }),
      error => error instanceof RangeError && error.message.startsWith('terrain.seed: got ') && error.message.includes(`from ${minimum} to ${maximum}`), String(seed));
    assert.throws(() => createRecipeTerrain({ seed, resolution: 4 }), /terrain\.seed/);
  }
  for (const seed of [undefined, minimum, 1, maximum]) assert.doesNotThrow(() => terrainVertexEstimate({ seed }));
  const geometries = [{ id: 'ground', type: 'terrain', seed: 2.5 }];
  assert.throws(() => createAgentScene(recipeWith({ geometries: [...geometries, { id: 'box', type: 'box' }] })), /geometries\[0\]\.terrain\.seed: got 2\.5/);
});
