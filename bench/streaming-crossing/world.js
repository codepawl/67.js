// A deterministic large world for the streaming crossing benchmark (npm run benchmark:streaming) and its test.
// The world is a grid of terrain tiles built from a seed with no downloads. Each tile has three detail levels, and the
// player crosses the grid on a scripted path. The same seed gives the same tiles byte for byte.
import { createNoiseHeight } from '../../src/terrain.js';

export const CROSSING_DEFAULTS = Object.freeze({
  seed: 7,
  tilesPerSide: 24,
  tileSize: 20,
  levelResolutions: Object.freeze([96, 48, 24]),
  levelDistances: Object.freeze([30, 70]),
  loadDistance: 120,
  budgetBytes: 20 * 1024 * 1024,
  playerSpeed: 30,
  eyeHeight: 2,
});

export const CROSSING_LIMITS = Object.freeze({ maximumTilesPerSide: 64, maximumResolution: 256, maximumPlayerSpeed: 1000 });

/** Checks a player speed in world units per second; the crossing never ends for zero, a negative number or NaN. */
export function requirePlayerSpeed(speed, label) {
  if (!Number.isFinite(speed) || speed <= 0 || speed > CROSSING_LIMITS.maximumPlayerSpeed) {
    throw new RangeError(`${label} must be a number above 0 and at most ${CROSSING_LIMITS.maximumPlayerSpeed} world units per second, got ${String(speed)}.`);
  }
}

const heightFunctions = new Map();

