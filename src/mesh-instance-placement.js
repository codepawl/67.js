import { quat } from 'gl-matrix';
import { seededRandom } from './mesh-fields.js';

// The `place` record of an `instances` spec: what keeps, shapes and varies the points once a source made them.
//
//   "place": { "at": "vertices" | "faces",   surface source only: the vertices or face centres, not random points
//              "spacing": 0.8,               Poisson-disk minimum distance between kept points
//              "density": <number field>,    chance 0..1 that a point stays
//              "variants": ["rockA", "rockB", { "geometry": "rockC", "material": "moss" }],
//              "variant": <number field>,    index into variants (rounded down, wrapped); default seeded random
//              "rotation": <vector field>,   extra Euler turn, radians, X then Y then Z
//              "size": <number or vector field> }   scale per point; multiplies the `scale` range
//
// Every choice is a pure function of the point index and the seed, so a scene builds the same way each time.

export const PLACE_FIELDS = Object.freeze(['at', 'spacing', 'density', 'variants', 'variant', 'rotation', 'size']);
export const MAX_VARIANTS = 16;
const MAX_SPACING = 1e6;
const MIN_SIZE = 0.001;
const MAX_SIZE = 1000;
const WELD_DIGITS = 1e5;

const CHANNEL_DENSITY = 40;
const CHANNEL_VARIANT = 41;

function placeError(message) {
  return new TypeError(`Instances: place ${message}`);
}

/** Check a `place` record and return it normalised; throws a TypeError that names the field. */
export function checkedPlace(place) {
  if (place === undefined) return {};
  if (!place || typeof place !== 'object' || Array.isArray(place)) throw placeError('must be an object.');
  for (const key of Object.keys(place)) {
    if (!PLACE_FIELDS.includes(key)) throw placeError(`does not take ${JSON.stringify(key.slice(0, 24))}; fields: ${PLACE_FIELDS.join(', ')}.`);
  }
  if (place.at !== undefined && place.at !== 'vertices' && place.at !== 'faces') throw placeError('at is "vertices" or "faces".');
  if (place.spacing !== undefined && !(typeof place.spacing === 'number' && place.spacing > 0 && place.spacing <= MAX_SPACING)) {
    throw placeError('spacing is a distance above 0.');
  }
  if (place.variant !== undefined && place.variants === undefined) throw placeError('variant needs a variants list.');
  const variants = place.variants === undefined ? null : variantList(place.variants);
  return { ...place, variants };
}

function variantList(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_VARIANTS) throw placeError(`variants is 1 to ${MAX_VARIANTS} entries.`);
  return entries.map(entry => {
    const record = typeof entry === 'string' ? { geometry: entry } : entry;
    const valid = record && typeof record === 'object' && !Array.isArray(record)
      && typeof record.geometry === 'string' && (record.material === undefined || typeof record.material === 'string')
      && Object.keys(record).every(key => key === 'geometry' || key === 'material');
    if (!valid) throw placeError('variants entries are a geometry id or { geometry, material }.');
    return record;
  });
}

/** Deduplicated vertices (by position) or face centres of a render geometry, with normals. */
export function meshPoints(geometry, at, limit) {
  const positions = [];
  const normals = [];
  if (at === 'vertices') {
    const seen = new Set();
    for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
      const offset = vertex * 3;
      const key = [0, 1, 2].map(axis => Math.round(geometry.positions[offset + axis] * WELD_DIGITS)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push(geometry.positions[offset], geometry.positions[offset + 1], geometry.positions[offset + 2]);
      normals.push(geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2]);
    }
  } else {
    for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
      const corners = [0, 1, 2].map(corner => geometry.indices[triangle * 3 + corner] * 3);
      const centre = [0, 1, 2].map(axis => corners.reduce((sum, corner) => sum + geometry.positions[corner + axis], 0) / 3);
      const edgeOne = [0, 1, 2].map(axis => geometry.positions[corners[1] + axis] - geometry.positions[corners[0] + axis]);
      const edgeTwo = [0, 1, 2].map(axis => geometry.positions[corners[2] + axis] - geometry.positions[corners[0] + axis]);
      const facing = [
        edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
        edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
        edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
      ];
      const length = Math.hypot(...facing);
      if (length === 0) continue;
      positions.push(...centre);
      normals.push(...facing.map(component => component / length));
    }
  }
  if (positions.length / 3 > limit) throw placeError(`at "${at}" found ${positions.length / 3} points; raise the surface count to ${limit} or more.`);
  return { positions: Float64Array.from(positions), normals: Float64Array.from(normals) };
}

/** Keep each point with the chance its density value gives. */
export function thinByDensity(indices, densities, seed) {
  return indices.filter(index => seededRandom(index, CHANNEL_DENSITY, seed) < densities[index]);
}

/**
 * Poisson-disk thinning by dart throwing: walk the points in order and keep one when no kept point is closer than
 * `spacing`. A hash grid with cells of the spacing keeps the check to the 27 nearby cells.
 */
export function thinBySpacing(indices, positions, spacing) {
  const cells = new Map();
  const cellOf = (index, axis) => Math.floor(positions[index * 3 + axis] / spacing);
  const kept = [];
  for (const index of indices) {
    const cell = [cellOf(index, 0), cellOf(index, 1), cellOf(index, 2)];
    if (!crowded(cells, cell, positions, index, spacing)) {
      kept.push(index);
      const key = cell.join(',');
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(index);
    }
  }
  return kept;
}

function crowded(cells, cell, positions, index, spacing) {
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const neighbours = cells.get(`${cell[0] + x},${cell[1] + y},${cell[2] + z}`);
        if (!neighbours) continue;
        for (const other of neighbours) {
          const distance = Math.hypot(
            positions[index * 3] - positions[other * 3],
            positions[index * 3 + 1] - positions[other * 3 + 1],
            positions[index * 3 + 2] - positions[other * 3 + 2],
          );
          if (distance < spacing) return true;
        }
      }
    }
  }
  return false;
}

/** The variant entry for a point: from the `variant` field when given, else a seeded random pick. */
export function pickVariant(variants, fieldValues, index, seed) {
  const raw = fieldValues ? Math.floor(fieldValues[index]) : Math.floor(seededRandom(index, CHANNEL_VARIANT, seed) * variants.length);
  return variants[((raw % variants.length) + variants.length) % variants.length];
}

/** Quaternion for XYZ Euler angles in radians (Rz * Ry * Rx, the node rotation order of the field language). */
export function eulerQuaternion(angleX, angleY, angleZ) {
  const turnX = quat.setAxisAngle(quat.create(), [1, 0, 0], angleX);
  const turnY = quat.setAxisAngle(quat.create(), [0, 1, 0], angleY);
  const turnZ = quat.setAxisAngle(quat.create(), [0, 0, 1], angleZ);
  return quat.multiply(quat.create(), quat.multiply(quat.create(), turnZ, turnY), turnX);
}

/** Scale triple from one number (uniform) or three (per axis), kept inside the scene's scale range. */
export function clampedSize(values, index, perAxis) {
  const pick = axis => Math.min(MAX_SIZE, Math.max(MIN_SIZE, values[perAxis ? index * 3 + axis : index]));
  return [pick(0), pick(1), pick(2)];
}
