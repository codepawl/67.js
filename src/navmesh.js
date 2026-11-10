// Walkable-grid navigation over triangle geometry: ground with slopes, holes and obstacles in, a smooth path out.
// The grid takes the top surface at each cell centre and blocks empty cells (holes) and obstacle footprints, then
// grows every blocked area by the agent radius. A step between cells that climbs past the slope limit is not allowed. A* finds a route over the cells and line-of-sight string pulling
// removes the grid zigzag. Pure JavaScript, no randomness: the same input gives the same path.

export const NAVMESH_LIMITS = Object.freeze({
  maximumCells: 250000,
  maximumSearchNodes: 200000,
  maximumObstacles: 64,
  maximumPathPoints: 200,
  defaultAgentRadius: 0.3,
  defaultSlopeDegrees: 40,
});

const NO_SURFACE = -Infinity;
const NEIGHBOUR_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const LINE_OF_SIGHT_SAMPLES_PER_CELL = 4;
const EDGE_TOLERANCE = 1e-9;

function positiveNumber(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new RangeError(`navmesh ${label} must be a positive number.`);
  return resolved;
}

function pointXZ(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
    throw new RangeError(`navmesh ${label} must be [x, z] in metres.`);
  }
  return value;
}

function geometryBounds(positions) {
  let minimumX = Infinity;
  let minimumZ = Infinity;
  let maximumX = -Infinity;
  let maximumZ = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    minimumX = Math.min(minimumX, positions[offset]);
    maximumX = Math.max(maximumX, positions[offset]);
    minimumZ = Math.min(minimumZ, positions[offset + 2]);
    maximumZ = Math.max(maximumZ, positions[offset + 2]);
  }
  return { minimumX, minimumZ, maximumX, maximumZ };
}

// Binary heap ordered by cost, then by cell index, so equal costs always leave in the same order.
function createOpenSet() {
  const costs = [];
  const cells = [];
  function isBefore(first, second) {
    return costs[first] < costs[second] || (costs[first] === costs[second] && cells[first] < cells[second]);
  }
  function swap(first, second) {
    [costs[first], costs[second]] = [costs[second], costs[first]];
    [cells[first], cells[second]] = [cells[second], cells[first]];
  }
  return {
    get size() {
      return cells.length;
    },
    push(cell, cost) {
      costs.push(cost);
      cells.push(cell);
      let index = cells.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!isBefore(index, parent)) break;
        swap(index, parent);
        index = parent;
      }
    },
    pop() {
      const top = cells[0];
      const lastCost = costs.pop();
      const lastCell = cells.pop();
      if (cells.length > 0) {
        costs[0] = lastCost;
        cells[0] = lastCell;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < cells.length && isBefore(left, smallest)) smallest = left;
          if (right < cells.length && isBefore(right, smallest)) smallest = right;
          if (smallest === index) break;
          swap(index, smallest);
          index = smallest;
        }
      }
      return top;
    },
  };
}

/**
 * Builds a navigation grid from triangles (`positions` x y z, `indices`, both in world space, Y up).
 * Options: `agentRadius` (0.3 m), `maxSlopeDegrees` (40), `cellSize` (the radius, at least 0.05 m),
 * `obstacles` ([{ min: [x, z], max: [x, z] }] footprints that block), `maxCells` (250,000).
 */
