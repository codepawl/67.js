import { placeCellVertices, quadsAroundEdges } from './surface-nets.js';

// The sdf geometry: a tree of signed-distance primitives and operations, sampled on a bounded grid and meshed by surface
// nets. Distances are negative inside. Everything is plain arithmetic in a fixed order, so the same recipe gives the same bytes.

export const SDF_LIMITS = Object.freeze({ minResolution: 4, maxResolution: 128, defaultResolution: 32, maxNodes: 64, maxDepth: 8, maxChildren: 16 });
const PADDING_VOXELS = 2;
const PRIMITIVE_FIELDS = {
  sphere: ['radius'],
  box: ['size'],
  roundBox: ['size', 'radius'],
  capsule: ['radius', 'height'],
  cylinder: ['radius', 'height'],
  torus: ['radius', 'tubeRadius'],
};
const OPERATIONS = ['union', 'subtract', 'intersect', 'offset'];
const PLACEMENT_FIELDS = ['position', 'rotation', 'scale'];

function fail(path, value, expected) {
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return new RangeError(`${path} is ${shown}; pass ${expected}.`);
}

function positiveNumber(node, field, fallback, path) {
  const value = node[field] ?? fallback;
  if (!Number.isFinite(value) || value <= 0) throw fail(`${path}.${field}`, value, 'a positive number');
  return value;
}

function vectorOf(value, fallback, path, { positive = false } = {}) {
  const vector = value ?? fallback;
  const valid = Array.isArray(vector) && vector.length === 3 && vector.every(component => Number.isFinite(component) && (!positive || component > 0));
  if (!valid) throw fail(path, vector, positive ? 'three positive numbers, such as [1, 1, 1]' : 'three numbers, such as [0, 0, 0]');
  return vector;
}

function checkKeys(node, allowed, path) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw fail(`${path}.${key}`, node[key], `one of ${allowed.join(', ')}; remove "${key}"`);
  }
}

// Rotation by Euler angles in radians: about X first, then Y, then Z. Stored as the 3x3 matrix, row by row.
function rotationMatrix([x, y, z]) {
  const cosX = Math.cos(x);
  const sinX = Math.sin(x);
  const cosY = Math.cos(y);
  const sinY = Math.sin(y);
  const cosZ = Math.cos(z);
  const sinZ = Math.sin(z);
  return [
    cosZ * cosY, cosZ * sinY * sinX - sinZ * cosX, cosZ * sinY * cosX + sinZ * sinX,
    sinZ * cosY, sinZ * sinY * sinX + cosZ * cosX, sinZ * sinY * cosX - cosZ * sinX,
    -sinY, cosY * sinX, cosY * cosX,
  ];
}

function length2(first, second) {
  return Math.sqrt(first * first + second * second);
}

function length3(first, second, third) {
  return Math.sqrt(first * first + second * second + third * third);
}

