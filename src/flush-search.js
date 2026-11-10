// Finds pairs of triangles that draw the same plane in the same place (issue #751): inside one part and across parts, exactly
// flush or a few millimetres to centimetres apart. Such pairs z-fight, since the rasteriser snaps two triangles on one plane to
// slightly different depths. flush-resolve.js turns the pairs into a draw rank per triangle.
//
// Triangles are hashed by their normal (sign folded, so opposite faces meet) and by a grid over their boxes. A triangle is
// native to the finest grid where it spans few cells and a guest in the coarser ones, so a wall of two triangles and the
// thousand small faces on it meet without the wall being listed in a thousand cells. Nothing is cut short silently: parts
// past the triangle budget come back in `unchecked`, and `truncated` says the pair budget ran out.

/** Shared area under this share of the smaller triangle is edge contact or rounding, not a fight. */
export const FLUSH_MINIMUM_AREA_SHARE = 1e-4;
const FLUSH_MINIMUM_AREA = 1e-8;
const DEFAULT_TRIANGLE_BUDGET = 2_000_000;
const DEFAULT_PAIR_BUDGET = 4_000_000;
const SAME_FACING = Math.cos(Math.PI / 180);
// Normals one degree apart differ by at most 0.0175 per component. Each triangle is listed in every normal cell within half
// of that, so two such triangles always share a cell.
const NORMAL_STEPS = 20;
const NORMAL_REACH = 0.0088;
const NORMAL_RANGE = 2 * NORMAL_STEPS + 3;
const NEAR_DOMINANT = 0.02;
const NATIVE_CELL_LIMIT = 64;
const GRID_LEVEL_SCALE = 16;
const GRID_LEVELS = 2;
const CELL_SAMPLES = 4096;
// Tags whose vertex shader moves vertices (renderer.js DEFORMING_TAGS): their triangles are not where the geometry says.
const DEFORMING_TAGS = new Set(['foliage', 'grass', 'water', 'fire', 'smoke']);

const localBoundsByGeometry = new WeakMap();

