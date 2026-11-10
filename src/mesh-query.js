import { mat4, vec3 } from 'gl-matrix';
import { buildTriangleBvh, pointBoxDistance, rayBoxDistance, traverseBvhPairs, traverseTriangleBvh } from './triangle-bvh.js';
import { barycentricWeights, closestPointOnTriangle, intersectRayTriangle, readTriangle, triangleNormal, trianglesIntersect } from './triangle-math.js';

const records = new WeakMap();
const EPSILON = 1e-9;
const INDEX_OPTIONS = new Set(['maxTriangles', 'maxVertices', 'memoryBudgetMiB', 'solid', 'maxValidationPairs']);
const PAIR_OPTIONS = new Set(['mode', 'maxTriangleTests']);
const NEAREST_OPTIONS = new Set(['maxDistance', 'maxTriangleTests']);
const PROJECT_OPTIONS = new Set(['origin', 'direction', 'maxDistance', 'maxTriangleTests']);
const DIRECTIONS = [[0, 0, 1], [1, 0.41421356237, 0.73205080757], [0.61803398875, 1, 0.27182818285], [0.17320508075, 0.44721359550, 1], [-1, 0.31622776602, 0.14142135624], [0.22360679775, -1, 0.70710678118]];

function createVector(x = 0, y = 0, z = 0) {
  return Float64Array.of(x, y, z);
}

// gl-matrix allocates Float32Array unless the caller supplies the output, which would lose precision here.
function createMatrix() {
  return mat4.identity(new Float64Array(16));
}

function optionsObject(options, fields) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Query options require an object.');
  for (const field of Object.keys(options)) if (!fields.has(field)) throw new TypeError(`Unsupported query option ${field}.`);
}

