import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { BAKE_LIMITS, MAX_BAKE_POINT_LIGHTS, MAX_BAKE_SPOT_LIGHTS, MAX_BAKE_AREA_LIGHTS, bakeLightmaps, normalizeBakeOptions, planLightmaps, MAX_BAKE_PARTS, MAX_GPU_BAKE_PARTS } from '../src/light-bake.js';
import { bakeLightmapsAsync } from '../src/light-bake-gpu.js';

const cube = box(0, 1);

function placed(name, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

// A small closed room with a wall that hides the floor behind it from the lamp.
function smallRoom() {
  return [
    placed('floor', [0, -0.05, 0], [6, 0.1, 6]),
    placed('ceiling', [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', [0, 1.5, -3.05], [6, 3.2, 0.1]),
    placed('left', [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('front', [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placed('divider', [0, 1.5, 0], [0.1, 3, 3]),
  ];
}

const lamp = { pointLights: [{ position: [-1.5, 2.5, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };
const fastOptions = { samples: 8, bounces: 2, texelsPerUnit: 2, maxResolution: 32 };

function lightmapBytes(part) {
  return part.material.emissiveMap.image.data;
}

test('the same input bakes the same bytes', () => {
  const first = bakeLightmaps(smallRoom(), lamp, fastOptions);
  const second = bakeLightmaps(smallRoom(), lamp, fastOptions);
  assert.equal(first.parts.length, second.parts.length);
  first.parts.forEach((part, index) => {
    assert.deepEqual(Array.from(lightmapBytes(part)), Array.from(lightmapBytes(second.parts[index])));
    assert.equal(part.material.emission, second.parts[index].material.emission);
    assert.deepEqual(Array.from(part.geometry.uvs), Array.from(second.parts[index].geometry.uvs));
  });
});

test('a bake gives each part lightmap UVs and an srgb emissive map, and leaves its input alone', () => {
  const parts = smallRoom();
  const originalGeometry = parts[0].geometry;
  const { parts: baked } = bakeLightmaps(parts, lamp, fastOptions);
  const floor = baked[0];
  assert.equal(parts[0].geometry, originalGeometry);
  assert.equal(parts[0].material.emissiveMap, undefined);
  assert.equal(floor.material.emissiveMap.colorSpace, 'srgb');
  assert.deepEqual(floor.material.emissiveColor, [1, 1, 1]);
  assert.ok(floor.material.emission > 0);
  assert.equal(floor.geometry.uvs.length, floor.geometry.positions.length / 3 * 2);
  const { width, height, data } = floor.material.emissiveMap.image;
  assert.equal(data.length, width * height * 4);
});

test('light reaches a surface the lamp cannot see, and a dark scene bakes nothing', () => {
  const { parts: baked } = bakeLightmaps(smallRoom(), lamp, { ...fastOptions, samples: 32 });
  // The right half of the floor sits behind the divider, so it gets only bounced light, but not none.
  const floor = baked[0];
  const bytes = lightmapBytes(floor);
  const brightestChannel = Math.max(...bytes.filter((value, index) => index % 4 !== 3));
  assert.ok(brightestChannel > 0);
  const dark = bakeLightmaps(smallRoom(), { pointLights: [], keyColor: [0, 0, 0] }, fastOptions);
  dark.parts.forEach(part => assert.equal(part.material.emissiveMap, undefined));
});

test('a part that sees little of the sky gets a linear occlusion map, and a part that sees all of it gets none', () => {
  const closed = bakeLightmaps(smallRoom(), lamp, fastOptions);
  const closedFloor = closed.parts[0];
  assert.equal(closedFloor.material.occlusionMap.colorSpace, 'linear');
  assert.equal(closedFloor.material.occlusionStrength, 1);
  assert.ok(Math.min(...closedFloor.material.occlusionMap.image.data.filter((value, index) => index % 4 === 0)) < 8);
  // The mean is over texels, and a floor slab is half top face (sees the closed room) and half underside (sees outside), now that texels are spread by area.
  assert.ok(Math.abs(closed.report.parts[0].skyVisibility - 0.5) < 0.05);
  assert.ok(closed.report.parts[6].skyVisibility < 0.05);
  const open = bakeLightmaps([placed('floor', [0, -0.05, 0], [6, 0.1, 6])], lamp, fastOptions);
  assert.equal(open.parts[0].material.occlusionMap, undefined);
  assert.equal(open.report.parts[0].skyVisibility, 1);
});

test('parts that cannot take a lightmap are skipped with a reason and still block light', () => {
  const parts = smallRoom();
  parts.push(placed('glass', [1, 0.5, 1], [0.5, 1, 0.5], { alphaMode: 'blend', opacity: 0.4 }));
  parts.push(placed('lava', [0, 2, 1], [0.2, 0.2, 0.2], { tag: 'fire' }));
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.deepEqual(report.skipped.map(entry => entry.name), ['glass', 'lava']);
  assert.equal(baked[7], parts[7]);
  assert.equal(baked[8], parts[8]);
});

test('a textured part keeps its map and UV channel 0 and receives light through a second UV set', () => {
  const mapImage = { width: 2, height: 2, data: new Uint8ClampedArray([200, 60, 40, 255, 220, 90, 60, 255, 190, 70, 50, 255, 210, 80, 50, 255]) };
  const brickMap = { image: mapImage, colorSpace: 'srgb' };
  const parts = smallRoom();
  const cubeUvs = new Float32Array(cube.positions.length / 3 * 2);
  for (let vertex = 0; vertex < cube.positions.length / 3; vertex++) {
    cubeUvs[vertex * 2] = cube.positions[vertex * 3] + 0.5;
    cubeUvs[vertex * 2 + 1] = cube.positions[vertex * 3 + 1] + 0.5;
  }
  const texturedCube = { ...cube, uvs: cubeUvs };
  parts.push({ ...placed('wall', [1.5, 1, 1.5], [1, 2, 1], { map: brickMap }), geometry: texturedCube });
  const { parts: baked, report } = bakeLightmaps(parts, lamp, { ...fastOptions, samples: 16 });
  const wall = baked[7];
  assert.equal(report.skipped.length, 0);
  assert.equal(wall.material.map, brickMap);
  assert.equal(wall.material.emissiveMap, undefined);
  assert.equal(wall.material.emission, 0);
  assert.equal(wall.material.lightMap.colorSpace, 'srgb');
  assert.ok(wall.material.lightMapScale > 0);
  const vertexCount = wall.geometry.positions.length / 3;
  assert.equal(wall.geometry.lightUvs.length, vertexCount * 2);
  assert.equal(wall.geometry.uvs.length, vertexCount * 2);
  const sourceUvs = new Set();
  for (let index = 0; index < cubeUvs.length; index += 2) sourceUvs.add(`${cubeUvs[index]},${cubeUvs[index + 1]}`);
  for (let index = 0; index < wall.geometry.uvs.length; index += 2) assert.ok(sourceUvs.has(`${wall.geometry.uvs[index]},${wall.geometry.uvs[index + 1]}`));
  const again = bakeLightmaps(parts, lamp, { ...fastOptions, samples: 16 }).parts[7];
  assert.deepEqual(Array.from(again.material.lightMap.image.data), Array.from(wall.material.lightMap.image.data));
});

test('an emitting part is baked through the light map slot and still lights the others', () => {
  const parts = smallRoom();
  parts.push(placed('lamp-shade', [-1.5, 2, 1], [0.2, 0.2, 0.2], { emission: 2 }));
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.equal(report.skipped.length, 0);
  assert.equal(baked[7].material.emission, 2);
  assert.ok(baked[7].material.lightMap);
});

test('a part whose maps read the second UV set is skipped with its material named, keeping its own UVs', () => {
  const normalImage = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) };
  const parts = smallRoom();
  parts.push(placed('floor tiles', [1.5, 1, 1.5], [1, 2, 1], { name: 'Laminate floor', normalMap: { image: normalImage, colorSpace: 'linear', uvChannel: 1 } }));
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.deepEqual(report.skipped.map(entry => entry.name), ['floor tiles']);
  assert.match(report.skipped[0].reason, /Laminate floor.*normalMap.*TEXCOORD_1/);
  assert.equal(baked[7], parts[7]);
});

test('a part with a layer map on the second UV set is skipped with the map named', () => {
  const clearcoatImage = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) };
  const parts = smallRoom();
  parts.push(placed('coated floor', [1.5, 1, 1.5], [1, 2, 1], { name: 'Coated', layerMaps: { clearcoatTexture: { image: clearcoatImage, colorSpace: 'linear', uvChannel: 1 } } }));
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.deepEqual(report.skipped.map(entry => entry.name), ['coated floor']);
  assert.match(report.skipped[0].reason, /Coated.*clearcoatTexture.*TEXCOORD_1/);
  assert.equal(baked[7], parts[7]);
});

test('a part marked as generating its own geometry is skipped', () => {
  const parts = smallRoom();
  parts[0] = { ...parts[0], generatesGeometry: true };
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.deepEqual(report.skipped.map(entry => entry.name), ['floor']);
  assert.equal(baked[0], parts[0]);
});

test('options are validated with their bounds', () => {
  const fallbacks = Object.fromEntries(Object.entries(BAKE_LIMITS).map(([name, limit]) => [name, limit.fallback]));
  assert.deepEqual(normalizeBakeOptions({}), { ...fallbacks, backend: 'cpu' });
  for (const [name, bad] of [['samples', 0], ['samples', 513], ['samples', Number.NaN], ['bounces', 9], ['maxResolution', 3], ['maxResolution', 1e9], ['texelsPerUnit', 0], ['texelsPerUnit', Infinity], ['maxSeconds', 0], ['maxSeconds', '60']]) {
    assert.throws(() => normalizeBakeOptions({ [name]: bad }), { name: 'RangeError', message: new RegExp(name) }, `${name} ${bad}`);
  }
  for (const bad of [null, [], 'fast', 3]) assert.throws(() => normalizeBakeOptions(bad), TypeError);
});

test('hostile spot and area lights are refused before any ray is traced', () => {
  const spot = { position: [0, 2, 0], direction: [0, -1, 0], intensity: 5 };
  const area = { position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1, intensity: 5 };
  const refused = [
    [{ spotLights: [{ ...spot, direction: [0, 0, 0] }] }, /spot light 0.*direction/],
    [{ spotLights: [{ ...spot, position: [0, Number.NaN, 0] }] }, /spot light 0/],
    [{ spotLights: [{ ...spot, angle: 4 }] }, /spot light 0.*angle/],
    [{ spotLights: Array(MAX_BAKE_SPOT_LIGHTS + 1).fill(spot) }, new RegExp(`at most ${MAX_BAKE_SPOT_LIGHTS} spot lights`)],
    [{ areaLights: [{ ...area, width: -1 }] }, /area light 0.*width/],
    [{ areaLights: [{ ...area, intensity: Infinity }] }, /area light 0/],
    [{ areaLights: Array(MAX_BAKE_AREA_LIGHTS + 1).fill(area) }, new RegExp(`at most ${MAX_BAKE_AREA_LIGHTS} area lights`)],
  ];
  for (const [lights, message] of refused) {
    assert.throws(() => bakeLightmaps(smallRoom(), { ...lamp, ...lights }, fastOptions), message);
  }
});

test('hostile parts and lights are refused before any ray is traced', () => {
  const withPosition = value => {
    const parts = smallRoom();
    const geometry = { ...cube, positions: Float32Array.from(cube.positions) };
    geometry.positions[4] = value;
    parts[0] = { ...parts[0], geometry };
    return parts;
  };
  assert.throws(() => bakeLightmaps(withPosition(Number.NaN), lamp, fastOptions), /non-finite position/);
  assert.throws(() => bakeLightmaps(withPosition(Infinity), lamp, fastOptions), /non-finite position/);
  const badIndex = smallRoom();
  badIndex[0] = { ...badIndex[0], geometry: { ...cube, indices: Uint32Array.from([0, 1, 9999]) } };
  assert.throws(() => bakeLightmaps(badIndex, lamp, fastOptions), /index past its last vertex/);
  const badMatrix = smallRoom();
  badMatrix[1] = { ...badMatrix[1], matrix: new Float32Array(15) };
  assert.throws(() => bakeLightmaps(badMatrix, lamp, fastOptions), /4x4 matrix/);
  const nanMatrix = smallRoom();
  nanMatrix[1].matrix[0] = Number.NaN;
  assert.throws(() => bakeLightmaps(nanMatrix, lamp, fastOptions), /4x4 matrix/);
  const noColor = smallRoom();
  noColor[1] = { ...noColor[1], material: { tag: 'surface' } };
  assert.throws(() => bakeLightmaps(noColor, lamp, fastOptions), /material color/);
  assert.throws(() => bakeLightmaps([], lamp, fastOptions), /from 1 to/);
  assert.throws(() => bakeLightmaps(null, lamp, fastOptions), /from 1 to/);
  const tooManyLights = { pointLights: Array.from({ length: MAX_BAKE_POINT_LIGHTS + 1 }, () => lamp.pointLights[0]) };
  assert.throws(() => bakeLightmaps(smallRoom(), tooManyLights, fastOptions), new RegExp(`at most ${MAX_BAKE_POINT_LIGHTS} point lights`));
  for (const light of [{ position: [Number.NaN, 0, 0], intensity: 1 }, { position: [0, 0, 0], intensity: -1 }, { position: [0, 0, 0], intensity: Infinity }, { position: [0, 0], intensity: 1 }, { position: [0, 0, 0], intensity: 1, range: -2 }]) {
    assert.throws(() => bakeLightmaps(smallRoom(), { pointLights: [light] }, fastOptions), RangeError);
  }
  assert.throws(() => bakeLightmaps(smallRoom(), { keyColor: [1, 1, Number.NaN], lightDirection: [0, 1, 0] }, fastOptions), /keyColor/);
  assert.throws(() => bakeLightmaps(smallRoom(), null, fastOptions), TypeError);
});

test('a bake that would trace too many rays is refused up front', () => {
  const heavy = { samples: BAKE_LIMITS.samples.maximum, bounces: BAKE_LIMITS.bounces.maximum, texelsPerUnit: BAKE_LIMITS.texelsPerUnit.maximum, maxResolution: BAKE_LIMITS.maxResolution.maximum };
  assert.throws(() => bakeLightmaps(smallRoom(), lamp, heavy), /limit is/);
});

test('a light mapped part exports its second UV set as TEXCOORD_1 and its light map as the emissive texture', () => {
  const parts = smallRoom();
  const mapImage = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(180) };
  const withMap = placed('wall', [1.5, 1, 1.5], [1, 2, 1], { map: { image: mapImage, colorSpace: 'srgb' } });
  parts.push({ ...withMap, geometry: { ...cube, uvs: new Float32Array(cube.positions.length / 3 * 2) } });
  const baked = bakeLightmaps(parts, lamp, fastOptions).parts;
  const view = new DataView(exportGlb(baked));
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, 20, view.getUint32(12, true))));
  const lightMapped = json.meshes.find((mesh, index) => json.nodes.some(node => node.mesh === index && node.name === 'wall'));
  assert.ok(lightMapped.primitives[0].attributes.TEXCOORD_1 !== undefined);
  assert.ok(lightMapped.primitives[0].attributes.TEXCOORD_0 !== undefined);
  const material = json.materials[lightMapped.primitives[0].material];
  assert.equal(material.emissiveTexture.texCoord, 1);
  assert.ok(material.pbrMetallicRoughness.baseColorTexture);
});

test('a bake that runs out of time throws instead of returning a partial result', () => {
  const slow = { samples: 256, bounces: 4, texelsPerUnit: 8, maxResolution: 128, maxSeconds: 1 };
  // Each clock read costs a second, so the limit is passed on any machine.
  const realNow = performance.now;
  let clockReads = 0;
  performance.now = () => {
    clockReads += 1;
    return clockReads * 1000;
  };
  try {
    assert.throws(() => bakeLightmaps(smallRoom(), lamp, slow), /maxSeconds/);
  } finally {
    performance.now = realNow;
  }
});

// The mean light a baked part stores, in linear units: the texture is sRGB and is scaled back by the part's emission.
function meanStoredLight(part) {
  const bytes = lightmapBytes(part);
  let total = 0;
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    total += (bytes[index] / 255) ** 2.2;
    count++;
  }
  return (total / count) * part.material.emission;
}

test('the default bounces follow most of the light that a closed room keeps, which two bounces cut off', () => {
  const { bounces, ...withoutBounces } = fastOptions;
  const meanFloorLight = options => meanStoredLight(bakeLightmaps(smallRoom(), lamp, { ...withoutBounces, samples: 48, ...options }).parts[0]);
  const byDefault = meanFloorLight({});
  const two = meanFloorLight({ bounces: 2 });
  const four = meanFloorLight({ bounces: 4 });
  assert.ok(two < byDefault && byDefault < four, `2 bounces ${two}, default ${byDefault}, 4 bounces ${four}`);
  assert.ok(byDefault > two * 1.05, `default ${byDefault} adds too little over 2 bounces ${two}`);
  assert.equal(BAKE_LIMITS.bounces.fallback, 3);
});

test('the backend option is cpu, gpu or webgpu, and the synchronous bake refuses the GPU ones', async () => {
  assert.equal(normalizeBakeOptions({ backend: 'gpu' }).backend, 'gpu');
  assert.equal(normalizeBakeOptions({ backend: 'webgpu' }).backend, 'webgpu');
  assert.throws(() => bakeLightmaps(smallRoom(), lamp, { ...fastOptions, backend: 'webgpu' }), { name: 'TypeError', message: /"webgpu".*light-bake-gpu/ });
  for (const bad of ['WebGPU', 'GPU', 1]) assert.throws(() => normalizeBakeOptions({ backend: bad }), { name: 'TypeError', message: /backend/ }, String(bad));
  assert.throws(() => bakeLightmaps(smallRoom(), lamp, { ...fastOptions, backend: 'gpu' }), { name: 'TypeError', message: /light-bake-gpu/ });
  const asynchronous = await bakeLightmapsAsync(smallRoom(), lamp, fastOptions);
  const synchronous = bakeLightmaps(smallRoom(), lamp, fastOptions);
  assert.equal(asynchronous.report.backend, 'cpu');
  assert.deepEqual(Array.from(lightmapBytes(asynchronous.parts[0])), Array.from(lightmapBytes(synchronous.parts[0])));
});

test('a GPU bake needs a page with WebGL2 and does not take light linking or a sky-only run', async () => {
  await assert.rejects(bakeLightmapsAsync(smallRoom(), lamp, { ...fastOptions, backend: 'gpu' }), /WebGL2/);
  await assert.rejects(bakeLightmapsAsync(smallRoom(), lamp, { ...fastOptions, backend: 'gpu', skyOnly: true }), /CPU backend only/);
  const linked = { pointLights: [{ ...lamp.pointLights[0], affects: ['floor'] }], keyColor: [0, 0, 0] };
  await assert.rejects(bakeLightmapsAsync(smallRoom(), linked, { ...fastOptions, backend: 'gpu' }), /light linking/);
});

test('the GPU backend takes up to 1024 parts where the CPU bake takes 256', () => {
  const crowd = Array.from({ length: MAX_BAKE_PARTS + 1 }, (_, index) => placed(`part-${index}`, [index, 0, 0], [0.5, 0.5, 0.5]));
  assert.throws(() => planLightmaps(crowd, lamp, fastOptions), { name: 'RangeError', message: /1 to 256 parts/ });
  assert.equal(planLightmaps(crowd, lamp, { ...fastOptions, backend: 'gpu' }).entries.length, crowd.length);
  const tooMany = Array.from({ length: MAX_GPU_BAKE_PARTS + 1 }, (_, index) => placed(`part-${index}`, [index, 0, 0], [0.5, 0.5, 0.5]));
  assert.throws(() => planLightmaps(tooMany, lamp, { ...fastOptions, backend: 'gpu' }), { name: 'RangeError', message: /1 to 1024 parts/ });
});
