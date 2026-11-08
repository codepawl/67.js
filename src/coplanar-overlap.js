import { depthLayerOf, MAXIMUM_DEPTH_LAYER, setFlushDepthLayers } from './depth-layer.js';

// The renderer runs resolveFlushParts once on the parts it is built with; the diagnostics and resolveCoplanar use the same search.
// Finds pairs of parts that draw the same plane in the same place, which z-fight: a sign flush with a wall, a road marking
// on asphalt, two boxes whose visible faces coincide. The work is bounded: a grid over part bounds, then triangles only
// inside the shared box of a pair, with a fixed budget for the whole scene (`truncated` says it ran out).
// Only faces that look the same way count, since a face against a floor looks away from it and is culled. A part with a
// double-sided material shows both sides, so there an opposite-facing pair counts too.

/** Planes closer than this (metres) and facing the same way are treated as one plane. */
export const COPLANAR_TOLERANCE = 0.001;
/** Overlaps smaller than this (square metres) are edge contact, not a fight. */
export const COPLANAR_MINIMUM_AREA = 1e-4;
/** The distance suggested in the fix text, in metres. */
export const SUGGESTED_OFFSET = 0.002;
const DEFAULT_WORK_BUDGET = 1_000_000;
const PRIORITY_BINS = 12;
const MAXIMUM_LISTED_PAIRS = 3_000_000;
const SAME_FACING = Math.cos(Math.PI / 180);
const REPORTED_PAIRS = 8;

const localBoundsByGeometry = new WeakMap();

function localBounds(geometry) {
  let bounds = localBoundsByGeometry.get(geometry);
  if (bounds) return bounds;
  bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const { positions } = geometry;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], positions[offset + axis]);
      bounds[3 + axis] = Math.max(bounds[3 + axis], positions[offset + axis]);
    }
  }
  localBoundsByGeometry.set(geometry, bounds);
  return bounds;
}

function worldBounds(part) {
  const local = localBounds(part.geometry);
  const matrix = part.matrix;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? local[3] : local[0];
    const y = corner & 2 ? local[4] : local[1];
    const z = corner & 4 ? local[5] : local[2];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      bounds[axis] = Math.min(bounds[axis], value);
      bounds[3 + axis] = Math.max(bounds[3 + axis], value);
    }
  }
  return bounds;
}

function determinantSign(matrix) {
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant < 0 ? -1 : 1;
}

// A plane is hashed by its normal (sign folded, 0.01 steps) and its offset (buckets of twice the tolerance), so two
// triangles on one plane meet in a bucket without testing every pair of triangles.
const NORMAL_STEPS = 100;
const OFFSET_BUCKET_RANGE = 2 ** 27;

function planeKey(normal, corners, tolerance) {
  const sign = normal[[0, 1, 2].reduce((best, axis) => (Math.abs(normal[axis]) > Math.abs(normal[best]) ? axis : best), 0)] < 0 ? -1 : 1;
  const [x, y, z] = normal.map(component => Math.round(component * sign * NORMAL_STEPS) + NORMAL_STEPS);
  const offset = (corners[0] * normal[0] + corners[1] * normal[1] + corners[2] * normal[2]) * sign;
  const position = offset / (2 * tolerance);
  const bucket = Math.floor(position);
  const normalKey = (x * (2 * NORMAL_STEPS + 1) + y) * (2 * NORMAL_STEPS + 1) + z;
  const nearer = position - bucket < 0.5 ? bucket - 1 : bucket + 1;
  const toKey = value => normalKey * OFFSET_BUCKET_RANGE + value + OFFSET_BUCKET_RANGE / 2;
  return { own: toKey(bucket), nearer: toKey(nearer) };
}