function integer(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} requires an integer within one and ${maximum}.`);
  return value;
}

function budget(maximum, label) {
  let tests = 0;
  return {
    charge() {
      tests++;
      if (tests > maximum) throw new RangeError(`${label} exhausted. Raise the query budget or reduce geometry detail.`);
    },
    get tests() { return tests; },
  };
}

function live(index) {
  const record = records.get(index);
  if (!record) throw new TypeError('Use an index from createMeshQueryIndex().');
  if (record.disposed) throw new Error('Mesh query index was disposed. Create a new index.');
  return record;
}

function isFloat32Triple(input) {
  return (Array.isArray(input) || ArrayBuffer.isView(input)) && input.length === 3 &&
    Array.from(input).every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)));
}

function transformPositions(positions, matrix) {
  const moved = new Float64Array(positions.length);
  const point = createVector();
  for (let offset = 0; offset < positions.length; offset += 3) {
    point[0] = positions[offset];
    point[1] = positions[offset + 1];
    point[2] = positions[offset + 2];
    vec3.transformMat4(point, point, matrix);
    moved.set(point, offset);
  }
  return moved;
}

function transformBounds(bounds, matrix) {
  const moved = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  const corner = createVector();
  for (let mask = 0; mask < 8; mask++) {
    corner[0] = bounds[mask & 1 ? 3 : 0];
    corner[1] = bounds[mask & 2 ? 4 : 1];
    corner[2] = bounds[mask & 4 ? 5 : 2];
    vec3.transformMat4(corner, corner, matrix);
    for (let axis = 0; axis < 3; axis++) {
      moved[axis] = Math.min(moved[axis], corner[axis]);
      moved[3 + axis] = Math.max(moved[3 + axis], corner[axis]);
    }
  }
  return moved;
}

function boundsContainPoint(bounds, point) {
  for (let axis = 0; axis < 3; axis++) if (point[axis] < bounds[axis] || point[axis] > bounds[3 + axis]) return false;
  return true;
}

function boundsOverlap(first, second) {
  for (let axis = 0; axis < 3; axis++) if (first[axis] > second[3 + axis] || second[axis] > first[3 + axis]) return false;
  return true;
}

function transformDirection(direction, matrix) {
  return createVector(
    matrix[0] * direction[0] + matrix[4] * direction[1] + matrix[8] * direction[2],
    matrix[1] * direction[0] + matrix[5] * direction[1] + matrix[9] * direction[2],
    matrix[2] * direction[0] + matrix[6] * direction[1] + matrix[10] * direction[2],
  );
}

function rotationScaleNorm(matrix) {
  return Math.hypot(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map(index => matrix[index]));
}

function maximumAbsolute(values) {
  return Math.max(...Array.from(values, Math.abs));
}

function castTriangles(first, second, secondToFirst, counter, visitor) {
  const secondPositions = transformPositions(second.positions, secondToFirst);
  const firstTriangle = new Float64Array(9);
  const secondTriangle = new Float64Array(9);
  return traverseBvhPairs(first.bvh, second.bvh, secondPositions, (firstId, secondId) => {
    counter.charge();
    readTriangle(first.positions, first.bvh.indices, firstId, firstTriangle);
    readTriangle(secondPositions, second.bvh.indices, secondId, secondTriangle);
    return visitor(firstTriangle, secondTriangle, firstId, secondId);
  });
}

function validateGeometry(geometry, maxVertices, maxTriangles) {
  if (!geometry || typeof geometry !== 'object') throw new TypeError('Mesh queries require geometry.');
  if (geometry.skinIndices !== undefined || geometry.skinWeights !== undefined || geometry.morphTargets !== undefined) {
    throw new RangeError('Mesh queries require static geometry without skinning or morph targets.');
  }
  const positions = geometry.positions;
  const indices = geometry.indices;
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0) throw new TypeError('Query positions require nonempty Float32 XYZ vertices.');
  if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3 !== 0) throw new TypeError('Query indices require nonempty Uint32 triangles.');
  if (positions.length / 3 > maxVertices || indices.length / 3 > maxTriangles) throw new RangeError('Geometry exceeds maxVertices or maxTriangles.');
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[offset + axis];
      if (!Number.isFinite(value)) throw new RangeError('Query positions must remain finite.');
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  for (const index of indices) if (index >= positions.length / 3) throw new RangeError('Query index exceeds the vertex count.');
  const center = createVector(...low.map((value, axis) => (value + high[axis]) / 2));
  const scale = Math.max(...high.map((value, axis) => value - low[axis]));
  if (scale === 0) throw new RangeError('Query geometry has no drawable extent.');
  return { center, scale, minimumAltitude: minimumNormalizedAltitude(positions, indices, scale), vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

function minimumNormalizedAltitude(positions, indices, scale) {
  const second = createVector();
  const third = createVector();
  const between = createVector();
  const cross = createVector();
  let minimumAltitude = Infinity;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const firstOffset = indices[offset] * 3;
    for (let axis = 0; axis < 3; axis++) {
      second[axis] = (positions[indices[offset + 1] * 3 + axis] - positions[firstOffset + axis]) / scale;
      third[axis] = (positions[indices[offset + 2] * 3 + axis] - positions[firstOffset + axis]) / scale;
    }
    vec3.subtract(between, second, third);
    const longest = Math.max(vec3.length(second), vec3.length(third), vec3.length(between));
    vec3.cross(cross, second, third);
    const altitude = vec3.length(cross) / longest;
    if (!Number.isFinite(altitude) || altitude <= 1e-8) throw new RangeError('Query triangle is degenerate or below the normalized precision domain.');
    minimumAltitude = Math.min(minimumAltitude, altitude);
  }
  return minimumAltitude;
}

function topology(geometry) {
  const vertexIds = new Uint32Array(geometry.positions.length / 3);
  const vertices = new Map();
  for (let vertex = 0; vertex < vertexIds.length; vertex++) {
    const offset = vertex * 3;
    const key = Array.from(geometry.positions.subarray(offset, offset + 3), value => value === 0 ? 0 : value).join(',');
    if (!vertices.has(key)) vertices.set(key, vertices.size);
    vertexIds[vertex] = vertices.get(key);
  }
  const triangles = Uint32Array.from(geometry.indices, index => vertexIds[index]);
  const edges = new Map();
  const neighbors = Array.from({ length: triangles.length / 3 }, () => []);
  const incident = Array.from({ length: vertices.size }, () => []);
  for (let face = 0; face < triangles.length / 3; face++) {
    const ids = Array.from(triangles.subarray(face * 3, face * 3 + 3));
    for (let corner = 0; corner < 3; corner++) {
      const first = ids[corner];
      const second = ids[(corner + 1) % 3];
      incident[first].push(face);
      const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ first, second, face });
    }
  }
  for (const adjacent of edges.values()) {
    if (adjacent.length !== 2 || adjacent[0].first !== adjacent[1].second || adjacent[0].second !== adjacent[1].first) {
      throw new RangeError('Solid geometry requires closed oriented manifold edges after exact position welding.');
    }
    neighbors[adjacent[0].face].push(adjacent[1].face);
    neighbors[adjacent[1].face].push(adjacent[0].face);
  }
  const visited = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const neighbor of neighbors[stack.pop()]) if (!visited.has(neighbor)) {
      visited.add(neighbor);
      stack.push(neighbor);
    }
  }
  if (visited.size !== triangles.length / 3) throw new RangeError('Solid geometry requires one connected boundary.');
  for (let vertex = 0; vertex < incident.length; vertex++) {
    if (incident[vertex].length === 0) continue;
    const links = new Map();
    for (const face of incident[vertex]) {
      const other = Array.from(triangles.subarray(face * 3, face * 3 + 3)).filter(index => index !== vertex);
      for (let side = 0; side < 2; side++) {
        if (!links.has(other[side])) links.set(other[side], []);
        links.get(other[side]).push(other[1 - side]);
      }
    }
    if (Array.from(links.values()).some(link => link.length !== 2)) throw new RangeError('Solid geometry requires manifold vertex links.');
    const reached = new Set();
    const pending = [links.keys().next().value];
    while (pending.length) {
      const current = pending.pop();
      if (reached.has(current)) continue;
      reached.add(current);
      pending.push(...links.get(current));
    }
    if (reached.size !== links.size) throw new RangeError('Solid geometry requires a single cycle at each vertex link.');
  }
  return triangles;
}

function subtractPoints(first, second) {
  return vec3.subtract(createVector(), first, second);
}

function cornerOf(triangle, corner) {
  return createVector(triangle[corner * 3], triangle[corner * 3 + 1], triangle[corner * 3 + 2]);
}

function coneContains(origin, first, second, point, normal) {
  const edgeA = subtractPoints(first, origin);
  const edgeB = subtractPoints(second, origin);
  const direction = subtractPoints(point, origin);
  const cross = createVector();
  const denominator = vec3.dot(vec3.cross(cross, edgeA, edgeB), normal);
  const firstWeight = vec3.dot(vec3.cross(cross, direction, edgeB), normal) / denominator;
  const secondWeight = vec3.dot(vec3.cross(cross, edgeA, direction), normal) / denominator;
  return firstWeight >= -EPSILON && secondWeight >= -EPSILON;
}

function validateSelfIntersections(record, welded, maximum) {
  const counter = budget(maximum, 'maxValidationPairs');
  const segment = new Float64Array(6);
  castTriangles(record, record, createMatrix(), counter, (first, second, firstId, secondId) => {
    if (firstId >= secondId) return false;
    if (!trianglesIntersect(first, second, segment)) return false;
    const firstIds = Array.from(welded.subarray(firstId * 3, firstId * 3 + 3));
    const secondIds = Array.from(welded.subarray(secondId * 3, secondId * 3 + 3));
    const shared = firstIds.filter(index => secondIds.includes(index));
    if (shared.length === 0 || shared.length === 3) throw new RangeError('Solid boundary intersects itself.');
    const firstPoints = [0, 1, 2].map(corner => cornerOf(first, corner));
    const secondPoints = [0, 1, 2].map(corner => cornerOf(second, corner));
    const firstNormal = triangleNormal(first, createVector());
    const secondNormal = triangleNormal(second, createVector());
    const coplanar = vec3.length(vec3.cross(createVector(), firstNormal, secondNormal)) <= EPSILON;
    if (shared.length === 2) {
      if (coplanar) {
        const origin = firstPoints[firstIds.indexOf(shared[0])];
        const edge = subtractPoints(firstPoints[firstIds.indexOf(shared[1])], origin);
        const firstTip = subtractPoints(firstPoints[firstIds.findIndex(index => !shared.includes(index))], origin);
        const secondTip = subtractPoints(secondPoints[secondIds.findIndex(index => !shared.includes(index))], origin);
        const firstSide = vec3.dot(vec3.cross(createVector(), edge, firstTip), firstNormal);
        const secondSide = vec3.dot(vec3.cross(createVector(), edge, secondTip), firstNormal);
        if (firstSide * secondSide >= 0) throw new RangeError('Solid adjacent faces overlap or have ambiguous coplanar sides.');
      }
      return false;
    }
    const origin = firstPoints[firstIds.indexOf(shared[0])];
    if (!coplanar) {
      const segmentStart = segment.subarray(0, 3);
      const segmentEnd = segment.subarray(3, 6);
      if (vec3.distance(segmentStart, origin) > EPSILON || vec3.distance(segmentEnd, origin) > EPSILON) throw new RangeError('Solid faces intersect beyond their shared vertex.');
      return false;
    }
    const firstOther = firstPoints.filter((point, index) => firstIds[index] !== shared[0]);
    const secondOther = secondPoints.filter((point, index) => secondIds[index] !== shared[0]);
    if (secondOther.some(point => coneContains(origin, ...firstOther, point, firstNormal)) || firstOther.some(point => coneContains(origin, ...secondOther, point, secondNormal))) {
      throw new RangeError('Solid coplanar faces intersect beyond their shared vertex.');
    }
    return false;
  });
  return counter.tests;
}

// A scene query casts thousands of rays against one part with the same matrix, so the last validated state is kept.
function matrixState(record, values) {
  const cached = record.matrixCache;
  if (cached && ArrayBuffer.isView(values) === cached.typed && values.length === 16 && cached.source.every((value, position) => value === values[position])) return cached.state;
  const state = computeMatrixState(record, values);
  record.matrixCache = { source: Array.from(values), typed: ArrayBuffer.isView(values), state };
  return state;
}

function computeMatrixState(record, values) {
  if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== 16) throw new TypeError('Query matrix requires 16 affine components.');
  const elements = Array.from(values, value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new RangeError('Query matrix requires finite Float32 components.');
    return Math.fround(value);
  });
  if (elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1) throw new RangeError('Query matrix must be affine.');
  const matrix = mat4.multiply(createMatrix(), Float64Array.from(elements), record.normalization);
  const determinant = mat4.determinant(matrix);
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError('Query matrix must be nonsingular.');
  const inverse = mat4.invert(createMatrix(), matrix);
  if (!inverse || !inverse.every(Number.isFinite)) throw new RangeError('Query matrix inverse exceeds the precision domain.');
  const bounds = transformBounds(record.bounds, matrix);
  if (!bounds.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) throw new RangeError('Query world coordinates exceed finite Float32 bounds.');
  const resolution = maximumAbsolute(bounds) * 2 ** -21 + 2 ** -149;
  if (record.minimumAltitude / rotationScaleNorm(inverse) <= resolution) throw new RangeError('Query transformed triangles collapse within the Float32 precision domain.');
  return { matrix, inverse, bounds };
}

function relativeState(second, transform) {
  const inverse = mat4.invert(createMatrix(), transform);
  const inverseNorm = inverse ? rotationScaleNorm(inverse) : 0;
  const maximum = maximumAbsolute(transformBounds(second.bounds, transform));
  if (!Number.isFinite(maximum) || maximum > 1e6 || second.minimumAltitude / inverseNorm <= 1e-8) {
    throw new RangeError('Relative mesh transform exceeds the normalized triangle precision domain.');
  }
}

function containment(record, point, counter) {
  if (!boundsContainPoint(record.bounds, point)) return { inside: false, attempts: 0 };
  const triangle = new Float64Array(9);
  const normal = createVector();
  const hit = createVector();
  const weights = createVector();
  let previous;
  let accepted = 0;
  let attempts = 0;
  for (const direction of DIRECTIONS) {
    attempts++;
    const rayDirection = vec3.normalize(createVector(), direction);
    let count = 0;
    let ambiguous = false;
    traverseTriangleBvh(
      record.bvh,
      (bounds, offset) => rayBoxDistance(point, rayDirection, bounds, offset),
      score => Number.isFinite(score),
      triangleId => {
        counter.charge();
        readTriangle(record.positions, record.bvh.indices, triangleId, triangle);
        triangleNormal(triangle, normal);
        const offsetFromCorner = subtractPoints(point, cornerOf(triangle, 0));
        if (Math.abs(vec3.dot(normal, rayDirection)) <= EPSILON && Math.abs(vec3.dot(normal, offsetFromCorner)) <= EPSILON) {
          ambiguous = true;
          return true;
        }
        const distance = intersectRayTriangle(point, rayDirection, triangle);
        if (distance < 0) return false;
        vec3.scaleAndAdd(hit, point, rayDirection, distance);
        barycentricWeights(hit, triangle, weights);
        if (distance <= EPSILON || Math.min(weights[0], weights[1], weights[2]) <= EPSILON) {
          ambiguous = true;
          return true;
        }
        count++;
        return false;
      },
    );
    if (ambiguous) continue;
    const inside = count % 2 === 1;
    if (accepted && previous !== inside) throw new RangeError('Solid containment has inconsistent ray witnesses.');
    previous = inside;
    accepted++;
    if (accepted === 2) return { inside, attempts };
  }
  throw new RangeError('Solid containment is indeterminate after bounded ray retries.');
}

function localVector(input, name) {
  if (!isFloat32Triple(input)) throw new TypeError(`${name} requires three finite Float32-representable components.`);
  return createVector(...input);
}

function queryLocalSurface(record, pointInput, directionInput, options) {
  const originalPoint = localVector(pointInput, 'Query point');
  const point = vec3.scale(createVector(), subtractPoints(originalPoint, record.center), 1 / record.scale);
  if (maximumAbsolute(point) > 1e6) throw new RangeError('Query point exceeds the normalized precision domain.');
  const maximum = options.maxDistance ?? Infinity;
  if ((maximum !== Infinity && (!Number.isFinite(maximum) || !Number.isFinite(Math.fround(maximum)))) || maximum < 0) {
    throw new RangeError('maxDistance must be nonnegative and Float32-representable, or Infinity.');
  }
  const counter = budget(integer(options.maxTriangleTests ?? 2_000_000, 100_000_000, 'maxTriangleTests'), 'maxTriangleTests');
  let rayDirection;
  if (directionInput !== undefined) {
    const direction = localVector(directionInput, 'Projection direction');
    if (vec3.length(direction) === 0) throw new RangeError('Projection direction must be nonzero.');
    rayDirection = vec3.normalize(direction, direction);
  }
  let bestDistance = maximum / record.scale;
  let bestLocalDistance = maximum;
  let bestTriangle = Infinity;
  let bestPoint;
  let bestNormal;
  let bestWeights;
  const triangle = new Float64Array(9);
  const candidate = createVector();
  const candidateLocal = createVector();
  traverseTriangleBvh(
    record.bvh,
    (bounds, offset) => rayDirection ? rayBoxDistance(point, rayDirection, bounds, offset) : pointBoxDistance(point, bounds, offset),
    score => Number.isFinite(score) && score <= bestDistance + EPSILON,
    triangleId => {
      counter.charge();
      readTriangle(record.positions, record.bvh.indices, triangleId, triangle);
      if (rayDirection) {
        const hitDistance = intersectRayTriangle(point, rayDirection, triangle);
        if (hitDistance < 0) return false;
        vec3.scaleAndAdd(candidate, point, rayDirection, hitDistance);
      } else {
        closestPointOnTriangle(point, triangle, candidate);
      }
      const distance = vec3.distance(candidate, point);
      if (!Number.isFinite(distance)) throw new RangeError('Surface query exceeds the numerical precision domain.');
      vec3.add(candidateLocal, vec3.scale(candidateLocal, candidate, record.scale), record.center);
      const localDistance = vec3.distance(candidateLocal, originalPoint);
      // Apply the caller's cutoff in its original frame, avoiding normalized subtraction at exact endpoints.
      if (localDistance > bestLocalDistance || (localDistance === bestLocalDistance && triangleId >= bestTriangle)) return false;
      const weights = barycentricWeights(candidate, triangle, createVector());
      const normal = triangleNormal(triangle, createVector());
      if (!weights || !weights.every(Number.isFinite) || vec3.length(normal) === 0) throw new RangeError('Surface query has invalid triangle coordinates.');
      bestDistance = distance;
      bestLocalDistance = localDistance;
      bestTriangle = triangleId;
      bestPoint = Float64Array.from(candidateLocal);
      bestWeights = weights;
      bestNormal = normal;
      return false;
    },
  );
  if (!bestPoint) return { hit: null, triangleTests: counter.tests };
  const distance = bestLocalDistance;
  if (!Number.isFinite(distance) || !bestPoint.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('Surface query hit exceeds finite Float32 coordinates.');
  return { hit: { point: Array.from(bestPoint), distance, triangle: bestTriangle, barycentric: Array.from(bestWeights), normal: Array.from(bestNormal) }, triangleTests: counter.tests };
}

function nearestRayHit(record, origin, direction) {
  const triangle = new Float64Array(9);
  let bestDistance = Infinity;
  let bestTriangle = -1;
  traverseTriangleBvh(
    record.bvh,
    (bounds, offset) => rayBoxDistance(origin, direction, bounds, offset),
    score => Number.isFinite(score) && score <= bestDistance,
    triangleId => {
      readTriangle(record.positions, record.bvh.indices, triangleId, triangle);
      const distance = intersectRayTriangle(origin, direction, triangle);
      if (distance >= 0 && distance < bestDistance) {
        bestDistance = distance;
        bestTriangle = triangleId;
      }
      return false;
    },
  );
  if (bestTriangle < 0) return null;
  return { triangle: bestTriangle, point: vec3.scaleAndAdd(createVector(), origin, direction, bestDistance) };
}

function readRayField(ray, field) {
  const input = ray[field];
  if (!isFloat32Triple(input)) throw new TypeError(`Ray ${field} requires three finite Float32 values.`);
  return createVector(...Array.from(input, Math.fround));
}

function raycastIndex(current, matrix, ray) {
  const state = matrixState(current, matrix);
  if (!ray || typeof ray !== 'object') throw new TypeError('ray requires origin and direction.');
  const origin = readRayField(ray, 'origin');
  const direction = readRayField(ray, 'direction');
  if (vec3.length(direction) === 0) throw new RangeError('Ray direction must be nonzero.');
  const maximum = ray.maxDistance ?? Infinity;
  if ((maximum !== Infinity && !Number.isFinite(maximum)) || maximum < 0) throw new RangeError('Ray maxDistance must be nonnegative.');
  const localOrigin = vec3.transformMat4(createVector(), origin, state.inverse);
  const localDirection = vec3.normalize(createVector(), transformDirection(vec3.normalize(createVector(), direction), state.inverse));
  if (maximumAbsolute(localOrigin) > 1e6) throw new RangeError('Ray origin exceeds the normalized query precision domain.');
  const result = nearestRayHit(current, localOrigin, localDirection);
  if (!result) return null;
  const worldPoint = vec3.transformMat4(createVector(), result.point, state.matrix);
  const distance = vec3.distance(worldPoint, origin);
  if (!Number.isFinite(distance) || !worldPoint.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError('Ray hit exceeds finite world coordinates.');
  if (distance > maximum) return null;
  const triangle = new Float64Array(9);
  readTriangle(current.positions, current.bvh.indices, result.triangle, triangle);
  const weights = barycentricWeights(result.point, triangle, createVector());
  if (!weights || !weights.every(Number.isFinite)) throw new RangeError('Ray barycentric coordinates exceed the query precision domain.');
  return { point: Array.from(worldPoint), distance, triangle: result.triangle, barycentric: Array.from(weights) };
}

function firstVertexIn(record, transform) {
  const offset = record.bvh.indices[0] * 3;
  return vec3.transformMat4(createVector(), record.positions.subarray(offset, offset + 3), transform);
}

/** Copies static geometry into a private normalized BVH. Returned handles expose no mesh internals. */
export function createMeshQueryIndex(geometry, options = {}) {
  optionsObject(options, INDEX_OPTIONS);
  const maxTriangles = integer(options.maxTriangles ?? 250_000, 1_000_000, 'maxTriangles');
  const maxVertices = integer(options.maxVertices ?? 250_000, 1_000_000, 'maxVertices');
  const maxValidationPairs = integer(options.maxValidationPairs ?? 2_000_000, 100_000_000, 'maxValidationPairs');
  const solid = options.solid ?? false;
  if (typeof solid !== 'boolean') throw new TypeError('solid must be boolean.');
  const memoryBudgetMiB = options.memoryBudgetMiB ?? 64;
  if (!Number.isFinite(memoryBudgetMiB) || memoryBudgetMiB <= 0 || memoryBudgetMiB > 1024) throw new RangeError('memoryBudgetMiB must be within zero and 1024.');
  const metadata = validateGeometry(geometry, maxVertices, maxTriangles);
  const reservedBytes = metadata.vertexCount * (solid ? 152 : 24) + metadata.triangleCount * (solid ? 512 : 128);
  if (reservedBytes > memoryBudgetMiB * 1024 * 1024) throw new RangeError('Mesh query allocation estimate exceeds memoryBudgetMiB.');
  const welded = solid ? topology(geometry) : null;
  const positions = new Float64Array(geometry.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) positions[offset + axis] = (geometry.positions[offset + axis] - metadata.center[axis]) / metadata.scale;
  }
  const normalization = Float64Array.of(metadata.scale, 0, 0, 0, 0, metadata.scale, 0, 0, 0, 0, metadata.scale, 0, metadata.center[0], metadata.center[1], metadata.center[2], 1);
  const bounds = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], positions[offset + axis]);
      bounds[3 + axis] = Math.max(bounds[3 + axis], positions[offset + axis]);
    }
  }
  const bvh = buildTriangleBvh(positions, new Uint32Array(geometry.indices), { leafSize: 8, maxDepth: 64 });
  const record = { ...metadata, normalization, positions, bounds, bvh, disposed: false, solid };
  const validationPairs = solid ? validateSelfIntersections(record, welded, maxValidationPairs) : 0;
  const memoryPlan = Object.freeze({ reservedBytes, memoryBudgetMiB, vertexCount: metadata.vertexCount, triangleCount: metadata.triangleCount, validationPairs });
  const handle = Object.freeze({
    solid,
    memoryPlan,
    info: Object.freeze({ vertexCount: metadata.vertexCount, triangleCount: metadata.triangleCount, estimatedBytes: reservedBytes }),
    nearest(point, options = {}) {
      optionsObject(options, NEAREST_OPTIONS);
      return queryLocalSurface(live(handle), point, undefined, options);
    },
    project(ray) {
      optionsObject(ray, PROJECT_OPTIONS);
      if (ray.direction === undefined) throw new TypeError('Projection requires direction.');
      return queryLocalSurface(live(handle), ray.origin, ray.direction, ray);
    },
    raycast(matrix, ray) {
      return raycastIndex(live(handle), matrix, ray);
    },
    dispose() {
      if (record.disposed) return;
      record.disposed = true;
      record.positions = null;
      record.bvh = null;
    },
  });
  records.set(handle, record);
  return handle;
}

/** Surface contacts are not proof of volume penetration. Closed solids additionally test containment. */
export function createMeshPairQuery(indexA, indexB, options = {}) {
  optionsObject(options, PAIR_OPTIONS);
  const first = live(indexA);
  const second = live(indexB);
  const mode = options.mode ?? 'surfaces';
  if (mode !== 'surfaces' && mode !== 'closed-solids') throw new RangeError('Query mode must be surfaces or closed-solids.');
  if (mode === 'closed-solids' && (!first.solid || !second.solid)) throw new RangeError('Closed-solid queries require two validated solid indices.');
  const maximum = integer(options.maxTriangleTests ?? 2_000_000, 100_000_000, 'maxTriangleTests');
  return Object.freeze({
    evaluate(matrixA, matrixB) {
      const currentA = live(indexA);
      const currentB = live(indexB);
      const stateA = matrixState(currentA, matrixA);
      const stateB = matrixState(currentB, matrixB);
      const result = { kind: mode === 'surfaces' ? 'surface-disjoint' : 'separate', solidRelation: mode === 'surfaces' ? 'not-tested' : 'outside', triangles: null, triangleTests: 0, rayAttempts: 0 };
      if (!boundsOverlap(stateA.bounds, stateB.bounds)) return result;
      const relativeB = mat4.multiply(createMatrix(), stateA.inverse, stateB.matrix);
      const relativeA = mat4.multiply(createMatrix(), stateB.inverse, stateA.matrix);
      relativeState(currentB, relativeB);
      relativeState(currentA, relativeA);
      const counter = budget(maximum, 'maxTriangleTests');
      const contact = castTriangles(currentA, currentB, relativeB, counter, (firstTriangle, secondTriangle, firstId, secondId) => {
        if (!trianglesIntersect(firstTriangle, secondTriangle)) return false;
        result.triangles = [firstId, secondId];
        return true;
      });
      if (contact) {
        result.kind = 'surface-intersection';
        result.solidRelation = mode === 'surfaces' ? 'not-tested' : 'boundaries-intersect';
      } else if (mode === 'closed-solids') {
        const firstInside = containment(currentB, firstVertexIn(currentA, relativeA), counter);
        const secondInside = containment(currentA, firstVertexIn(currentB, relativeB), counter);
        result.rayAttempts = firstInside.attempts + secondInside.attempts;
        if (firstInside.inside && secondInside.inside) throw new RangeError('Solid containment witnesses are inconsistent.');
        if (firstInside.inside || secondInside.inside) {
          result.kind = 'contained';
          result.solidRelation = firstInside.inside ? 'a-in-b' : 'b-in-a';
        }
      }
      result.triangleTests = counter.tests;
      return result;
    },
  });
}

/** A query index over indexed triangles in any typed or plain arrays, for callers that hold render geometry or MeshData triangles. */
export function createTriangleSurfaceIndex({ positions, indices }) {
  return createMeshQueryIndex({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
}
