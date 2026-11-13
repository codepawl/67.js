// Binds the mesh volumes of environment.localVolumes (shape "mesh") to the parts they name. A volume that fits the bounds of its
// part becomes an oriented box: the part's local bounding box carried through its matrix, so a rotated room is still a tight box.
// A volume that fits the closed mesh keeps the part: the CPU path tracer walks the mesh itself (path-tracer-volume.js,
// prepareMeshVolume) and the rasterizer draws it into a depth buffer first (mesh-volume-pass.js).
import { findVolumeGrid } from './volume-grid.js';

function weldedVertexIds(positions, tolerance) {
  const ids = new Map();
  const welded = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < welded.length; vertex++) {
    const key = `${Math.round(positions[vertex * 3] / tolerance)},${Math.round(positions[vertex * 3 + 1] / tolerance)},${Math.round(positions[vertex * 3 + 2] / tolerance)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    welded[vertex] = ids.get(key);
  }
  return welded;
}

/**
 * Counts the edges that do not join exactly two triangles (`open`, with vertices at the same place counted as one) and, among those
 * that do, the edges whose two triangles run the same way along it (`inconsistent`: faces wound against each other).
 */
export function countMeshEdgeProblems(positions, indices, tolerance) {
  const welded = weldedVertexIds(positions, tolerance);
  const uses = new Map();
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const from = welded[indices[corner + edge]];
      const to = welded[indices[corner + (edge + 1) % 3]];
      if (from === to) continue;
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      const use = uses.get(key) ?? { count: 0, direction: 0 };
      use.count++;
      use.direction += from < to ? 1 : -1;
      uses.set(key, use);
    }
  }
  let open = 0;
  let inconsistent = 0;
  for (const { count, direction } of uses.values()) {
    if (count !== 2) open++;
    else if (direction !== 0) inconsistent++;
  }
  return { open, inconsistent };
}

/** The number of edges that do not join exactly two triangles, with vertices at the same place counted as one. 0 for a closed mesh. */
export function countOpenEdges(positions, indices, tolerance) {
  return countMeshEdgeProblems(positions, indices, tolerance).open;
}

const LISTED_PART_NAMES = 12;
const boundsByGeometry = new WeakMap();

function localBounds(geometry) {
  let bounds = boundsByGeometry.get(geometry);
  if (bounds) return bounds;
  const positions = geometry.positions;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  bounds = { minimum, maximum };
  boundsByGeometry.set(geometry, bounds);
  return bounds;
}

function orientedBounds(part, label) {
  const { minimum, maximum } = localBounds(part.geometry);
  const matrix = part.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const localCenter = minimum.map((low, axis) => (low + maximum[axis]) / 2);
  const center = [0, 1, 2].map(row => matrix[row] * localCenter[0] + matrix[4 + row] * localCenter[1] + matrix[8 + row] * localCenter[2] + matrix[12 + row]);
  const size = [];
  const axes = [];
  for (let column = 0; column < 3; column++) {
    const x = matrix[column * 4];
    const y = matrix[column * 4 + 1];
    const z = matrix[column * 4 + 2];
    const scale = Math.hypot(x, y, z);
    if (!(scale > 0)) throw new RangeError(`${label}.part "${part.name}" has a flat transform; a mesh volume needs a part with volume`);
    size.push((maximum[column] - minimum[column]) * scale);
    axes.push(x / scale, y / scale, z / scale);
  }
  if (!size.every(extent => extent > 0)) throw new RangeError(`${label}.part "${part.name}" has no thickness along one axis; a mesh volume needs a part with volume`);
  return { center, size, axes };
}

const edgeProblemsByGeometry = new WeakMap();

/** Throws unless the part's mesh is closed and its faces wind the same way, which the rasterizer's front and back faces rely on. */
export function assertClosedMesh(part, label) {
  let problems = edgeProblemsByGeometry.get(part.geometry);
  if (!problems) {
    const { minimum, maximum } = localBounds(part.geometry);
    const diagonal = Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]);
    problems = countMeshEdgeProblems(part.geometry.positions, part.geometry.indices, diagonal * 1e-6);
    edgeProblemsByGeometry.set(part.geometry, problems);
  }
  if (problems.open > 0) throw new RangeError(`${label}.part "${part.name}" is not a closed mesh (${problems.open} open edges), so it has no inside; close it or use fit "bounds"`);
  if (problems.inconsistent > 0) throw new RangeError(`${label}.part "${part.name}" has faces wound against each other (${problems.inconsistent} edges), so the rasterizer cannot tell inside from outside; flip those faces or use the path tracer`);
}

/** Gives every grid volume (shape "grid") its registered grid, and its size from the grid file when the volume names none. */
function bindLocalVolumeGrids(volumes, label) {
  if (!volumes.some(volume => volume.shape === 'grid')) return volumes;
  return volumes.map((volume, index) => {
    if (volume.shape !== 'grid') return volume;
    const field = `${label}[${index}]`;
    const gridData = findVolumeGrid(volume.grid, field);
    const size = volume.size ?? gridData.size;
    if (!size) throw new RangeError(`${field}.size is required: grid "${volume.grid}" carries no size of its own`);
    return { ...volume, size, gridData };
  });
}

function findPart(parts, name, label) {
  const part = parts.find(candidate => candidate.name === name);
  if (part) return part;
  const names = parts.map(candidate => candidate.name).filter(Boolean);
  const listed = names.slice(0, LISTED_PART_NAMES).join(', ');
  throw new RangeError(`${label}.part "${name}" names no part in the scene${listed ? `; parts: ${listed}${names.length > LISTED_PART_NAMES ? ', ...' : ''}` : ''}`);
}

/**
 * Returns the resolved volumes with every mesh volume bound to its part. A volume with fit "bounds" becomes a box; one with
 * fit "mesh" keeps its part and also carries the bounds. Volumes that are not meshes are returned as they are.
 */
export function bindLocalVolumeParts(input, parts, { label = 'environment.localVolumes' } = {}) {
  const volumes = bindLocalVolumeGrids(input, label);
  if (!volumes.some(volume => volume.shape === 'mesh')) return volumes;
  return volumes.map((volume, index) => {
    if (volume.shape !== 'mesh') return volume;
    const field = `${label}[${index}]`;
    const part = findPart(parts, volume.part, field);
    if (!part.geometry?.positions || !part.geometry.indices) throw new TypeError(`${field}.part "${part.name}" has no geometry`);
    if (part.skin) throw new RangeError(`${field}.part "${part.name}" is skinned; a mesh volume needs a rigid part`);
    const bounds = orientedBounds(part, field);
    if (volume.fit === 'mesh') {
      return { ...volume, ...bounds, part };
    }
    const rest = { ...volume };
    delete rest.part;
    delete rest.fit;
    return { ...rest, shape: 'box', ...bounds };
  });
}
