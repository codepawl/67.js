import { quat } from 'gl-matrix';
import { INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES } from './mesh-operations.js';
import { evaluateField, pointSetContext, seededRandom } from './mesh-fields.js';
import { createTriangleSurfaceIndex } from './mesh-query.js';

// Instance on points: a node with an `instances` record becomes a group node plus one child node per point, all
// sharing the node's geometry and material, so the renderer draws them in one instanced call. Points come from a
// grid, a seeded scatter in a box, or the surface of a geometry. Placement is deterministic from the seed, and a
// bounded count is checked before any point is made.
//
//   { "id": "grass", "geometry": "blade", "material": "green", "parent": "ground",
//     "instances": { "surface": { "geometry": "ground-shape", "count": 300 }, "seed": 3,
//                    "where": { "gt": [{ "attr": "position", "component": "x" }, 0] },
//                    "yaw": true, "alignToNormal": false, "scale": [0.7, 1.3] } }
//
// Points are in the group's own space: the group takes the node's translation, rotation and scale, and its parent.
// Put the group under the node that carries the surface geometry to place instances on that node's surface.

export { MAX_INSTANCE_CANDIDATES };
const MAX_COORDINATE = 1e6;
const SOURCES = INSTANCE_SOURCES;
const INSTANCE_FIELDS = Object.freeze([...SOURCES, 'seed', 'where', 'yaw', 'alignToNormal', 'scale']);
const MAX_SEED = 0x7fffffff;
const UP = Object.freeze([0, 1, 0]);

const CHANNEL_SCATTER = 20;
const CHANNEL_YAW = 10;
const CHANNEL_SCALE = 11;
const CHANNEL_SURFACE_TRIANGLE = 30;
const CHANNEL_SURFACE_U = 31;
const CHANNEL_SURFACE_V = 32;

function instanceError(message) {
  return new TypeError(`Instances: ${message}`);
}

function plainRecord(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw instanceError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw instanceError(`${label} does not take ${JSON.stringify(key.slice(0, 24))}; fields: ${allowed.join(', ')}.`);
  }
  return value;
}

function coordinates(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(entry => typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= MAX_COORDINATE)) {
    throw instanceError(`${label} needs three finite numbers.`);
  }
  return value;
}

function wholeNumber(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw instanceError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function gridPoints(source) {
  plainRecord(source, 'grid', ['counts', 'spacing']);
  const counts = coordinates(source.counts, 'grid counts').map(count => wholeNumber(count, 1, MAX_INSTANCE_CANDIDATES, 'grid count'));
  const total = counts[0] * counts[1] * counts[2];
  if (total > MAX_INSTANCE_CANDIDATES) throw instanceError(`a grid of ${total} points is over the limit of ${MAX_INSTANCE_CANDIDATES}.`);
  const spacing = coordinates(source.spacing, 'grid spacing');
  const positions = new Float64Array(total * 3);
  let index = 0;
  for (let z = 0; z < counts[2]; z++) {
    for (let y = 0; y < counts[1]; y++) {
      for (let x = 0; x < counts[0]; x++) {
        positions[index * 3] = (x - (counts[0] - 1) / 2) * spacing[0];
        positions[index * 3 + 1] = (y - (counts[1] - 1) / 2) * spacing[1];
        positions[index * 3 + 2] = (z - (counts[2] - 1) / 2) * spacing[2];
        index++;
      }
    }
  }
  return { positions, normals: null };
}

function scatterPoints(source, seed) {
  plainRecord(source, 'scatter', ['count', 'min', 'max']);
  const count = wholeNumber(source.count, 1, MAX_INSTANCE_CANDIDATES, 'scatter count');
  const minimum = coordinates(source.min, 'scatter min');
  const maximum = coordinates(source.max, 'scatter max');
  const positions = new Float64Array(count * 3);
  for (let index = 0; index < count; index++) {
    for (let axis = 0; axis < 3; axis++) {
      const fraction = seededRandom(index, CHANNEL_SCATTER + axis, seed);
      positions[index * 3 + axis] = minimum[axis] + (maximum[axis] - minimum[axis]) * fraction;
    }
  }
  return { positions, normals: null };
}

function triangleAreas(geometry) {
  const triangleCount = geometry.indices.length / 3;
  const cumulative = new Float64Array(triangleCount);
  let total = 0;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const [first, second, third] = [0, 1, 2].map(corner => geometry.indices[triangle * 3 + corner] * 3);
    const edgeOne = [0, 1, 2].map(axis => geometry.positions[second + axis] - geometry.positions[first + axis]);
    const edgeTwo = [0, 1, 2].map(axis => geometry.positions[third + axis] - geometry.positions[first + axis]);
    const area = Math.hypot(
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ) / 2;
    total += area;
    cumulative[triangle] = total;
  }
  return { cumulative, total };
}

