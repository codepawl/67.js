import { createMeshData, TAG_PREFIX } from './mesh-data.js';
import { MeshBuilder, mirrorMesh } from './mesh-stack.js';
import { faceNormals } from './mesh-normals.js';
import { facePolygons, buildPolygonMesh, edgeFaces } from './mesh-polygons.js';
import { bisectPlane } from './mesh-bisect.js';
import { dissolveEdges } from './mesh-dissolve.js';
import { UnionFind } from './mesh-topology.js';

// Reshaping edits after Blender's poke, dual mesh, tris to quads, symmetrize, scale elements and extrude edges.
// Every edit is deterministic: elements are visited in index order and ties break toward the lower index.

const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

function positionOf(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

function faceVertices(mesh, face) {
  const vertices = [];
  for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) vertices.push(mesh.cornerVertices[corner]);
  return vertices;
}

function faceCenter(mesh, face) {
  const center = [0, 0, 0];
  const vertices = faceVertices(mesh, face);
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis++) center[axis] += mesh.positions[vertex * 3 + axis] / vertices.length;
  }
  return center;
}

/**
 * Replace each selected face with a triangle fan around a new centre vertex. The centre sits at the face's average
 * point, moved `offset` along the face normal (times the average corner distance when `relative`). The triangles keep
 * the face's attributes and get the tag `<name>.poke`; a corner at the centre takes the middle of its triangle's base.
 */
export function pokeFaces(mesh, faceMask, { offset = 0, relative = false, name = 'poke' } = {}) {
  const { normals } = faceNormals(mesh);
  const extraPositions = [];
  const polygons = facePolygons(mesh);
  const result = [];
  let poked = 0;
  polygons.forEach((polygon, face) => {
    if (!faceMask[face]) {
      result.push(polygon);
      return;
    }
    const center = faceCenter(mesh, face);
    const vertices = polygon.vertices;
    let scale = offset;
    if (relative) {
      const meanDistance = vertices.reduce((sum, vertex) => sum + Math.hypot(...positionOf(mesh, vertex).map((value, axis) => value - center[axis])), 0) / vertices.length;
      scale = offset * meanDistance;
    }
    extraPositions.push(center.map((value, axis) => value + normals[face * 3 + axis] * scale));
    const centerVertex = mesh.vertexCount + extraPositions.length - 1;
    for (let index = 0; index < vertices.length; index++) {
      const next = (index + 1) % vertices.length;
      result.push({
        vertices: [vertices[index], vertices[next], centerVertex],
        sourceFace: face,
        sourceCorners: [polygon.sourceCorners[index], polygon.sourceCorners[next], { from: polygon.sourceCorners[index], to: polygon.sourceCorners[next], t: 0.5 }],
        sourceEdges: [polygon.sourceEdges[index], -1, -1],
        tags: [`${name}.poke`],
      });
    }
    poked++;
  });
  if (poked === 0) throw new RangeError('The selection holds no face to poke.');
  return { mesh: buildPolygonMesh(mesh, result, extraPositions), pokedFaces: poked };
}

/**
 * Dual mesh: one vertex at the centre of every face and one face around every vertex, wound the same way as the
 * original. The mesh must be closed with consistent winding, so that the faces around each vertex form one ring.
 * Dual faces are new, so they carry no attributes and get the tag `<name>.dual`.
 */
