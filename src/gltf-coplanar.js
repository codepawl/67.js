import { sharedArea, COPLANAR_TOLERANCE, COPLANAR_MINIMUM_AREA, SUGGESTED_OFFSET } from './coplanar-overlap.js';
import { MAXIMUM_DEPTH_LAYER } from './depth-layer.js';

// Loaded by parseGltf only for a file with at least one static triangle mesh, never part of the core bundle.
// Finds faces inside one mesh that draw the same plane in the same place, which z-fight (downloaded models often carry a
// sign mesh stacked on a wall, or a face exported twice). Exact duplicates are dropped. Overlapping faces that differ are
// reported for the caller to move onto their own depth layer.
// The search is bounded: triangles are hashed by plane (normal and distance), and only triangles in the same plane bucket
// whose bounds touch are compared, with a fixed work budget per geometry.

const NORMAL_STEPS = 64;
const DEFAULT_WORK_BUDGET = 150_000;
const SAME_FACING = Math.cos(Math.PI / 180);

function triangleRecords(positions, indices, tolerance, eligible) {
  const records = [];
  const triangleCount = indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    if (!eligible[triangle]) continue;
    const corners = new Float64Array(9);
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle * 3 + corner] * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[vertex + axis];
        corners[corner * 3 + axis] = value;
        if (value < bounds[axis]) bounds[axis] = value;
        if (value > bounds[3 + axis]) bounds[3 + axis] = value;
      }
    }
    const oneX = corners[3] - corners[0];
    const oneY = corners[4] - corners[1];
    const oneZ = corners[5] - corners[2];
    const twoX = corners[6] - corners[0];
    const twoY = corners[7] - corners[1];
    const twoZ = corners[8] - corners[2];
    const crossX = oneY * twoZ - oneZ * twoY;
    const crossY = oneZ * twoX - oneX * twoZ;
    const crossZ = oneX * twoY - oneY * twoX;
    const length = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
    if (!(length > 1e-12)) continue;
    const normal = [crossX / length, crossY / length, crossZ / length];
    const offset = normal[0] * corners[0] + normal[1] * corners[1] + normal[2] * corners[2];
    records.push({ triangle, corners, normal, bounds, offset, key: planeKeyOf(normal[0], normal[1], normal[2], offset, tolerance) });
  }
  return records;
}

// One id per distinct position, so a triangle's key is three small integers instead of nine floats written as text.
function positionIds(positions) {
  const ids = new Map();
  const idOfVertex = new Int32Array(positions.length / 3);
  for (let vertex = 0; vertex < idOfVertex.length; vertex++) {
    const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    idOfVertex[vertex] = id;
  }
  return idOfVertex;
}

// One number per plane: the normal rounded to 1/64 per axis, then the distance bucket, so the hash needs no strings.
const DISTANCE_BUCKETS = 4194304;

function planeKeyOf(normalX, normalY, normalZ, offset, tolerance) {
  const steps = NORMAL_STEPS * 2 + 1;
  const normalNumber = ((Math.round(normalX * NORMAL_STEPS) + NORMAL_STEPS) * steps + Math.round(normalY * NORMAL_STEPS) + NORMAL_STEPS) * steps + Math.round(normalZ * NORMAL_STEPS) + NORMAL_STEPS;
  const bucket = Math.floor(offset / tolerance);
  return normalNumber * DISTANCE_BUCKETS + (((bucket % DISTANCE_BUCKETS) + DISTANCE_BUCKETS) % DISTANCE_BUCKETS);
}

// First pass, no allocation per triangle: the plane key of each triangle (NaN for a degenerate one).
function planeKeys(positions, indices, tolerance) {
  const keys = new Float64Array(indices.length / 3);
  for (let triangle = 0; triangle < keys.length; triangle++) {
    const first = indices[triangle * 3] * 3;
    const second = indices[triangle * 3 + 1] * 3;
    const third = indices[triangle * 3 + 2] * 3;
    const oneX = positions[second] - positions[first];
    const oneY = positions[second + 1] - positions[first + 1];
    const oneZ = positions[second + 2] - positions[first + 2];
    const twoX = positions[third] - positions[first];
    const twoY = positions[third + 1] - positions[first + 1];
    const twoZ = positions[third + 2] - positions[first + 2];
    const crossX = oneY * twoZ - oneZ * twoY;
    const crossY = oneZ * twoX - oneX * twoZ;
    const crossZ = oneX * twoY - oneY * twoX;
    const length = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
    if (!(length > 1e-12)) {
      keys[triangle] = NaN;
      continue;
    }
    const offset = (crossX * positions[first] + crossY * positions[first + 1] + crossZ * positions[first + 2]) / length;
    keys[triangle] = planeKeyOf(crossX / length, crossY / length, crossZ / length, offset, tolerance);
  }
  return keys;
}

