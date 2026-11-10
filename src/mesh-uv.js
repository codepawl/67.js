import { createMeshData, DOMAINS } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { triangulateMesh } from './mesh-render.js';
import { cornerCycles, cornerFaces, edgeCornerTable, UnionFind } from './mesh-topology.js';
import { selectEdges, edgeFaces } from './mesh-bevel.js';

// Automatic UV unwrapping: seams from an edge rule, extra cuts until every island is a disk, least-squares conformal
// maps (LSCM, the "Conformal" method Blender offers) solved per island, area normalisation for an even texel density,
// and shelf packing into the unit square.

const MAX_CUT_ROUNDS = 8;
const MAX_SOLVER_ITERATIONS = 4000;

const subtract = (first, second) => [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
const length = vector => Math.hypot(vector[0], vector[1], vector[2]);
const normalize = vector => {
  const size = length(vector);
  return size === 0 ? [0, 0, 0] : [vector[0] / size, vector[1] / size, vector[2] / size];
};

function positionOf(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

/**
 * Corner groups that share one UV vertex (corners of one mesh vertex joined across uncut edges) and faces grouped
 * into islands (faces joined across uncut edges). Edges with other than two consistently wound faces always cut.
 */
function groupsAndIslands(mesh, seam, table, nextCorner, facesOfCorners) {
  const corners = new UnionFind(mesh.cornerCount);
  const faces = new UnionFind(mesh.faceCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (seam[edge] || table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
    const first = table.edgeCorners[table.edgeOffsets[edge]];
    const second = table.edgeCorners[table.edgeOffsets[edge] + 1];
    if (mesh.cornerVertices[first] === mesh.cornerVertices[second]) continue;
    corners.union(first, nextCorner[second]);
    corners.union(nextCorner[first], second);
    faces.union(facesOfCorners[first], facesOfCorners[second]);
  }
  const islandOfRoot = new Map();
  const islands = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    const root = faces.find(face);
    if (!islandOfRoot.has(root)) {
      islandOfRoot.set(root, islands.length);
      islands.push({ faces: [] });
    }
    islands[islandOfRoot.get(root)].faces.push(face);
  }
  return { corners, islands };
}

/** UV vertices, uncut interior edges and boundary loops of one island. */
function describeIsland(mesh, island, corners, nextCorner, seam) {
  const localOf = new Map();
  const vertexOfLocal = [];
  const cornerLocal = new Map();
  const edgeUses = new Map();
  const interiorEdges = new Set();
  for (const face of island.faces) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const root = corners.find(corner);
      if (!localOf.has(root)) {
        localOf.set(root, vertexOfLocal.length);
        vertexOfLocal.push(mesh.cornerVertices[corner]);
      }
      cornerLocal.set(corner, localOf.get(root));
    }
  }
  for (const face of island.faces) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const from = cornerLocal.get(corner);
      const to = cornerLocal.get(nextCorner[corner]);
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
      if (!seam[mesh.cornerEdges[corner]]) interiorEdges.add(mesh.cornerEdges[corner]);
    }
  }
  const boundaryNeighbours = new Map();
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [from, to] = key.split(',').map(Number);
    if (!boundaryNeighbours.has(from)) boundaryNeighbours.set(from, []);
    if (!boundaryNeighbours.has(to)) boundaryNeighbours.set(to, []);
    boundaryNeighbours.get(from).push(to);
    boundaryNeighbours.get(to).push(from);
  }
  const loops = [];
  const visited = new Set();
  for (const start of boundaryNeighbours.keys()) {
    if (visited.has(start)) continue;
    const loop = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const vertex = stack.pop();
      loop.push(vertex);
      for (const neighbour of boundaryNeighbours.get(vertex)) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
    loops.push(loop);
  }
  const euler = vertexOfLocal.length - edgeUses.size + island.faces.length;
  return { localOf, vertexOfLocal, cornerLocal, interiorEdges, loops, euler, isDisk: loops.length === 1 && euler === 1 };
}