function boxDistance(x, y, z, half) {
  const qx = Math.abs(x) - half[0];
  const qy = Math.abs(y) - half[1];
  const qz = Math.abs(z) - half[2];
  return length3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

// Local distance function and half extents of each primitive; capsule, cylinder and torus stand along Y.
function primitiveShape(node, path) {
  switch (node.shape) {
    case 'sphere': {
      const radius = positiveNumber(node, 'radius', 0.5, path);
      return { half: [radius, radius, radius], distance: (x, y, z) => length3(x, y, z) - radius };
    }
    case 'box': {
      const size = vectorOf(node.size, [1, 1, 1], `${path}.size`, { positive: true });
      const half = size.map(value => value / 2);
      return { half, distance: (x, y, z) => boxDistance(x, y, z, half) };
    }
    case 'roundBox': {
      const size = vectorOf(node.size, [1, 1, 1], `${path}.size`, { positive: true });
      const radius = node.radius ?? 0.1;
      if (!Number.isFinite(radius) || radius < 0 || radius > Math.min(...size) / 2) {
        throw fail(`${path}.radius`, radius, `a number from 0 to half the smallest size, ${Math.min(...size) / 2}`);
      }
      const half = size.map(value => value / 2);
      const inner = half.map(value => value - radius);
      return { half, distance: (x, y, z) => boxDistance(x, y, z, inner) - radius };
    }
    case 'capsule': {
      const radius = positiveNumber(node, 'radius', 0.25, path);
      const halfSegment = positiveNumber(node, 'height', 0.5, path) / 2;
      return {
        half: [radius, halfSegment + radius, radius],
        distance: (x, y, z) => length3(x, y - Math.max(-halfSegment, Math.min(halfSegment, y)), z) - radius,
      };
    }
    case 'cylinder': {
      const radius = positiveNumber(node, 'radius', 0.5, path);
      const halfHeight = positiveNumber(node, 'height', 1, path) / 2;
      return {
        half: [radius, halfHeight, radius],
        distance: (x, y, z) => {
          const radial = length2(x, z) - radius;
          const vertical = Math.abs(y) - halfHeight;
          return Math.min(Math.max(radial, vertical), 0) + length2(Math.max(radial, 0), Math.max(vertical, 0));
        },
      };
    }
    case 'torus': {
      const radius = positiveNumber(node, 'radius', 0.5, path);
      const tubeRadius = positiveNumber(node, 'tubeRadius', 0.15, path);
      return {
        half: [radius + tubeRadius, tubeRadius, radius + tubeRadius],
        distance: (x, y, z) => length2(length2(x, z) - radius, y) - tubeRadius,
      };
    }
    default:
      throw fail(`${path}.shape`, node.shape, `one of ${Object.keys(PRIMITIVE_FIELDS).join(', ')}`);
  }
}

function placedPrimitive(node, path) {
  checkKeys(node, ['shape', ...PRIMITIVE_FIELDS[node.shape] ?? [], ...PLACEMENT_FIELDS], path);
  const shape = primitiveShape(node, path);
  const position = vectorOf(node.position, [0, 0, 0], `${path}.position`);
  const rotation = vectorOf(node.rotation, [0, 0, 0], `${path}.rotation`);
  const scale = node.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) throw fail(`${path}.scale`, scale, 'one positive number; scale is uniform');
  const matrix = rotationMatrix(rotation);
  const inverseScale = 1 / scale;
  // The point goes into the shape's frame with the transpose of the rotation; the distance comes back multiplied by the scale.
  const distance = (x, y, z) => {
    const dx = x - position[0];
    const dy = y - position[1];
    const dz = z - position[2];
    const localX = (matrix[0] * dx + matrix[3] * dy + matrix[6] * dz) * inverseScale;
    const localY = (matrix[1] * dx + matrix[4] * dy + matrix[7] * dz) * inverseScale;
    const localZ = (matrix[2] * dx + matrix[5] * dy + matrix[8] * dz) * inverseScale;
    return shape.distance(localX, localY, localZ) * scale;
  };
  const reach = [0, 1, 2].map(row => scale * (Math.abs(matrix[row * 3]) * shape.half[0] + Math.abs(matrix[row * 3 + 1]) * shape.half[1] + Math.abs(matrix[row * 3 + 2]) * shape.half[2]));
  return {
    distance,
    bounds: { min: reach.map((value, axis) => position[axis] - value), max: reach.map((value, axis) => position[axis] + value) },
  };
}

// Polynomial smooth minimum: it lowers the plain minimum by at most smooth / 4, and equals it when smooth is 0.
function smoothMinimum(first, second, smooth) {
  if (smooth === 0) return Math.min(first, second);
  const blend = Math.max(smooth - Math.abs(first - second), 0) / smooth;
  return Math.min(first, second) - blend * blend * smooth / 4;
}

function combine(operation, smooth) {
  switch (operation) {
    case 'union': return (first, second) => smoothMinimum(first, second, smooth);
    case 'intersect': return (first, second) => -smoothMinimum(-first, -second, smooth);
    default: return (first, second) => -smoothMinimum(-first, second, smooth);
  }
}

function expandedBounds(bounds, amount) {
  return { min: bounds.min.map(value => value - amount), max: bounds.max.map(value => value + amount) };
}