export function createNavmesh({ positions, indices, agentRadius, maxSlopeDegrees, cellSize, obstacles = [], maxCells } = {}) {
  if (!(positions?.length >= 9) || !(indices?.length >= 3)) throw new RangeError('navmesh needs positions and indices with at least one triangle.');
  const radius = positiveNumber(agentRadius, NAVMESH_LIMITS.defaultAgentRadius, 'agentRadius');
  const slopeDegrees = positiveNumber(maxSlopeDegrees, NAVMESH_LIMITS.defaultSlopeDegrees, 'maxSlopeDegrees');
  if (slopeDegrees >= 90) throw new RangeError('navmesh maxSlopeDegrees must stay below 90.');
  const size = positiveNumber(cellSize, Math.max(radius, 0.05), 'cellSize');
  const cellBudget = positiveNumber(maxCells, NAVMESH_LIMITS.maximumCells, 'maxCells');
  if (!Array.isArray(obstacles) || obstacles.length > NAVMESH_LIMITS.maximumObstacles) {
    throw new RangeError(`navmesh obstacles must be a list of at most ${NAVMESH_LIMITS.maximumObstacles} footprints.`);
  }

  const bounds = geometryBounds(positions);
  const columns = Math.max(1, Math.ceil((bounds.maximumX - bounds.minimumX) / size));
  const rows = Math.max(1, Math.ceil((bounds.maximumZ - bounds.minimumZ) / size));
  if (columns * rows > cellBudget) {
    const neededSize = Math.sqrt(((bounds.maximumX - bounds.minimumX) * (bounds.maximumZ - bounds.minimumZ)) / cellBudget);
    throw new RangeError(`navmesh needs ${columns * rows} cells at cellSize ${size} m, over the budget of ${cellBudget}. Raise cellSize to at least ${Math.ceil(neededSize * 100) / 100} m or use a smaller ground.`);
  }
  const maximumStep = Math.tan((slopeDegrees * Math.PI) / 180);

  const heights = new Float32Array(columns * rows).fill(NO_SURFACE);
  rasterizeTopSurface(positions, indices, bounds, size, columns, rows, heights);

  const blocked = new Uint8Array(columns * rows);
  for (let cell = 0; cell < blocked.length; cell++) {
    if (heights[cell] === NO_SURFACE) blocked[cell] = 1;
  }
  for (const obstacle of obstacles) {
    blockFootprint(obstacle, bounds, size, columns, rows, blocked);
  }
  const walkable = growBlockedAreas(blocked, columns, rows, Math.ceil(radius / size), radius / size);
  const walkableCellCount = walkable.reduce((total, value) => total + value, 0);

  function cellOf(worldX, worldZ) {
    const column = Math.floor((worldX - bounds.minimumX) / size);
    const row = Math.floor((worldZ - bounds.minimumZ) / size);
    if (column < 0 || row < 0 || column >= columns || row >= rows) return -1;
    return row * columns + column;
  }

  function centerOf(cell) {
    return [bounds.minimumX + ((cell % columns) + 0.5) * size, bounds.minimumZ + (Math.floor(cell / columns) + 0.5) * size];
  }

  function isWalkable(worldX, worldZ) {
    const cell = cellOf(worldX, worldZ);
    return cell >= 0 && walkable[cell] === 1;
  }

  // Bilinear over the four nearest cell centres that have a surface; a cell without one adds no weight.
  function heightAt(worldX, worldZ) {
    const columnPosition = (worldX - bounds.minimumX) / size - 0.5;
    const rowPosition = (worldZ - bounds.minimumZ) / size - 0.5;
    const baseColumn = Math.floor(columnPosition);
    const baseRow = Math.floor(rowPosition);
    let weightedHeight = 0;
    let totalWeight = 0;
    for (let rowStep = 0; rowStep <= 1; rowStep++) {
      for (let columnStep = 0; columnStep <= 1; columnStep++) {
        const column = baseColumn + columnStep;
        const row = baseRow + rowStep;
        if (column < 0 || row < 0 || column >= columns || row >= rows) continue;
        const height = heights[row * columns + column];
        if (height === NO_SURFACE) continue;
        const weight = (columnStep === 0 ? 1 - (columnPosition - baseColumn) : columnPosition - baseColumn)
          * (rowStep === 0 ? 1 - (rowPosition - baseRow) : rowPosition - baseRow);
        weightedHeight += height * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight > 0) return weightedHeight / totalWeight;
    const cell = cellOf(worldX, worldZ);
    return cell >= 0 && heights[cell] !== NO_SURFACE ? heights[cell] : null;
  }

  function canStep(fromCell, toCell, distance) {
    return walkable[toCell] === 1 && Math.abs(heights[toCell] - heights[fromCell]) <= maximumStep * distance;
  }

  function hasLineOfSight(fromPoint, toPoint) {
    const length = Math.hypot(toPoint[0] - fromPoint[0], toPoint[1] - fromPoint[1]);
    const samples = Math.max(1, Math.ceil((length / size) * LINE_OF_SIGHT_SAMPLES_PER_CELL));
    let previousCell = cellOf(fromPoint[0], fromPoint[1]);
    for (let sample = 1; sample <= samples; sample++) {
      const fraction = sample / samples;
      const cell = cellOf(fromPoint[0] + (toPoint[0] - fromPoint[0]) * fraction, fromPoint[1] + (toPoint[1] - fromPoint[1]) * fraction);
      if (cell < 0 || walkable[cell] === 0) return false;
      if (cell !== previousCell) {
        const [previousX, previousZ] = centerOf(previousCell);
        const [currentX, currentZ] = centerOf(cell);
        if (!canStep(previousCell, cell, Math.hypot(currentX - previousX, currentZ - previousZ))) return false;
        previousCell = cell;
      }
    }
    return true;
  }

  function explainUnwalkable(worldX, worldZ, label) {
    const cell = cellOf(worldX, worldZ);
    if (cell < 0) return `${label} [${worldX}, ${worldZ}] is outside the ground.`;
    if (heights[cell] === NO_SURFACE) return `${label} [${worldX}, ${worldZ}] has no ground under it (a hole).`;
    const nearest = nearestWalkableCenter(worldX, worldZ);
    const suggestion = nearest ? ` The nearest walkable point is [${nearest[0].toFixed(2)}, ${nearest[1].toFixed(2)}].` : '';
    return `${label} [${worldX}, ${worldZ}] is not walkable: it is on an obstacle or a steep slope, or within the agent radius ${radius} m of a hole or an obstacle.${suggestion}`;
  }

  function nearestWalkableCenter(worldX, worldZ) {
    let best = null;
    let bestDistance = Infinity;
    for (let cell = 0; cell < walkable.length; cell++) {
      if (walkable[cell] === 0) continue;
      const [centerX, centerZ] = centerOf(cell);
      const distance = Math.hypot(centerX - worldX, centerZ - worldZ);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [centerX, centerZ];
      }
    }
    return best;
  }

  /** Route from [x, z] to [x, z]: { points: [[x, y, z], ...], length, searchNodes }. Throws when the goal cannot be reached. */
  function findPath(from, to, { spacing, maxSearchNodes } = {}) {
    pointXZ(from, 'from');
    pointXZ(to, 'to');
    const budget = positiveNumber(maxSearchNodes, NAVMESH_LIMITS.maximumSearchNodes, 'maxSearchNodes');
    const startCell = cellOf(from[0], from[1]);
    const goalCell = cellOf(to[0], to[1]);
    if (startCell < 0 || walkable[startCell] === 0) throw new RangeError(explainUnwalkable(from[0], from[1], 'Start'));
    if (goalCell < 0 || walkable[goalCell] === 0) throw new RangeError(explainUnwalkable(to[0], to[1], 'Goal'));

    const cellRoute = searchCells(startCell, goalCell, budget);
    const corners = [from, ...cellRoute.cells.slice(1, -1).map(centerOf), to];
    const pulled = pullString(corners);
    const points = resample(pulled, positiveNumber(spacing, Math.max(1.5, size * 2), 'spacing'));
    let length = 0;
    for (let index = 1; index < pulled.length; index++) {
      length += Math.hypot(pulled[index][0] - pulled[index - 1][0], pulled[index][1] - pulled[index - 1][1]);
    }
    return { points, length, searchNodes: cellRoute.searchNodes };
  }

  function searchCells(startCell, goalCell, budget) {
    const [goalX, goalZ] = centerOf(goalCell);
    const costSoFar = new Float32Array(columns * rows).fill(Infinity);
    const cameFrom = new Int32Array(columns * rows).fill(-1);
    const closed = new Uint8Array(columns * rows);
    const open = createOpenSet();
    const remaining = cell => {
      const [x, z] = centerOf(cell);
      return Math.hypot(x - goalX, z - goalZ);
    };
    costSoFar[startCell] = 0;
    open.push(startCell, remaining(startCell));
    let searchNodes = 0;
    while (open.size > 0) {
      const cell = open.pop();
      if (closed[cell] === 1) continue;
      closed[cell] = 1;
      searchNodes++;
      if (cell === goalCell) return { cells: traceBack(cameFrom, cell), searchNodes };
      if (searchNodes > budget) {
        throw new RangeError(`navmesh search used ${budget} nodes without reaching the goal. Raise cellSize, or check that the goal is on the same side of the holes and obstacles.`);
      }
      const column = cell % columns;
      const row = Math.floor(cell / columns);
      for (const [columnStep, rowStep] of NEIGHBOUR_OFFSETS) {
        const nextColumn = column + columnStep;
        const nextRow = row + rowStep;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
        const next = nextRow * columns + nextColumn;
        const isDiagonal = columnStep !== 0 && rowStep !== 0;
        const distance = isDiagonal ? size * Math.SQRT2 : size;
        if (closed[next] === 1 || !canStep(cell, next, distance)) continue;
        if (isDiagonal && (walkable[row * columns + nextColumn] === 0 || walkable[nextRow * columns + column] === 0)) continue;
        const cost = costSoFar[cell] + Math.hypot(distance, heights[next] - heights[cell]);
        if (cost < costSoFar[next]) {
          costSoFar[next] = cost;
          cameFrom[next] = cell;
          open.push(next, cost + remaining(next));
        }
      }
    }
    throw new RangeError('navmesh found no walkable route from start to goal: holes, obstacles or steep ground cut them apart.');
  }

  function traceBack(cameFrom, goalCell) {
    const cells = [];
    for (let cell = goalCell; cell !== -1; cell = cameFrom[cell]) cells.push(cell);
    return cells.reverse();
  }

  function pullString(corners) {
    const pulled = [corners[0]];
    let anchor = 0;
    while (anchor < corners.length - 1) {
      let farthest = anchor + 1;
      for (let candidate = corners.length - 1; candidate > anchor + 1; candidate--) {
        if (hasLineOfSight(corners[anchor], corners[candidate])) {
          farthest = candidate;
          break;
        }
      }
      pulled.push(corners[farthest]);
      anchor = farthest;
    }
    return pulled;
  }

  function resample(pulled, requestedSpacing) {
    let length = 0;
    for (let index = 1; index < pulled.length; index++) {
      length += Math.hypot(pulled[index][0] - pulled[index - 1][0], pulled[index][1] - pulled[index - 1][1]);
    }
    const spacingUsed = Math.max(requestedSpacing, length / (NAVMESH_LIMITS.maximumPathPoints - pulled.length));
    const points = [];
    const addPoint = (x, z) => points.push([x, heightAt(x, z) ?? heights[cellOf(x, z)], z]);
    addPoint(pulled[0][0], pulled[0][1]);
    for (let index = 1; index < pulled.length; index++) {
      const [startX, startZ] = pulled[index - 1];
      const [endX, endZ] = pulled[index];
      const segmentLength = Math.hypot(endX - startX, endZ - startZ);
      const pieces = Math.max(1, Math.round(segmentLength / spacingUsed));
      for (let piece = 1; piece <= pieces; piece++) {
        const fraction = piece / pieces;
        addPoint(startX + (endX - startX) * fraction, startZ + (endZ - startZ) * fraction);
      }
    }
    return points;
  }

  return { cellSize: size, columns, rows, cellCount: columns * rows, walkableCellCount, agentRadius: radius, isWalkable, heightAt, findPath };
}