function heightFunctionFor(seed) {
  if (!heightFunctions.has(seed)) heightFunctions.set(seed, createNoiseHeight({ amplitude: 14, featureSize: 70 }, seed));
  return heightFunctions.get(seed);
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a whole number from ${minimum} to ${maximum}, got ${String(value)}.`);
  }
  return value;
}

/** Centre of tile (column, row) in world units. The grid is centred on the origin. */
export function tileCenter(column, row, tileSize, tilesPerSide) {
  const half = tilesPerSide / 2;
  return [(column + 0.5 - half) * tileSize, (row + 0.5 - half) * tileSize];
}

export function tileId(column, row) {
  return `tile-${String(column).padStart(2, '0')}-${String(row).padStart(2, '0')}`;
}

/** Terrain height at a world position for a seed; the player path rides on it. */
export function terrainHeight(seed, worldX, worldZ) {
  return heightFunctionFor(seed)(worldX, worldZ);
}

/**
 * Build one tile as Float32 positions and normals and Uint32 triangles, in world coordinates. Pure and deterministic, so it
 * runs the same in a worker, in the page and in Node. `resolution` is the number of quads along one side.
 */
export function generateTile({ seed, column, row, tilesPerSide, tileSize, resolution }) {
  requireInteger(tilesPerSide, 'generateTile tilesPerSide', 1, CROSSING_LIMITS.maximumTilesPerSide);
  requireInteger(column, 'generateTile column', 0, tilesPerSide - 1);
  requireInteger(row, 'generateTile row', 0, tilesPerSide - 1);
  requireInteger(resolution, 'generateTile resolution', 1, CROSSING_LIMITS.maximumResolution);
  const height = heightFunctionFor(seed);
  const [centerX, centerZ] = tileCenter(column, row, tileSize, tilesPerSide);
  const side = resolution + 1;
  const step = tileSize / resolution;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  for (let rowIndex = 0; rowIndex < side; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < side; columnIndex += 1) {
      const worldX = centerX - tileSize / 2 + columnIndex * step;
      const worldZ = centerZ - tileSize / 2 + rowIndex * step;
      const offset = (rowIndex * side + columnIndex) * 3;
      positions[offset] = worldX;
      positions[offset + 1] = height(worldX, worldZ);
      positions[offset + 2] = worldZ;
      // Central differences over the shared field, so neighbouring tiles agree on their border normals.
      const slopeX = (height(worldX + step, worldZ) - height(worldX - step, worldZ)) / (2 * step);
      const slopeZ = (height(worldX, worldZ + step) - height(worldX, worldZ - step)) / (2 * step);
      const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
      normals[offset] = -slopeX * inverseLength;
      normals[offset + 1] = inverseLength;
      normals[offset + 2] = -slopeZ * inverseLength;
    }
  }
  const indices = new Uint32Array(resolution * resolution * 6);
  let cursor = 0;
  for (let rowIndex = 0; rowIndex < resolution; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < resolution; columnIndex += 1) {
      const topLeft = rowIndex * side + columnIndex;
      const bottomLeft = topLeft + side;
      indices.set([topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1], cursor);
      cursor += 6;
    }
  }
  return { positions, normals, indices };
}

export function tileBytes(geometry) {
  return geometry.positions.byteLength + geometry.normals.byteLength + geometry.indices.byteLength;
}

/** Bytes a tile level takes, known before it loads, so the streaming budget can reserve them. */
export function estimatedTileBytes(resolution) {
  const vertices = (resolution + 1) ** 2;
  return vertices * 6 * 4 + resolution * resolution * 6 * 4;
}

/** A gentle S curve from one corner region to the opposite one, as waypoints [x, z]. The path stays inside the grid. */
export function createCrossingPath(settings) {
  const extent = settings.tilesPerSide * settings.tileSize / 2 - settings.tileSize;
  const waypoints = [];
  for (let index = 0; index <= 8; index += 1) {
    const fraction = index / 8;
    const sway = Math.sin(fraction * Math.PI * 2) * extent * 0.3;
    waypoints.push([-extent + 2 * extent * fraction, -extent + 2 * extent * fraction + sway]);
  }
  return waypoints;
}

/**
 * The streamed asset definitions, the scripted path across the world and the settings that produced them. `source` encodes
 * the tile and its resolution, so a loader needs nothing else.
 */
export function createCrossingWorld(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('createCrossingWorld options must be an object or left out.');
  const settings = { ...CROSSING_DEFAULTS, ...options };
  requireInteger(settings.seed, 'createCrossingWorld seed', 0, 2 ** 31 - 1);
  requireInteger(settings.tilesPerSide, 'createCrossingWorld tilesPerSide', 2, CROSSING_LIMITS.maximumTilesPerSide);
  if (!Number.isFinite(settings.tileSize) || settings.tileSize <= 0) throw new RangeError('createCrossingWorld tileSize must be a positive number of world units.');
  requirePlayerSpeed(settings.playerSpeed, 'createCrossingWorld playerSpeed');
  for (const resolution of settings.levelResolutions) requireInteger(resolution, 'createCrossingWorld levelResolutions entry', 1, CROSSING_LIMITS.maximumResolution);
  if (settings.levelDistances.length !== settings.levelResolutions.length - 1) {
    throw new RangeError('createCrossingWorld levelDistances needs one distance fewer than levelResolutions: the last level has no end.');
  }
  const assets = [];
  for (let row = 0; row < settings.tilesPerSide; row += 1) {
    for (let column = 0; column < settings.tilesPerSide; column += 1) {
      const [centerX, centerZ] = tileCenter(column, row, settings.tileSize, settings.tilesPerSide);
      assets.push({
        id: tileId(column, row),
        format: 'terrain-tile',
        position: [centerX, 0, centerZ],
        loadDistance: settings.loadDistance,
        levels: settings.levelResolutions.map((resolution, level) => ({
          source: `tile:${settings.seed}:${column}:${row}:${resolution}:${settings.tilesPerSide}:${settings.tileSize}`,
          estimatedBytes: estimatedTileBytes(resolution),
          maximumDistance: settings.levelDistances[level],
        })),
      });
    }
  }
  return { settings, assets, path: createCrossingPath(settings) };
}

/** Position along the waypoints after `distance` world units travelled, held at the end. Ground height is added by the caller. */
export function pathPosition(waypoints, distance) {
  let remaining = Math.max(0, distance);
  for (let index = 1; index < waypoints.length; index += 1) {
    const [fromX, fromZ] = waypoints[index - 1];
    const [toX, toZ] = waypoints[index];
    const length = Math.hypot(toX - fromX, toZ - fromZ);
    if (remaining <= length) {
      const fraction = length === 0 ? 0 : remaining / length;
      return { x: fromX + (toX - fromX) * fraction, z: fromZ + (toZ - fromZ) * fraction, headingX: (toX - fromX) / length, headingZ: (toZ - fromZ) / length };
    }
    remaining -= length;
  }
  const [lastX, lastZ] = waypoints[waypoints.length - 1];
  const [beforeX, beforeZ] = waypoints[waypoints.length - 2];
  const length = Math.hypot(lastX - beforeX, lastZ - beforeZ);
  return { x: lastX, z: lastZ, headingX: (lastX - beforeX) / length, headingZ: (lastZ - beforeZ) / length };
}

export function pathLength(waypoints) {
  let total = 0;
  for (let index = 1; index < waypoints.length; index += 1) {
    total += Math.hypot(waypoints[index][0] - waypoints[index - 1][0], waypoints[index][1] - waypoints[index - 1][1]);
  }
  return total;
}

/** The runtime system that walks the path at a constant speed and exposes the player position, one update per frame. */
export function createPathPlayer({ waypoints, seed, speed, eyeHeight }) {
  const total = pathLength(waypoints);
  const state = { distance: 0, finished: false, position: [0, 0, 0], heading: [1, 0] };
  function place() {
    const { x, z, headingX, headingZ } = pathPosition(waypoints, state.distance);
    state.position = [x, terrainHeight(seed, x, z) + eyeHeight, z];
    state.heading = [headingX, headingZ];
  }
  place();
  return {
    name: 'path-player',
    state,
    total,
    update(deltaSeconds) {
      state.distance = Math.min(total, state.distance + speed * deltaSeconds);
      state.finished = state.distance >= total;
      place();
    },
  };
}

/** Parse the source string made by createCrossingWorld back into the arguments of generateTile. */
export function parseTileSource(source) {
  const [prefix, seed, column, row, resolution, tilesPerSide, tileSize] = String(source).split(':');
  if (prefix !== 'tile' || tileSize === undefined) {
    throw new RangeError(`Tile source must look like "tile:<seed>:<column>:<row>:<resolution>:<tilesPerSide>:<tileSize>", got "${source}".`);
  }
  return { seed: Number(seed), column: Number(column), row: Number(row), resolution: Number(resolution), tilesPerSide: Number(tilesPerSide), tileSize: Number(tileSize) };
}