export function dualMesh(mesh, { name = 'dual' } = {}) {
  const halfEdgeKey = (from, to) => from * mesh.vertexCount + to;
  const faceOfHalfEdge = new Map();
  const cornersOfVertex = Array.from({ length: mesh.vertexCount }, () => []);
  for (let face = 0; face < mesh.faceCount; face++) {
    const vertices = faceVertices(mesh, face);
    vertices.forEach((vertex, index) => {
      const next = vertices[(index + 1) % vertices.length];
      const key = halfEdgeKey(vertex, next);
      if (faceOfHalfEdge.has(key)) throw new RangeError(`Faces ${faceOfHalfEdge.get(key)} and ${face} both run from vertex ${vertex} to vertex ${next}; dual needs consistent winding. Run flip_normals on the faces that point the wrong way.`);
      faceOfHalfEdge.set(key, face);
      cornersOfVertex[vertex].push({ face, previous: vertices[(index + vertices.length - 1) % vertices.length] });
    });
  }
  const builder = new MeshBuilder(mesh);
  const centers = Array.from({ length: mesh.faceCount }, (_, face) => builder.addVertex(...faceCenter(mesh, face)));
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const corners = cornersOfVertex[vertex];
    if (corners.length === 0) continue;
    const previousOf = new Map(corners.map(({ face, previous }) => [face, previous]));
    const ring = [];
    let face = corners[0].face;
    do {
      ring.push(face);
      const neighbor = faceOfHalfEdge.get(halfEdgeKey(vertex, previousOf.get(face)));
      if (neighbor === undefined) throw new RangeError(`Vertex ${vertex} lies on an open boundary; dual needs a closed mesh. Run fill_holes first.`);
      face = neighbor;
    } while (face !== corners[0].face && ring.length <= corners.length);
    if (ring.length !== corners.length) throw new RangeError(`The faces around vertex ${vertex} do not form one ring (a pinched or non-manifold vertex); dual needs a manifold mesh. Run merge_by_distance or split the mesh.`);
    builder.addFace(ring.map(ringFace => centers[ringFace]), { tags: [`${name}.dual`] });
  }
  return { mesh: builder.build(), dualFaces: builder.faceSources.length, dualVertices: mesh.faceCount };
}

function cornerAngleDegrees(origin, first, second) {
  const a = first.map((value, axis) => value - origin[axis]);
  const b = second.map((value, axis) => value - origin[axis]);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...cross), dot) * 180 / Math.PI;
}

// Joined quad [apex of A, p, apex of B, q] for triangles A = (apex, p, q) and B = (apex, q, p) over the shared edge p-q.
function quadCandidate(mesh, edge, faceA, faceB, normals, maxAngle) {
  const sharedFrom = mesh.edgeVertices[edge * 2];
  const sharedTo = mesh.edgeVertices[edge * 2 + 1];
  const verticesA = faceVertices(mesh, faceA);
  const verticesB = faceVertices(mesh, faceB);
  const startA = verticesA.findIndex(vertex => !(vertex === sharedFrom || vertex === sharedTo));
  const apexA = verticesA[startA];
  const p = verticesA[(startA + 1) % 3];
  const q = verticesA[(startA + 2) % 3];
  const apexB = verticesB.find(vertex => vertex !== p && vertex !== q);
  const quad = [apexA, p, apexB, q];
  const dotNormals = normals[faceA * 3] * normals[faceB * 3] + normals[faceA * 3 + 1] * normals[faceB * 3 + 1] + normals[faceA * 3 + 2] * normals[faceB * 3 + 2];
  if (Math.acos(Math.max(-1, Math.min(1, dotNormals))) * 180 / Math.PI > maxAngle) return null;
  const points = quad.map(vertex => positionOf(mesh, vertex));
  let cost = 0;
  for (let corner = 0; corner < 4; corner++) {
    const angle = cornerAngleDegrees(points[corner], points[(corner + 3) % 4], points[(corner + 1) % 4]);
    if (angle >= 179) return null;
    cost += Math.abs(angle - 90);
  }
  // A concave quad has a corner turning the other way from the face normal.
  const normalX = normals[faceA * 3] + normals[faceB * 3];
  const normalY = normals[faceA * 3 + 1] + normals[faceB * 3 + 1];
  const normalZ = normals[faceA * 3 + 2] + normals[faceB * 3 + 2];
  for (let corner = 0; corner < 4; corner++) {
    const before = points[(corner + 3) % 4];
    const here = points[corner];
    const after = points[(corner + 1) % 4];
    const first = here.map((value, axis) => value - before[axis]);
    const second = after.map((value, axis) => value - here[axis]);
    const turn = (first[1] * second[2] - first[2] * second[1]) * normalX + (first[2] * second[0] - first[0] * second[2]) * normalY + (first[0] * second[1] - first[1] * second[0]) * normalZ;
    if (turn <= 0) return null;
  }
  return { edge, faceA, faceB, cost };
}