// The highest triangle over each cell centre wins, so a floor under a roof is not walked through the roof.
function rasterizeTopSurface(positions, indices, bounds, size, columns, rows, heights) {
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3;
    const b = indices[offset + 1] * 3;
    const c = indices[offset + 2] * 3;
    const ax = positions[a];
    const az = positions[a + 2];
    const determinant = (positions[b + 2] - positions[c + 2]) * (ax - positions[c]) + (positions[c] - positions[b]) * (az - positions[c + 2]);
    if (Math.abs(determinant) < 1e-12) continue;
    const minimumColumn = Math.max(0, Math.floor((Math.min(ax, positions[b], positions[c]) - bounds.minimumX) / size - 0.5));
    const maximumColumn = Math.min(columns - 1, Math.ceil((Math.max(ax, positions[b], positions[c]) - bounds.minimumX) / size));
    const minimumRow = Math.max(0, Math.floor((Math.min(az, positions[b + 2], positions[c + 2]) - bounds.minimumZ) / size - 0.5));
    const maximumRow = Math.min(rows - 1, Math.ceil((Math.max(az, positions[b + 2], positions[c + 2]) - bounds.minimumZ) / size));
    for (let row = minimumRow; row <= maximumRow; row++) {
      for (let column = minimumColumn; column <= maximumColumn; column++) {
        const x = bounds.minimumX + (column + 0.5) * size;
        const z = bounds.minimumZ + (row + 0.5) * size;
        const weightA = ((positions[b + 2] - positions[c + 2]) * (x - positions[c]) + (positions[c] - positions[b]) * (z - positions[c + 2])) / determinant;
        const weightB = ((positions[c + 2] - az) * (x - positions[c]) + (ax - positions[c]) * (z - positions[c + 2])) / determinant;
        const weightC = 1 - weightA - weightB;
        if (weightA < -EDGE_TOLERANCE || weightB < -EDGE_TOLERANCE || weightC < -EDGE_TOLERANCE) continue;
        const height = weightA * positions[a + 1] + weightB * positions[b + 1] + weightC * positions[c + 1];
        const cell = row * columns + column;
        if (height > heights[cell]) heights[cell] = height;
      }
    }
  }
}