function combinedBounds(operation, childBounds, slack, path) {
  if (operation === 'subtract') return childBounds[0];
  const pick = operation === 'union' ? [Math.min, Math.max] : [Math.max, Math.min];
  const bounds = {
    min: [0, 1, 2].map(axis => pick[0](...childBounds.map(child => child.min[axis]))),
    max: [0, 1, 2].map(axis => pick[1](...childBounds.map(child => child.max[axis]))),
  };
  if (operation === 'intersect' && bounds.min.some((value, axis) => value >= bounds.max[axis])) {
    throw fail(path, 'children that do not overlap', 'children whose shapes overlap, or use union');
  }
  return operation === 'union' ? expandedBounds(bounds, slack) : bounds;
}

function compileNode(node, path, depth, counter) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw fail(path, node, `a primitive such as { "shape": "sphere", "radius": 0.5 } or an operation such as { "op": "union", "children": [...] }`);
  counter.count += 1;
  if (counter.count > SDF_LIMITS.maxNodes) throw fail(path, `more than ${SDF_LIMITS.maxNodes} nodes`, `at most ${SDF_LIMITS.maxNodes} primitives and operations in all`);
  if (depth > SDF_LIMITS.maxDepth) throw fail(path, `nesting deeper than ${SDF_LIMITS.maxDepth}`, `at most ${SDF_LIMITS.maxDepth} levels of operations`);
  if (node.shape !== undefined) {
    if (node.op !== undefined) throw fail(`${path}.op`, node.op, 'either shape or op, not both');
    return placedPrimitive(node, path);
  }
  if (!OPERATIONS.includes(node.op)) throw fail(`${path}.op`, node.op, `shape (${Object.keys(PRIMITIVE_FIELDS).join(', ')}) or op (${OPERATIONS.join(', ')})`);
  if (node.op === 'offset') return compileOffset(node, path, depth, counter);
  checkKeys(node, ['op', 'smooth', 'children'], path);
  const smooth = node.smooth ?? 0;
  if (!Number.isFinite(smooth) || smooth < 0) throw fail(`${path}.smooth`, smooth, 'a blend radius of 0 or more, in the units of the shapes');
  const children = node.children;
  if (!Array.isArray(children) || children.length < 2 || children.length > SDF_LIMITS.maxChildren) {
    throw fail(`${path}.children`, Array.isArray(children) ? `${children.length} children` : children, `2 to ${SDF_LIMITS.maxChildren} nodes`);
  }
  const compiled = children.map((child, index) => compileNode(child, `${path}.children[${index}]`, depth + 1, counter));
  const join = combine(node.op, smooth);
  const distance = (x, y, z) => {
    let result = compiled[0].distance(x, y, z);
    for (let index = 1; index < compiled.length; index++) result = join(result, compiled[index].distance(x, y, z));
    return result;
  };
  const slack = smooth / 4 * (compiled.length - 1);
  return { distance, bounds: combinedBounds(node.op, compiled.map(child => child.bounds), slack, path) };
}

function compileOffset(node, path, depth, counter) {
  checkKeys(node, ['op', 'distance', 'child'], path);
  if (!Number.isFinite(node.distance)) throw fail(`${path}.distance`, node.distance, 'a number: positive grows the shape, negative shrinks it');
  const child = compileNode(node.child, `${path}.child`, depth + 1, counter);
  const bounds = node.distance > 0 ? expandedBounds(child.bounds, node.distance) : child.bounds;
  return { distance: (x, y, z) => child.distance(x, y, z) - node.distance, bounds };
}

