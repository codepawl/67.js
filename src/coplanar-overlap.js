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
// Triangles whose planes are read in the first pass; a scene past it is searched part by part, smallest first.
const DEFAULT_TRIANGLE_BUDGET = 600_000;
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

// A plane is hashed by its normal (sign folded, 0.01 steps) and its offset (buckets of twice the tolerance). Two triangles
// on one plane share a bucket or sit in neighbouring buckets (the offset is the lowest part of the key), so candidate pairs
// come from buckets, and the search scales with triangles instead of part pairs.
const NORMAL_STEPS = 100;
const NORMAL_RANGE = 2 * NORMAL_STEPS + 1;
const OFFSET_BUCKET_RANGE = 2 ** 27;

function planeKey(normalX, normalY, normalZ, pointX, pointY, pointZ, tolerance) {
  const absoluteX = Math.abs(normalX);
  const absoluteY = Math.abs(normalY);
  const absoluteZ = Math.abs(normalZ);
  let dominant = normalX;
  if (absoluteY > absoluteX && absoluteY >= absoluteZ) dominant = normalY;
  else if (absoluteZ > absoluteX && absoluteZ > absoluteY) dominant = normalZ;
  const sign = dominant < 0 ? -1 : 1;
  const x = Math.round(normalX * sign * NORMAL_STEPS) + NORMAL_STEPS;
  const y = Math.round(normalY * sign * NORMAL_STEPS) + NORMAL_STEPS;
  const z = Math.round(normalZ * sign * NORMAL_STEPS) + NORMAL_STEPS;
  const offset = (pointX * normalX + pointY * normalY + pointZ * normalZ) * sign;
  const bucket = Math.floor(offset / (2 * tolerance));
  return ((x * NORMAL_RANGE + y) * NORMAL_RANGE + z) * OFFSET_BUCKET_RANGE + bucket + OFFSET_BUCKET_RANGE / 2;
}

const scratchCorners = new Float64Array(9);

