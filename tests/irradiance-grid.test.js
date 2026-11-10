import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeAgentBake } from '../src/agent-bake.js';
import { IRRADIANCE_GRID_TEXTURE_UNIT, evaluateIrradianceGrid, normalizeIrradianceGrid, placeIrradianceGrid, traceIrradianceGrid } from '../src/irradiance-grid.js';
import { createFragmentShader } from '../src/shaders.js';

const cube = box(0, 1);

function placed(name, translation, scale, color) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color, metallic: 0, roughness: 0.8, emission: 0 } };
}

// A closed room with a warm floor and white walls. The ceiling has a slit, so the sun lights a strip of the floor.
function sunlitRoom() {
  const white = [0.8, 0.8, 0.8];
  return [
    placed('floor', [0, -0.05, 0], [6, 0.1, 6], [0.8, 0.4, 0.1]),
    placed('ceiling-left', [-2.2, 3.05, 0], [1.6, 0.1, 6], white),
    placed('ceiling-right', [2.2, 3.05, 0], [3.6, 0.1, 6], white),
    placed('back', [0, 1.5, -3.05], [6.2, 3.2, 0.1], white),
    placed('front', [0, 1.5, 3.05], [6.2, 3.2, 0.1], white),
    placed('left', [-3.05, 1.5, 0], [0.1, 3.2, 6], white),
    placed('right', [3.05, 1.5, 0], [0.1, 3.2, 6], white),
  ];
}

const sun = { keyColor: [3, 3, 3], lightDirection: [0.2, 1, 0.1] };

test('the recipe field is true, an integer node count or off, and anything else is refused', () => {
  assert.equal(normalizeIrradianceGrid(undefined), null);
  assert.equal(normalizeIrradianceGrid(false), null);
  assert.equal(normalizeIrradianceGrid(true), true);
  assert.equal(normalizeIrradianceGrid(16), 16);
  for (const bad of [4, 49, 1.5, 'big', {}]) {
    assert.throws(() => normalizeIrradianceGrid(bad), /bake\.irradianceGrid/);
  }
  assert.equal(normalizeAgentBake({ preset: 'draft' }).irradianceGrid, undefined);
  assert.equal(normalizeAgentBake({ preset: 'draft', irradianceGrid: true }).irradianceGrid, true);
});

test('a warm floor sends warm light to a wall the sun never reaches, and the same input gives the same bytes', () => {
  const first = traceIrradianceGrid(sunlitRoom(), sun, { resolution: 12, samples: 16, bounces: 2 });
  const second = traceIrradianceGrid(sunlitRoom(), sun, { resolution: 12, samples: 16, bounces: 2 });
  assert.deepEqual(Array.from(first.data), Array.from(second.data));
  const [red, green, blue] = evaluateIrradianceGrid(first, [0, 1.5, -2.8], [0, 0, 1]);
  assert.ok(red > 0.01 && red / blue > 1.5, `bounced light is warm: ${red} ${green} ${blue}`);
  const lookingAtFloor = evaluateIrradianceGrid(first, [0, 1.5, 0], [0, -1, 0]);
  const lookingAtCeiling = evaluateIrradianceGrid(first, [0, 1.5, 0], [0, 1, 0]);
  assert.ok(lookingAtFloor[0] > lookingAtCeiling[0], 'the lit floor is seen from above, so the downward lobe is brighter');
});

test('the grid stores the sky a node sees: little in a closed room, a lot under open sky', () => {
  const skyAtRoomCentre = grid => {
    const [x, y, z] = [0, 1.5, 0].map((value, axis) => Math.round((value - grid.origin[axis]) / grid.cellSize));
    return grid.data[(x + grid.size[0] * (y + grid.size[1] * z)) * 16 + 12];
  };
  const withoutCeiling = sunlitRoom().filter(part => part.name !== 'ceiling-left' && part.name !== 'ceiling-right');
  const closed = traceIrradianceGrid(withoutCeiling.concat([placed('roof', [0, 3.05, 0], [6.2, 0.1, 6.2], [0.8, 0.8, 0.8])]), sun, { resolution: 10, samples: 16, bounces: 1 });
  const open = traceIrradianceGrid(withoutCeiling, sun, { resolution: 10, samples: 16, bounces: 1 });
  const closedSky = skyAtRoomCentre(closed);
  const openSky = skyAtRoomCentre(open);
  assert.ok(closedSky < 0.05 && openSky > 0.2, `closed ${closedSky}, open ${openSky}`);
});

test('nodes inside a solid are found and filled from their neighbours', () => {
  const solid = traceIrradianceGrid([placed('block', [0, 0, 0], [4, 4, 4], [0.5, 0.5, 0.5])], sun, { resolution: 9, samples: 4, bounces: 1 });
  assert.ok(solid.solidNodes > 0 && solid.solidNodes < solid.nodes, `${solid.solidNodes} of ${solid.nodes}`);
});