function triangleAtFraction(cumulative, target) {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] >= target) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Points spread over the triangles of a render geometry in proportion to their area, with interpolated normals. */
export function surfacePoints(geometry, count, seed) {
  const { cumulative, total } = triangleAreas(geometry);
  if (!(total > 0)) throw instanceError('the surface geometry has no area.');
  const positions = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  for (let index = 0; index < count; index++) {
    const triangle = triangleAtFraction(cumulative, seededRandom(index, CHANNEL_SURFACE_TRIANGLE, seed) * total);
    const rootU = Math.sqrt(seededRandom(index, CHANNEL_SURFACE_U, seed));
    const fractionV = seededRandom(index, CHANNEL_SURFACE_V, seed);
    const weights = [1 - rootU, rootU * (1 - fractionV), rootU * fractionV];
    const corners = [0, 1, 2].map(corner => geometry.indices[triangle * 3 + corner] * 3);
    for (let axis = 0; axis < 3; axis++) {
      positions[index * 3 + axis] = corners.reduce((sum, corner, slot) => sum + geometry.positions[corner + axis] * weights[slot], 0);
      normals[index * 3 + axis] = corners.reduce((sum, corner, slot) => sum + geometry.normals[corner + axis] * weights[slot], 0);
    }
    const length = Math.hypot(normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[index * 3 + axis] /= length;
  }
  return { positions, normals };
}

function candidatePoints(spec, seed, resolveSurface) {
  const sourceName = SOURCES.filter(name => Object.hasOwn(spec, name));
  if (sourceName.length !== 1) throw instanceError(`give exactly one point source: ${SOURCES.join(', ')}.`);
  if (sourceName[0] === 'grid') return gridPoints(spec.grid);
  if (sourceName[0] === 'scatter') return scatterPoints(spec.scatter, seed);
  const source = plainRecord(spec.surface, 'surface', ['geometry', 'count']);
  const count = wholeNumber(source.count, 1, MAX_INSTANCE_CANDIDATES, 'surface count');
  if (typeof source.geometry !== 'string') throw instanceError('surface needs a geometry id.');
  return surfacePoints(resolveSurface(source.geometry), count, seed);
}

function keptIndices(spec, points, resolveSurface) {
  const count = points.positions.length / 3;
  const kept = [];
  if (spec.where === undefined) {
    for (let index = 0; index < count; index++) kept.push(index);
    return kept;
  }
  const normals = points.normals ?? Float64Array.from({ length: count * 3 }, (unused, position) => UP[position % 3]);
  const loadSurface = surface => {
    if (typeof surface !== 'string') throw instanceError('a where field reads a surface by its geometry id.');
    return createTriangleSurfaceIndex(resolveSurface(surface));
  };
  const { values } = evaluateField(spec.where, pointSetContext(points.positions, normals, loadSurface), { kind: 'scalar' });
  for (let index = 0; index < count; index++) {
    if (values[index] !== 0) kept.push(index);
  }
  return kept;
}

function instanceRotation(spec, seed, candidate, normals) {
  const rotation = quat.create();
  if (spec.alignToNormal && normals) {
    const normal = [normals[candidate * 3], normals[candidate * 3 + 1], normals[candidate * 3 + 2]];
    quat.rotationTo(rotation, UP, normal);
  }
  if (spec.yaw) {
    const turn = quat.setAxisAngle(quat.create(), UP, seededRandom(candidate, CHANNEL_YAW, seed) * Math.PI * 2);
    quat.multiply(rotation, rotation, turn);
  }
  return Array.from(rotation);
}

function instanceScale(spec, seed, candidate) {
  if (spec.scale === undefined) return 1;
  return spec.scale[0] + (spec.scale[1] - spec.scale[0]) * seededRandom(candidate, CHANNEL_SCALE, seed);
}

function checkedSpec(spec) {
  plainRecord(spec, 'instances', INSTANCE_FIELDS);
  const seed = spec.seed === undefined ? 0 : wholeNumber(spec.seed, 0, MAX_SEED, 'seed');
  for (const flag of ['yaw', 'alignToNormal']) {
    if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') throw instanceError(`${flag} must be boolean.`);
  }
  if (spec.alignToNormal && !Object.hasOwn(spec, 'surface')) throw instanceError('alignToNormal needs a surface source, because only a surface has normals.');
  if (spec.scale !== undefined) {
    const range = spec.scale;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(entry => typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry <= 1000) || range[0] > range[1]) {
      throw instanceError('scale is [minimum, maximum] with 0 < minimum <= maximum <= 1000.');
    }
  }
  return seed;
}

/**
 * Replace each node that has an `instances` record with a group node and its instance children. `resolveSurface(id)`
 * returns the render geometry ({ positions, normals, indices }) for a surface source. Nodes without `instances` pass
 * through untouched.
 */
export function expandInstancedNodes(nodes, { resolveSurface, maxNodes }) {
  if (!Array.isArray(nodes)) return nodes;
  const expanded = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'instances')) {
      expanded.push(node);
      continue;
    }
    const { instances: spec, geometry, material, ...group } = node;
    if (typeof geometry !== 'string' || typeof material !== 'string') throw instanceError(`node ${JSON.stringify(String(node.id).slice(0, 48))} needs geometry and material ids to instance.`);
    const seed = checkedSpec(spec);
    const points = candidatePoints(spec, seed, resolveSurface);
    expanded.push(group);
    for (const [slot, candidate] of keptIndices(spec, points, resolveSurface).entries()) {
      const scale = instanceScale(spec, seed, candidate);
      expanded.push({
        id: `${node.id}.${slot}`, parent: node.id, geometry, material,
        translation: [points.positions[candidate * 3], points.positions[candidate * 3 + 1], points.positions[candidate * 3 + 2]],
        rotation: instanceRotation(spec, seed, candidate, points.normals),
        scale: [scale, scale, scale],
      });
      if (expanded.length > maxNodes) throw new RangeError(`Instances expand past the limit of ${maxNodes} nodes.`);
    }
  }
  return expanded;
}