class MinHeap {
  constructor() {
    this.keys = [];
    this.items = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, item) {
    let index = this.keys.length;
    this.keys.push(key);
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop() {
    const top = [this.keys[0], this.items[0]];
    const lastKey = this.keys.pop();
    const lastItem = this.items.pop();
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.items[0] = lastItem;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  swap(first, second) {
    [this.keys[first], this.keys[second]] = [this.keys[second], this.keys[first]];
    [this.items[first], this.items[second]] = [this.items[second], this.items[first]];
  }
}

/** Shortest path along the given edges from any source vertex to any target vertex (Dijkstra by edge length). */
function shortestPath(mesh, edges, sources, targets) {
  const neighbours = new Map();
  for (const edge of edges) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    const distance = length(subtract(positionOf(mesh, first), positionOf(mesh, second)));
    if (!neighbours.has(first)) neighbours.set(first, []);
    if (!neighbours.has(second)) neighbours.set(second, []);
    neighbours.get(first).push({ vertex: second, edge, distance });
    neighbours.get(second).push({ vertex: first, edge, distance });
  }
  const best = new Map();
  const previous = new Map();
  const queue = new MinHeap();
  for (const source of sources) {
    best.set(source, 0);
    queue.push(0, source);
  }
  while (queue.size) {
    const [distance, vertex] = queue.pop();
    if (distance > best.get(vertex)) continue;
    if (targets.has(vertex) && !sources.has(vertex)) {
      const path = [];
      let current = vertex;
      while (previous.has(current)) {
        const step = previous.get(current);
        path.push(step.edge);
        current = step.from;
      }
      return { path, end: vertex };
    }
    for (const next of neighbours.get(vertex) ?? []) {
      const candidate = distance + next.distance;
      if (candidate < (best.get(next.vertex) ?? Infinity)) {
        best.set(next.vertex, candidate);
        previous.set(next.vertex, { from: vertex, edge: next.edge });
        queue.push(candidate, next.vertex);
      }
    }
  }
  return null;
}

/** Vertex farthest (along the given edges) from a start vertex. */
function farthestVertex(mesh, edges, start) {
  const all = new Set();
  for (const edge of edges) {
    all.add(mesh.edgeVertices[edge * 2]);
    all.add(mesh.edgeVertices[edge * 2 + 1]);
  }
  let farthest = start;
  let farthestDistance = -1;
  for (const vertex of all) {
    const distance = length(subtract(positionOf(mesh, vertex), positionOf(mesh, start)));
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = vertex;
    }
  }
  return farthest;
}

/**
 * Add cuts until every island is a disk: islands with several boundary loops get a cut along the shortest path
 * joining two loops; closed islands get a slit between two far-apart vertices. Returns the number of edges added.
 */