test('nodes inside walls are filled and every coefficient is finite', () => {
  const grid = traceIrradianceGrid(sunlitRoom(), sun, { resolution: 10, samples: 8, bounces: 1 });
  assert.ok(grid.data.every(Number.isFinite));
  assert.equal(grid.data.length, grid.nodes * 16);
});

test('placing the grid wraps each material once and keeps reading the live material', () => {
  const parts = sunlitRoom();
  const grid = traceIrradianceGrid(parts, sun, { resolution: 8, samples: 4, bounces: 1 });
  const wrapped = placeIrradianceGrid(parts, grid);
  assert.ok(wrapped.every(part => part.material.irradianceGrid === grid));
  parts[0].material.color = [0.1, 0.2, 0.3];
  assert.deepEqual(wrapped[0].material.color, [0.1, 0.2, 0.3]);
});

test('the shader carries the grid code only for a renderer that asks for the feature', () => {
  assert.match(createFragmentShader(['irradianceGrid']), /irradianceGridSample\(worldPosition, normal\)/);
  assert.match(createFragmentShader(['irradianceGrid']), /occlusion \*= min\(irradianceGridValue\.a, 1\.0\)/);
  assert.doesNotMatch(createFragmentShader([]), /irradianceGrid/);
});

test('a recipe with bake.irradianceGrid skips lightmaps, reports the grid and gives every part the grid', () => {
  const boxNode = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'floor', color: [0.8, 0.4, 0.1] }, { id: 'white', color: [0.8, 0.8, 0.8] }],
    nodes: [
      boxNode('floor', [0, -0.05, 0], [4, 0.1, 4], 'floor'),
      boxNode('ceiling', [0, 3.05, 0], [4, 0.1, 4], 'white'),
      boxNode('back', [0, 1.5, -2.05], [4.2, 3.2, 0.1], 'white'),
      boxNode('front', [0, 1.5, 2.05], [4.2, 3.2, 0.1], 'white'),
      boxNode('left', [-2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
      boxNode('right', [2.05, 1.5, 0], [0.1, 3.2, 4.2], 'white'),
    ],
    camera: { eye: [0, 1.5, 1.9], target: [0, 1.4, -2], fov: 70, near: 0.05, far: 20 },
    environment: { pointLights: [{ position: [0, 2.7, 0], intensity: 14, radius: 0.1 }], keyIntensity: 0, fillIntensity: 0 },
    bake: { preset: 'draft', irradianceGrid: 10 },
  });
  const report = scene.inspect().bake;
  assert.equal(report.texels, 0);
  assert.equal(report.irradianceGrid.size.length, 3);
  assert.ok(report.irradianceGrid.nodes > 0 && report.irradianceGrid.data === undefined);
  const parts = scene.getParts?.() ?? scene.parts;
  assert.ok(parts.every(part => part.material.irradianceGrid && !part.material.lightMap));
});

test('a scene with splat layers and the grid keeps the two on different texture units', async () => {
  const { SPLAT_UNITS } = await import('../src/shader-registry.js');
  await import('../src/splat-shader.js');
  const taken = [...Object.values(SPLAT_UNITS), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15];
  assert.ok(!taken.includes(IRRADIANCE_GRID_TEXTURE_UNIT), 'the grid sampler has its own unit');
  const source = createFragmentShader(['splat', 'irradianceGrid']);
  assert.match(source, /irradianceGridSample/);
  assert.match(source, /splatColor/);
});

test('bake.gridFog is a boolean that needs the grid, and is not stored when off', () => {
  assert.equal(normalizeAgentBake({ irradianceGrid: true, gridFog: true }).gridFog, true);
  assert.equal(Object.hasOwn(normalizeAgentBake({ irradianceGrid: true, gridFog: false }), 'gridFog'), false);
  assert.equal(Object.hasOwn(normalizeAgentBake({ irradianceGrid: true }), 'gridFog'), false);
  assert.throws(() => normalizeAgentBake({ gridFog: true }), /bake\.gridFog: got true; expected true only together with bake\.irradianceGrid/);
  assert.throws(() => normalizeAgentBake({ irradianceGrid: true, gridFog: 'yes' }), /bake\.gridFog: got "yes"; expected true or false/);
});

test('the grid scatters in the fog only when the lighting carries the fog', () => {
  const fog = { minimum: [-4, -1, -4], maximum: [4, 4, 4], density: 0.4, color: [1, 1, 1] };
  const options = { resolution: 10, samples: 16, bounces: 2 };
  const without = traceIrradianceGrid(sunlitRoom(), sun, options);
  const withFog = traceIrradianceGrid(sunlitRoom(), { ...sun, volumeFog: fog }, options);
  assert.equal(Object.hasOwn(without, 'fogScattered'), false);
  assert.ok(withFog.fogScattered.some(value => value > 0), 'the sun the fog scattered is recorded');
  assert.notDeepEqual(Array.from(withFog.data), Array.from(without.data));
  assert.deepEqual(Array.from(traceIrradianceGrid(sunlitRoom(), sun, options).data), Array.from(without.data));
});
