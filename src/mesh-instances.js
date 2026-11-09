import { quat } from 'gl-matrix';
import { INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES } from './mesh-operations.js';
import { evaluateField, pointSetContext, seededRandom } from './mesh-fields.js';
import { MAX_CURVE_POINTS, curveLength, filletCurve, resampleCurve } from './curve-operations.js';
import { createTriangleSurfaceIndex } from './mesh-query.js';
import './mesh-field-surfaces.js';
import './field-rotation.js';
import {
  checkedPlace, clampedSize, eulerQuaternion, mergeRealizedInstances, meshPoints, pickVariant, thinByDensity, thinBySpacing,
} from './mesh-instance-placement.js';

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
// "place" adds Poisson spacing, a density field, variants, and per-point rotation and size from fields; see
// mesh-instance-placement.js. `place.at` makes a surface source give its vertices or face centres.
//
// Points are in the group's own space: the group takes the node's translation, rotation and scale, and its parent.
// Put the group under the node that carries the surface geometry to place instances on that node's surface.

export { MAX_INSTANCE_CANDIDATES };
const MAX_COORDINATE = 1e6;
const SOURCES = INSTANCE_SOURCES;
const INSTANCE_FIELDS = Object.freeze([...SOURCES, 'seed', 'where', 'yaw', 'alignToNormal', 'scale', 'place', 'realize']);
const MAX_SEED = 0x7fffffff;
const CURVE_FILLET_SEGMENTS = 8;
const UP = Object.freeze([0, 1, 0]);
const REALIZED_MAX_ENTRIES = 128;
const realizedGeometries = new Map();

export function realizedGeometry(key) {
  return realizedGeometries.get(key);
}

export function realizedVertexCount(key) {
  const geometry = realizedGeometries.get(key);
  return geometry ? geometry.positions.length / 3 : 0;
}

function storeRealizedGeometry(key, geometry) {
  if (realizedGeometries.has(key)) realizedGeometries.delete(key);
  realizedGeometries.set(key, geometry);
  while (realizedGeometries.size > REALIZED_MAX_ENTRIES) {
    realizedGeometries.delete(realizedGeometries.keys().next().value);
  }
}

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

// Points at equal arc length along a polyline, optionally with rounded corners; the "normal" of each point is the
// direction of travel, so alignToNormal turns up along the curve.
function curvePoints(source) {
  plainRecord(source, 'curve', ['points', 'count', 'length', 'closed', 'fillet']);
  if (!Array.isArray(source.points) || source.points.length < 2 || source.points.length > MAX_CURVE_POINTS) {
    throw instanceError(`curve points are 2 to ${MAX_CURVE_POINTS} positions.`);
  }
  const corners = source.points.map(point => coordinates(point, 'curve point'));
  const closed = source.closed === true;
  if (source.closed !== undefined && typeof source.closed !== 'boolean') throw instanceError('curve closed must be boolean.');
  if ((source.count === undefined) === (source.length === undefined)) {
    throw instanceError('curve needs count or length, not both.');
  }
  if (source.length !== undefined && !(typeof source.length === 'number' && Number.isFinite(source.length) && source.length > 0 && source.length <= MAX_COORDINATE)) {
    throw instanceError('curve length is a spacing above 0.');
  }
  if (source.fillet !== undefined && !(typeof source.fillet === 'number' && source.fillet > 0 && source.fillet <= MAX_COORDINATE)) {
    throw instanceError('curve fillet is a radius above 0.');
  }
  const path = source.fillet === undefined ? corners : filletCurve(corners, source.fillet, CURVE_FILLET_SEGMENTS, closed);
  const minimumCount = closed ? 3 : 2;
  const rawCount = source.count !== undefined
    ? source.count
    : closed
      ? Math.max(minimumCount, Math.round(curveLength(path, true) / source.length))
      : Math.max(minimumCount, Math.floor(curveLength(path, false) / source.length) + 1);
  const count = wholeNumber(rawCount, minimumCount, MAX_INSTANCE_CANDIDATES, 'curve count');
  const samples = resampleCurve(path, count, closed);
  const positions = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  samples.forEach(({ point, direction }, index) => {
    positions.set(point, index * 3);
    normals.set(direction, index * 3);
  });
  return { positions, normals };
}

