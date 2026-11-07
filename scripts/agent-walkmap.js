import { createSceneQuery, walkableMask } from '../src/scene-query.js';

const MAXIMUM_LISTED_CELLS = 4096;

function matrixChecksum(parts) {
  let total = 0;
  for (const part of parts) {
    for (let index = 0; index < 16; index++) total += part.matrix[index] * (index + 1);
  }
  return total;
}

/** Imported asset scenes list their own surfaces; a recipe scene's parts already hold geometry, a world matrix and a material. */
function queryPartsOf(scene) {
  if (typeof scene.queryParts === 'function') return scene.queryParts();
  return scene.parts.map(part => ({ id: part.name, geometry: part.geometry, matrix: part.matrix, material: part.material?.id }));
}

/** One cached scene query per session. It is rebuilt when the revision or any part matrix (a seeked pose) changes. */
export function sceneQueryFor(record) {
  const parts = queryPartsOf(record.scene);
  const key = `${record.scene.revision}:${parts.length}:${matrixChecksum(parts)}`;
  if (record.sceneQueryKey !== key) {
    record.sceneQuery?.dispose();
    record.sceneQuery = createSceneQuery(parts);
    record.sceneQueryKey = key;
  }
  return record.sceneQuery;
}

/** keepOut and streetY switch obstacle marking on; without either the map is the plain ground and headroom one. */
export function walkOptionsFor(options, keepOut, streetY) {
  if (keepOut === undefined && streetY === undefined) return options;
  return { ...options, obstacles: streetY === undefined ? true : { streetY } };
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

/** Turns the raw cells into text rows an agent can read: '.' walkable, 'x' blocked, '#' no surface. */
export function summarizeWalkMap(map, { clearance, groundRange, keepOut, includeCells }) {
  const { columns, rows, cellSize, min } = map;
  const mask = walkableMask(map, { clearance, groundRange, keepOut });
  const grid = Array.from({ length: rows }, () => Array(columns).fill('#'));
  const listed = [];
  for (const [x, z, groundY, headroom] of map.cells) {
    const column = Math.round((x - min[0]) / cellSize);
    const row = Math.round((z - min[1]) / cellSize);
    grid[row][column] = 'x';
    listed.push([x, z, rounded(groundY), rounded(headroom)]);
  }
  // Closing can open a cell that had no surface (a seam), so walkable cells are marked from the mask alone.
  let walkable = 0;
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      if (!mask[column * rows + row]) continue;
      grid[row][column] = '.';
      walkable++;
    }
  }
  if (includeCells && listed.length > MAXIMUM_LISTED_CELLS) {
    throw new RangeError(`includeCells lists at most ${MAXIMUM_LISTED_CELLS} cells and this region has ${listed.length} with a surface. Shrink the region or raise cellSize.`);
  }
  return {
    cellSize, min, columns, rows, surfaceCells: map.cells.length, walkableCells: walkable,
    legend: { '.': 'walkable', x: 'ground with too little headroom, an obstacle, outside groundRange or within keepOut', '#': 'no surface' },
    grid: grid.map(row => row.join('')),
    ...(includeCells ? { cells: listed } : {}),
  };
}

// Query-only load path: raycasts and walk maps over a catalog GLB that is too big to render through MCP. The server strips
// its textures and sends the file once; this page parses geometry only and keeps one scene query, with no render targets.
// Every number is a ceiling the agent cannot raise.
export const QUERY_ASSET_LIMITS = Object.freeze({
  maxVertices: 6_000_000,
  maxTriangles: 6_000_000,
  maxParts: 16_384,
  // Per part BVH budget; the mesh query itself refuses a part over 1,000,000 triangles.
  memoryBudgetMiB: 256,
});

/** One loaded scene at a time, keyed by the catalog asset ID. Without `bytes` an unknown asset answers `needsData`. */
export function createQueryOnlyCache(parseGltf) {
  let current = null;
  async function load(bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const asset = await parseGltf(buffer, { maxBytes: bytes.length + 1024, maxVertices: QUERY_ASSET_LIMITS.maxVertices, maxParts: QUERY_ASSET_LIMITS.maxParts });
    let triangles = 0;
    for (const part of asset.parts) triangles += part.geometry.indices.length / 3;
    if (triangles > QUERY_ASSET_LIMITS.maxTriangles) {
      throw new RangeError(`Query-only asset has ${triangles} triangles, over the query maxTriangles ${QUERY_ASSET_LIMITS.maxTriangles}. Split it or decimate it.`);
    }
    const parts = asset.parts.map((part, position) => ({ id: part.name ?? `part-${position}`, geometry: part.geometry, matrix: part.matrix, material: part.material?.id }));
    return { query: createSceneQuery(parts, { memoryBudgetMiB: QUERY_ASSET_LIMITS.memoryBudgetMiB }), parts: parts.length, triangles };
  }
  return Object.freeze({
    async walkMap({ assetId, bytes, clearance = 2, groundRange, keepOut, streetY, includeCells = false, ...options }) {
      const started = performance.now();
      if (current?.assetId !== assetId) {
        if (!bytes) return { needsData: true };
        current?.scene.query.dispose();
        current = null;
        current = { assetId, scene: await load(bytes) };
      }
      const { query, parts, triangles } = current.scene;
      const map = query.walkMap(walkOptionsFor(options, keepOut, streetY));
      return {
        assetId, queryOnly: true, parts, triangles,
        ...summarizeWalkMap(map, { clearance, groundRange, keepOut, includeCells }),
        skippedParts: query.skipped.length, milliseconds: Math.round(performance.now() - started),
      };
    },
    dispose() {
      current?.scene.query.dispose();
      current = null;
    },
  });
}