// Every non-degenerate world-space triangle of a part, each as corners (9 numbers), a unit normal (3) and its plane keys.
function worldTriangles(part, tolerance) {
  const { positions, indices } = part.geometry;
  const matrix = part.matrix;
  const flip = determinantSign(matrix);
  const triangles = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const corners = new Float64Array(9);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle * 3 + corner] * 3;
      for (let axis = 0; axis < 3; axis++) {
        corners[corner * 3 + axis] = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      }
    }
    const edgeOne = [corners[3] - corners[0], corners[4] - corners[1], corners[5] - corners[2]];
    const edgeTwo = [corners[6] - corners[0], corners[7] - corners[1], corners[8] - corners[2]];
    const normal = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    const length = Math.hypot(...normal);
    if (!(length > 1e-12)) continue;
    const unitNormal = normal.map(component => component * flip / length);
    triangles.push({ corners, normal: unitNormal, planes: planeKey(unitNormal, corners, tolerance) });
  }
  return triangles;
}

// The part's triangles that touch `region`; the world-space triangles are built once per part and kept on its entry.
function trianglesInRegion(entry, region, tolerance, budget) {
  entry.triangles ??= worldTriangles(entry.part, tolerance);
  budget.work += entry.triangles.length / 32;
  return entry.triangles.filter(({ corners }) => {
    for (let axis = 0; axis < 3; axis++) {
      const low = Math.min(corners[axis], corners[3 + axis], corners[6 + axis]);
      const high = Math.max(corners[axis], corners[3 + axis], corners[6 + axis]);
      if (high < region[axis] - tolerance || low > region[3 + axis] + tolerance) return false;
    }
    return true;
  });
}

function planeDistance(first, second, corner) {
  const normal = first.normal;
  return (second.corners[corner * 3] - first.corners[0]) * normal[0]
    + (second.corners[corner * 3 + 1] - first.corners[1]) * normal[1]
    + (second.corners[corner * 3 + 2] - first.corners[2]) * normal[2];
}

// Projects a triangle to the plane's two largest axes, clips it against the other (Sutherland-Hodgman) and returns the
// shared area in square metres.
function sharedArea(first, second) {
  const normal = first.normal.map(Math.abs);
  const dropped = normal.indexOf(Math.max(...normal));
  const axes = [0, 1, 2].filter(axis => axis !== dropped);
  const project = (triangle, corner) => [triangle.corners[corner * 3 + axes[0]], triangle.corners[corner * 3 + axes[1]]];
  let polygon = [0, 1, 2].map(corner => project(second, corner));
  const clipper = [0, 1, 2].map(corner => project(first, corner));
  const clipperTurn = signedArea(clipper) >= 0 ? 1 : -1;
  for (let edge = 0; edge < 3 && polygon.length > 0; edge++) {
    const start = clipper[edge];
    const end = clipper[(edge + 1) % 3];
    const side = point => clipperTurn * ((end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]));
    const next = [];
    for (let index = 0; index < polygon.length; index++) {
      const current = polygon[index];
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      const currentSide = side(current);
      const previousSide = side(previous);
      if ((currentSide >= 0) !== (previousSide >= 0)) {
        const along = previousSide / (previousSide - currentSide);
        next.push([previous[0] + (current[0] - previous[0]) * along, previous[1] + (current[1] - previous[1]) * along]);
      }
      if (currentSide >= 0) next.push(current);
    }
    polygon = next;
  }
  return polygon.length < 3 ? 0 : Math.abs(signedArea(polygon)) / Math.max(normal[dropped], 1e-12);
}

function signedArea(polygon) {
  let total = 0;
  for (let index = 0; index < polygon.length; index++) {
    const next = polygon[(index + 1) % polygon.length];
    total += polygon[index][0] * next[1] - next[0] * polygon[index][1];
  }
  return total / 2;
}

function boundsOverlapRegion(first, second, tolerance) {
  const region = [0, 0, 0, 0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    region[axis] = Math.max(first[axis], second[axis]);
    region[3 + axis] = Math.min(first[3 + axis], second[3 + axis]);
    if (region[axis] > region[3 + axis] + tolerance) return null;
  }
  return region;
}

function diagonal(bounds) {
  return Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
}

function resolvedByLayer(first, second) {
  return depthLayerOf(first) !== depthLayerOf(second);
}

