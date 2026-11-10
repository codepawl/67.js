// Binds the mesh volumes of environment.localVolumes (shape "mesh") to the parts they name. A volume that fits the bounds of its
// part becomes an oriented box: the part's local bounding box carried through its matrix, so a rotated room is still a tight box.
// A volume that fits the closed mesh keeps the part for the CPU path tracer, which walks the mesh itself
// (path-tracer-volume.js, prepareMeshVolume); the rasterizer has no mesh pass and refuses it with a message that names the field.

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

function findPart(parts, name, label) {
  const part = parts.find(candidate => candidate.name === name);
  if (part) return part;
  const names = parts.map(candidate => candidate.name).filter(Boolean);
  const listed = names.slice(0, LISTED_PART_NAMES).join(', ');
  throw new RangeError(`${label}.part "${name}" names no part in the scene${listed ? `; parts: ${listed}${names.length > LISTED_PART_NAMES ? ', ...' : ''}` : ''}`);
}

/**
 * Returns the resolved volumes with every mesh volume bound to its part. Pass `meshFit: false` for the rasterizer, which draws
 * the bounds only. Volumes that are not meshes are returned as they are.
 */
export function bindLocalVolumeParts(volumes, parts, { meshFit = true, label = 'environment.localVolumes' } = {}) {
  if (!volumes.some(volume => volume.shape === 'mesh')) return volumes;
  return volumes.map((volume, index) => {
    if (volume.shape !== 'mesh') return volume;
    const field = `${label}[${index}]`;
    const part = findPart(parts, volume.part, field);
    if (!part.geometry?.positions || !part.geometry.indices) throw new TypeError(`${field}.part "${part.name}" has no geometry`);
    if (part.skin) throw new RangeError(`${field}.part "${part.name}" is skinned; a mesh volume needs a rigid part`);
    const bounds = orientedBounds(part, field);
    if (volume.fit === 'mesh') {
      if (!meshFit) throw new RangeError(`${field}.fit "mesh" is traced by the CPU path tracer only; the rasterizer draws the part's bounds. Use fit "bounds" or the path tracer with backend "cpu".`);
      return { ...volume, ...bounds, part };
    }
    const rest = { ...volume };
    delete rest.part;
    delete rest.fit;
    return { ...rest, shape: 'box', ...bounds };
  });
}