// The same three positions in both triangles; the same cyclic order too, unless the surface is double sided.
function sameVertices(idOfVertex, indices, earlier, later, doubleSided) {
  const first = [0, 1, 2].map(corner => idOfVertex[indices[earlier * 3 + corner]]);
  const second = [0, 1, 2].map(corner => idOfVertex[indices[later * 3 + corner]]);
  if (!first.every(id => second.includes(id))) return false;
  if (doubleSided) return true;
  return (second[0] === first[0] && second[1] === first[1]) || (second[0] === first[1] && second[1] === first[2]) || (second[0] === first[2] && second[1] === first[0]);
}

function boundsTouch(first, second, tolerance) {
  for (let axis = 0; axis < 3; axis++) {
    if (second[axis] > first[3 + axis] + tolerance || second[3 + axis] < first[axis] - tolerance) return false;
  }
  return true;
}

// The axis the faces of one plane spread over most, so a sweep along it rejects the most pairs.
function sweepAxisOf(records) {
  let widest = 0;
  let widestAxis = 0;
  for (let axis = 0; axis < 3; axis++) {
    let low = Infinity;
    let high = -Infinity;
    for (const record of records) {
      if (record.bounds[axis] < low) low = record.bounds[axis];
      if (record.bounds[3 + axis] > high) high = record.bounds[3 + axis];
    }
    if (high - low > widest) {
      widest = high - low;
      widestAxis = axis;
    }
  }
  return widestAxis;
}

function dotOf(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/**
 * Faces of one geometry that share a plane. `duplicates` are triangle numbers to drop: the later copy of a triangle with the
 * same three positions (the opposite winding counts only when `doubleSided`). `overlapping` maps the later triangle of each
 * pair of different triangles that lie in one plane (within `tolerance`) and share area to the earlier ones it overlaps. `work`
 * counts tests.
 */
export function findCoplanarFaces(geometry, { tolerance = COPLANAR_TOLERANCE, doubleSided = false, workBudget = DEFAULT_WORK_BUDGET } = {}) {
  const { positions, indices } = geometry;
  const keys = planeKeys(positions, indices, tolerance);
  const idOfVertex = positionIds(positions);
  const duplicates = new Set();
  const seen = new Map();
  const keyCounts = new Map();
  const eligible = new Uint8Array(keys.length);
  for (let triangle = 0; triangle < keys.length; triangle++) {
    if (Number.isNaN(keys[triangle])) continue;
    const first = idOfVertex[indices[triangle * 3]];
    const second = idOfVertex[indices[triangle * 3 + 1]];
    const third = idOfVertex[indices[triangle * 3 + 2]];
    const low = Math.min(first, second, third);
    const high = Math.max(first, second, third);
    const middle = first + second + third - low - high;
    const triangleKey = (low * 2097152 + middle) * 1031 + (high % 1031);
    const earlier = seen.get(triangleKey);
    if (earlier !== undefined && sameVertices(idOfVertex, indices, earlier, triangle, doubleSided)) {
      duplicates.add(triangle);
      continue;
    }
    if (earlier === undefined) seen.set(triangleKey, triangle);
    eligible[triangle] = 1;
    keyCounts.set(keys[triangle], (keyCounts.get(keys[triangle]) ?? 0) + 1);
  }
  // A triangle alone in its plane bucket, with nothing in the next bucket up or down, has nothing to overlap.
  for (let triangle = 0; triangle < keys.length; triangle++) {
    if (!eligible[triangle]) continue;
    const key = keys[triangle];
    if (keyCounts.get(key) < 2 && !keyCounts.has(key + 1) && !keyCounts.has(key - 1)) eligible[triangle] = 0;
  }
  const records = triangleRecords(positions, indices, tolerance, eligible);
  const distinct = records;
  const buckets = new Map();
  for (const record of distinct) {
    const members = buckets.get(record.key);
    if (members) members.push(record);
    else buckets.set(record.key, [record]);
  }
  const overlapping = new Map();
  let work = 0;
  const compareBuckets = (members, others) => {
    const sweep = sweepAxisOf(members);
    const sorted = [...members].sort((first, second) => first.bounds[sweep] - second.bounds[sweep]);
    const candidates = others === members ? sorted : [...others].sort((first, second) => first.bounds[sweep] - second.bounds[sweep]);
    for (let index = 0; index < sorted.length; index++) {
      const record = sorted[index];
      for (let next = others === members ? index + 1 : 0; next < candidates.length; next++) {
        const other = candidates[next];
        if (other.bounds[sweep] > record.bounds[3 + sweep] + tolerance) break;
        if (work++ > workBudget) return;
        if (!boundsTouch(record.bounds, other.bounds, tolerance)) continue;
        const facing = dotOf(record.normal, other.normal);
        if (facing < SAME_FACING && !(doubleSided && facing <= -SAME_FACING)) continue;
        if (Math.abs(dotOf(record.normal, [other.corners[0] - record.corners[0], other.corners[1] - record.corners[1], other.corners[2] - record.corners[2]])) > tolerance) continue;
        if (sharedArea(record, other) < COPLANAR_MINIMUM_AREA) continue;
        const later = Math.max(record.triangle, other.triangle);
        const earlier = Math.min(record.triangle, other.triangle);
        if (overlapping.has(later)) overlapping.get(later).push(earlier);
        else overlapping.set(later, [earlier]);
      }
    }
  };
  for (const [key, members] of buckets) {
    if (work > workBudget) break;
    compareBuckets(members, members);
    const neighbour = buckets.get(key + 1);
    if (neighbour) compareBuckets(members, neighbour);
  }
  return { duplicates, overlapping, work, truncated: work > workBudget };
}

/** `indices` without the given triangles. */
export function withoutTriangles(indices, dropped) {
  const kept = new indices.constructor(indices.length - dropped.size * 3);
  let write = 0;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    if (dropped.has(triangle)) continue;
    kept.set(indices.subarray(triangle * 3, triangle * 3 + 3), write);
    write += 3;
  }
  return kept;
}

