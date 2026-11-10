import { createMeshData } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { facePolygons, buildPolygonMesh, edgeFaces } from './mesh-polygons.js';
import { UnionFind } from './mesh-topology.js';

// Split edges, delete loose vertices and flatten vertices after Blender's split edges, delete loose and flatten.
// Every edit is deterministic: elements are visited in index order.

function positionOf(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

// Corners that sit on the same vertex of a shared edge belong to one fan of faces.
function joinCornersOfEdge(mesh, corners, groups) {
  const first = corners[0];
  for (const other of corners.slice(1)) {
    const sameDirection = mesh.cornerVertices[first.from] === mesh.cornerVertices[other.from];
    groups.union(first.from, sameDirection ? other.from : other.to);
    groups.union(first.to, sameDirection ? other.to : other.from);
  }
}

/**
 * Split the selected edges: the faces on the two sides of each selected edge stop sharing its vertices, so the surface
 * opens along it. A vertex is copied once for every group of faces that still meet around it through an edge that is
 * not selected; the first group keeps the original vertex. Faces keep their corner order, tags and attributes.
 */
export function splitEdges(mesh, edgeMask) {
  const table = edgeFaces(mesh);
  const groups = new UnionFind(mesh.cornerVertices.length);
  const cornersOfEdge = Array.from({ length: mesh.edgeCount }, () => []);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      cornersOfEdge[mesh.cornerEdges[corner]].push({ from: corner, to: corner + 1 === end ? start : corner + 1 });
    }
  }
  let splitCount = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!edgeMask[edge]) {
      joinCornersOfEdge(mesh, cornersOfEdge[edge], groups);
    } else if (table.faces[edge].length > 1) {
      splitCount++;
    }
  }
  if (splitCount === 0) throw new RangeError('The rule selects no edge shared by two faces. Select interior edges, such as { "angle": 30 } or { "all": true }.');
  const extraPositions = [];
  const vertexOfGroup = new Map();
  const seenVertices = new Set();
  const polygons = facePolygons(mesh);
  for (const polygon of polygons) {
    polygon.vertices = polygon.sourceCorners.map(corner => {
      const vertex = mesh.cornerVertices[corner];
      const group = groups.find(corner);
      if (!vertexOfGroup.has(group)) {
        if (seenVertices.has(vertex)) {
          extraPositions.push(positionOf(mesh, vertex));
          vertexOfGroup.set(group, mesh.vertexCount + extraPositions.length - 1);
        } else {
          seenVertices.add(vertex);
          vertexOfGroup.set(group, vertex);
        }
      }
      return vertexOfGroup.get(group);
    });
  }
  return { mesh: buildPolygonMesh(mesh, polygons, extraPositions), splitEdges: splitCount, addedVertices: extraPositions.length };
}

/** Drop every vertex that no face uses. Faces, tags and attributes stay as they are. */
export function deleteLoose(mesh) {
  const used = new Uint8Array(mesh.vertexCount);
  for (const vertex of mesh.cornerVertices) used[vertex] = 1;
  const removedVertices = used.reduce((count, flag) => count + (flag ? 0 : 1), 0);
  if (removedVertices === 0) throw new RangeError('The mesh has no loose vertex. mesh_lint lists loose vertices as loose-vertex.');
  return { mesh: buildPolygonMesh(mesh, facePolygons(mesh)), removedVertices };
}

function averageSelectedFaceNormal(mesh, vertexMask) {
  const { normals, areas } = faceNormals(mesh);
  const total = [0, 0, 0];
  for (let face = 0; face < mesh.faceCount; face++) {
    let allSelected = true;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      if (!vertexMask[mesh.cornerVertices[corner]]) allSelected = false;
    }
    if (!allSelected) continue;
    for (let axis = 0; axis < 3; axis++) total[axis] += normals[face * 3 + axis] * areas[face];
  }
  return total;
}

/**
 * Move the selected vertices toward the plane through their average point. `normal` is the plane direction; without
 * one it is the area-weighted average normal of the faces whose corners are all selected. `factor` 1 lands every
 * vertex on the plane and 0 leaves it where it is.
 */
export function flattenVertices(mesh, vertexMask, { normal = null, factor = 1 } = {}) {
  const center = [0, 0, 0];
  let count = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!vertexMask[vertex]) continue;
    count++;
    for (let axis = 0; axis < 3; axis++) center[axis] += mesh.positions[vertex * 3 + axis];
  }
  if (count === 0) throw new RangeError('The rule selects no vertex. Use { "all": true } or { "vertices": [0, 1, 2, 3] }.');
  for (let axis = 0; axis < 3; axis++) center[axis] /= count;
  const planeNormal = normal ?? averageSelectedFaceNormal(mesh, vertexMask);
  const planeLength = Math.hypot(...planeNormal);
  if (planeLength === 0) throw new RangeError('No plane direction: no face has all of its vertices selected. Pass normal, such as [0, 1, 0].');
  const unit = planeNormal.map(value => value / planeLength);
  const positions = Float32Array.from(mesh.positions);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!vertexMask[vertex]) continue;
    let distance = 0;
    for (let axis = 0; axis < 3; axis++) distance += (mesh.positions[vertex * 3 + axis] - center[axis]) * unit[axis];
    for (let axis = 0; axis < 3; axis++) positions[vertex * 3 + axis] -= unit[axis] * distance * factor;
  }
  const flattened = createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes: mesh.attributes,
  });
  return { mesh: flattened, flattenedVertices: count };
}