/**
 * Join pairs of adjacent selected triangles into quads. A pair qualifies when its face normals differ by at most
 * `angle` degrees and the quad is convex; the best (closest to rectangular) pairs are taken first and each triangle
 * joins at most once. Joined faces get the tag `<name>.merged`.
 */
export function trisToQuads(mesh, faceMask, { angle = 40, name = 'tris' } = {}) {
  const { normals } = faceNormals(mesh);
  const table = edgeFaces(mesh);
  const candidates = [];
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const faces = table.faces[edge];
    if (faces.length !== 2) continue;
    const [faceA, faceB] = faces;
    if (!faceMask[faceA] || !faceMask[faceB]) continue;
    if (mesh.faceOffsets[faceA + 1] - mesh.faceOffsets[faceA] !== 3 || mesh.faceOffsets[faceB + 1] - mesh.faceOffsets[faceB] !== 3) continue;
    const candidate = quadCandidate(mesh, edge, faceA, faceB, normals, angle);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((first, second) => first.cost - second.cost || first.edge - second.edge);
  const taken = new Uint8Array(mesh.faceCount);
  const edgeMask = new Uint8Array(mesh.edgeCount);
  let joined = 0;
  for (const { edge, faceA, faceB } of candidates) {
    if (taken[faceA] || taken[faceB]) continue;
    taken[faceA] = 1;
    taken[faceB] = 1;
    edgeMask[edge] = 1;
    joined++;
  }
  if (joined === 0) throw new RangeError(`No two adjacent selected triangles join into a convex quad within ${angle} degrees. Select triangles (triangulate first), or raise angle.`);
  return { mesh: dissolveEdges(mesh, edgeMask, { name }).mesh, joinedPairs: joined };
}

