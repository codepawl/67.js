import { createMeshQueryIndex } from './mesh-query.js';

const INDEX_OPTIONS = Object.freeze({ maxTriangles: 1_000_000, maxVertices: 1_000_000, memoryBudgetMiB: 256 });
const DEFAULT_WALK_OPTIONS = Object.freeze({
  cellSize: 1,
  topY: 100,
  probeHeight: 0.3,
  clearanceCap: 99,
  maxCells: 65_536,
});
const WALK_OPTION_NAMES = new Set(['min', 'max', 'cellSize', 'topY', 'probeHeight', 'clearanceCap', 'maxCells', 'lowerPass', 'obstacles']);
const LOWER_PASS_NAMES = new Set(['fromY', 'maxDistance', 'groundBelow', 'minHeadroom']);
// A kerb is about 0.15 to 0.2 m, so 0.3 m keeps kerbs walkable while bollards, lamp posts, planters and tables stand out.
const DEFAULT_OBSTACLES = Object.freeze({ reach: 2.6, minHeight: 0.3, maxDrop: 6, maxLayers: 8 });
const OBSTACLE_NAMES = new Set(['streetY', 'fromY', 'reach', 'minHeight']);
const STREET_SAMPLE_CELLS = 1024;
// Seams a closing step fills: kerb faces and cracks narrower than this many metres.
const SEAM_METRES = 0.75;

function assertNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} requires a finite number.`);
  return value;
}

function localBounds(positions) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], positions[offset + axis]);
      bounds[3 + axis] = Math.max(bounds[3 + axis], positions[offset + axis]);
    }
  }
  return bounds;
}

function worldBounds(bounds, matrix) {
  const result = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds[3] : bounds[0];
    const y = corner & 2 ? bounds[4] : bounds[1];
    const z = corner & 4 ? bounds[5] : bounds[2];
    const world = [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
    for (let axis = 0; axis < 3; axis++) {
      result[axis] = Math.min(result[axis], world[axis]);
      result[3 + axis] = Math.max(result[3 + axis], world[axis]);
    }
  }
  return result;
}

// Slab test: the distance along the ray where it enters the box, or Infinity when it misses or the box is behind it.
function enterDistance(origin, direction, bounds, maxDistance) {
  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    if (direction[axis] === 0) {
      if (origin[axis] < bounds[axis] || origin[axis] > bounds[3 + axis]) return Infinity;
      continue;
    }
    const first = (bounds[axis] - origin[axis]) / direction[axis];
    const second = (bounds[3 + axis] - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return Infinity;
  }
  return near;
}

// Slivers with no usable area crash the precision checks of the mesh query and can never be walked on, so they are
// dropped from the indexed copy. The caller's geometry is not changed.
function withoutSlivers(geometry, matrix, bounds) {
  const { positions, indices } = geometry;
  const extent = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
  const columnLength = offset => Math.hypot(matrix[offset], matrix[offset + 1], matrix[offset + 2]);
  const matrixScale = Math.max((columnLength(0) + columnLength(4) + columnLength(8)) / 3, 1e-12);
  const minimumAltitude = Math.max(extent * 1e-6, (2 ** -19 * Math.max(...bounds.map(Math.abs))) / matrixScale);
  const kept = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const first = indices[offset] * 3;
    const second = indices[offset + 1] * 3;
    const third = indices[offset + 2] * 3;
    const edgeA = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
    const edgeB = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
    const edgeC = [0, 1, 2].map(axis => edgeA[axis] - edgeB[axis]);
    const cross = Math.hypot(
      edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
      edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
      edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
    );
    const longest = Math.max(Math.hypot(...edgeA), Math.hypot(...edgeB), Math.hypot(...edgeC));
    if (longest > 0 && cross / longest > minimumAltitude) kept.push(indices[offset], indices[offset + 1], indices[offset + 2]);
  }
  if (kept.length === indices.length) return { geometry, dropped: 0 };
  return { geometry: { positions, indices: Uint32Array.from(kept) }, dropped: (indices.length - kept.length) / 3 };
}

function faceNormal(geometry, triangle, matrix, direction) {
  const corners = [0, 1, 2].map(corner => {
    const offset = geometry.indices[triangle * 3 + corner] * 3;
    const x = geometry.positions[offset];
    const y = geometry.positions[offset + 1];
    const z = geometry.positions[offset + 2];
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
  });
  const first = corners[1].map((value, axis) => value - corners[0][axis]);
  const second = corners[2].map((value, axis) => value - corners[0][axis]);
  const normal = [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
  const length = Math.hypot(...normal) || 1;
  // Face the side the ray came from, so a back face never reports a normal pointing away from the viewer.
  const facing = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2] > 0 ? -1 : 1;
  return normal.map(value => (value / length) * facing);
}

// The lowest surface among an evenly spaced sample of the region: the street level when no streetY is given.
function lowestSampledGround(settings, topHit) {
  const { columns, rows, cellSize } = settings;
  const stride = Math.max(1, Math.ceil(Math.sqrt((columns * rows) / STREET_SAMPLE_CELLS)));
  let lowest = Infinity;
  for (let column = 0; column < columns; column += stride) {
    for (let row = 0; row < rows; row += stride) {
      const top = topHit(settings.min[0] + column * cellSize, settings.min[1] + row * cellSize);
      if (top) lowest = Math.min(lowest, top.point[1]);
    }
  }
  if (lowest === Infinity) throw new RangeError('walkMap obstacles found no surface to take the street level from. Pass obstacles.streetY.');
  return lowest;
}

function readWalkOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('walkMap requires an options object.');
  for (const name of Object.keys(options)) {
    if (!WALK_OPTION_NAMES.has(name)) throw new TypeError(`Unsupported walkMap option ${name}.`);
  }
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const settings = { ...DEFAULT_WALK_OPTIONS, ...given };
  for (const field of ['min', 'max']) {
    if (!Array.isArray(settings[field]) || settings[field].length !== 2) throw new TypeError(`walkMap ${field} requires [x, z].`);
    settings[field].forEach((value, index) => assertNumber(value, `walkMap ${field}[${index}]`));
  }
  for (const field of ['cellSize', 'topY', 'probeHeight', 'clearanceCap', 'maxCells']) assertNumber(settings[field], `walkMap ${field}`);
  if (settings.cellSize <= 0 || settings.probeHeight <= 0) throw new RangeError('walkMap cellSize and probeHeight must be positive.');
  if (settings.max[0] < settings.min[0] || settings.max[1] < settings.min[1]) throw new RangeError('walkMap max must not be below min.');
  if (settings.lowerPass !== undefined) {
    for (const name of Object.keys(settings.lowerPass)) {
      if (!LOWER_PASS_NAMES.has(name)) throw new TypeError(`Unsupported walkMap lowerPass option ${name}.`);
    }
    settings.lowerPass = { maxDistance: 4, minHeadroom: 2.4, ...settings.lowerPass };
    for (const field of ['fromY', 'groundBelow']) assertNumber(settings.lowerPass[field], `walkMap lowerPass.${field}`);
  }
  if (settings.obstacles !== undefined) {
    const given = settings.obstacles === true ? {} : settings.obstacles;
    if (!given || typeof given !== 'object') throw new TypeError('walkMap obstacles requires true or an options object.');
    for (const name of Object.keys(given)) {
      if (!OBSTACLE_NAMES.has(name)) throw new TypeError(`Unsupported walkMap obstacles option ${name}.`);
      assertNumber(given[name], `walkMap obstacles.${name}`);
    }
    settings.obstacles = { ...DEFAULT_OBSTACLES, ...given };
    if (settings.obstacles.minHeight <= 0 || settings.obstacles.reach <= 0) throw new RangeError('walkMap obstacles minHeight and reach must be positive.');
  }
  settings.columns = Math.floor((settings.max[0] - settings.min[0]) / settings.cellSize + 1e-9) + 1;
  settings.rows = Math.floor((settings.max[1] - settings.min[1]) / settings.cellSize + 1e-9) + 1;
  if (settings.columns * settings.rows > settings.maxCells) {
    throw new RangeError(`walkMap region holds ${settings.columns * settings.rows} cells, above maxCells ${settings.maxCells}. Use a larger cellSize or a smaller region.`);
  }
  return settings;
}

/**
 * Raycasts and walk maps over a whole loaded scene. `parts` are objects like the `parts` of loadGltf:
 * { geometry: { positions, indices }, matrix, material, name } with a 16 component world matrix, plus an optional `id`.
 * Each part gets a BVH on its first query and keeps it, so repeated queries only pay for traversal.
 * Parts the mesh query rejects (skinned or morphed meshes, degenerate matrices) are listed in `skipped`, never hit.
 */
export function createSceneQuery(parts, options = {}) {
  if (!Array.isArray(parts)) throw new TypeError('createSceneQuery requires an array of parts.');
  const indexOptions = { ...INDEX_OPTIONS, ...options };
  const entries = parts.map((part, position) => ({
    part, position, id: part.id ?? part.name ?? `part-${position}`, index: null, failed: null,
    bounds: worldBounds(localBounds(part.geometry.positions), part.matrix),
  }));
  const skipped = [];
  let disposed = false;
  let droppedTriangles = 0;

  function indexOf(entry) {
    if (entry.failed) return null;
    if (!entry.index) {
      try {
        const surface = withoutSlivers(entry.part.geometry, entry.part.matrix, entry.bounds);
        entry.index = createMeshQueryIndex(surface.geometry, indexOptions);
        entry.surface = surface.geometry;
        droppedTriangles += surface.dropped;
      } catch (error) {
        entry.failed = error.message;
        skipped.push({ id: entry.id, reason: error.message });
        return null;
      }
    }
    return entry.index;
  }

  function raycast(ray) {
    if (disposed) throw new Error('Scene query was disposed. Create a new one.');
    const direction = Array.from(ray.direction);
    const length = Math.hypot(...direction);
    if (!(length > 0)) throw new RangeError('Ray direction must be nonzero.');
    const unit = direction.map(value => value / length);
    const origin = Array.from(ray.origin);
    const maxDistance = ray.maxDistance ?? Infinity;
    const candidates = [];
    for (const entry of entries) {
      const enter = enterDistance(origin, unit, entry.bounds, maxDistance);
      if (enter !== Infinity) candidates.push({ entry, enter });
    }
    candidates.sort((first, second) => first.enter - second.enter);
    let best = null;
    for (const { entry, enter } of candidates) {
      if (best && enter > best.distance) break;
      const index = indexOf(entry);
      if (!index) continue;
      const hit = index.raycast(entry.part.matrix, { origin, direction: unit, maxDistance });
      if (hit && (!best || hit.distance < best.distance)) best = { ...hit, entry };
    }
    if (!best) return null;
    return {
      point: best.point, distance: best.distance, id: best.entry.id, partIndex: best.entry.position,
      material: best.entry.part.material ?? null, triangle: best.triangle,
      normal: faceNormal(best.entry.surface, best.triangle, best.entry.part.matrix, unit),
    };
  }

  function walkMap(walkOptions) {
    const settings = readWalkOptions(walkOptions);
    const { cellSize, columns, rows, topY, probeHeight, clearanceCap, lowerPass } = settings;
    const down = [0, -1, 0];
    const up = [0, 1, 0];
    function headroomAbove(x, z, groundY) {
      const hit = raycast({ origin: [x, groundY + probeHeight, z], direction: up, maxDistance: topY - groundY });
      return hit ? Math.min(hit.point[1] - groundY, clearanceCap) : clearanceCap;
    }
    // Obstacle marking: a down ray from about `reach` metres above the street. When its first hit stands more than
    // `minHeight` above the lowest surface under it, the cell holds an obstacle. Ground and headroom come from that column.
    const obstacles = settings.obstacles;
    let obstacleFromY = obstacles?.fromY;
    if (obstacles && obstacleFromY === undefined) {
      const streetY = obstacles.streetY
        ?? lowestSampledGround(settings, (x, z) => raycast({ origin: [x, topY, z], direction: down }));
      obstacleFromY = streetY + obstacles.reach;
    }
    function obstacleCell(x, z) {
      const first = raycast({ origin: [x, obstacleFromY, z], direction: down });
      if (!first) return null;
      let groundY = first.point[1];
      for (let layer = 0; layer < obstacles.maxLayers; layer++) {
        const lower = raycast({ origin: [x, groundY - 0.01, z], direction: down, maxDistance: obstacles.maxDrop });
        if (!lower) break;
        groundY = lower.point[1];
      }
      const standing = first.point[1] - groundY > obstacles.minHeight;
      return [x, z, groundY, headroomAbove(x, z, groundY), standing ? 1 : 0];
    }
    const cells = [];
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const x = settings.min[0] + column * cellSize;
        const z = settings.min[1] + row * cellSize;
        if (obstacles) {
          const cell = obstacleCell(x, z);
          if (cell) cells.push(cell);
          continue;
        }
        const top = raycast({ origin: [x, topY, z], direction: down });
        if (!top) continue;
        let groundY = top.point[1];
        let headroom = headroomAbove(x, z, groundY);
        // A roof or an arch can hide the street: a second ray from walking height finds the ground underneath.
        if (lowerPass && groundY > lowerPass.groundBelow) {
          const low = raycast({ origin: [x, lowerPass.fromY, z], direction: down, maxDistance: lowerPass.maxDistance });
          if (low && low.point[1] < lowerPass.groundBelow) {
            const lowHeadroom = headroomAbove(x, z, low.point[1]);
            if (lowHeadroom > lowerPass.minHeadroom) {
              groundY = low.point[1];
              headroom = lowHeadroom;
            }
          }
        }
        cells.push([x, z, groundY, headroom]);
      }
    }
    return { cellSize, min: settings.min, columns, rows, cells };
  }

  return Object.freeze({
    raycast,
    walkMap,
    get skipped() { return skipped.slice(); },
    get info() { return { parts: entries.length, indexed: entries.filter(entry => entry.index).length, droppedTriangles }; },
    dispose() {
      disposed = true;
      for (const entry of entries) entry.index?.dispose();
    },
  });
}

/**
 * Which cells of a walkMap result an agent may walk, as a Uint8Array indexed `column * rows + row` (1 = walkable).
 * A cell is open when it has a surface, enough headroom, is not an obstacle (see walkMap `obstacles`) and sits in
 * `groundRange`. With `keepOut` (metres) the open cells go through a closing step, so one-cell seams such as kerb
 * faces do not split a street, then obstacles are cut back out, and every cell closer than `keepOut` to anything that
 * is not open (an obstacle, a wall, a gap) stops being walkable.
 */
export function walkableMask(map, { clearance = 2, groundRange, keepOut = 0 } = {}) {
  const { columns, rows, cellSize, min } = map;
  const count = columns * rows;
  const open = new Uint8Array(count);
  const obstacle = new Uint8Array(count);
  for (const [x, z, groundY, headroom, standing] of map.cells) {
    const slot = Math.round((x - min[0]) / cellSize) * rows + Math.round((z - min[1]) / cellSize);
    const inRange = !groundRange || (groundY >= groundRange[0] && groundY <= groundRange[1]);
    if (standing) obstacle[slot] = 1;
    else if (headroom >= clearance && inRange) open[slot] = 1;
  }
  if (!(keepOut > 0)) return open;
  const seam = Math.max(1, Math.round(SEAM_METRES / cellSize));
  let free = open;
  // Closing = grow the open cells, then shrink them. Outside the grid counts as the same state as the edge cell, so the
  // border never eats into the result.
  for (let step = 0; step < seam; step++) free = spread(free, columns, rows, 1);
  for (let step = 0; step < seam; step++) free = spread(free, columns, rows, 0);
  for (let slot = 0; slot < count; slot++) if (obstacle[slot]) free[slot] = 0;
  free = spread(spread(free, columns, rows, 0), columns, rows, 1);
  return keepClear(free, columns, rows, keepOut / cellSize);
}

// One 4-neighbour step: every cell next to a cell holding `value` takes `value` too.
function spread(grid, columns, rows, value) {
  const next = Uint8Array.from(grid);
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const slot = column * rows + row;
      if (grid[slot] === value) continue;
      const beside = (column > 0 && grid[slot - rows] === value)
        || (column < columns - 1 && grid[slot + rows] === value)
        || (row > 0 && grid[slot - 1] === value)
        || (row < rows - 1 && grid[slot + 1] === value);
      if (beside) next[slot] = value;
    }
  }
  return next;
}

// Clears every open cell within `radius` cells of a closed cell. Only closed cells that touch an open one need to spread.
function keepClear(free, columns, rows, radius) {
  const reach = Math.ceil(radius);
  const offsets = [];
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      if (dx * dx + dz * dz < radius * radius) offsets.push([dx, dz]);
    }
  }
  const result = Uint8Array.from(free);
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      if (free[column * rows + row]) continue;
      const touchesOpen = (column > 0 && free[(column - 1) * rows + row])
        || (column < columns - 1 && free[(column + 1) * rows + row])
        || (row > 0 && free[column * rows + row - 1])
        || (row < rows - 1 && free[column * rows + row + 1]);
      if (!touchesOpen) continue;
      for (const [dx, dz] of offsets) {
        const nearColumn = column + dx;
        const nearRow = row + dz;
        if (nearColumn >= 0 && nearColumn < columns && nearRow >= 0 && nearRow < rows) result[nearColumn * rows + nearRow] = 0;
      }
    }
  }
  return result;
}
