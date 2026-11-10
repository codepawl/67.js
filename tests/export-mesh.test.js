import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { box, sphere } from '../src/geometry.js';
import { exportObj, exportStl, MAX_MESH_EXPORT_TRIANGLES } from '../src/export-mesh.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';

const redMaterial = { color: [0.8, 0.1, 0.1], metallic: 0, roughness: 0.4 };
const glowMaterial = { color: [0.1, 0.2, 0.9], emissiveColor: [1, 0.5, 0], emission: 0.5, metallic: 1, roughness: 0.2 };

function placed(geometry, translation, scale = [1, 1, 1], material = redMaterial) {
  const matrix = mat4.fromRotationTranslationScale(mat4.create(), [0, 0, 0, 1], translation, scale);
  return { name: 'Part one', geometry, matrix, material };
}

function sceneParts() {
  return [placed(box(), [2, 0, 0], [1, 2, 3]), placed(sphere(12, 8), [0, 5, 0], [1, 1, 1], glowMaterial)];
}

function expectedTriangleCount(parts) {
  return parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
}

function worldBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const { positions } = part.geometry;
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = part.matrix[axis] * positions[offset] + part.matrix[4 + axis] * positions[offset + 1]
          + part.matrix[8 + axis] * positions[offset + 2] + part.matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { minimum, maximum };
}

function readStl(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(buffer.byteLength, 84 + count * 50);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let triangle = 0; triangle < count; triangle++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = view.getFloat32(84 + triangle * 50 + 12 + vertex * 12 + axis * 4, true);
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { count, minimum, maximum };
}

function readObj(text) {
  const vertices = [];
  let faces = 0;
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    if (fields[0] === 'v') vertices.push(fields.slice(1).map(Number));
    if (fields[0] === 'f') {
      faces++;
      for (const corner of fields.slice(1)) assert.ok(Number(corner.split('/')[0]) <= vertices.length, 'face uses a vertex written earlier');
    }
  }
  const minimum = [0, 1, 2].map(axis => Math.min(...vertices.map(vertex => vertex[axis])));
  const maximum = [0, 1, 2].map(axis => Math.max(...vertices.map(vertex => vertex[axis])));
  return { faces, minimum, maximum };
}

function assertClose(actual, expected) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-5, `${actual} vs ${expected}`));
}

test('STL roundtrip keeps the triangle count and world bounds', () => {
  const parts = sceneParts();
  const read = readStl(exportStl(parts));
  const bounds = worldBounds(parts);
  assert.equal(read.count, expectedTriangleCount(parts));
  assertClose(read.minimum, bounds.minimum);
  assertClose(read.maximum, bounds.maximum);
});

test('OBJ roundtrip keeps the triangle count and world bounds, and the MTL names every material', () => {
  const parts = sceneParts();
  const { obj, mtl } = exportObj(parts);
  const read = readObj(obj);
  const bounds = worldBounds(parts);
  assert.equal(read.faces, expectedTriangleCount(parts));
  assertClose(read.minimum, bounds.minimum);
  assertClose(read.maximum, bounds.maximum);
  assert.match(obj, /^mtllib model\.mtl$/m);
  assert.equal(obj.match(/^o Part_one$/gm).length, 2);
  assert.match(mtl, /newmtl material_0\nKd 0\.8 0\.1 0\.1\nPr 0\.4\nPm 0\nd 1/);
  assert.match(mtl, /newmtl material_1\nKd 0\.1 0\.2 0\.9\nKe 0\.5 0\.25 0\nPr 0\.2\nPm 1/);
  assert.ok(obj.includes('usemtl material_1'));
});

test('exports have the same triangles as the GLB export of the same parts', async () => {
  const parts = sceneParts();
  const asset = await parseGltf(exportGlb(parts));
  const glbTriangles = asset.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  assert.equal(readStl(exportStl(parts)).count, glbTriangles);
  assert.equal(readObj(exportObj(parts).obj).faces, glbTriangles);
});

test('output bytes are identical for the same input and parts sharing a material share one MTL entry', () => {
  const parts = [placed(box(), [0, 0, 0]), placed(box(), [3, 0, 0])];
  assert.deepEqual(Buffer.from(exportStl(parts)), Buffer.from(exportStl(parts)));
  assert.deepEqual(exportObj(parts), exportObj(parts));
  assert.equal(exportObj(parts).mtl.match(/newmtl/g).length, 1);
});

test('a mirrored part keeps outward winding and OBJ normals follow non-uniform scale', () => {
  const mirrored = placed(box(), [0, 0, 0], [-1, 1, 1]);
  const view = new DataView(exportStl([mirrored]));
  // The first face normal must point away from the box center.
  const normal = [0, 1, 2].map(axis => view.getFloat32(84 + axis * 4, true));
  const corner = [0, 1, 2].map(axis => view.getFloat32(84 + 12 + axis * 4, true));
  assert.ok(normal[0] * corner[0] + normal[1] * corner[1] + normal[2] * corner[2] > 0);
  const stretched = placed({ ...box(), normals: Float32Array.from([...box().normals].map((_, index) => index % 3 === 0 ? 1 : 0)) }, [0, 0, 0], [1, 4, 1]);
  const firstNormal = exportObj([stretched]).obj.split('\n').find(line => line.startsWith('vn ')).split(' ').slice(1).map(Number);
  assertClose(firstNormal, [1, 0, 0]);
});

test('a part without a matrix exports at its own coordinates', () => {
  const geometry = box();
  const read = readStl(exportStl([{ name: 'bare', geometry, material: redMaterial }]));
  assert.equal(read.count, geometry.indices.length / 3);
});

test('invalid input names the field and what to pass', () => {
  const parts = sceneParts();
  assert.throws(() => exportStl([]), /nonempty parts array/);
  assert.throws(() => exportObj('parts'), /nonempty parts array/);
  assert.throws(() => exportStl([{ geometry: { positions: new Float32Array(3) } }]), /geometry\.positions/);
  assert.throws(() => exportStl([{ geometry: { positions: Float32Array.of(0, 0, 0, 1, 0, 0, NaN, 1, 0), indices: Uint32Array.of(0, 1, 2) } }]), /finite positions/);
  assert.throws(() => exportStl([{ geometry: { positions: new Float32Array(9), indices: [0, 1, 2] } }]), /Uint32Array/);
  assert.throws(() => exportStl([{ geometry: { positions: new Float32Array(9), indices: Uint32Array.of(0, 1, 3) } }]), /index past/);
  assert.throws(() => exportStl([{ ...parts[0], matrix: new Float32Array(15) }]), /part\.matrix/);
  for (const mtlFilename of ['model.txt', '../model.mtl', 'a b.mtl', 7]) {
    assert.throws(() => exportObj(parts, { mtlFilename }), /mtlFilename/);
  }
  assert.equal(exportObj(parts, { mtlFilename: 'scene.mtl' }).obj.includes('mtllib scene.mtl'), true);
});

test('the triangle limit is enforced before any output is built', () => {
  const geometry = { positions: new Float32Array(9), indices: new Uint32Array(MAX_MESH_EXPORT_TRIANGLES * 3 + 3) };
  assert.throws(() => exportStl([{ geometry }]), /limited to 1000000 triangles/);
  assert.throws(() => exportObj([{ geometry }]), /limited to 1000000 triangles/);
});