function withoutTags(mesh, tagNames) {
  const attributes = { ...mesh.attributes, face: { ...mesh.attributes.face } };
  for (const tag of tagNames) delete attributes.face[TAG_PREFIX + tag];
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

/**
 * Make the mesh symmetric across the plane through the origin perpendicular to `axis`: keep the half on the `keep`
 * side ("positive" or "negative"), cut faces that cross the plane, drop the other half and mirror the kept half over
 * it. Mirrored faces get `<name>.mirrored` and swap their left/right (top/bottom, front/back) tags.
 */
export function symmetrizeMesh(mesh, { axis = 'x', keep = 'positive', distance = 1e-4, name = 'symmetrize' } = {}) {
  const axisIndex = AXIS_INDEX[axis];
  const sign = keep === 'positive' ? 1 : -1;
  // 1 on the kept side, -1 on the dropped side, 0 within `distance` of the plane.
  const sideOf = (source, vertex) => {
    const coordinate = source.positions[vertex * 3 + axisIndex] * sign;
    if (coordinate > distance) return 1;
    return coordinate < -distance ? -1 : 0;
  };
  let straddles = false;
  for (let face = 0; face < mesh.faceCount && !straddles; face++) {
    const sides = faceVertices(mesh, face).map(vertex => sideOf(mesh, vertex));
    straddles = sides.includes(1) && sides.includes(-1);
  }
  let current = mesh;
  if (straddles) {
    const normal = [0, 0, 0];
    normal[axisIndex] = 1;
    const cutName = `${name}.cut`;
    const cut = bisectPlane(mesh, { point: [0, 0, 0], normal, distance, name: cutName });
    current = withoutTags(cut.mesh, [`${cutName}.inner`, `${cutName}.outer`]);
  }
  const kept = facePolygons(current).filter(polygon => polygon.vertices.every(vertex => sideOf(current, vertex) >= 0));
  const hasKeptSide = kept.some(polygon => polygon.vertices.some(vertex => sideOf(current, vertex) === 1));
  if (!hasKeptSide) {
    throw new RangeError(`No face lies on the ${keep} side of the ${axis} axis, so there is nothing to mirror. Use keep "${keep === 'positive' ? 'negative' : 'positive'}" or another axis.`);
  }
  const removedFaces = current.faceCount - kept.length;
  const half = buildPolygonMesh(current, kept);
  return { mesh: mirrorMesh(half, { axis, merge: distance, name }), removedFaces };
}

/**
 * Scale the vertices of the selected faces about their centre. Faces that share a vertex scale together as one
 * island, about the average of the island's vertices, so a connected selection keeps its shape. Neighbouring faces
 * that are not selected follow along their shared vertices.
 */
export function scaleElements(mesh, faceMask, { scale }) {
  const groups = new UnionFind(mesh.vertexCount);
  const selected = new Uint8Array(mesh.vertexCount);
  let selectedFaces = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    if (!faceMask[face]) continue;
    selectedFaces++;
    const vertices = faceVertices(mesh, face);
    for (const vertex of vertices) {
      selected[vertex] = 1;
      groups.union(vertices[0], vertex);
    }
  }
  if (selectedFaces === 0) throw new RangeError('The selection holds no face to scale.');
  const sums = new Map();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!selected[vertex]) continue;
    const root = groups.find(vertex);
    if (!sums.has(root)) sums.set(root, { total: [0, 0, 0], count: 0 });
    const island = sums.get(root);
    for (let axis = 0; axis < 3; axis++) island.total[axis] += mesh.positions[vertex * 3 + axis];
    island.count++;
  }
  const positions = Float32Array.from(mesh.positions);
  let movedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!selected[vertex]) continue;
    const island = sums.get(groups.find(vertex));
    for (let axis = 0; axis < 3; axis++) {
      const center = island.total[axis] / island.count;
      positions[vertex * 3 + axis] = center + (mesh.positions[vertex * 3 + axis] - center) * scale;
    }
    movedVertices++;
  }
  const scaled = createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes: mesh.attributes,
  });
  return { mesh: scaled, movedVertices, islands: sums.size };
}

/**
 * Extrude the selected edges: every vertex on a selected edge is copied and moved by `offset`, and each edge gets a
 * quad between it and its copy, tagged `<name>.side`. The new quad is wound against the first face of its edge so a
 * boundary edge continues the surface. Select boundary edges with { "open": true } to grow a surface outward.
 */
export function extrudeEdges(mesh, edgeMask, { offset, name = 'extrude' }) {
  const table = edgeFaces(mesh);
  const polygons = facePolygons(mesh);
  const extraPositions = [];
  const copyOf = new Map();
  const copyVertex = vertex => {
    if (!copyOf.has(vertex)) {
      extraPositions.push(positionOf(mesh, vertex).map((value, axis) => value + offset[axis]));
      copyOf.set(vertex, mesh.vertexCount + extraPositions.length - 1);
    }
    return copyOf.get(vertex);
  };
  let extruded = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!edgeMask[edge]) continue;
    const face = table.faces[edge][0];
    let from = -1;
    let to = -1;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      if (mesh.cornerEdges[corner] !== edge) continue;
      from = mesh.cornerVertices[corner];
      to = mesh.cornerVertices[corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1];
    }
    polygons.push({
      vertices: [to, from, copyVertex(from), copyVertex(to)],
      sourceFace: -1, sourceCorners: null, sourceEdges: null, tags: [`${name}.side`],
    });
    extruded++;
  }
  if (extruded === 0) throw new RangeError('The rule selects no edge. For a surface boundary use { "open": true }.');
  return { mesh: buildPolygonMesh(mesh, polygons, extraPositions), extrudedEdges: extruded };
}
