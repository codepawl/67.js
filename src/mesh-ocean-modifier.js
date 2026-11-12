import { GROUP_PREFIX, createMeshData } from './mesh-data.js';
import { oceanWaves, oceanSurfaceAt } from './ocean-waves.js';
import { registerModifierNormalizer, registerModifierRunner } from './mesh-modifiers.js';

export { oceanWaves, oceanSurfaceAt };

export const MAX_OCEAN_RESOLUTION = 16;
export const MAX_OCEAN_WORK = 50_000_000;
const UP_AXES = Object.freeze({ x: 0, y: 1, z: 2 });
const MAX_SEED = 0x7fffffff;

/** Displace every vertex by the sea and write the vertex group `foam`; `axis` is the up axis of the sea. */
export function oceanMesh(mesh, { axis, windSpeed, direction, choppiness, size, seed, time, resolution }) {
  const waves = oceanWaves({ windSpeed, direction, size, seed, resolution });
  if (waves.length * mesh.vertexCount > MAX_OCEAN_WORK) {
    throw new RangeError(`ocean would make ${waves.length * mesh.vertexCount} wave evaluations, over the limit of ${MAX_OCEAN_WORK}. Lower resolution or use a coarser grid.`);
  }
  const up = UP_AXES[axis];
  const first = (up + 1) % 3;
  const second = (up + 2) % 3;
  const positions = new Float32Array(mesh.positions);
  const foam = new Float32Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const surface = oceanSurfaceAt(waves, positions[vertex * 3 + first], positions[vertex * 3 + second], time, choppiness);
    positions[vertex * 3 + up] += surface.height;
    positions[vertex * 3 + first] += surface.moveX;
    positions[vertex * 3 + second] += surface.moveZ;
    foam[vertex] = surface.foam;
  }
  const attributes = { ...mesh.attributes, point: { ...mesh.attributes.point, [`${GROUP_PREFIX}foam`]: { data: foam, size: 1 } } };
  return createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function normalizeOcean(edit, normalized, index, { finiteNumber, integerInRange }) {
  normalized.axis = edit.axis ?? 'y';
  if (!Object.hasOwn(UP_AXES, normalized.axis)) throw new TypeError(`Mesh edit ${index} (axis must be x, y or z)`);
  normalized.windSpeed = edit.windSpeed === undefined ? 10 : finiteNumber(edit.windSpeed, index, 'windSpeed', { minimum: 0, maximum: 60, exclusiveMinimum: true });
  normalized.direction = edit.direction === undefined ? 0 : finiteNumber(edit.direction, index, 'direction', { minimum: -3600, maximum: 3600 });
  normalized.choppiness = edit.choppiness === undefined ? 1 : finiteNumber(edit.choppiness, index, 'choppiness', { minimum: 0, maximum: 4 });
  normalized.size = edit.size === undefined ? 100 : finiteNumber(edit.size, index, 'size', { minimum: 1, maximum: 10_000 });
  normalized.seed = edit.seed === undefined ? 0 : integerInRange(edit.seed, index, 'seed', 0, MAX_SEED);
  normalized.time = edit.time === undefined ? 0 : finiteNumber(edit.time, index, 'time', { minimum: -1e6, maximum: 1e6 });
  normalized.resolution = edit.resolution === undefined ? 8 : integerInRange(edit.resolution, index, 'resolution', 1, MAX_OCEAN_RESOLUTION);
}

registerModifierNormalizer('ocean', normalizeOcean);
registerModifierRunner('ocean', (mesh, edit) => ({ mesh: oceanMesh(mesh, edit), result: {} }));