// Whether the boxes of two triangles touch, a cheap test before the plane and area checks.
function trianglesMeet(first, second, tolerance) {
  for (let axis = 0; axis < 3; axis++) {
    const firstLow = Math.min(first.corners[axis], first.corners[3 + axis], first.corners[6 + axis]);
    const firstHigh = Math.max(first.corners[axis], first.corners[3 + axis], first.corners[6 + axis]);
    const secondLow = Math.min(second.corners[axis], second.corners[3 + axis], second.corners[6 + axis]);
    const secondHigh = Math.max(second.corners[axis], second.corners[3 + axis], second.corners[6 + axis]);
    if (firstHigh < secondLow - tolerance || secondHigh < firstLow - tolerance) return false;
  }
  return true;
}

function pairOverlap(first, second, region, tolerance, budget) {
  const bothSides = first.part.material?.doubleSided === true || second.part.material?.doubleSided === true;
  const firstTriangles = trianglesInRegion(first, region, tolerance, budget);
  const secondTriangles = trianglesInRegion(second, region, tolerance, budget);
  const secondByPlane = new Map();
  for (const secondTriangle of secondTriangles) {
    const members = secondByPlane.get(secondTriangle.planes.own);
    if (members) members.push(secondTriangle);
    else secondByPlane.set(secondTriangle.planes.own, [secondTriangle]);
  }
  let area = 0;
  let distance = 0;
  let normal = null;
  let largestPiece = 0;
  for (const firstTriangle of firstTriangles) {
    if (budget.work > budget.limit) break;
    const sameOffset = secondByPlane.get(firstTriangle.planes.own) ?? [];
    const nearerOffset = secondByPlane.get(firstTriangle.planes.nearer) ?? [];
    for (const secondTriangle of [...sameOffset, ...nearerOffset]) {
      budget.work += 1 / 64;
      if (!trianglesMeet(firstTriangle, secondTriangle, tolerance)) continue;
      budget.work++;
      const facing = firstTriangle.normal[0] * secondTriangle.normal[0] + firstTriangle.normal[1] * secondTriangle.normal[1] + firstTriangle.normal[2] * secondTriangle.normal[2];
      const visibleTogether = facing >= SAME_FACING || (bothSides && facing <= -SAME_FACING);
      if (!visibleTogether) continue;
      let largest = 0;
      for (let corner = 0; corner < 3; corner++) largest = Math.max(largest, Math.abs(planeDistance(firstTriangle, secondTriangle, corner)));
      if (largest > tolerance) continue;
      const shared = sharedArea(firstTriangle, secondTriangle);
      if (shared <= 0) continue;
      area += shared;
      distance = Math.max(distance, largest);
      if (shared > largestPiece) {
        largestPiece = shared;
        normal = firstTriangle.normal;
      }
    }
  }
  return area >= COPLANAR_MINIMUM_AREA ? { area, distance, normal } : null;
}

// Broad phase: a uniform grid sized to the typical part. A pair is tested once, in the lowest cell both parts cover. Parts
// spanning more than LARGE_CELLS cells (floors, long walls) are tested against everything instead of entering the grid.
const LARGE_CELLS = 8;
const CELL_LIMIT = 65535;

function cellCoordinate(value, cellSize) {
  return Math.max(-CELL_LIMIT, Math.min(CELL_LIMIT, Math.floor(value / cellSize)));
}

function cellKey(x, y, z) {
  return ((x + CELL_LIMIT) * 131072 + (y + CELL_LIMIT)) * 131072 + (z + CELL_LIMIT);
}

