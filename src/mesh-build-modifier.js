import { seededRandom } from './mesh-fields.js';
import { faceCentroids } from './mesh-normals.js';
import { registerModifierNormalizer, registerModifierRunner } from './mesh-modifiers.js';
import { MeshBuilder } from './mesh-stack.js';
import { editBoolean, editField } from './mesh-edit-field.js';

// Build modifier, as Blender's Build: the faces of the mesh appear one by one over a run of frames. `frame` is the frame to
// show, `start` and `length` give the run, and `order` says which face comes next: by index, by a seeded shuffle or along
// an axis (lowest centroid first). `reverse` plays the run backwards, so the mesh unbuilds. The order depends only on the
// mesh and the fields, so every frame, seek and run gives the same vertices. Vertices no visible face uses are dropped.
// A mesh cannot be empty, so while no face shows the mesh is one zero-area triangle at the first vertex, which draws nothing.

export const BUILD_ORDERS = Object.freeze(['index', 'random', 'axis']);
export const MAX_BUILD_FRAME = 1e6;
export const MAX_BUILD_SEED = 0x7fffffff;
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });
const RANDOM_CHANNEL = 71;

function faceBuildOrder(mesh, { order, axis, seed }) {
  const faces = Array.from({ length: mesh.faceCount }, (unused, face) => face);
  if (order === 'index') return faces;
  const keys = new Float64Array(mesh.faceCount);
  if (order === 'random') {
    for (const face of faces) keys[face] = seededRandom(face, RANDOM_CHANNEL, seed);
  } else {
    const centroids = faceCentroids(mesh);
    for (const face of faces) keys[face] = centroids[face * 3 + AXIS_INDEX[axis]];
  }
  return faces.sort((first, second) => keys[first] - keys[second] || first - second);
}

/** How many faces show at `frame`: none before `start`, all from `start + length` on, flipped when `reverse`. */
export function visibleBuildFaces(faceCount, { frame, start, length, reverse }) {
  const progress = Math.min(1, Math.max(0, (frame - start) / length));
  return Math.floor((reverse ? 1 - progress : progress) * faceCount + 1e-9);
}

function hiddenMesh(mesh, builder) {
  const [x, y, z] = mesh.positions;
  builder.addFace([builder.addVertex(x, y, z), builder.addVertex(x, y, z), builder.addVertex(x, y, z)]);
  return builder.build();
}

export function buildMesh(mesh, edit) {
  const visibleCount = visibleBuildFaces(mesh.faceCount, edit);
  if (visibleCount >= mesh.faceCount) return mesh;
  const builder = new MeshBuilder(mesh);
  if (visibleCount === 0) return hiddenMesh(mesh, builder);
  const newVertex = new Map();
  for (const face of faceBuildOrder(mesh, edit).slice(0, visibleCount).sort((first, second) => first - second)) {
    const corners = [];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) corners.push(corner);
    const vertices = corners.map(corner => {
      const vertex = mesh.cornerVertices[corner];
      if (!newVertex.has(vertex)) {
        newVertex.set(vertex, builder.addVertex(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]));
      }
      return newVertex.get(vertex);
    });
    builder.addFace(vertices, { sourceFace: face, sourceCorners: corners, sourceEdges: corners.map(corner => mesh.cornerEdges[corner]) });
  }
  return builder.build();
}

function normalizeBuild(edit, normalized, index, { finiteNumber, integerInRange }) {
  normalized.order = edit.order ?? 'index';
  if (!BUILD_ORDERS.includes(normalized.order)) {
    throw editField(index, 'order', edit.order, `one of ${BUILD_ORDERS.join(', ')}, such as "random" with a seed`);
  }
  normalized.frame = edit.frame === undefined ? 0 : finiteNumber(edit.frame, index, 'frame', { minimum: -MAX_BUILD_FRAME, maximum: MAX_BUILD_FRAME });
  normalized.start = edit.start === undefined ? 0 : finiteNumber(edit.start, index, 'start', { minimum: -MAX_BUILD_FRAME, maximum: MAX_BUILD_FRAME });
  normalized.length = edit.length === undefined ? 60 : finiteNumber(edit.length, index, 'length', { minimum: 0, maximum: MAX_BUILD_FRAME, exclusiveMinimum: true });
  normalized.reverse = editBoolean(edit.reverse, index, 'reverse') ?? false;
  if (normalized.order === 'random') {
    normalized.seed = edit.seed === undefined ? 0 : integerInRange(edit.seed, index, 'seed', 0, MAX_BUILD_SEED);
  } else if (edit.seed !== undefined) {
    throw editField(index, 'seed', edit.seed, 'left out, because only order "random" uses a seed');
  }
  if (normalized.order === 'axis') {
    normalized.axis = edit.axis ?? 'y';
    if (!Object.hasOwn(AXIS_INDEX, normalized.axis)) throw editField(index, 'axis', edit.axis, 'one of "x", "y", "z"');
  } else if (edit.axis !== undefined) {
    throw editField(index, 'axis', edit.axis, 'left out, because only order "axis" uses an axis');
  }
}

registerModifierNormalizer('build', normalizeBuild);
registerModifierRunner('build', (mesh, edit) => {
  const built = buildMesh(mesh, edit);
  return { mesh: built, result: { visibleFaces: built === mesh ? mesh.faceCount : visibleBuildFaces(mesh.faceCount, edit), totalFaces: mesh.faceCount } };
});