// Calls visit(corners, normalX, normalY, normalZ) for every non-degenerate world-space triangle of a part. `corners` is a
// scratch array that the next call overwrites; the normal is unit length and follows the winding after the matrix.
function forEachWorldTriangle(part, visit) {
  const { positions, indices } = part.geometry;
  const matrix = part.matrix;
  const flip = determinantSign(matrix);
  const corners = scratchCorners;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle + corner] * 3;
      const x = positions[vertex];
      const y = positions[vertex + 1];
      const z = positions[vertex + 2];
      corners[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      corners[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      corners[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const edgeOneX = corners[3] - corners[0];
    const edgeOneY = corners[4] - corners[1];
    const edgeOneZ = corners[5] - corners[2];
    const edgeTwoX = corners[6] - corners[0];
    const edgeTwoY = corners[7] - corners[1];
    const edgeTwoZ = corners[8] - corners[2];
    const normalX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
    const normalY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
    const normalZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
    const length = Math.hypot(normalX, normalY, normalZ);
    if (!(length > 1e-12)) continue;
    const scale = flip / length;
    visit(corners, normalX * scale, normalY * scale, normalZ * scale);
  }
}

// The plane buckets a part has triangles in, for the triangles that touch `region` (the box where other parts' bounds meet
// this part's): the cheap pass that decides which parts can fight at all.
function planeKeysOf(part, tolerance, region) {
  const keys = new Set();
  forEachWorldTriangle(part, (corners, normalX, normalY, normalZ) => {
    for (let axis = 0; axis < 3; axis++) {
      const low = Math.min(corners[axis], corners[3 + axis], corners[6 + axis]);
      const high = Math.max(corners[axis], corners[3 + axis], corners[6 + axis]);
      if (high < region[axis] - tolerance || low > region[3 + axis] + tolerance) return;
    }
    keys.add(planeKey(normalX, normalY, normalZ, corners[0], corners[1], corners[2], tolerance));
  });
  return keys;
}

// The part's world-space triangles grouped by plane bucket, each as corners (9 numbers), a unit normal (3) and its box (6).
// A bucket keeps its triangles sorted by their lowest x and the widest triangle, so a small region of a big part is found by
// bisection instead of a scan. Built once per part, and only for parts that share a bucket with another part.
function worldTrianglesByPlane(part, tolerance) {
  const byPlane = new Map();
  forEachWorldTriangle(part, (corners, normalX, normalY, normalZ) => {
    const key = planeKey(normalX, normalY, normalZ, corners[0], corners[1], corners[2], tolerance);
    const box = [
      Math.min(corners[0], corners[3], corners[6]), Math.min(corners[1], corners[4], corners[7]), Math.min(corners[2], corners[5], corners[8]),
      Math.max(corners[0], corners[3], corners[6]), Math.max(corners[1], corners[4], corners[7]), Math.max(corners[2], corners[5], corners[8]),
    ];
    const triangle = { corners: Float64Array.from(corners), normal: [normalX, normalY, normalZ], box };
    const bucket = byPlane.get(key);
    if (bucket) bucket.triangles.push(triangle);
    else byPlane.set(key, { triangles: [triangle], widest: 0 });
  });
  for (const bucket of byPlane.values()) {
    bucket.triangles.sort((first, second) => first.box[0] - second.box[0]);
    for (const { box } of bucket.triangles) bucket.widest = Math.max(bucket.widest, box[3] - box[0]);
  }
  return byPlane;
}

function trianglesTouching(bucket, region, tolerance) {
  const { triangles, widest } = bucket;
  let low = 0;
  let high = triangles.length;
  const earliest = region[0] - tolerance - widest;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (triangles[middle].box[0] < earliest) low = middle + 1;
    else high = middle;
  }
  const touching = [];
  for (let index = low; index < triangles.length; index++) {
    const { box } = triangles[index];
    if (box[0] > region[3] + tolerance) break;
    if (box[3] < region[0] - tolerance) continue;
    if (box[4] < region[1] - tolerance || box[1] > region[4] + tolerance) continue;
    if (box[5] < region[2] - tolerance || box[2] > region[5] + tolerance) continue;
    touching.push(triangles[index]);
  }
  return touching;
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
  first.planes ??= worldTrianglesByPlane(first.part, tolerance);
  second.planes ??= worldTrianglesByPlane(second.part, tolerance);
  let area = 0;
  let distance = 0;
  let normal = null;
  let largestPiece = 0;
  // Only triangles in the same or a neighbouring plane bucket can be flush, so a big part is never scanned whole.
  for (const [key, firstBucket] of first.planes) {
    for (const neighbour of [key - 1, key, key + 1]) {
      const secondBucket = second.planes.get(neighbour);
      if (!secondBucket) continue;
      budget.work += Math.log2(firstBucket.triangles.length + secondBucket.triangles.length + 2) / 4;
      const firstTriangles = trianglesTouching(firstBucket, region, tolerance);
      const secondTriangles = trianglesTouching(secondBucket, region, tolerance);
      for (const firstTriangle of firstTriangles) {
        if (budget.work > budget.limit) break;
        for (const secondTriangle of secondTriangles) {
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
    }
  }
  return area >= COPLANAR_MINIMUM_AREA ? { area, distance, normal } : null;
}

// Gives each part the box where other parts' bounds touch it (`region`), or none when nothing touches it: a part alone in
// space can z-fight with nothing, and its triangles are never read.
function markContactRegions(entries, tolerance) {
  const sorted = [...entries].sort((first, second) => first.bounds[0] - second.bounds[0]);
  for (let first = 0; first < sorted.length; first++) {
    const a = sorted[first];
    for (let second = first + 1; second < sorted.length; second++) {
      const b = sorted[second];
      if (b.bounds[0] > a.bounds[3] + tolerance) break;
      const overlap = boundsOverlapRegion(a.bounds, b.bounds, tolerance);
      if (!overlap) continue;
      for (const entry of [a, b]) {
        if (!entry.region) entry.region = overlap.slice();
        for (let axis = 0; axis < 3; axis++) {
          entry.region[axis] = Math.min(entry.region[axis], overlap[axis]);
          entry.region[3 + axis] = Math.max(entry.region[3 + axis], overlap[3 + axis]);
        }
      }
    }
  }
}

// Broad phase: parts are bucketed by the planes their triangles lie on, and only parts that share a bucket (or sit in
// neighbouring offset buckets) and whose bounds meet become a pair. Inside a bucket the parts are swept along x, so a wall
// and a thousand small parts on other planes cost nothing, and a pair is reported once however many planes it shares.
function forEachCandidatePair(entries, tolerance, scanBudget, test) {
  const buckets = new Map();
  markContactRegions(entries, tolerance);
  entries.forEach((entry, index) => { entry.index = index; });
  // Small parts are read first, so the scan budget (triangles) goes to many flat parts before it goes to one huge mesh.
  const scanOrder = entries.filter(entry => entry.region).sort((first, second) => first.part.geometry.indices.length - second.part.geometry.indices.length);
  for (const entry of scanOrder) {
    if (scanBudget.triangles <= 0) {
      scanBudget.exhausted = true;
      break;
    }
    scanBudget.triangles -= entry.part.geometry.indices.length / 3;
    for (const key of planeKeysOf(entry.part, tolerance, entry.region)) {
      const members = buckets.get(key);
      if (members) members.push(entry);
      else buckets.set(key, [entry]);
    }
  }
  const seen = new Set();
  for (const [key, own] of buckets) {
    const next = buckets.get(key + 1) ?? [];
    if (own.length + next.length < 2) continue;
    const members = [...own.map(entry => ({ entry, own: true })), ...next.map(entry => ({ entry, own: false }))];
    members.sort((first, second) => first.entry.bounds[0] - second.entry.bounds[0]);
    for (let first = 0; first < members.length; first++) {
      const a = members[first];
      for (let second = first + 1; second < members.length; second++) {
        const b = members[second];
        if (b.entry.bounds[0] > a.entry.bounds[3] + tolerance) break;
        if ((!a.own && !b.own) || a.entry === b.entry) continue;
        if (b.entry.bounds[1] > a.entry.bounds[4] + tolerance || a.entry.bounds[1] > b.entry.bounds[4] + tolerance) continue;
        if (b.entry.bounds[2] > a.entry.bounds[5] + tolerance || a.entry.bounds[2] > b.entry.bounds[5] + tolerance) continue;
        const low = Math.min(a.entry.index, b.entry.index);
        const high = Math.max(a.entry.index, b.entry.index);
        const pairKey = low * entries.length + high;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        test(a.entry, b.entry);
      }
    }
  }
}


/**
 * Pairs of parts that draw the same plane in the same place. A part is `{ name, geometry: { positions, indices }, matrix,
 * material?, decal?, depthLayer?, skin?, morph? }`; skinned and morphed parts are skipped. Returns
 * `{ overlaps, truncated, work }` with each overlap as `{ smaller, larger, area, distance, normal }` (areas in square
 * metres, the larger part by bounds diagonal). `work` counts bounds and triangle tests, capped by `workBudget`.
 */
export function findCoplanarOverlaps(parts, { tolerance = COPLANAR_TOLERANCE, workBudget = DEFAULT_WORK_BUDGET, triangleBudget = DEFAULT_TRIANGLE_BUDGET } = {}) {
  const entries = [];
  const stacks = new Map();
  for (const part of parts) {
    if (part.skin || part.morph || !part.geometry?.indices?.length) continue;
    // Parts with one geometry and one matrix are stacked copies (hundreds of dust motes parked at one spot). Two of them still
    // report as a pair, and the rest are left out, so a stack of n costs 2 parts and not n * n / 2 pairs.
    const stack = stacks.get(part.geometry) ?? new Map();
    stacks.set(part.geometry, stack);
    const pose = Array.prototype.join.call(part.matrix, ',');
    const copies = stack.get(pose) ?? 0;
    if (copies >= 2) continue;
    stack.set(pose, copies + 1);
    entries.push({ part, bounds: worldBounds(part) });
  }
  const budget = { work: 0, limit: workBudget };
  const scanBudget = { triangles: triangleBudget, exhausted: false };
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
  forEachCandidatePair(entries, tolerance, scanBudget, collect);
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
  const truncated = budget.work > workBudget || scanBudget.exhausted;
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
