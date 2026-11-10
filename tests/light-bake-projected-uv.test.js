import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { meshFromGeometry } from '../src/mesh-convert.js';
import { extractRender } from '../src/mesh-render.js';
import { projectUv } from '../src/mesh-uv-project.js';
import { bakeLightmaps } from '../src/light-bake.js';

const unitBox = box(0, 1);
const lamp = { pointLights: [{ position: [-1.5, 2, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };
const options = { samples: 16, bounces: 2, texelsPerUnit: 8, maxResolution: 64 };

function placed(name, translation, scale, geometry = unitBox, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

// A crate whose own UVs come from the cube projection and the island packer, in a closed lit room.
function litRoomWithCrate(crateMaterial) {
  const projected = projectUv(meshFromGeometry(unitBox), { mode: 'cube' }).mesh;
  const crateGeometry = extractRender(projected).geometry;
  return [
    placed('floor', [0, -0.05, 0], [6, 0.1, 6]),
    placed('ceiling', [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', [0, 1.5, -3.05], [6, 3.2, 0.1]),
    placed('left', [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('front', [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placed('crate', [0.5, 0.5, 0], [1, 1, 1], crateGeometry, crateMaterial),
  ];
}

function insideTriangle(points, x, y) {
  const sign = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const signs = [sign(points[0], points[1]), sign(points[1], points[2]), sign(points[2], points[0])];
  return signs.every(value => value >= 0) || signs.every(value => value <= 0);
}

function triangleFace(geometry, triangle) {
  const corners = [0, 1, 2].map(offset => geometry.indices[triangle * 3 + offset]);
  const normal = [0, 1, 2].map(axis => Math.round(geometry.normals[corners[0] * 3 + axis]));
  return { corners, key: normal.join(',') };
}

// Walks every texel centre inside every triangle and reports the texels claimed by more than one face direction.
function sharedTexels(geometry, resolution) {
  const uvs = geometry.lightUvs ?? geometry.uvs;
  const owners = new Map();
  const shared = [];
  for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
    const { corners, key: faceKey } = triangleFace(geometry, triangle);
    const points = corners.map(corner => [uvs[corner * 2] * resolution, uvs[corner * 2 + 1] * resolution]);
    const minX = Math.floor(Math.min(...points.map(point => point[0])));
    const maxX = Math.ceil(Math.max(...points.map(point => point[0])));
    const minY = Math.floor(Math.min(...points.map(point => point[1])));
    const maxY = Math.ceil(Math.max(...points.map(point => point[1])));
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        if (!insideTriangle(points, x + 0.5, y + 0.5)) continue;
        const texel = `${x},${y}`;
        if (owners.has(texel) && owners.get(texel) !== faceKey) shared.push(texel);
        owners.set(texel, faceKey);
      }
    }
  }
  return shared;
}

function texelBrightness(part, textureKey, faceKey) {
  const geometry = part.geometry;
  const uvs = geometry.lightUvs ?? geometry.uvs;
  const { width, height, data } = part.material[textureKey].image;
  const values = [];
  for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
    const { corners, key } = triangleFace(geometry, triangle);
    if (key !== faceKey) continue;
    const u = corners.reduce((sum, corner) => sum + uvs[corner * 2], 0) / 3;
    const v = corners.reduce((sum, corner) => sum + uvs[corner * 2 + 1], 0) / 3;
    const offset = (Math.min(height - 1, Math.floor(v * height)) * width + Math.min(width - 1, Math.floor(u * width))) * 4;
    values.push((data[offset] + data[offset + 1] + data[offset + 2]) / 3);
  }
  return values;
}

const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;

const cases = [
  ['a plain crate', {}, 'emissiveMap'],
  ['a crate with a texture map', { map: { image: { width: 2, height: 2, data: new Uint8Array(16).fill(200) }, colorSpace: 'srgb' } }, 'lightMap'],
];

for (const [label, material, textureKey] of cases) {
  test(`a lightmap bake on a projected and packed crate: ${label}`, () => {
    const { parts } = bakeLightmaps(litRoomWithCrate(material), lamp, options);
    const crate = parts.find(part => part.name === 'crate');
    const { width, height, data } = crate.material[textureKey].image;
    assert.equal(width, height);
    assert.deepEqual(sharedTexels(crate.geometry, width), [], 'no texel is shared by two faces');
    for (const value of crate.geometry.lightUvs ?? crate.geometry.uvs) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    for (const byte of data) assert.ok(Number.isFinite(byte));
    const toward = average(texelBrightness(crate, textureKey, '-1,0,0'));
    const away = average(texelBrightness(crate, textureKey, '1,0,0'));
    assert.ok(toward > 0 && Number.isFinite(away));
    assert.ok(toward > away * 1.5, `face toward the lamp ${toward} against the far face ${away}`);
  });
}
