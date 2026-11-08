// Compact polygon mesh in Blender's evaluated-mesh layout: positions, face offsets into corner arrays,
// and edges derived once from face boundaries. Attributes live on four domains.

export const DOMAINS = Object.freeze(['point', 'edge', 'face', 'corner']);
export const MAX_MESH_VERTICES = 4_000_000;
export const MAX_MESH_CORNERS = 16_000_000;
export const TAG_PREFIX = 'tag:';
export const GROUP_PREFIX = 'group:';
const RESERVED_ATTRIBUTE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const ATTRIBUTE_TYPES = new Map([
  [Float32Array, 'float32'], [Uint8Array, 'uint8'], [Uint16Array, 'uint16'],
  [Uint32Array, 'uint32'], [Int32Array, 'int32'],
]);

function allFinite(values) {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

function domainCount(mesh, domain) {
  if (domain === 'point') return mesh.vertexCount;
  if (domain === 'edge') return mesh.edgeCount;
  if (domain === 'face') return mesh.faceCount;
  return mesh.cornerCount;
}

function validateAttribute(name, attribute, expectedCount) {
  // Attributes are stored by name on plain objects, where these names would reach the prototype instead of an attribute.
  if (RESERVED_ATTRIBUTE_NAMES.has(name)) throw new TypeError(`Attribute name ${name} is reserved; pick another name.`);
  if (!attribute || typeof attribute !== 'object') throw new TypeError(`Attribute ${name} must be { data, size }.`);
  const { data, size } = attribute;
  if (!ATTRIBUTE_TYPES.has(data?.constructor)) throw new TypeError(`Attribute ${name} needs a Float32, Uint8, Uint16, Uint32 or Int32 array.`);
  if (!Number.isInteger(size) || size < 1 || size > 16) throw new RangeError(`Attribute ${name} size must be an integer from 1 to 16.`);
  if (data.length !== expectedCount * size) throw new RangeError(`Attribute ${name} needs ${expectedCount * size} values, not ${data.length}.`);
  if (data instanceof Float32Array && !allFinite(data)) throw new RangeError(`Attribute ${name} contains non-finite values.`);
  return Object.freeze({ data, size });
}

function validateFaces(vertexCount, faceOffsets, cornerVertices) {
  if (!(faceOffsets instanceof Uint32Array) || faceOffsets.length < 2 || faceOffsets[0] !== 0) {
    throw new TypeError('faceOffsets must be a Uint32Array that starts at 0 and has faceCount + 1 entries.');
  }
  if (!(cornerVertices instanceof Uint32Array) || faceOffsets.at(-1) !== cornerVertices.length) {
    throw new TypeError('cornerVertices must be a Uint32Array whose length equals the last face offset.');
  }
  if (cornerVertices.length > MAX_MESH_CORNERS) throw new RangeError(`Meshes support at most ${MAX_MESH_CORNERS} corners.`);
  for (let face = 0; face + 1 < faceOffsets.length; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    if (end - start < 3) throw new RangeError(`Face ${face} needs at least three corners.`);
    for (let corner = start; corner < end; corner++) {
      const vertex = cornerVertices[corner];
      if (vertex >= vertexCount) throw new RangeError(`Face ${face} references missing vertex ${vertex}.`);
      const next = corner + 1 === end ? cornerVertices[start] : cornerVertices[corner + 1];
      if (next === vertex) throw new RangeError(`Face ${face} repeats vertex ${vertex} on consecutive corners.`);
    }
  }
}

function validateExplicitEdges(vertexCount, faceOffsets, cornerVertices, edgeVertices, cornerEdges) {
  if (!(edgeVertices instanceof Uint32Array) || edgeVertices.length % 2 !== 0) throw new TypeError('edgeVertices must be a Uint32Array of vertex pairs.');
  if (!(cornerEdges instanceof Uint32Array) || cornerEdges.length !== cornerVertices.length) throw new TypeError('cornerEdges needs one edge per corner.');
  const edgeCount = edgeVertices.length / 2;
  for (let edge = 0; edge < edgeCount; edge++) {
    const first = edgeVertices[edge * 2];
    const second = edgeVertices[edge * 2 + 1];
    if (first >= vertexCount || second >= vertexCount || first === second) throw new RangeError(`Edge ${edge} has invalid vertices.`);
  }
  for (let face = 0; face + 1 < faceOffsets.length; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const edge = cornerEdges[corner];
      if (edge >= edgeCount) throw new RangeError(`Corner ${corner} references missing edge ${edge}.`);
      const vertex = cornerVertices[corner];
      const nextVertex = corner + 1 === end ? cornerVertices[start] : cornerVertices[corner + 1];
      const first = edgeVertices[edge * 2];
      const second = edgeVertices[edge * 2 + 1];
      const matches = (first === vertex && second === nextVertex) || (first === nextVertex && second === vertex);
      if (!matches) throw new RangeError(`Corner ${corner} edge ${edge} does not join its vertices.`);
    }
  }
}

/**
 * Derive unique undirected edges and the edge of every corner (corner to the next corner of its face).
 * Edges are found through per-vertex linked lists, so the cost is linear in corners times vertex degree.
 */
