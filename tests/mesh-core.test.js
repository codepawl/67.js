import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMeshData, editMesh, meshData, validateTopology, meshFromGeometry, extractRender, lintMesh,
  facesWithTag, tagCounts, triangulateMesh, faceNormals, gatherRenderPositions, EditMesh,
} from '../src/mesh.js';
import { box, sphere, cylinder, torus } from '../src/geometry.js';
import { lathe, extrude } from '../src/modeling.js';

function polygonMesh(positions, faces, attributes) {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => { faceOffsets[index + 1] = faceOffsets[index] + face.length; });
  return createMeshData({ positions: new Float32Array(positions), faceOffsets, cornerVertices: new Uint32Array(faces.flat()), attributes });
}

function unitCube() {
  return polygonMesh(
    [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
    [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
  );
}

function grid(columns, rows) {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const offset = (row * (columns + 1) + column) * 3;
      positions[offset] = column;
      positions[offset + 2] = -row;
    }
  }
  const faceOffsets = new Uint32Array(columns * rows + 1);
  const cornerVertices = new Uint32Array(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const face = row * columns + column;
      const first = row * (columns + 1) + column;
      faceOffsets[face + 1] = (face + 1) * 4;
      cornerVertices.set([first, first + 1, first + columns + 2, first + columns + 1], face * 4);
    }
  }
  return createMeshData({ positions, faceOffsets, cornerVertices });
}

function triangleArea(positions, indices, offset) {
  const [a, b, c] = [indices[offset] * 3, indices[offset + 1] * 3, indices[offset + 2] * 3];
  const first = [0, 1, 2].map(axis => positions[b + axis] - positions[a + axis]);
  const second = [0, 1, 2].map(axis => positions[c + axis] - positions[a + axis]);
  return Math.hypot(first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]) / 2;
}

function surfaceArea(geometry) {
  let area = 0;
  for (let offset = 0; offset < geometry.indices.length; offset += 3) area += triangleArea(geometry.positions, geometry.indices, offset);
  return area;
}

test('MeshData derives unique edges for a cube', () => {
  const cube = unitCube();
  assert.equal(cube.vertexCount, 8);
  assert.equal(cube.edgeCount, 12);
  assert.equal(cube.faceCount, 6);
  assert.ok(Object.isFrozen(cube));
});

test('MeshData rejects invalid faces and attributes with actionable messages', () => {
  assert.throws(() => polygonMesh([0, 0, 0, 1, 0, 0], [[0, 1]]), /at least three corners/);
  assert.throws(() => polygonMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 5]]), /missing vertex 5/);
  assert.throws(() => polygonMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 1, 2]]), /repeats vertex/);
  assert.throws(() => polygonMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]], { face: { 'tag:top': { data: new Float32Array(1), size: 1 } } }), /Uint8Array/);
  assert.throws(() => polygonMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]], { corner: { uv: { data: new Float32Array(4), size: 2 } } }), /needs 6 values/);
});

test('EditMesh round trip keeps topology, order and attributes', () => {
  const uv = new Float32Array(24 * 2).map((_, index) => index / 48);
  const source = polygonMesh(
    Array.from(unitCube().positions),
    [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
    { corner: { uv: { data: uv, size: 2 } }, face: { 'tag:top': { data: Uint8Array.from([0, 1, 0, 0, 0, 0]), size: 1 } } },
  );
  const edit = editMesh(source);
  assert.deepEqual(validateTopology(edit), { vertices: 8, edges: 12, faces: 6, loops: 24, euler: 2 });
  assert.equal(edit.vertexDegree(0), 3);
  assert.equal(edit.edgeFaceCount(edit.findEdge(0, 1)), 2);
  assert.deepEqual(edit.faceNeighbors(0).sort(), [2, 3, 4, 5]);
  const back = meshData(edit);
  assert.deepEqual(back.positions, source.positions);
  assert.deepEqual(back.faceOffsets, source.faceOffsets);
  assert.deepEqual(back.cornerVertices, source.cornerVertices);
  assert.deepEqual(back.edgeVertices, source.edgeVertices);
  assert.deepEqual(back.attributes.corner.uv.data, uv);
  assert.deepEqual(facesWithTag(back, 'top'), [1]);
});

test('EditMesh removal keeps every cycle valid and recycles indices', () => {
  const edit = editMesh(unitCube());
  edit.removeFace(0);
  assert.equal(validateTopology(edit).euler, 1);
  edit.removeVertex(6);
  assert.deepEqual(validateTopology(edit), { vertices: 7, edges: 9, faces: 2, loops: 8, euler: 0 });
  const vertex = edit.createVertex(1, 1, 1);
  assert.equal(vertex, 6, 'freed vertex index is reused');
  edit.createFace([1, 2, vertex, 5]);
  edit.createFace([2, 3, 7, vertex]);
  edit.createFace([4, 5, vertex, 7]);
  edit.createFace([0, 1, 2, 3].reverse());
  assert.deepEqual(validateTopology(edit), { vertices: 8, edges: 12, faces: 6, loops: 24, euler: 2 });
  assert.equal(lintMesh(meshData(edit)).ok, true);
});

test('EditMesh rejects faces with repeated or missing vertices', () => {
  const edit = new EditMesh();
  const a = edit.createVertex(0, 0, 0);
  const b = edit.createVertex(1, 0, 0);
  assert.throws(() => edit.createFace([a, b, a]), /repeat/);
  assert.throws(() => edit.createFace([a, b, 99]), /does not exist/);
  assert.throws(() => edit.ensureEdge(a, a), /distinct/);
});

test('validateTopology reports a corrupted link', () => {
  const edit = editMesh(unitCube());
  edit.loops.arrays.next[0] = 5;
  assert.throws(() => validateTopology(edit), /Topology invalid/);
});

test('random face removal and rebuilding keeps the topology valid', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const edit = editMesh(grid(12, 12));
  for (let step = 0; step < 200; step++) {
    const faces = [...edit.liveIndices('face')];
    if (random() < 0.6 && faces.length > 10) {
      edit.removeFace(faces[Math.floor(random() * faces.length)]);
    } else {
      const vertices = [...edit.liveIndices('point')];
      const picked = new Set();
      while (picked.size < 3) picked.add(vertices[Math.floor(random() * vertices.length)]);
      const corners = [...picked];
      const [first, second, third] = corners;
      const occupied = [[first, second], [second, third], [third, first]].some(([from, to]) => {
        const edge = edit.findEdge(from, to);
        return edge !== -1 && edit.edgeLoops(edge).some(loop => edit.loops.arrays.vertex[loop] === from);
      });
      if (!occupied) edit.createFace(corners);
    }
    validateTopology(edit);
  }
  const compact = meshData(edit);
  validateTopology(editMesh(compact));
});