function candidatePoints(spec, seed, resolveSurface, place) {
  const sourceName = SOURCES.filter(name => Object.hasOwn(spec, name));
  if (sourceName.length !== 1) throw instanceError(`give exactly one point source: ${SOURCES.join(', ')}.`);
  if (sourceName[0] === 'grid') return gridPoints(spec.grid);
  if (sourceName[0] === 'scatter') return scatterPoints(spec.scatter, seed);
  if (sourceName[0] === 'curve') return curvePoints(spec.curve);
  const source = plainRecord(spec.surface, 'surface', ['geometry', 'count']);
  const count = wholeNumber(source.count, 1, MAX_INSTANCE_CANDIDATES, 'surface count');
  if (typeof source.geometry !== 'string') throw instanceError('surface needs a geometry id.');
  if (place.at) return meshPoints(resolveSurface(source.geometry), place.at, count);
  return surfacePoints(resolveSurface(source.geometry), count, seed);
}

// Evaluate a field expression over every candidate point; a missing expression gives null.
function pointField(expression, points, resolveSurface, kind) {
  if (expression === undefined) return null;
  const count = points.positions.length / 3;
  const normals = points.normals ?? Float64Array.from({ length: count * 3 }, (unused, position) => UP[position % 3]);
  const loadSurface = surface => {
    if (typeof surface !== 'string') throw instanceError('a field reads a surface by its geometry id.');
    return createTriangleSurfaceIndex(resolveSurface(surface));
  };
  return evaluateField(expression, pointSetContext(points.positions, normals, loadSurface), kind ? { kind } : {});
}

function keptIndices(spec, place, points, fields, seed) {
  const count = points.positions.length / 3;
  let kept = Array.from({ length: count }, (unused, index) => index);
  if (fields.where) kept = kept.filter(index => fields.where.values[index] !== 0);
  if (fields.density) kept = thinByDensity(kept, fields.density.values, seed);
  if (place.spacing) kept = thinBySpacing(kept, points.positions, place.spacing);
  return kept;
}

function instanceRotation(spec, seed, candidate, normals, turns) {
  const rotation = quat.create();
  if (spec.alignToNormal && normals) {
    const normal = [normals[candidate * 3], normals[candidate * 3 + 1], normals[candidate * 3 + 2]];
    quat.rotationTo(rotation, UP, normal);
  }
  if (spec.yaw) {
    const turn = quat.setAxisAngle(quat.create(), UP, seededRandom(candidate, CHANNEL_YAW, seed) * Math.PI * 2);
    quat.multiply(rotation, rotation, turn);
  }
  if (turns) quat.multiply(rotation, rotation, eulerQuaternion(turns[candidate * 3], turns[candidate * 3 + 1], turns[candidate * 3 + 2]));
  return Array.from(rotation);
}

function instanceScale(spec, seed, candidate, sizes) {
  const uniform = spec.scale === undefined ? 1 : spec.scale[0] + (spec.scale[1] - spec.scale[0]) * seededRandom(candidate, CHANNEL_SCALE, seed);
  if (!sizes) return [uniform, uniform, uniform];
  return clampedSize(sizes.values, candidate, sizes.kind === 'vector').map(size => size * uniform);
}

function checkedSpec(spec) {
  plainRecord(spec, 'instances', INSTANCE_FIELDS);
  const seed = spec.seed === undefined ? 0 : wholeNumber(spec.seed, 0, MAX_SEED, 'seed');
  for (const flag of ['yaw', 'alignToNormal', 'realize']) {
    if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') throw instanceError(`${flag} must be boolean.`);
  }
  if (spec.alignToNormal && !Object.hasOwn(spec, 'surface') && !Object.hasOwn(spec, 'curve')) throw instanceError('alignToNormal needs a surface or curve source, because only those have normals.');
  if (spec.scale !== undefined) {
    const range = spec.scale;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(entry => typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry <= 1000) || range[0] > range[1]) {
      throw instanceError('scale is [minimum, maximum] with 0 < minimum <= maximum <= 1000.');
    }
  }
  return seed;
}

