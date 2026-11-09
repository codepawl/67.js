import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMaterialPattern, cellularNoise, fractalNoise, gradientNoise, materialPatternTextures, normalizeMaterialPattern, PATTERN_DEFAULTS, ridgedNoise } from '../src/material-patterns.js';
import { MATERIAL_PATTERN_TYPES, MAX_MATERIAL_PATTERNS } from '../src/agent-scene-capabilities.js';
import { createAgentScene } from '../src/agent-scene.js';

const baseScene = materials => ({
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'block', type: 'box', bevel: 0 }],
  materials,
  nodes: [{ id: 'part', geometry: 'block', material: materials[0].id }],
});

function bake(type, overrides = {}) {
  return bakeMaterialPattern(normalizeMaterialPattern({ type, resolution: 256, ...overrides }));
}

function meanColumnStep(image, firstColumn, secondColumn) {
  let total = 0;
  for (let row = 0; row < image.height; row++) {
    for (let channel = 0; channel < 3; channel++) {
      const first = image.data[(row * image.width + firstColumn) * 4 + channel];
      const second = image.data[(row * image.width + secondColumn) * 4 + channel];
      total += Math.abs(first - second);
    }
  }
  return total / (image.height * 3);
}

function meanRowStep(image, firstRow, secondRow) {
  let total = 0;
  for (let column = 0; column < image.width; column++) {
    for (let channel = 0; channel < 3; channel++) {
      const first = image.data[(firstRow * image.width + column) * 4 + channel];
      const second = image.data[(secondRow * image.width + column) * 4 + channel];
      total += Math.abs(first - second);
    }
  }
  return total / (image.width * 3);
}

test('noise is periodic over the unit square', () => {
  for (const [positionU, positionV] of [[0.13, 0.71], [0.5, 0.25], [0.999, 0.001]]) {
    assert.ok(Math.abs(gradientNoise(positionU, positionV, 4, 4, 3) - gradientNoise(positionU + 1, positionV, 4, 4, 3)) < 1e-9);
    assert.ok(Math.abs(fractalNoise(positionU, positionV, 3, 2, 3) - fractalNoise(positionU, positionV + 1, 3, 2, 3)) < 1e-9);
    assert.ok(Math.abs(ridgedNoise(positionU, positionV, 3, 3, 3) - ridgedNoise(positionU + 1, positionV + 1, 3, 3, 3)) < 1e-9);
    assert.ok(Math.abs(cellularNoise(positionU, positionV, 5, 3).nearest - cellularNoise(positionU + 1, positionV, 5, 3).nearest) < 1e-9);
  }
});

test('gradient noise spreads over its range and stays bounded', () => {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let sample = 0; sample < 4000; sample++) {
    const value = gradientNoise((sample * 0.6180339) % 1, (sample * 0.7548776) % 1, 8, 8, 5);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  assert.ok(minimum < -0.5 && maximum > 0.5, `${minimum} to ${maximum}`);
  assert.ok(minimum >= -1.2 && maximum <= 1.2, `${minimum} to ${maximum}`);
});

test('every pattern tiles: the step across the seam is like any other step', () => {
  for (const type of MATERIAL_PATTERN_TYPES) {
    const { image } = bake(type).map;
    let largestInsideU = 0;
    let largestInsideV = 0;
    for (let index = 0; index < image.width - 1; index++) {
      largestInsideU = Math.max(largestInsideU, meanColumnStep(image, index, index + 1));
      largestInsideV = Math.max(largestInsideV, meanRowStep(image, index, index + 1));
    }
    const seamU = meanColumnStep(image, image.width - 1, 0);
    const seamV = meanRowStep(image, image.height - 1, 0);
    assert.ok(seamU <= largestInsideU + 1, `${type} across U: ${seamU} vs ${largestInsideU}`);
    assert.ok(seamV <= largestInsideV + 1, `${type} across V: ${seamV} vs ${largestInsideV}`);
  }
});

test('patterns are deterministic and change with the seed', () => {
  for (const type of MATERIAL_PATTERN_TYPES) {
    const first = bake(type).map.image.data;
    const again = bake(type).map.image.data;
    assert.deepEqual(first, again, type);
    const reseeded = bake(type, { seed: 2 }).map.image.data;
    assert.notDeepEqual(first, reseeded, type);
  }
});