function cutToDisks(mesh, seam, table, nextCorner, facesOfCorners) {
  let added = 0;
  for (let round = 0; round < MAX_CUT_ROUNDS; round++) {
    const { corners, islands } = groupsAndIslands(mesh, seam, table, nextCorner, facesOfCorners);
    let changed = false;
    for (const island of islands) {
      const description = describeIsland(mesh, island, corners, nextCorner, seam);
      if (description.isDisk || !description.interiorEdges.size) continue;
      let path = null;
      if (description.loops.length >= 2) {
        const sources = new Set(description.loops[0].map(local => description.vertexOfLocal[local]));
        const targets = new Set(description.loops.slice(1).flat().map(local => description.vertexOfLocal[local]));
        path = shortestPath(mesh, description.interiorEdges, sources, targets);
      } else if (description.loops.length === 0) {
        const anyVertex = description.vertexOfLocal[0];
        const first = farthestVertex(mesh, description.interiorEdges, anyVertex);
        const second = farthestVertex(mesh, description.interiorEdges, first);
        path = shortestPath(mesh, description.interiorEdges, new Set([first]), new Set([second]));
      }
      if (!path || !path.path.length) continue;
      for (const edge of path.path) {
        if (!seam[edge]) {
          seam[edge] = 1;
          added++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return added;
}

/**
 * Least squares by conjugate gradients on the normal equations (CGLS), starting from x. Rows are compressed:
 * rowOffsets, columns and values. Columns are scaled by their norms first (Jacobi preconditioning).
 */
function solveLeastSquares({ rowOffsets, columns, values }, columnCount, rightSide, x) {
  const rowCount = rowOffsets.length - 1;
  const columnScale = new Float64Array(columnCount);
  for (let entry = 0; entry < values.length; entry++) columnScale[columns[entry]] += values[entry] * values[entry];
  for (let column = 0; column < columnCount; column++) columnScale[column] = columnScale[column] > 0 ? 1 / Math.sqrt(columnScale[column]) : 0;
  const scaled = new Float64Array(values.length);
  for (let entry = 0; entry < values.length; entry++) scaled[entry] = values[entry] * columnScale[columns[entry]];
  const multiply = (vector, result) => {
    for (let row = 0; row < rowCount; row++) {
      let sum = 0;
      for (let entry = rowOffsets[row]; entry < rowOffsets[row + 1]; entry++) sum += scaled[entry] * vector[columns[entry]];
      result[row] = sum;
    }
  };
  const multiplyTransposed = (vector, result) => {
    result.fill(0);
    for (let row = 0; row < rowCount; row++) {
      const value = vector[row];
      for (let entry = rowOffsets[row]; entry < rowOffsets[row + 1]; entry++) result[columns[entry]] += scaled[entry] * value;
    }
  };
  const squaredNorm = vector => {
    let sum = 0;
    for (let index = 0; index < vector.length; index++) sum += vector[index] * vector[index];
    return sum;
  };
  // Solve for y = x / scale.
  const y = new Float64Array(columnCount);
  for (let column = 0; column < columnCount; column++) y[column] = columnScale[column] > 0 ? x[column] / columnScale[column] : 0;
  const residual = new Float64Array(rowCount);
  multiply(y, residual);
  for (let row = 0; row < rowCount; row++) residual[row] = rightSide[row] - residual[row];
  const gradient = new Float64Array(columnCount);
  multiplyTransposed(residual, gradient);
  const direction = Float64Array.from(gradient);
  const step = new Float64Array(rowCount);
  let gamma = squaredNorm(gradient);
  const tolerance = gamma * 1e-16;
  for (let iteration = 0; iteration < MAX_SOLVER_ITERATIONS && gamma > tolerance && gamma > 0; iteration++) {
    multiply(direction, step);
    const stepNorm = squaredNorm(step);
    if (stepNorm === 0) break;
    const alpha = gamma / stepNorm;
    for (let column = 0; column < columnCount; column++) y[column] += alpha * direction[column];
    for (let row = 0; row < rowCount; row++) residual[row] -= alpha * step[row];
    multiplyTransposed(residual, gradient);
    const nextGamma = squaredNorm(gradient);
    const beta = nextGamma / gamma;
    for (let column = 0; column < columnCount; column++) direction[column] = gradient[column] + beta * direction[column];
    gamma = nextGamma;
  }
  for (let column = 0; column < columnCount; column++) x[column] = y[column] * columnScale[column];
  return x;
}

/** Project island vertices onto the plane of the island's area-weighted normal (counter-clockwise from the front). */
function planarProjection(mesh, description, triangles, normal) {
  const reference = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const tangent = normalize(cross(reference, normal));
  const bitangent = cross(normal, tangent);
  return description.vertexOfLocal.map(vertex => {
    const point = positionOf(mesh, vertex);
    return [dot(point, tangent), dot(point, bitangent)];
  });
}

/** Least-squares conformal map of one disk island; returns [u, v] per local vertex. */
function conformalMap(mesh, description, triangles, normal) {
  const initial = planarProjection(mesh, description, triangles, normal);
  const count = initial.length;
  if (count < 3 || !description.isDisk) return initial;
  // Pin the two boundary vertices farthest apart, at their projected positions.
  const boundary = description.loops[0];
  let pinA = boundary[0];
  let pinB = boundary[0];
  let widest = -1;
  for (const first of boundary) {
    for (const second of boundary) {
      const distance = length(subtract(positionOf(mesh, description.vertexOfLocal[first]), positionOf(mesh, description.vertexOfLocal[second])));
      if (distance > widest) {
        widest = distance;
        pinA = first;
        pinB = second;
      }
    }
    if (boundary.length > 400) break;
  }
  const columnOf = new Int32Array(count * 2).fill(-1);
  let columns = 0;
  for (let local = 0; local < count; local++) {
    if (local === pinA || local === pinB) continue;
    columnOf[local * 2] = columns++;
    columnOf[local * 2 + 1] = columns++;
  }
  const pinned = new Map([[pinA, initial[pinA]], [pinB, initial[pinB]]]);
  const rowOffsets = [0];
  const rowColumns = [];
  const rowValues = [];
  const rightSide = [];
  const pushRow = (entries, constant) => {
    for (const [column, value] of entries) {
      rowColumns.push(column);
      rowValues.push(value);
    }
    rowOffsets.push(rowColumns.length);
    rightSide.push(constant);
  };
  for (const [first, second, third] of triangles) {
    const pointA = positionOf(mesh, description.vertexOfLocal[first]);
    const pointB = positionOf(mesh, description.vertexOfLocal[second]);
    const pointC = positionOf(mesh, description.vertexOfLocal[third]);
    const edgeAB = subtract(pointB, pointA);
    const edgeAC = subtract(pointC, pointA);
    const sideLength = length(edgeAB);
    const doubleArea = length(cross(edgeAB, edgeAC));
    if (sideLength === 0 || doubleArea === 0) continue;
    // Local triangle coordinates: A at the origin, B on the x axis.
    const local = [[0, 0], [sideLength, 0], [dot(edgeAC, edgeAB) / sideLength, doubleArea / sideLength]];
    const weight = 1 / Math.sqrt(doubleArea);
    const vertices = [first, second, third];
    // W_j = (x_{j+2} - x_{j+1}) + i (y_{j+2} - y_{j+1}); sum_j W_j (u_j + i v_j) = 0 for a conformal map.
    const real = [];
    const imaginary = [];
    let realConstant = 0;
    let imaginaryConstant = 0;
    for (let index = 0; index < 3; index++) {
      const next = local[(index + 1) % 3];
      const after = local[(index + 2) % 3];
      const wReal = (after[0] - next[0]) * weight;
      const wImaginary = (after[1] - next[1]) * weight;
      const vertex = vertices[index];
      if (pinned.has(vertex)) {
        const [u, v] = pinned.get(vertex);
        realConstant += wReal * u - wImaginary * v;
        imaginaryConstant += wImaginary * u + wReal * v;
      } else {
        real.push([columnOf[vertex * 2], wReal], [columnOf[vertex * 2 + 1], -wImaginary]);
        imaginary.push([columnOf[vertex * 2], wImaginary], [columnOf[vertex * 2 + 1], wReal]);
      }
    }
    pushRow(real, -realConstant);
    pushRow(imaginary, -imaginaryConstant);
  }
  const x = new Float64Array(columns);
  for (let local = 0; local < count; local++) {
    if (columnOf[local * 2] === -1) continue;
    x[columnOf[local * 2]] = initial[local][0];
    x[columnOf[local * 2 + 1]] = initial[local][1];
  }
  const rows = { rowOffsets: Int32Array.from(rowOffsets), columns: Int32Array.from(rowColumns), values: Float64Array.from(rowValues) };
  solveLeastSquares(rows, columns, rightSide, x);
  return initial.map((point, local) => pinned.has(local) ? pinned.get(local) : [x[columnOf[local * 2]], x[columnOf[local * 2 + 1]]]);
}

function convexHull(points) {
  const sorted = [...points].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const turn = (origin, first, second) => (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && turn(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && turn(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Rotate island coordinates so their bounding box has the least area (tested along every hull edge). */
function rotateToSmallestBox(points) {
  const hull = convexHull(points);
  let bestAngle = 0;
  let bestArea = Infinity;
  for (let index = 0; index < hull.length; index++) {
    const next = hull[(index + 1) % hull.length];
    const angle = -Math.atan2(next[1] - hull[index][1], next[0] - hull[index][0]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumY = Infinity;
    let maximumY = -Infinity;
    for (const [x, y] of hull) {
      const rotatedX = x * cosine - y * sine;
      const rotatedY = x * sine + y * cosine;
      minimumX = Math.min(minimumX, rotatedX);
      maximumX = Math.max(maximumX, rotatedX);
      minimumY = Math.min(minimumY, rotatedY);
      maximumY = Math.max(maximumY, rotatedY);
    }
    const area = (maximumX - minimumX) * (maximumY - minimumY);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = angle;
    }
  }
  const cosine = Math.cos(bestAngle);
  const sine = Math.sin(bestAngle);
  return points.map(([x, y]) => [x * cosine - y * sine, x * sine + y * cosine]);
}

export function bounds2d(points) {
  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  for (const [x, y] of points) {
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }
  return { minimumX, minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

function signedArea2d(first, second, third) {
  return ((second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])) / 2;
}

function triangleArea3d(mesh, description, [first, second, third]) {
  const pointA = positionOf(mesh, description.vertexOfLocal[first]);
  const toB = subtract(positionOf(mesh, description.vertexOfLocal[second]), pointA);
  const toC = subtract(positionOf(mesh, description.vertexOfLocal[third]), pointA);
  return length(cross(toB, toC)) / 2;
}

/**
 * Flatten one island: conformal map (or a planar projection when it is not a disk), facing up, scaled so its UV area
 * equals its surface area, rotated to its smallest box. Reports flipped triangles and area distortion.
 */
function flattenIsland(mesh, island, context) {
  const { corners, nextCorner, seam, faceNormal, faceArea, triangleCorners, trianglesOfFace } = context;
  const description = describeIsland(mesh, island, corners, nextCorner, seam);
  const triangles = [];
  const normalSum = [0, 0, 0];
  let area = 0;
  for (const face of island.faces) {
    area += faceArea[face];
    for (let axis = 0; axis < 3; axis++) normalSum[axis] += faceNormal[face * 3 + axis] * faceArea[face];
    for (const triangle of trianglesOfFace.get(face) ?? []) {
      triangles.push([0, 1, 2].map(offset => description.cornerLocal.get(triangleCorners[triangle * 3 + offset])));
    }
  }
  let points = conformalMap(mesh, description, triangles, normalize(normalSum));
  let uvArea = 0;
  for (const [first, second, third] of triangles) uvArea += signedArea2d(points[first], points[second], points[third]);
  if (uvArea < 0) {
    points = points.map(([u, v]) => [-u, v]);
    uvArea = -uvArea;
  }
  const scaleToArea = uvArea > 0 ? Math.sqrt(area / uvArea) : 1;
  points = rotateToSmallestBox(points.map(([u, v]) => [u * scaleToArea, v * scaleToArea]));
  let flipped = 0;
  let distortion = 0;
  for (const triangle of triangles) {
    const area2d = signedArea2d(points[triangle[0]], points[triangle[1]], points[triangle[2]]);
    const area3d = triangleArea3d(mesh, description, triangle);
    if (area2d < 0) flipped++;
    if (area3d > 0) distortion += Math.abs(Math.abs(area2d) / area3d - 1) * area3d;
  }
  return {
    island, description, triangles, points, area, flipped,
    distortion: area > 0 ? distortion / area : 0,
    box: bounds2d(points),
  };
}

/** Shelf layout of island boxes for one row width: offsets per island and the overall extent. */
function shelfLayout(placed, rowWidth, gap) {
  const offsets = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let layoutWidth = 0;
  for (const item of placed) {
    if (cursorX > 0 && cursorX + item.box.width > rowWidth) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    offsets.push([cursorX - item.box.minimumX, cursorY - item.box.minimumY]);
    cursorX += item.box.width + gap;
    rowHeight = Math.max(rowHeight, item.box.height);
    layoutWidth = Math.max(layoutWidth, cursorX - gap);
  }
  return { offsets, extent: Math.max(layoutWidth, cursorY + rowHeight, 1e-12) };
}

/**
 * Pack islands into the unit square: each lies landscape, tallest first, in shelves; several row widths are tried and
 * the most compact kept (rotate false keeps each island upright). Sets item.offset and returns the scale from island units to UV.
 */
export function packIslands(placed, margin, rotate = true) {
  for (const item of placed) {
    if (rotate && item.box.height > item.box.width) {
      item.points = item.points.map(([u, v]) => [v, -u]);
      item.box = bounds2d(item.points);
    }
  }
  placed.sort((left, right) => right.box.height - left.box.height || right.box.width - left.box.width);
  const totalBoxArea = placed.reduce((sum, item) => sum + Math.max(item.box.width, 1e-9) * Math.max(item.box.height, 1e-9), 0);
  const gap = margin * Math.sqrt(totalBoxArea) * 1.2;
  const widest = Math.max(...placed.map(item => item.box.width));
  let best = null;
  for (let factor = 0.6; factor <= 3; factor += 0.1) {
    const layout = shelfLayout(placed, Math.max(widest, Math.sqrt(totalBoxArea) * factor), gap);
    if (!best || layout.extent < best.extent) best = layout;
  }
  placed.forEach((item, index) => {
    item.offset = best.offsets[index];
  });
  return (1 - 2 * margin) / best.extent;
}

/** Mark edges between faces that face different principal axes, inside the given islands. Returns edges added. */
function splitIntoAxisCharts(mesh, islands, seam, table, faceNormal) {
  const axisOfFace = face => {
    let best = 0;
    for (let axis = 1; axis < 3; axis++) {
      if (Math.abs(faceNormal[face * 3 + axis]) > Math.abs(faceNormal[face * 3 + best])) best = axis;
    }
    return best * 2 + (faceNormal[face * 3 + best] < 0 ? 1 : 0);
  };
  const facesOfCorners = cornerFaces(mesh);
  const chosen = new Uint8Array(mesh.faceCount);
  for (const island of islands) for (const face of island.faces) chosen[face] = 1;
  let added = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (seam[edge] || table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
    const first = facesOfCorners[table.edgeCorners[table.edgeOffsets[edge]]];
    const second = facesOfCorners[table.edgeCorners[table.edgeOffsets[edge] + 1]];
    if (!chosen[first] || !chosen[second] || axisOfFace(first) === axisOfFace(second)) continue;
    seam[edge] = 1;
    added++;
  }
  return added;
}

/**
 * Unwrap the mesh into corner attribute `uv` (and edge attribute `seam`).
 * seams: an edge rule (see selectEdges), default { angle: 60 }. Islands that still are not disks, fold over, or stretch
 * more than maxDistortion are split into charts by the axis their faces face and flattened again.
 * margin: gap between islands and around the square, as a fraction of it. Returns the new mesh and a report:
 * islands, seamEdges (from the rule), cutEdges (added to make disks), chartEdges (added by the split), flatIslands
 * (projected, not disks), flipped triangles, areaDistortion (area-weighted mean of |uv area / mesh area - 1| after one
 * global scale), and utilization (share of the square islands cover).
 */
export function unwrapUv(mesh, { seams = { angle: 60 }, margin = 0.01, maxDistortion = 0.25 } = {}) {
  const table = edgeCornerTable(mesh);
  const { nextCorner } = cornerCycles(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const seam = selectEdges(mesh, seams, edgeFaces(mesh));
  let seamEdges = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) seamEdges += seam[edge];
  const { normals: faceNormal, areas: faceArea } = faceNormals(mesh);
  // A closed island (a sphere, a rounded box with no sharp edges) flattens badly from a single slit, so it goes
  // straight to axis charts instead of being solved twice.
  const initial = groupsAndIslands(mesh, seam, table, nextCorner, facesOfCorners);
  const closedIslands = initial.islands.filter(island => !describeIsland(mesh, island, initial.corners, nextCorner, seam).loops.length);
  let chartEdges = closedIslands.length ? splitIntoAxisCharts(mesh, closedIslands, seam, table, faceNormal) : 0;
  let cutEdges = cutToDisks(mesh, seam, table, nextCorner, facesOfCorners);
  const { triangleCorners, triangleFaces } = triangulateMesh(mesh, faceNormal);
  const trianglesOfFace = new Map();
  for (let triangle = 0; triangle < triangleFaces.length; triangle++) {
    const face = triangleFaces[triangle];
    if (!trianglesOfFace.has(face)) trianglesOfFace.set(face, []);
    trianglesOfFace.get(face).push(triangle);
  }
  const flattenAll = () => {
    const { corners, islands } = groupsAndIslands(mesh, seam, table, nextCorner, facesOfCorners);
    const context = { corners, nextCorner, seam, faceNormal, faceArea, triangleCorners, trianglesOfFace };
    return islands.map(island => flattenIsland(mesh, island, context));
  };
  let placed = flattenAll();
  const poor = placed.filter(item => !item.description.isDisk || item.flipped > 0 || item.distortion > maxDistortion);
  if (poor.length) {
    const splitEdges = splitIntoAxisCharts(mesh, poor.map(item => item.island), seam, table, faceNormal);
    chartEdges += splitEdges;
    if (splitEdges) {
      cutEdges += cutToDisks(mesh, seam, table, nextCorner, facesOfCorners);
      placed = flattenAll();
    }
  }
  const islands = placed.map(item => item.island);
  const flatIslands = placed.filter(item => !item.description.isDisk).length;
  const scale = packIslands(placed, margin);
  const uv = new Float32Array(mesh.cornerCount * 2);
  let flipped = 0;
  let uvAreaTotal = 0;
  let meshAreaTotal = 0;
  const triangleRatios = [];
  for (const item of placed) {
    const final = item.points.map(([u, v]) => [margin + (u + item.offset[0]) * scale, margin + (v + item.offset[1]) * scale]);
    for (const face of item.island.faces) {
      for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
        const [u, v] = final[item.description.cornerLocal.get(corner)];
        uv[corner * 2] = u;
        uv[corner * 2 + 1] = v;
      }
    }
    for (const [first, second, third] of item.triangles) {
      const area2d = signedArea2d(final[first], final[second], final[third]);
      const pointA = positionOf(mesh, item.description.vertexOfLocal[first]);
      const area3d = length(cross(subtract(positionOf(mesh, item.description.vertexOfLocal[second]), pointA), subtract(positionOf(mesh, item.description.vertexOfLocal[third]), pointA))) / 2;
      if (area2d < 0) flipped++;
      uvAreaTotal += Math.abs(area2d);
      meshAreaTotal += area3d;
      triangleRatios.push([Math.abs(area2d), area3d]);
    }
  }
  const globalRatio = meshAreaTotal > 0 ? uvAreaTotal / meshAreaTotal : 1;
  let distortion = 0;
  for (const [area2d, area3d] of triangleRatios) {
    if (area3d > 0) distortion += Math.abs(area2d / (area3d * globalRatio) - 1) * area3d;
  }
  const attributes = {};
  for (const domain of DOMAINS) attributes[domain] = { ...mesh.attributes[domain] };
  attributes.corner.uv = { data: uv, size: 2 };
  const seamData = new Uint8Array(seam);
  attributes.edge.seam = { data: seamData, size: 1 };
  const result = createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
  return {
    mesh: result,
    islands: islands.length,
    seamEdges,
    cutEdges,
    chartEdges,
    flatIslands,
    flipped,
    areaDistortion: meshAreaTotal > 0 ? distortion / meshAreaTotal : 0,
    utilization: uvAreaTotal,
  };
}
