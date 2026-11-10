import { MeshBuilder } from './mesh-stack.js';

// Unsubdivide: reverse one level of Catmull-Clark subdivision where the topology allows it.
//
// One level turns every coarse face into quads that each hold one face point, two edge points and one original vertex,
// in that cyclic order. So the vertices fall into three roles, and the original vertices (with the coarse faces made of
// them) are what is left. The surviving vertices stay where they are: the smoothing is not undone, so a subdivide
// followed by an unsubdivide gives the coarse topology with vertices pulled slightly inward, like Blender's Un-Subdivide.

const EDGE_POINT = 0;
const FACE_POINT = 1;
const ORIGINAL = 2;
const NO_ROLE = -1;

function cornersOf(mesh, face) {
  return Array.from(mesh.cornerVertices.subarray(mesh.faceOffsets[face], mesh.faceOffsets[face + 1]));
}

function neighborLists(mesh) {
  const neighbors = Array.from({ length: mesh.vertexCount }, () => []);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    neighbors[first].push(second);
    neighbors[second].push(first);
  }
  return neighbors;
}

function facesOfVertex(mesh) {
  const faces = Array.from({ length: mesh.vertexCount }, () => []);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (const vertex of cornersOf(mesh, face)) faces[vertex].push(face);
  }
  return faces;
}

/** Walk the vertices of one connected piece in index order, 2-coloring them by edge. Returns null when an edge joins equal colors. */
function bipartitePiece(start, neighbors, color) {
  const piece = [start];
  color[start] = 0;
  for (let index = 0; index < piece.length; index++) {
    const vertex = piece[index];
    for (const other of neighbors[vertex]) {
      if (color[other] === -1) {
        color[other] = 1 - color[vertex];
        piece.push(other);
      } else if (color[other] === color[vertex]) {
        return null;
      }
    }
  }
  return piece;
}

/** Give the vertices that are not edge points the role face point or original so that every quad has one of each. */
function assignFaceAndOriginal(mesh, piece, faceLists, roles, seedRole) {
  const seed = piece.find(vertex => roles[vertex] === NO_ROLE);
  if (seed === undefined) return 'it has no vertex besides the edge points';
  const queue = [seed];
  roles[seed] = seedRole;
  for (let index = 0; index < queue.length; index++) {
    const vertex = queue[index];
    for (const face of faceLists[vertex]) {
      const corners = cornersOf(mesh, face);
      const opposite = corners[(corners.indexOf(vertex) + 2) % 4];
      if (roles[opposite] === NO_ROLE) {
        roles[opposite] = roles[vertex] === FACE_POINT ? ORIGINAL : FACE_POINT;
        queue.push(opposite);
      } else if (roles[opposite] === roles[vertex]) {
        return `quad ${face} joins two vertices of the same kind across its diagonal`;
      }
    }
  }
  return null;
}

/** The coarse face around one face point: the original vertex of each quad around it, in winding order. Returns { error } on failure. */
function coarseFaceAround(mesh, facePoint, faceLists, roles) {
  const quads = faceLists[facePoint].map(face => {
    const corners = cornersOf(mesh, face);
    const start = corners.indexOf(facePoint);
    const [, edgeBefore, original, edgeAfter] = [0, 1, 2, 3].map(offset => corners[(start + offset) % 4]);
    const fits = roles[edgeBefore] === EDGE_POINT && roles[original] === ORIGINAL && roles[edgeAfter] === EDGE_POINT;
    return { face, edgeBefore, original, edgeAfter, fits };
  });
  const misfit = quads.find(quad => !quad.fits);
  if (misfit) return { error: `quad ${misfit.face} around vertex ${facePoint} is not face point, edge point, original vertex, edge point` };
  const byEdgeBefore = new Map(quads.map(quad => [quad.edgeBefore, quad]));
  if (byEdgeBefore.size !== quads.length) return { error: `the quads around vertex ${facePoint} share an edge point twice` };
  const polygon = [];
  let quad = quads[0];
  do {
    polygon.push(quad.original);
    quad = byEdgeBefore.get(quad.edgeAfter);
  } while (quad && quad !== quads[0] && polygon.length <= quads.length);
  if (quad !== quads[0] || polygon.length !== quads.length) return { error: `the quads around vertex ${facePoint} do not close into one ring` };
  if (polygon.length < 3 || new Set(polygon).size !== polygon.length) return { error: `vertex ${facePoint} would make a coarse face of fewer than 3 distinct vertices` };
  return { polygon, quadCount: quads.length };
}