function forEachCandidatePair(entries, tolerance, budget, test) {
  const meanExtents = entries.map(entry => ((entry.bounds[3] - entry.bounds[0]) + (entry.bounds[4] - entry.bounds[1]) + (entry.bounds[5] - entry.bounds[2])) / 3).sort((first, second) => first - second);
  const cellSize = Math.max(meanExtents[Math.floor(meanExtents.length / 2)], 0.01);
  const grid = new Map();
  const large = [];
  for (const entry of entries) {
    const low = [0, 1, 2].map(axis => cellCoordinate(entry.bounds[axis] - tolerance, cellSize));
    const high = [0, 1, 2].map(axis => cellCoordinate(entry.bounds[3 + axis] + tolerance, cellSize));
    entry.lowCell = low;
    if (high.some((value, axis) => value - low[axis] >= LARGE_CELLS)) {
      large.push(entry);
      continue;
    }
    for (let x = low[0]; x <= high[0]; x++) {
      for (let y = low[1]; y <= high[1]; y++) {
        for (let z = low[2]; z <= high[2]; z++) {
          const key = cellKey(x, y, z);
          const members = grid.get(key);
          if (members) members.push(entry);
          else grid.set(key, [entry]);
        }
      }
    }
  }
  for (const [key, members] of grid) {
    const z = key % 131072 - CELL_LIMIT;
    const y = Math.floor(key / 131072) % 131072 - CELL_LIMIT;
    const x = Math.floor(key / 17179869184) - CELL_LIMIT;
    for (let first = 0; first < members.length; first++) {
      for (let second = first + 1; second < members.length; second++) {
        const a = members[first].lowCell;
        const b = members[second].lowCell;
        if (Math.max(a[0], b[0]) !== x || Math.max(a[1], b[1]) !== y || Math.max(a[2], b[2]) !== z) continue;
        if (budget.work > budget.limit) return;
        test(members[first], members[second]);
      }
    }
  }
  const largeSet = new Set(large);
  for (let index = 0; index < large.length; index++) {
    for (const other of entries) {
      if (other === large[index] || (largeSet.has(other) && large.indexOf(other) < index)) continue;
      if (budget.work > budget.limit) return;
      test(large[index], other);
    }
  }
}

/**
 * Pairs of parts that draw the same plane in the same place. A part is `{ name, geometry: { positions, indices }, matrix,
 * material?, decal?, depthLayer?, skin?, morph? }`; skinned and morphed parts are skipped. Returns
 * `{ overlaps, truncated, work }` with each overlap as `{ smaller, larger, area, distance, normal }` (areas in square
 * metres, the larger part by bounds diagonal). `work` counts bounds and triangle tests, capped by `workBudget`.
 */
export function findCoplanarOverlaps(parts, { tolerance = COPLANAR_TOLERANCE, workBudget = DEFAULT_WORK_BUDGET } = {}) {
  const entries = [];
  for (const part of parts) {
    if (part.skin || part.morph || !part.geometry?.indices?.length) continue;
    entries.push({ part, bounds: worldBounds(part) });
  }
  const budget = { work: 0, limit: workBudget };
  const overlaps = [];
  if (entries.length < 2) return { overlaps, truncated: false, work: 0 };
  // The sweep first lists every pair whose boxes meet (cheap), binned by how much flat contact the shared box offers, so the
  // work budget goes to the pairs that can show a large flush face before it goes to edge contacts and thin slivers.
  const bins = Array.from({ length: PRIORITY_BINS }, () => []);
  let listed = 0;
  const collect = (first, second) => {
    const region = boundsOverlapRegion(first.bounds, second.bounds, tolerance);
    if (!region || resolvedByLayer(first.part, second.part) || listed >= MAXIMUM_LISTED_PAIRS) return;
    const extents = [region[3] - region[0], region[4] - region[1], region[5] - region[2]].sort((smallest, largest) => smallest - largest);
    const faceArea = extents[1] * extents[2];
    const flatBonus = extents[0] <= tolerance ? PRIORITY_BINS / 2 : 0;
    const sizeRank = Math.max(0, Math.min(PRIORITY_BINS / 2 - 1, Math.floor(Math.log10(Math.max(faceArea, 1e-6)) + 6)));
    bins[PRIORITY_BINS - 1 - (flatBonus + sizeRank)].push(first, second, region);
    listed++;
  };
  forEachCandidatePair(entries, tolerance, { work: 0, limit: Infinity }, collect);
  for (const bin of bins) {
    for (let index = 0; index < bin.length && budget.work <= budget.limit; index += 3) {
      const first = bin[index];
      const second = bin[index + 1];
      const found = pairOverlap(first, second, bin[index + 2], tolerance, budget);
      if (!found) continue;
      const firstIsLarger = diagonal(first.bounds) >= diagonal(second.bounds);
      overlaps.push({ smaller: (firstIsLarger ? second : first).part, larger: (firstIsLarger ? first : second).part, ...found });
    }
  }
  const truncated = budget.work > workBudget;
  overlaps.sort((first, second) => second.area - first.area || String(first.smaller.name).localeCompare(String(second.smaller.name)));
  return { overlaps, truncated, work: budget.work };
}