export function localBounds(geometry) {
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

export function worldBounds(part) {
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

export function determinantSign(matrix) {
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant < 0 ? -1 : 1;
}

export function boundsDiagonal(bounds) {
  return Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
}

/** The distance between neighbouring float32 values at this magnitude. */
export function float32Step(magnitude) {
  return 2 ** (Math.floor(Math.log2(Math.max(magnitude, 1e-30))) - 23);
}

/** Planes closer than this (metres) are one plane: 0.1 mm, or eight float32 steps of the largest coordinate when that is more. */
export function flushTolerance(largestCoordinate) {
  return Math.max(1e-4, 8 * float32Step(largestCoordinate));
}

/** Same-facing planes up to this far apart (metres) can still fight far from the camera; `diagonal` spans both parts. */
export function nearTolerance(diagonal) {
  return Math.min(0.25, Math.max(0.002, 1.5e-4 * diagonal));
}

/** Whether a part's drawn triangles leave its geometry (skin, morph, crowd, wind, liquid), so a search of the geometry says nothing. */
export function isDeformingPart(part) {
  const { geometry, material } = part;
  if (part.skin || part.morph || part.crowd || geometry.skinIndices || geometry.morphTargets) return true;
  return DEFORMING_TAGS.has(material?.tag) || material?.transmission > 0;
}

// Parts with one geometry and one matrix are stacked copies (hundreds of dust motes parked at one spot). They draw the same
// depth bit for bit, so two of them stand for the stack.
function searchableParts(parts) {
  const stacks = new Map();
  const searchable = [];
  for (const part of parts) {
    if (!part.geometry?.indices?.length || isDeformingPart(part)) continue;
    const stack = stacks.get(part.geometry) ?? new Map();
    stacks.set(part.geometry, stack);
    const pose = Array.prototype.join.call(part.matrix, ',');
    const copies = stack.get(pose) ?? 0;
    if (copies >= 2) continue;
    stack.set(pose, copies + 1);
    searchable.push(part);
  }
  return searchable;
}

// Past the budget the largest parts are searched, since a large flush face is the one people see; the rest is `unchecked`.
function withinTriangleBudget(parts, triangleBudget) {
  const entries = parts.map((part, order) => ({ part, order, bounds: worldBounds(part), triangles: part.geometry.indices.length / 3 }));
  const total = entries.reduce((sum, entry) => sum + entry.triangles, 0);
  if (total <= triangleBudget) return { entries, unchecked: [] };
  const bySize = [...entries].sort((first, second) => boundsDiagonal(second.bounds) - boundsDiagonal(first.bounds));
  const kept = [];
  const unchecked = [];
  let used = 0;
  for (const entry of bySize) {
    if (used + entry.triangles <= triangleBudget) {
      used += entry.triangles;
      kept.push(entry);
    } else {
      unchecked.push(entry.part);
    }
  }
  kept.sort((first, second) => first.order - second.order);
  return { entries: kept, unchecked };
}

// World-space corners (9 numbers), unit normal (3), box (6) and area of every non-degenerate triangle, part after part.
function readTriangles(entries) {
  const capacity = entries.reduce((sum, entry) => sum + entry.triangles, 0);
  const table = {
    count: 0,
    corners: new Float64Array(capacity * 9),
    normals: new Float64Array(capacity * 3),
    boxes: new Float64Array(capacity * 6),
    areas: new Float64Array(capacity),
    owner: new Uint32Array(capacity),
    local: new Uint32Array(capacity),
  };
  entries.forEach((entry, partIndex) => readPartTriangles(table, entry.part, partIndex));
  return table;
}

function readPartTriangles(table, part, partIndex) {
  const { positions, indices } = part.geometry;
  const matrix = part.matrix;
  const flip = determinantSign(matrix);
  const { corners, normals, boxes } = table;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const base = table.count * 9;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle + corner] * 3;
      const x = positions[vertex];
      const y = positions[vertex + 1];
      const z = positions[vertex + 2];
      corners[base + corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      corners[base + corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      corners[base + corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const edgeOneX = corners[base + 3] - corners[base];
    const edgeOneY = corners[base + 4] - corners[base + 1];
    const edgeOneZ = corners[base + 5] - corners[base + 2];
    const edgeTwoX = corners[base + 6] - corners[base];
    const edgeTwoY = corners[base + 7] - corners[base + 1];
    const edgeTwoZ = corners[base + 8] - corners[base + 2];
    const normalX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
    const normalY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
    const normalZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
    const length = Math.hypot(normalX, normalY, normalZ);
    if (!(length > 1e-12)) continue;
    const id = table.count;
    const scale = flip / length;
    normals[id * 3] = normalX * scale;
    normals[id * 3 + 1] = normalY * scale;
    normals[id * 3 + 2] = normalZ * scale;
    for (let axis = 0; axis < 3; axis++) {
      const low = Math.min(corners[base + axis], corners[base + 3 + axis], corners[base + 6 + axis]);
      const high = Math.max(corners[base + axis], corners[base + 3 + axis], corners[base + 6 + axis]);
      boxes[id * 6 + axis] = low;
      boxes[id * 6 + 3 + axis] = high;
    }
    table.areas[id] = length / 2;
    table.owner[id] = partIndex;
    table.local[id] = triangle / 3;
    table.count++;
  }
}

// Twice the median triangle extent: most triangles then touch a handful of cells.
function gridCellSize(table, reach) {
  const extents = [];
  const stride = Math.max(1, Math.floor(table.count / CELL_SAMPLES));
  for (let id = 0; id < table.count; id += stride) {
    const box = id * 6;
    extents.push(Math.max(table.boxes[box + 3] - table.boxes[box], table.boxes[box + 4] - table.boxes[box + 1], table.boxes[box + 5] - table.boxes[box + 2]));
  }
  extents.sort((first, second) => first - second);
  return Math.max(2 * extents[extents.length >> 1], 4 * reach, 1e-6);
}

// The normal cells a triangle is listed in. The sign is folded by the dominant component; when another component is nearly
// as large and has the other sign, both folds are listed, so two near-equal normals never fold apart.
function normalCellsOf(table, id, cells) {
  const x = table.normals[id * 3];
  const y = table.normals[id * 3 + 1];
  const z = table.normals[id * 3 + 2];
  const largest = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  let positive = false;
  let negative = false;
  for (const component of [x, y, z]) {
    if (Math.abs(component) < largest - NEAR_DOMINANT) continue;
    if (component < 0) negative = true;
    else positive = true;
  }
  cells.length = 0;
  for (const sign of [1, -1]) {
    if (sign > 0 ? !positive : !negative) continue;
    const lowX = Math.round((x * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highX = Math.round((x * sign + NORMAL_REACH) * NORMAL_STEPS);
    const lowY = Math.round((y * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highY = Math.round((y * sign + NORMAL_REACH) * NORMAL_STEPS);
    const lowZ = Math.round((z * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highZ = Math.round((z * sign + NORMAL_REACH) * NORMAL_STEPS);
    for (let cellX = lowX; cellX <= highX; cellX++) {
      for (let cellY = lowY; cellY <= highY; cellY++) {
        for (let cellZ = lowZ; cellZ <= highZ; cellZ++) {
          const cell = ((cellX + NORMAL_STEPS + 1) * NORMAL_RANGE + cellY + NORMAL_STEPS + 1) * NORMAL_RANGE + cellZ + NORMAL_STEPS + 1;
          if (!cells.includes(cell)) cells.push(cell);
        }
      }
    }
  }
  return cells;
}

const cellRange = new Int32Array(6);

// The grid cells a triangle's box touches at one level, grown by half the reach so two boxes within the reach share a cell.
// Returns how many cells that is.
function cellRangeOf(table, id, cellSize, reach) {
  let cells = 1;
  for (let axis = 0; axis < 3; axis++) {
    const low = Math.floor((table.boxes[id * 6 + axis] - reach / 2) / cellSize);
    const high = Math.floor((table.boxes[id * 6 + 3 + axis] + reach / 2) / cellSize);
    cellRange[axis] = low;
    cellRange[3 + axis] = high;
    cells *= high - low + 1;
  }
  return cells;
}

function cellKey(normalCell, level, cellX, cellY, cellZ) {
  const mixed = Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663) ^ Math.imul(cellZ, 83492791) ^ Math.imul(normalCell * GRID_LEVELS + level, 0x9e3779b1);
  return mixed >>> 0;
}

// Lists every triangle in the cells of its own level (`natives`), then as a guest in the coarser cells that hold a native.
// The last level is one cell per normal cell, for triangles too large for any grid.
function buildCells(table, cellSize, reach) {
  const levels = Array.from({ length: GRID_LEVELS + 1 }, () => new Map());
  const nativeLevel = new Uint8Array(table.count);
  const normalCells = [];
  const visitCells = (id, level, visit) => {
    normalCellsOf(table, id, normalCells);
    if (level === GRID_LEVELS) {
      for (const normalCell of normalCells) visit(normalCell);
      return;
    }
    cellRangeOf(table, id, cellSize * GRID_LEVEL_SCALE ** level, reach);
    const [lowX, lowY, lowZ, highX, highY, highZ] = cellRange;
    for (const normalCell of normalCells) {
      for (let cellX = lowX; cellX <= highX; cellX++) {
        for (let cellY = lowY; cellY <= highY; cellY++) {
          for (let cellZ = lowZ; cellZ <= highZ; cellZ++) visit(cellKey(normalCell, level, cellX, cellY, cellZ));
        }
      }
    }
  };
  for (let id = 0; id < table.count; id++) {
    let level = 0;
    while (level < GRID_LEVELS && cellRangeOf(table, id, cellSize * GRID_LEVEL_SCALE ** level, reach) > NATIVE_CELL_LIMIT) level++;
    nativeLevel[id] = level;
    const cells = levels[level];
    visitCells(id, level, key => {
      const cell = cells.get(key);
      if (cell) cell.natives.push(id);
      else cells.set(key, { natives: [id], guests: [] });
    });
  }
  for (let id = 0; id < table.count; id++) {
    for (let level = nativeLevel[id] + 1; level <= GRID_LEVELS; level++) {
      const cells = levels[level];
      if (cells.size === 0) continue;
      visitCells(id, level, key => cells.get(key)?.guests.push(id));
    }
  }
  return levels.flatMap(cells => [...cells.values()]);
}

const clipFirst = new Float64Array(32);
const clipSecond = new Float64Array(32);
const sharedCentre = new Float64Array(2);

// Clips triangle `second` against triangle `first` on the plane's two largest axes (Sutherland-Hodgman). Returns the shared
// area in square metres and leaves the centre of the shared piece in `sharedCentre`.
function sharedArea(table, first, second, dropped, axisU, axisV) {
  const { corners, normals } = table;
  let polygon = clipFirst;
  let next = clipSecond;
  let size = 3;
  for (let corner = 0; corner < 3; corner++) {
    polygon[corner * 2] = corners[second * 9 + corner * 3 + axisU];
    polygon[corner * 2 + 1] = corners[second * 9 + corner * 3 + axisV];
  }
  const base = first * 9;
  const turn = (corners[base + 3 + axisU] - corners[base + axisU]) * (corners[base + 6 + axisV] - corners[base + axisV])
    - (corners[base + 3 + axisV] - corners[base + axisV]) * (corners[base + 6 + axisU] - corners[base + axisU]) >= 0 ? 1 : -1;
  for (let edge = 0; edge < 3 && size > 0; edge++) {
    const startU = corners[base + edge * 3 + axisU];
    const startV = corners[base + edge * 3 + axisV];
    const edgeU = corners[base + ((edge + 1) % 3) * 3 + axisU] - startU;
    const edgeV = corners[base + ((edge + 1) % 3) * 3 + axisV] - startV;
    let nextSize = 0;
    let previousU = polygon[size * 2 - 2];
    let previousV = polygon[size * 2 - 1];
    let previousSide = turn * (edgeU * (previousV - startV) - edgeV * (previousU - startU));
    for (let index = 0; index < size; index++) {
      const currentU = polygon[index * 2];
      const currentV = polygon[index * 2 + 1];
      const currentSide = turn * (edgeU * (currentV - startV) - edgeV * (currentU - startU));
      if ((currentSide >= 0) !== (previousSide >= 0)) {
        const along = previousSide / (previousSide - currentSide);
        next[nextSize * 2] = previousU + (currentU - previousU) * along;
        next[nextSize * 2 + 1] = previousV + (currentV - previousV) * along;
        nextSize++;
      }
      if (currentSide >= 0) {
        next[nextSize * 2] = currentU;
        next[nextSize * 2 + 1] = currentV;
        nextSize++;
      }
      previousU = currentU;
      previousV = currentV;
      previousSide = currentSide;
    }
    const swap = polygon;
    polygon = next;
    next = swap;
    size = nextSize;
  }
  if (size < 3) return 0;
  let doubled = 0;
  let centreU = 0;
  let centreV = 0;
  for (let index = 0; index < size; index++) {
    const following = (index + 1) % size;
    doubled += polygon[index * 2] * polygon[following * 2 + 1] - polygon[following * 2] * polygon[index * 2 + 1];
    centreU += polygon[index * 2];
    centreV += polygon[index * 2 + 1];
  }
  sharedCentre[0] = centreU / size;
  sharedCentre[1] = centreV / size;
  return Math.abs(doubled) / 2 / Math.max(Math.abs(normals[first * 3 + dropped]), 1e-12);
}

// Where a triangle's plane sits along the dropped axis above the point (u, v).
function planeHeight(table, id, dropped, axisU, axisV, u, v) {
  const { corners, normals } = table;
  const slope = normals[id * 3 + axisU] * (u - corners[id * 9 + axisU]) + normals[id * 3 + axisV] * (v - corners[id * 9 + axisV]);
  return corners[id * 9 + dropped] - slope / normals[id * 3 + dropped];
}

function createPairTest(table, entries, reach, pairBudget, result) {
  const { corners, normals, boxes, areas, owner } = table;
  const seen = new Set();
  const tolerances = new Map();
  const pairTolerance = (firstPart, secondPart) => {
    const key = Math.min(firstPart, secondPart) * entries.length + Math.max(firstPart, secondPart);
    let tolerance = tolerances.get(key);
    if (tolerance === undefined) {
      const first = entries[firstPart].bounds;
      const second = entries[secondPart].bounds;
      tolerance = nearTolerance(Math.hypot(
        Math.max(first[3], second[3]) - Math.min(first[0], second[0]),
        Math.max(first[4], second[4]) - Math.min(first[1], second[1]),
        Math.max(first[5], second[5]) - Math.min(first[2], second[2]),
      ));
      tolerances.set(key, tolerance);
    }
    return tolerance;
  };
  return function testPair(one, other) {
    // Two cells of one triangle can hash to one key, which lists it twice.
    if (one === other) return;
    const first = Math.min(one, other);
    const second = Math.max(one, other);
    for (let axis = 0; axis < 3; axis++) {
      if (boxes[first * 6 + 3 + axis] < boxes[second * 6 + axis] - reach) return;
      if (boxes[second * 6 + 3 + axis] < boxes[first * 6 + axis] - reach) return;
    }
    const normalX = normals[first * 3];
    const normalY = normals[first * 3 + 1];
    const normalZ = normals[first * 3 + 2];
    const facing = normalX * normals[second * 3] + normalY * normals[second * 3 + 1] + normalZ * normals[second * 3 + 2];
    if (Math.abs(facing) < SAME_FACING) return;
    const opposite = facing < 0;
    // A face against a floor looks away from it and is culled, unless one of the two shows both sides.
    if (opposite && entries[owner[first]].part.material?.doubleSided !== true && entries[owner[second]].part.material?.doubleSided !== true) return;
    const tolerance = pairTolerance(owner[first], owner[second]);
    for (let corner = 0; corner < 3; corner++) {
      const distance = (corners[second * 9 + corner * 3] - corners[first * 9]) * normalX
        + (corners[second * 9 + corner * 3 + 1] - corners[first * 9 + 1]) * normalY
        + (corners[second * 9 + corner * 3 + 2] - corners[first * 9 + 2]) * normalZ;
      if (Math.abs(distance) > tolerance) return;
    }
    const pairKey = first * table.count + second;
    if (seen.has(pairKey)) return;
    seen.add(pairKey);
    const absoluteX = Math.abs(normalX);
    const absoluteY = Math.abs(normalY);
    const absoluteZ = Math.abs(normalZ);
    let dropped = 0;
    if (absoluteY > absoluteX && absoluteY >= absoluteZ) dropped = 1;
    else if (absoluteZ > absoluteX && absoluteZ > absoluteY) dropped = 2;
    const axisU = (dropped + 1) % 3;
    const axisV = (dropped + 2) % 3;
    const area = sharedArea(table, first, second, dropped, axisU, axisV);
    if (area < Math.max(FLUSH_MINIMUM_AREA, FLUSH_MINIMUM_AREA_SHARE * Math.min(areas[first], areas[second]))) return;
    if (result.pairs.length >= pairBudget) {
      result.truncated = true;
      return;
    }
    const lift = planeHeight(table, second, dropped, axisU, axisV, sharedCentre[0], sharedCentre[1]) - planeHeight(table, first, dropped, axisU, axisV, sharedCentre[0], sharedCentre[1]);
    const gap = lift * normals[first * 3 + dropped];
    // The two planes are one plane when the gap is within the rounding of the coordinates of these two triangles, not of the
    // whole scene: a far backdrop must not blur the order of faces near the origin.
    let largestCoordinate = 0;
    for (let value = 0; value < 6; value++) largestCoordinate = Math.max(largestCoordinate, Math.abs(boxes[first * 6 + value]), Math.abs(boxes[second * 6 + value]));
    result.pairs.push({ first, second, gap, area, opposite, flush: Math.abs(gap) <= flushTolerance(largestCoordinate) });
  };
}

// Natives are swept along x against each other; every native is also tested against every guest of the cell.
function testCell(cell, boxes, reach, testPair) {
  const { natives, guests } = cell;
  if (natives.length > 2) natives.sort((first, second) => boxes[first * 6] - boxes[second * 6]);
  for (let index = 0; index < natives.length; index++) {
    const native = natives[index];
    const end = boxes[native * 6 + 3] + reach;
    for (let other = index + 1; other < natives.length; other++) {
      if (boxes[natives[other] * 6] > end) break;
      testPair(native, natives[other]);
    }
    for (let other = 0; other < guests.length; other++) testPair(native, guests[other]);
  }
}

/**
 * Pairs of triangles that draw the same plane in the same place. A part is `{ name, geometry: { positions, indices }, matrix,
 * material? }`; deforming parts (isDeformingPart) are left out. Returns `{ parts, count, owner, local, areas, corners, pairs,
 * unchecked, truncated }`: `corners` holds nine world coordinates per triangle, `pairs` holds `{ first, second, gap, area, opposite, flush }` with triangle ids below `count`, `owner[id]` the
 * index into `parts` and `local[id]` the triangle inside that part's geometry. `gap` is in metres along the first triangle's
 * normal, positive when the second triangle is in front of it; `flush` says the gap is within rounding (flushTolerance), so the
 * two lie on one plane; `opposite` marks a pair that faces opposite ways (one part is double sided). `unchecked` lists parts
 * past `triangleBudget`.
 */
export function findFlushPairs(parts, { triangleBudget = DEFAULT_TRIANGLE_BUDGET, pairBudget = DEFAULT_PAIR_BUDGET } = {}) {
  const { entries, unchecked } = withinTriangleBudget(searchableParts(parts), triangleBudget);
  const table = readTriangles(entries);
  const result = { parts: entries.map(entry => entry.part), count: table.count, owner: table.owner, local: table.local, areas: table.areas, corners: table.corners, pairs: [], unchecked, truncated: false };
  if (table.count < 2) return result;
  const sceneBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { bounds } of entries) {
    for (let axis = 0; axis < 3; axis++) {
      sceneBounds[axis] = Math.min(sceneBounds[axis], bounds[axis]);
      sceneBounds[3 + axis] = Math.max(sceneBounds[3 + axis], bounds[3 + axis]);
    }
  }
  // No pair of parts spans more than the scene, so this is the widest gap any pair is tested with.
  const reach = nearTolerance(boundsDiagonal(sceneBounds));
  const testPair = createPairTest(table, entries, reach, pairBudget, result);
  for (const cell of buildCells(table, gridCellSize(table, reach), reach)) testCell(cell, table.boxes, reach, testPair);
  result.pairs.sort((first, second) => first.first - second.first || first.second - second.second);
  return result;
}
