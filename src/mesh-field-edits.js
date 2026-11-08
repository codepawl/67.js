import { createMeshData, vertexGroupWeights } from './mesh-data.js';
import { evaluateField, meshFieldContext } from './mesh-fields.js';
import { vertexNormals } from './mesh-normals.js';
import { selectFaces } from './mesh-select.js';

// Edits driven by field expressions (see mesh-fields.js). Every expression is evaluated on the input positions
// before anything moves, so the result does not depend on vertex order.

export const DISPLACE_DIRECTIONS = Object.freeze(['normal', 'x', 'y', 'z']);
const AXIS_DIRECTIONS = new Map([['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]);

export function withPositions(mesh, positions) {
  return createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes: mesh.attributes,
  });
}

/** One flag per vertex: set when the vertex belongs to a face the rule selects. Without a rule, every vertex. */
export function selectedVertices(mesh, rule) {
  const flags = new Uint8Array(mesh.vertexCount);
  if (!rule) {
    flags.fill(1);
    return flags;
  }
  const faceMask = selectFaces(mesh, rule);
  for (let face = 0; face < mesh.faceCount; face++) {
    if (!faceMask[face]) continue;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) flags[mesh.cornerVertices[corner]] = 1;
  }
  return flags;
}

/**
 * Blender's Set Position: `position` (a vector expression, default the current position) and then `offset` (a vector
 * expression added to it) for the vertices of the selected faces.
 */
export function setPosition(mesh, { select, position, offset }) {
  const context = meshFieldContext(mesh, 'point');
  const target = position === undefined ? null : evaluateField(position, context, { kind: 'vector' }).values;
  const shift = offset === undefined ? null : evaluateField(offset, context, { kind: 'vector' }).values;
  const flags = selectedVertices(mesh, select);
  const positions = new Float32Array(mesh.positions);
  let movedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!flags[vertex]) continue;
    movedVertices++;
    for (let axis = 0; axis < 3; axis++) {
      const base = target ? target[vertex * 3 + axis] : mesh.positions[vertex * 3 + axis];
      positions[vertex * 3 + axis] = base + (shift ? shift[vertex * 3 + axis] : 0);
    }
  }
  return { mesh: withPositions(mesh, positions), movedVertices };
}

/**
 * Blender's Displace modifier with a field as the texture: each vertex of the selected faces moves by
 * (field - midlevel) * strength along its normal or an axis.
 */
export function displaceMesh(mesh, { select, field, strength = 1, midlevel = 0.5, direction = 'normal', group }) {
  const context = meshFieldContext(mesh, 'point');
  const { values } = evaluateField(field, context, { kind: 'scalar' });
  const normals = direction === 'normal' ? vertexNormals(mesh) : null;
  const axis = AXIS_DIRECTIONS.get(direction);
  const flags = selectedVertices(mesh, select);
  // A vertex group scales the move per vertex, as the vertex group of Blender's Displace modifier.
  const groupWeights = group === undefined ? null : vertexGroupWeights(mesh, group);
  const positions = new Float32Array(mesh.positions);
  let movedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!flags[vertex]) continue;
    const weight = groupWeights ? groupWeights[vertex] : 1;
    if (weight === 0) continue;
    movedVertices++;
    const distance = (values[vertex] - midlevel) * strength * weight;
    for (let component = 0; component < 3; component++) {
      const along = normals ? normals[vertex * 3 + component] : axis[component];
      positions[vertex * 3 + component] += distance * along;
    }
  }
  return { mesh: withPositions(mesh, positions), movedVertices };
}