// The fields a spec reads, evaluated once over all candidate points.
function placementFields(spec, place, points, resolveSurface) {
  return {
    where: pointField(spec.where, points, resolveSurface, 'scalar'),
    density: pointField(place.density, points, resolveSurface, 'scalar'),
    variant: pointField(place.variant, points, resolveSurface, 'scalar'),
    rotation: pointField(place.rotation, points, resolveSurface, 'vector'),
    size: pointField(place.size, points, resolveSurface),
  };
}

/**
 * Replace each node that has an `instances` record with a group node and its instance children. `resolveSurface(id)`
 * returns the render geometry ({ positions, normals, indices }) for a surface source. Nodes without `instances` pass
 * through untouched.
 */
export function expandInstancedNodes(nodes, { resolveSurface, maxNodes, maxVertices }, geometries) {
  if (!Array.isArray(nodes)) return nodes;
  const expanded = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'instances')) {
      expanded.push(node);
      continue;
    }
    const { instances: spec, geometry, material, ...group } = node;
    const place = checkedPlace(spec?.place);
    if (typeof material !== 'string' || (typeof geometry !== 'string' && !place.variants)) throw instanceError(`node ${JSON.stringify(String(node.id).slice(0, 48))} needs geometry and material ids to instance.`);
    const seed = checkedSpec(spec);
    if (place.at && !Object.hasOwn(spec, 'surface')) throw instanceError('place.at needs a surface source.');
    const points = candidatePoints(spec, seed, resolveSurface, place);
    const fields = placementFields(spec, place, points, resolveSurface);
    expanded.push(group);
    const placements = keptIndices(spec, place, points, fields, seed).map((candidate, slot) => {
      const variant = place.variants ? pickVariant(place.variants, fields.variant?.values, candidate, seed) : { geometry, material };
      return {
        slot, geometry: variant.geometry, material: variant.material ?? material,
        translation: [points.positions[candidate * 3], points.positions[candidate * 3 + 1], points.positions[candidate * 3 + 2]],
        rotation: instanceRotation(spec, seed, candidate, points.normals, fields.rotation?.values),
        scale: instanceScale(spec, seed, candidate, fields.size),
      };
    });
    if (spec.realize || place.realize) {
      const byMaterial = new Map();
      for (const item of placements) {
        if (!byMaterial.has(item.material)) byMaterial.set(item.material, []);
        byMaterial.get(item.material).push({
          geometry: resolveSurface(item.geometry),
          translation: item.translation, rotation: item.rotation, scale: item.scale,
        });
      }
      let groupIndex = 0;
      for (const [materialId, entries] of byMaterial) {
        const merged = mergeRealizedInstances(entries, maxVertices);
        const childId = `${node.id}.${groupIndex}`;
        const geometryId = `${node.id}.realized.${groupIndex}`;
        let subdivisions = 1;
        while (subdivisions <= 128 && realizedGeometries.has(JSON.stringify({ type: 'box', bevel: 0, subdivisions }))) subdivisions++;
        const base = { type: 'box', bevel: 0, subdivisions };
        storeRealizedGeometry(JSON.stringify(base), merged);
        const registered = geometries?.push({ id: geometryId, type: 'mesh', base });
        expanded.push({
          id: childId, parent: node.id, geometry: geometryId, material: materialId,
          translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
          ...(typeof registered === 'number' ? {} : { realizedGeometry: merged }),
        });
        groupIndex++;
        if (expanded.length > maxNodes) throw new RangeError(`Instances expand past the limit of ${maxNodes} nodes.`);
      }
      continue;
    }
    for (const item of placements) {
      expanded.push({
        id: `${node.id}.${item.slot}`, parent: node.id, geometry: item.geometry, material: item.material,
        translation: item.translation, rotation: item.rotation, scale: item.scale,
      });
      if (expanded.length > maxNodes) throw new RangeError(`Instances expand past the limit of ${maxNodes} nodes.`);
    }
  }
  return expanded;
}