function blockFootprint(obstacle, bounds, size, columns, rows, blocked) {
  const minimum = pointXZ(obstacle?.min, 'obstacle min');
  const maximum = pointXZ(obstacle?.max, 'obstacle max');
  const firstColumn = Math.max(0, Math.floor((minimum[0] - bounds.minimumX) / size));
  const lastColumn = Math.min(columns - 1, Math.floor((maximum[0] - bounds.minimumX) / size));
  const firstRow = Math.max(0, Math.floor((minimum[1] - bounds.minimumZ) / size));
  const lastRow = Math.min(rows - 1, Math.floor((maximum[1] - bounds.minimumZ) / size));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) blocked[row * columns + column] = 1;
  }
}

// Marks a cell walkable only when no blocked cell lies within the agent radius.
function growBlockedAreas(blocked, columns, rows, radiusInCells, radiusInCellUnits) {
  const walkable = new Uint8Array(blocked.length).fill(1);
  const reach = Math.max(radiusInCells, 1);
  const limit = Math.max(radiusInCellUnits, 0.75);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (blocked[row * columns + column] === 0) continue;
      for (let rowOffset = -reach; rowOffset <= reach; rowOffset++) {
        for (let columnOffset = -reach; columnOffset <= reach; columnOffset++) {
          if (Math.hypot(rowOffset, columnOffset) > limit) continue;
          const nearbyRow = row + rowOffset;
          const nearbyColumn = column + columnOffset;
          if (nearbyRow < 0 || nearbyColumn < 0 || nearbyRow >= rows || nearbyColumn >= columns) continue;
          walkable[nearbyRow * columns + nearbyColumn] = 0;
        }
      }
    }
  }
  return walkable;
}