function metres(value) {
  return `${Math.round(value * 1000) / 1000}`;
}

/** Warnings in the shape of `agent-diagnostics.js`, the biggest overlaps first, plus one line for the rest. */
export function coplanarOverlapDiagnostics({ overlaps, truncated }) {
  const problems = overlaps.slice(0, REPORTED_PAIRS).map(({ smaller, larger, area, distance, normal }) => ({
    kind: 'coplanar-overlap',
    severity: 'warning',
    target: smaller.name,
    parts: [smaller.name, larger.name],
    area: Math.round(area * 10000) / 10000,
    message: `${smaller.name} and ${larger.name} draw the same plane (${metres(distance * 1000)} mm apart, ${metres(area)} m2 overlap) and will flicker (z-fighting).`,
    fix: `Move ${smaller.name} ${metres(SUGGESTED_OFFSET * 1000)} mm along its normal [${normal.map(component => Math.round(component * 1000) / 1000).join(', ')}], or set decal: true on ${smaller.name}, or set environment.resolveCoplanar to 'offset' to bias it at draw time without moving it.`,
  }));
  if (overlaps.length > REPORTED_PAIRS || (truncated && overlaps.length)) {
    problems.push({
      kind: 'coplanar-overlap',
      severity: 'warning',
      target: 'scene',
      message: truncated ? `${overlaps.length} coplanar pairs found before the check hit its work budget; more may exist.` : `${overlaps.length - REPORTED_PAIRS} more coplanar pairs.`,
      fix: "Set environment.resolveCoplanar to 'offset' to bias every smaller part at draw time.",
    });
  }
  return problems;
}

/**
 * The layer each smaller part of a pair should draw on, as a Map from part to layer. A part that is the smaller one against
 * a part already on layer n gets n + 1, up to MAXIMUM_DEPTH_LAYER. Parts that set their own layer are left alone.
 */
export function coplanarLayers(overlaps) {
  const layers = new Map();
  const ordered = [...overlaps].sort((first, second) => diagonalOfPart(second.larger) - diagonalOfPart(first.larger));
  for (const { smaller, larger } of ordered) {
    if (smaller.decal !== undefined || smaller.depthLayer !== undefined) continue;
    const base = layers.get(larger) ?? depthLayerOf(larger);
    layers.set(smaller, Math.min(MAXIMUM_DEPTH_LAYER, Math.max(layers.get(smaller) ?? 0, base + 1)));
  }
  return layers;
}

function diagonalOfPart(part) {
  return diagonal(worldBounds(part));
}

/**
 * Adds the coplanar-overlap warning to `renderer.diagnostics`. The check is bounded (see findCoplanarOverlaps) and runs once
 * per layout, when the renderer's batches change, not per frame, so parts that move later are not rechecked.
 */
export function installCoplanarDiagnostics(renderer, onOverlaps = null) {
  let checkedBatches = null;
  let problems = null;
  renderer.coplanarDiagnostics = batches => {
    if (batches !== checkedBatches) {
      checkedBatches = batches;
      const found = findCoplanarOverlaps(batches.flatMap(batch => batch.parts));
      problems = coplanarOverlapDiagnostics(found);
      onOverlaps?.(found.overlaps);
    }
    return problems;
  };
  return renderer;
}

/**
 * Puts the smaller part of each coplanar pair on the next depth layer (a polygon offset at draw time, geometry never moves),
 * for the parts of one scene. The renderer calls it once when it is built; a part that sets `decal` or `depthLayer` keeps its own.
 */
export function resolveFlushParts(parts) {
  const layers = coplanarLayers(findCoplanarOverlaps(parts).overlaps);
  setFlushDepthLayers(layers);
  return layers.size;
}

/** `parts` with `depthLayer` set on the smaller part of each coplanar pair; other parts are returned as they are. */
export function resolveCoplanarParts(parts) {
  const layers = coplanarLayers(findCoplanarOverlaps(parts).overlaps);
  if (layers.size === 0) return parts;
  return parts.map(part => (layers.has(part) ? Object.freeze({ ...part, depthLayer: layers.get(part) }) : part));
}