test('meshFromGeometry welds seams, joins quads, marks hard edges and tags a box', () => {
  const mesh = meshFromGeometry(box(0, 1));
  assert.equal(mesh.vertexCount, 8);
  assert.equal(mesh.faceCount, 6);
  assert.equal(mesh.edgeCount, 12);
  assert.ok(mesh.attributes.edge.sharp.data.every(value => value === 1), 'every box edge is hard');
  assert.deepEqual(tagCounts(mesh), { right: 1, left: 1, top: 1, bottom: 1, front: 1, back: 1, side: 4 });
  const report = lintMesh(mesh);
  assert.equal(report.ok, true);
  assert.equal(report.parts.closed, 1);
  assert.deepEqual(report.problems, []);
});

test('meshFromGeometry keeps a sphere smooth and closed', () => {
  const mesh = meshFromGeometry(sphere(32, 16));
  assert.equal(mesh.vertexCount, 32 * 15 + 2);
  const report = lintMesh(mesh);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.parts.count, 1);
  assert.ok(mesh.attributes.edge.sharp.data.every(value => value === 0), 'seam is not a hard edge');
  assert.ok(facesWithTag(mesh, 'top').length > 0);
});

test('extractRender reproduces area and hard edges of generators', () => {
  for (const geometry of [box(0, 1), box(0.1, 3), sphere(24, 12), cylinder(24, 0.05, 2), torus(0.2, 24, 12)]) {
    const mesh = meshFromGeometry(geometry);
    const { geometry: rendered } = extractRender(mesh);
    const expected = surfaceArea(geometry);
    assert.ok(Math.abs(surfaceArea(rendered) - expected) < expected * 1e-4, 'triangulated area matches the input');
    for (let index = 0; index < rendered.normals.length; index += 3) {
      assert.ok(Math.abs(Math.hypot(...rendered.normals.subarray(index, index + 3)) - 1) < 1e-5);
    }
  }
  const { geometry: cube } = extractRender(meshFromGeometry(box(0, 1)));
  assert.equal(cube.positions.length / 3, 24, 'hard cube corners split into one vertex per face');
  assert.equal(cube.indices.length / 3, 12);
});

test('extractRender splits UV seams but not normals, and respects sharpAngle', () => {
  const mesh = meshFromGeometry(lathe([[0, 0], [1, 0], [1, 1], [0, 1]], { segments: 16 }));
  assert.ok(mesh.attributes.corner.uv);
  const { geometry } = extractRender(mesh);
  assert.ok(geometry.uvs.length === geometry.positions.length / 3 * 2);
  const smooth = extractRender(unitCube()).geometry;
  assert.equal(smooth.positions.length / 3, 8, 'no sharp attribute and no angle limit keeps vertices shared');
  const hard = extractRender(unitCube(), { sharpAngle: Math.PI / 6 }).geometry;
  assert.equal(hard.positions.length / 3, 24);
});