const VERTEX_ARRAY_FIELDS_SKIPPED = new Set(['indices']);

function matrixScale(matrix) {
  const lengths = [0, 4, 8].map(column => Math.hypot(matrix[column], matrix[column + 1], matrix[column + 2]));
  return Math.max((lengths[0] + lengths[1] + lengths[2]) / 3, 1e-9);
}

// Gives the listed triangles their own copies of their vertices, moved along the face normal by `distances` (local units).
function moveTrianglesApart(geometry, lifted) {
  const vertexCount = geometry.positions.length / 3;
  const fields = Object.keys(geometry).filter(name => !VERTEX_ARRAY_FIELDS_SKIPPED.has(name) && ArrayBuffer.isView(geometry[name]) && geometry[name].length % vertexCount === 0);
  const added = lifted.size * 3;
  const grown = new Map(fields.map(name => {
    const stride = geometry[name].length / vertexCount;
    const bigger = new geometry[name].constructor(geometry[name].length + added * stride);
    bigger.set(geometry[name]);
    return [name, bigger];
  }));
  const indices = geometry.indices.slice();
  let nextVertex = vertexCount;
  for (const [triangle, { normal, distance }] of lifted) {
    for (let corner = 0; corner < 3; corner++) {
      const source = indices[triangle * 3 + corner];
      for (const [name, bigger] of grown) {
        const stride = bigger.length / (vertexCount + added);
        for (let component = 0; component < stride; component++) bigger[nextVertex * stride + component] = bigger[source * stride + component];
      }
      const positions = grown.get('positions');
      for (let axis = 0; axis < 3; axis++) positions[nextVertex * 3 + axis] += normal[axis] * distance;
      indices[triangle * 3 + corner] = nextVertex;
      nextVertex += 1;
    }
  }
  for (const [name, bigger] of grown) geometry[name] = bigger;
  geometry.indices = indices;
}

/**
 * Repairs coplanar faces inside the meshes of `parts` (rigid parts only): drops exact duplicate triangles, and moves each
 * face that overlaps an earlier one of the same mesh 2 mm along its normal per layer (the earlier face stays), on copies of
 * its vertices so neighbours do not stretch. Returns one warning per mesh with the counts. Shared geometry is repaired once.
 */
export function repairCoplanarFaces(parts, { tolerance = COPLANAR_TOLERANCE, offset = SUGGESTED_OFFSET, maximumLayer = MAXIMUM_DEPTH_LAYER } = {}) {
  const warnings = [];
  const repaired = new Set();
  for (const part of parts) {
    const geometry = part.geometry;
    if (part.skin || part.morph || geometry.morphTargets || repaired.has(geometry)) continue;
    repaired.add(geometry);
    const scale = matrixScale(part.matrix);
    const found = findCoplanarFaces(geometry, { tolerance: tolerance / scale, doubleSided: part.material?.doubleSided === true });
    if (!found.duplicates.size && !found.overlapping.size) continue;
    const lifted = new Map();
    const layers = new Map();
    for (const later of [...found.overlapping.keys()].sort((first, second) => first - second)) {
      if (found.duplicates.has(later)) continue;
      const below = Math.max(0, ...found.overlapping.get(later).map(earlier => layers.get(earlier) ?? 0));
      const layer = Math.min(maximumLayer, below + 1);
      layers.set(later, layer);
      const triangleNormal = triangleNormalOf(geometry, later);
      lifted.set(later, { normal: triangleNormal, distance: offset * layer / scale });
    }
    if (lifted.size) moveTrianglesApart(geometry, lifted);
    if (found.duplicates.size) geometry.indices = withoutTriangles(geometry.indices, found.duplicates);
    const label = String(part.name);
    warnings.push(`Mesh ${label}: dropped ${found.duplicates.size} duplicate face(s) and moved ${lifted.size} overlapping coplanar face(s) ${metres(offset * 1000)} mm apart (z-fighting).`);
  }
  return warnings;
}

function metres(value) {
  return `${Math.round(value * 1000) / 1000}`;
}

function triangleNormalOf(geometry, triangle) {
  const { positions, indices } = geometry;
  const [first, second, third] = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
  const edgeOne = [positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]];
  const edgeTwo = [positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]];
  const normal = [
    edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
    edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
    edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
  ];
  const length = Math.hypot(...normal) || 1;
  return normal.map(component => component / length);
}