function tryRoles(mesh, piece, edgeClass, seedRole, faceLists, color) {
  const roles = new Int8Array(mesh.vertexCount).fill(NO_ROLE);
  const ascending = [...piece].sort((first, second) => first - second);
  for (const vertex of ascending) {
    if (color[vertex] === edgeClass) roles[vertex] = EDGE_POINT;
  }
  const failure = assignFaceAndOriginal(mesh, piece, faceLists, roles, seedRole);
  if (failure) return { error: failure };
  const polygons = [];
  let quadsCovered = 0;
  for (const vertex of ascending) {
    if (roles[vertex] !== FACE_POINT) continue;
    const outcome = coarseFaceAround(mesh, vertex, faceLists, roles);
    if (outcome.error) return outcome;
    polygons.push(outcome.polygon);
    quadsCovered += outcome.quadCount;
  }
  const quadsInPiece = new Set(piece.flatMap(vertex => faceLists[vertex])).size;
  if (quadsCovered !== quadsInPiece) return { error: 'some quads have no face point' };
  return { polygons };
}

function coarsePolygonsOfPiece(mesh, piece, faceLists, color) {
  const seedClass = color[piece[0]];
  const firstError = [];
  for (const edgeClass of [1 - seedClass, seedClass]) {
    for (const seedRole of [ORIGINAL, FACE_POINT]) {
      const outcome = tryRoles(mesh, piece, edgeClass, seedRole, faceLists, color);
      if (outcome.polygons) return outcome.polygons;
      firstError.push(outcome.error);
    }
  }
  return { error: firstError[0] };
}

/**
 * Reverse one Catmull-Clark level. Needs a mesh made only of quads that came from one subdivision (every coarse face
 * becomes one face, every original vertex survives at its place). Throws a RangeError that names the quad that breaks it.
 */
export function unsubdivideMesh(mesh) {
  const triangleOrPolygon = Array.from({ length: mesh.faceCount }, (_, face) => face)
    .find(face => mesh.faceOffsets[face + 1] - mesh.faceOffsets[face] !== 4);
  if (triangleOrPolygon !== undefined) {
    throw new RangeError(`Face ${triangleOrPolygon} is not a quad; unsubdivide reverses Catmull-Clark subdivision, which leaves only quads. Run tris_to_quads first, or use a mesh from the subdivide edit.`);
  }
  const neighbors = neighborLists(mesh);
  const faceLists = facesOfVertex(mesh);
  const color = new Int8Array(mesh.vertexCount).fill(-1);
  const allPolygons = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (color[vertex] !== -1 || neighbors[vertex].length === 0) continue;
    const piece = bipartitePiece(vertex, neighbors, color);
    if (!piece) throw new RangeError(`The edges around vertex ${vertex} form an odd cycle, so the mesh is not a subdivided surface (a subdivided mesh alternates edge points and the rest). Unsubdivide needs one level of Catmull-Clark output.`);
    const polygons = coarsePolygonsOfPiece(mesh, piece, faceLists, color);
    if (polygons.error) throw new RangeError(`The mesh is not one level of Catmull-Clark subdivision: ${polygons.error}. Unsubdivide only reverses that exact pattern.`);
    allPolygons.push(...polygons);
  }
  const survivors = [...new Set(allPolygons.flat())].sort((first, second) => first - second);
  const builder = new MeshBuilder(mesh);
  const remap = new Map(survivors.map(vertex => [vertex, builder.addVertex(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2])]));
  for (const polygon of allPolygons) builder.addFace(polygon.map(vertex => remap.get(vertex)));
  return { mesh: builder.build(), coarseFaces: allPolygons.length, removedVertices: mesh.vertexCount - survivors.length };
}