test('triangulation handles concave n-gons in both windings', () => {
  const lShape = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  for (const order of [lShape, [...lShape].reverse()]) {
    const mesh = polygonMesh(order.flatMap(([x, z]) => [x, 0, z]), [order.map((_, index) => index)]);
    const { normals } = faceNormals(mesh);
    const { triangleCorners } = triangulateMesh(mesh, normals);
    assert.equal(triangleCorners.length, 12);
    const { geometry } = extractRender(mesh);
    assert.ok(Math.abs(surfaceArea(geometry) - 3) < 1e-6);
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      const [a, b, c] = [0, 1, 2].map(corner => geometry.indices[offset + corner] * 3);
      const p = geometry.positions;
      const crossY = (p[c] - p[a]) * (p[b + 2] - p[a + 2]) - (p[c + 2] - p[a + 2]) * (p[b] - p[a]);
      assert.equal(Math.sign(crossY), Math.sign(normals[1]), 'triangles keep the face winding');
    }
  }
});

test('extrude with holes converts into one closed mesh', () => {
  const geometry = extrude([[-2, -2], [2, -2], [2, 2], [-2, 2]], { holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]], depth: 0.5 });
  const mesh = meshFromGeometry(geometry);
  const report = lintMesh(mesh);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.parts.closed, 1);
  assert.ok(Math.abs(surfaceArea(extractRender(mesh).geometry) - surfaceArea(geometry)) < 1e-4);
});

test('lintMesh names open, non-manifold, inverted and loose problems with fixes', () => {
  const openBox = polygonMesh(Array.from(unitCube().positions), [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]);
  const open = lintMesh(openBox);
  assert.equal(open.ok, true);
  assert.equal(open.problems[0].kind, 'boundary-edge');
  assert.equal(open.problems[0].count, 4);
  const inside = polygonMesh(Array.from(unitCube().positions), [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]);
  const inverted = lintMesh(inside);
  assert.equal(inverted.ok, false);
  assert.equal(inverted.problems[0].kind, 'inverted-part');
  assert.match(inverted.problems[0].fix, /flip_normals/);
  const fin = polygonMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 5, 5, 5], [[0, 1, 2], [1, 0, 3], [0, 1, 4]]);
  const kinds = lintMesh(fin).problems.map(problem => problem.kind);
  assert.ok(kinds.includes('non-manifold-edge'));
  assert.ok(kinds.includes('loose-vertex'));
  const flipped = polygonMesh(Array.from(unitCube().positions), [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]);
  assert.ok(lintMesh(flipped).problems.some(problem => problem.kind === 'inconsistent-winding'));
});

test('lintMesh reports valence, quad quality, topologyScore and quad distortion warnings', () => {
  const cube = unitCube();
  const cubeReport = lintMesh(cube);
  assert.deepEqual(cubeReport.valence, { regular: 0, poles3: 8, poles5: 0, poles6Plus: 0 });
  assert.deepEqual(cubeReport.quadQuality, { meanAngleError: 0, maxAngleError: 0, maxAspect: 1, maxWarp: 0 });
  assert.equal(cubeReport.topologyScore, 0.875);

  const sheet = grid(3, 3);
  const sheetReport = lintMesh(sheet);
  assert.deepEqual(sheetReport.valence, { regular: 4, poles3: 0, poles5: 0, poles6Plus: 0 }, 'boundary vertices are excluded from interior valence counts');
  assert.equal(sheetReport.topologyScore, 1);

  const sphereMesh = meshFromGeometry(sphere(16, 8));
  const sphereReport = lintMesh(sphereMesh);
  assert.equal(sphereReport.valence.poles6Plus, 2, 'the two UV sphere poles have valence 16');
  assert.equal(sphereReport.valence.regular, 16 * 7, 'interior rings are regular valence-4 vertices');
  assert.ok(sphereReport.topologyScore > 0.7 && sphereReport.topologyScore < 1);

  // Fold one quad across its diagonal and skew another corner past 75 degrees from a right angle.
  const warped = polygonMesh([0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1], [[0, 1, 2, 3]]);
  const warpedGeom = lintMesh(warped, { geometry: true });
  assert.ok(warpedGeom.quadQuality.maxWarp > 45);
  assert.ok(warpedGeom.problems.some(problem => problem.kind === 'non-planar-quad'));

  const skewed = polygonMesh([0, 0, 0, 2, 0, 0, 2.5, 0, 0.1, 0.5, 0, 0.1], [[0, 1, 2, 3]]);
  const skewedGeom = lintMesh(skewed, { geometry: true });
  assert.ok(skewedGeom.quadQuality.maxAngleError > 75);
  assert.ok(skewedGeom.problems.some(problem => problem.kind === 'skewed-quad'));
});

test('gatherRenderPositions follows a deform-only edit', () => {
  const mesh = meshFromGeometry(sphere(16, 8));
  const { geometry, renderVertexSource } = extractRender(mesh);
  const moved = createMeshData({ ...mesh, positions: mesh.positions.map(value => value * 2), attributes: mesh.attributes });
  const positions = gatherRenderPositions(moved, renderVertexSource);
  assert.deepEqual(positions, geometry.positions.map(value => value * 2));
});