test('bump 0 gives a flat normal map, and rust is less metallic where it has rusted', () => {
  const flat = bake('stone', { bump: 0 }).normalMap.image.data;
  for (let offset = 0; offset < 4000; offset += 4) {
    assert.deepEqual([flat[offset], flat[offset + 1], flat[offset + 2]], [128, 128, 255]);
  }
  const { data } = bake('rust').metallicRoughnessMap.image;
  const metalValues = new Set();
  for (let offset = 2; offset < data.length; offset += 4 * 97) metalValues.add(data[offset]);
  assert.ok(Math.min(...metalValues) < 40 && Math.max(...metalValues) > 200);
});

test('a normalized pattern normalizes to itself and bad fields say what to pass', () => {
  assert.deepEqual(Object.keys(PATTERN_DEFAULTS).sort(), [...MATERIAL_PATTERN_TYPES].sort());
  const normalized = normalizeMaterialPattern({ type: 'bricks', size: 2 });
  assert.deepEqual(normalizeMaterialPattern(normalized), normalized);
  assert.throws(() => normalizeMaterialPattern({ type: 'plasma' }), /type must be one of noise, wood/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', colour: [] }), /does not take colour/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', size: 0 }), /size must be a number/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', colors: [[0, 0, 2], [1, 1, 1]] }), /colors must be/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', colors: [[0, 0, 0], [1, 1, 1], [1, 1, 1]] }), /colors must be/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', resolution: 300 }), /resolution must be one of/);
  assert.throws(() => normalizeMaterialPattern({ type: 'wood', axis: 'w' }), /axis must be/);
  assert.equal(normalizeMaterialPattern({ type: 'bricks', colors: [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5]] }).colors.length, 3);
});

test('recipe materials carry patterns as textures without needing UVs', () => {
  const scene = createAgentScene(baseScene([{ id: 'oak', pattern: { type: 'wood', size: 0.5, axis: 'x' }, roughness: 0.8 }]));
  const [part] = scene.parts;
  assert.equal(part.geometry.uvs, undefined);
  assert.equal(part.material.boxMapScale, 2);
  assert.equal(part.material.boxMapAxis, 0);
  assert.equal(part.material.map.colorSpace, 'srgb');
  assert.equal(part.material.normalMap.colorSpace, 'linear');
  assert.equal(part.material.map, part.material.map);
  assert.deepEqual(Array.from(part.material.color), [1, 1, 1]);
  const exported = scene.exportRecipe().materials[0];
  assert.equal(exported.pattern.type, 'wood');
  assert.equal(exported.pattern.size, 0.5);
  const reloaded = createAgentScene({ ...baseScene([exported]) });
  assert.equal(reloaded.parts[0].material.map, part.material.map);
});

test('a material without a pattern is unchanged', () => {
  const scene = createAgentScene(baseScene([{ id: 'plain' }]));
  const { material } = scene.parts[0];
  assert.deepEqual(Array.from(material.color), [0.5, 0.5, 0.5]);
  assert.equal(material.map, undefined);
  assert.equal(material.boxMapScale, undefined);
  assert.equal(scene.exportRecipe().materials[0].pattern, undefined);
});

test('patterns need the surface tag and a scene holds a bounded number', () => {
  assert.throws(() => createAgentScene(baseScene([{ id: 'glow', tag: 'unlit', pattern: { type: 'wood' } }])), /materials\[0\]\.pattern: got "wood"; expected a material with the surface tag/);
  const tooMany = Array.from({ length: MAX_MATERIAL_PATTERNS + 1 }, (_, index) => ({ id: `material-${index}`, pattern: { type: 'wood', seed: index } }));
  assert.throws(() => createAgentScene(baseScene(tooMany)), /at most 16 different material patterns/);
  const shared = Array.from({ length: MAX_MATERIAL_PATTERNS + 1 }, (_, index) => ({ id: `material-${index}`, pattern: { type: 'wood' }, color: [index / 17, 1, 1] }));
  assert.doesNotThrow(() => createAgentScene(baseScene(shared)));
});

test('changing a pattern rebuilds the renderer resources, and changing its tint does not', () => {
  const scene = createAgentScene(baseScene([{ id: 'oak', pattern: { type: 'wood' } }]));
  const before = scene.topologyRevision;
  scene.apply([{ type: 'set-material', id: 'oak', color: [0.5, 0.5, 0.5] }], { expectedRevision: scene.revision });
  assert.equal(scene.topologyRevision, before);
  assert.deepEqual(Array.from(scene.parts[0].material.color), [0.5, 0.5, 0.5]);
  scene.apply([{ type: 'set-material', id: 'oak', pattern: { type: 'bricks' } }], { expectedRevision: scene.revision });
  assert.equal(scene.topologyRevision, before + 1);
  assert.equal(scene.parts[0].material.map, materialPatternTextures(scene.exportRecipe().materials[0].pattern).map);
});