export function deriveEdges(vertexCount, faceOffsets, cornerVertices) {
  const cornerCount = cornerVertices.length;
  const firstEdgeOfVertex = new Int32Array(vertexCount).fill(-1);
  const nextEdgeOfSameVertex = new Int32Array(cornerCount);
  const edgeVertices = new Uint32Array(cornerCount * 2);
  const cornerEdges = new Uint32Array(cornerCount);
  let edgeCount = 0;
  const faceCount = faceOffsets.length - 1;
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const vertex = cornerVertices[corner];
      const nextVertex = corner + 1 === end ? cornerVertices[start] : cornerVertices[corner + 1];
      const low = Math.min(vertex, nextVertex);
      const high = Math.max(vertex, nextVertex);
      let edge = firstEdgeOfVertex[low];
      while (edge !== -1 && edgeVertices[edge * 2 + 1] !== high) edge = nextEdgeOfSameVertex[edge];
      if (edge === -1) {
        edge = edgeCount;
        edgeCount++;
        edgeVertices[edge * 2] = low;
        edgeVertices[edge * 2 + 1] = high;
        nextEdgeOfSameVertex[edge] = firstEdgeOfVertex[low];
        firstEdgeOfVertex[low] = edge;
      }
      cornerEdges[corner] = edge;
    }
  }
  return { edgeVertices: edgeVertices.slice(0, edgeCount * 2), cornerEdges, edgeCount };
}

/**
 * Create an immutable polygon mesh. Inputs are used without copying; callers must not mutate them afterwards.
 * attributes: { point: { name: { data, size } }, edge: {...}, face: {...}, corner: {...} }.
 * Edge attributes are only accepted together with edgeVertices and cornerEdges, because derived edge order is internal.
 */
export function createMeshData({ positions, faceOffsets, cornerVertices, edgeVertices, cornerEdges, attributes = {} }) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0 || positions.length === 0) {
    throw new TypeError('positions must be a nonempty Float32Array of XYZ triples.');
  }
  const vertexCount = positions.length / 3;
  if (vertexCount > MAX_MESH_VERTICES) throw new RangeError(`Meshes support at most ${MAX_MESH_VERTICES} vertices.`);
  if (!allFinite(positions)) throw new RangeError('positions must be finite.');
  validateFaces(vertexCount, faceOffsets, cornerVertices);
  let edges;
  if (edgeVertices && cornerEdges) {
    validateExplicitEdges(vertexCount, faceOffsets, cornerVertices, edgeVertices, cornerEdges);
    edges = { edgeVertices, cornerEdges, edgeCount: edgeVertices.length / 2 };
  } else {
    if (attributes.edge && Object.keys(attributes.edge).length) throw new TypeError('Edge attributes need explicit edgeVertices and cornerEdges.');
    edges = deriveEdges(vertexCount, faceOffsets, cornerVertices);
  }
  const mesh = {
    vertexCount,
    edgeCount: edges.edgeCount,
    faceCount: faceOffsets.length - 1,
    cornerCount: cornerVertices.length,
    positions, faceOffsets, cornerVertices,
    edgeVertices: edges.edgeVertices,
    cornerEdges: edges.cornerEdges,
  };
  const validated = {};
  for (const domain of DOMAINS) {
    const entries = attributes[domain] ?? {};
    const domainAttributes = {};
    for (const [name, attribute] of Object.entries(entries)) {
      domainAttributes[name] = validateAttribute(name, attribute, domainCount(mesh, domain));
    }
    validated[domain] = Object.freeze(domainAttributes);
  }
  for (const name of Object.keys(validated.face)) {
    if (name.startsWith(TAG_PREFIX) && (!(validated.face[name].data instanceof Uint8Array) || validated.face[name].size !== 1)) {
      throw new TypeError(`Tag ${name} must be a Uint8Array face attribute of size 1.`);
    }
  }
  mesh.attributes = Object.freeze(validated);
  return Object.freeze(mesh);
}

/** Names of face tags, without the "tag:" prefix. */
export function meshTags(mesh) {
  return Object.keys(mesh.attributes.face).filter(name => name.startsWith(TAG_PREFIX)).map(name => name.slice(TAG_PREFIX.length));
}

/** Names of vertex groups (point attributes "group:<name>" of one float weight per vertex), without the prefix. */
export function vertexGroupNames(mesh) {
  return Object.keys(mesh.attributes.point).filter(name => name.startsWith(GROUP_PREFIX)).map(name => name.slice(GROUP_PREFIX.length));
}

/** The weight of every vertex in a named group. Throws a message listing the known groups when the name is unknown. */
export function vertexGroupWeights(mesh, name) {
  const attribute = mesh.attributes.point[GROUP_PREFIX + name];
  if (!attribute || attribute.size !== 1) {
    throw new RangeError(`Unknown vertex group ${name}. Known groups: ${vertexGroupNames(mesh).join(', ') || 'none'}. Make one with a vertex_group edit before this one.`);
  }
  return attribute.data;
}

/** Face indices carrying a tag. */
export function facesWithTag(mesh, tag) {
  const attribute = mesh.attributes.face[TAG_PREFIX + tag];
  if (!attribute) throw new RangeError(`Unknown tag ${tag}. Known tags: ${meshTags(mesh).join(', ') || 'none'}.`);
  const faces = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    if (attribute.data[face]) faces.push(face);
  }
  return faces;
}

/** Number of faces carrying each tag. */
export function tagCounts(mesh) {
  const counts = {};
  for (const tag of meshTags(mesh)) {
    const data = mesh.attributes.face[TAG_PREFIX + tag].data;
    let count = 0;
    for (let face = 0; face < mesh.faceCount; face++) count += data[face] ? 1 : 0;
    counts[tag] = count;
  }
  return counts;
}

/** Axis-aligned bounds of the positions. */
export function meshBounds(mesh) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positions = mesh.positions;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[offset + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
  }
  return { min: minimum, max: maximum };
}