/** Validates an sdf geometry and returns its grid, without sampling it. */
export function planSdf(value) {
  const unknown = Object.keys(value).filter(key => !['id', 'type', 'root', 'resolution'].includes(key));
  if (unknown.length) throw fail(`sdf.${unknown[0]}`, value[unknown[0]], 'only root and resolution; remove it');
  const resolution = value.resolution ?? SDF_LIMITS.defaultResolution;
  if (!Number.isInteger(resolution) || resolution < SDF_LIMITS.minResolution || resolution > SDF_LIMITS.maxResolution) {
    throw fail('sdf.resolution', resolution, `a whole number of cells along the longest side, ${SDF_LIMITS.minResolution} to ${SDF_LIMITS.maxResolution}; the grid is capped at ${SDF_LIMITS.maxResolution ** 3} cells`);
  }
  const root = compileNode(value.root, 'sdf.root', 0, { count: 0 });
  const extent = root.bounds.max.map((high, axis) => high - root.bounds.min[axis]);
  const edge = Math.max(...extent) / resolution;
  const points = extent.map(length => Math.ceil(length / edge - 1e-9) + 1 + PADDING_VOXELS * 2);
  const origin = root.bounds.min.map(low => low - PADDING_VOXELS * edge);
  return { root, resolution, edge, points, origin, vertexEstimate: 8 * resolution * resolution };
}

/** The vertex count to reserve for an sdf geometry: validated, not sampled. Surfaces with more detail are checked after meshing. */
export function sdfVertexEstimate(value) {
  return planSdf(value).vertexEstimate;
}

function sampleGrid({ root, edge, points, origin }) {
  const [pointsX, pointsY, pointsZ] = points;
  const distances = new Float32Array(pointsX * pointsY * pointsZ);
  let index = 0;
  for (let z = 0; z < pointsZ; z++) {
    for (let y = 0; y < pointsY; y++) {
      for (let x = 0; x < pointsX; x++) {
        distances[index++] = root.distance(origin[0] + x * edge, origin[1] + y * edge, origin[2] + z * edge);
      }
    }
  }
  return distances;
}

function gradientAt(distance, x, y, z, step) {
  return [
    distance(x + step, y, z) - distance(x - step, y, z),
    distance(x, y + step, z) - distance(x, y - step, z),
    distance(x, y, z + step) - distance(x, y, z - step),
  ];
}

// Two triangles per quad, split along the shorter diagonal so thin quads do not fold.
function triangulate(quads, positions) {
  const indices = [];
  const gap = (first, second) => {
    const dx = positions[first * 3] - positions[second * 3];
    const dy = positions[first * 3 + 1] - positions[second * 3 + 1];
    const dz = positions[first * 3 + 2] - positions[second * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  for (const [first, second, third, fourth] of quads) {
    if (gap(first, third) <= gap(second, fourth)) indices.push(first, second, third, first, third, fourth);
    else indices.push(first, second, fourth, second, third, fourth);
  }
  return Uint32Array.from(indices);
}

/** Mesh an sdf geometry: positions, normals from the field gradient, box-projected UVs and triangle indices. */
export function sdfGeometry(value) {
  const plan = planSdf(value);
  const grid = { points: plan.points, edge: plan.edge };
  const distances = sampleGrid(plan);
  const { cellVertex, positions: cellPositions } = placeCellVertices(distances, grid, plan.origin);
  const quads = quadsAroundEdges(distances, grid, cellVertex);
  if (!quads.length) throw new RangeError('sdf has no surface: the shape is empty or smaller than a cell. Pass a larger resolution or check subtract and intersect children.');
  const positions = Float32Array.from(cellPositions);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array(positions.length / 3 * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const gradient = gradientAt(plan.root.distance, cellPositions[vertex * 3], cellPositions[vertex * 3 + 1], cellPositions[vertex * 3 + 2], plan.edge * 0.5);
    normals.set(gradient, vertex * 3);
    const strongest = Math.abs(gradient[0]) >= Math.abs(gradient[1]) && Math.abs(gradient[0]) >= Math.abs(gradient[2]) ? 0 : Math.abs(gradient[1]) >= Math.abs(gradient[2]) ? 1 : 2;
    const [u, v] = [[1, 2], [0, 2], [0, 1]][strongest];
    uvs[vertex * 2] = cellPositions[vertex * 3 + u];
    uvs[vertex * 2 + 1] = cellPositions[vertex * 3 + v];
  }
  return { positions, normals, uvs, indices: triangulate(quads, positions) };
}