function crossProduct(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/** The selected vertices as closed loops: every vertex has exactly two selected neighbours along an edge. */
function selectedLoops(mesh, vertexMask) {
  const neighbors = new Map();
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if (!vertexMask[first] || !vertexMask[second]) continue;
    for (const [vertex, other] of [[first, second], [second, first]]) {
      if (!neighbors.has(vertex)) neighbors.set(vertex, []);
      neighbors.get(vertex).push(other);
    }
  }
  const loops = [];
  const visited = new Set();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!vertexMask[vertex]) continue;
    const around = neighbors.get(vertex) ?? [];
    if (around.length !== 2) {
      throw new RangeError(`Vertex ${vertex} has ${around.length} selected neighbours; circularize needs closed loops where each vertex has exactly 2. Select only the vertices of the loop, such as { "vertices": [0, 1, 2, 3] }.`);
    }
    if (visited.has(vertex)) continue;
    const loop = [vertex];
    visited.add(vertex);
    let previous = vertex;
    let current = Math.min(...around);
    while (current !== vertex) {
      loop.push(current);
      visited.add(current);
      const [one, two] = neighbors.get(current);
      if (one === undefined || two === undefined) throw new RangeError('The selected vertices do not form closed loops.');
      const next = one === previous ? two : one;
      previous = current;
      current = next;
    }
    if (loop.length < 3) throw new RangeError(`The loop through vertex ${vertex} has ${loop.length} vertices; circularize needs at least 3.`);
    loops.push(loop);
  }
  if (loops.length === 0) throw new RangeError('The rule selects no vertex. Use a loop such as { "vertices": [0, 1, 2, 3] }.');
  return loops;
}

/**
 * Turn each selected vertex loop into a circle after LoopTools Circle. The circle lies in the loop's best plane (the
 * Newell normal), centred on the average point, with the average distance as its radius. `regular` spaces the vertices
 * evenly from the first one; otherwise each keeps its own angle. `factor` 1 lands on the circle and 0 changes nothing.
 */
export function circularizeVertices(mesh, vertexMask, { factor = 1, regular = true } = {}) {
  const positions = Float32Array.from(mesh.positions);
  let circularizedVertices = 0;
  for (const loop of selectedLoops(mesh, vertexMask)) {
    const points = loop.map(vertex => positionOf(mesh, vertex));
    const center = [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
    const offsets = points.map(point => point.map((value, axis) => value - center[axis]));
    const normal = [0, 0, 0];
    offsets.forEach((offset, index) => {
      const area = crossProduct(offset, offsets[(index + 1) % offsets.length]);
      for (let axis = 0; axis < 3; axis++) normal[axis] += area[axis];
    });
    const normalLength = Math.hypot(...normal);
    if (normalLength === 0) throw new RangeError(`The loop through vertex ${loop[0]} is degenerate (no plane); circularize needs a loop that encloses an area.`);
    const unit = normal.map(value => value / normalLength);
    const inPlane = offsets.map(offset => {
      const height = dotProduct(offset, unit);
      return offset.map((value, axis) => value - unit[axis] * height);
    });
    const radius = inPlane.reduce((sum, offset) => sum + Math.hypot(...offset), 0) / inPlane.length;
    const firstLength = Math.hypot(...inPlane[0]);
    if (firstLength === 0) throw new RangeError(`Vertex ${loop[0]} sits on the loop's centre; circularize cannot tell its direction.`);
    const along = inPlane[0].map(value => value / firstLength);
    const across = crossProduct(unit, along);
    loop.forEach((vertex, index) => {
      const angle = regular
        ? index * 2 * Math.PI / loop.length
        : Math.atan2(dotProduct(inPlane[index], across), dotProduct(inPlane[index], along));
      for (let axis = 0; axis < 3; axis++) {
        const target = center[axis] + radius * (Math.cos(angle) * along[axis] + Math.sin(angle) * across[axis]);
        const current = positions[vertex * 3 + axis];
        positions[vertex * 3 + axis] = current + (target - current) * factor;
      }
      circularizedVertices++;
    });
  }
  const circular = createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes: mesh.attributes,
  });
  return { mesh: circular, circularizedVertices };
}
