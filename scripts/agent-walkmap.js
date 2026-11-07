import { createSceneQuery } from '../src/scene-query.js';

const MAXIMUM_LISTED_CELLS = 4096;

function matrixChecksum(parts) {
  let total = 0;
  for (const part of parts) {
    for (let index = 0; index < 16; index++) total += part.matrix[index] * (index + 1);
  }
  return total;
}

/** One cached scene query per session. It is rebuilt when the revision or any part matrix (a seeked pose) changes. */
export function sceneQueryFor(record) {
  const parts = record.scene.queryParts();
  const key = `${record.scene.revision}:${parts.length}:${matrixChecksum(parts)}`;
  if (record.sceneQueryKey !== key) {
    record.sceneQuery?.dispose();
    record.sceneQuery = createSceneQuery(parts);
    record.sceneQueryKey = key;
  }
  return record.sceneQuery;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

/** Turns the raw cells into text rows an agent can read: '.' walkable, 'x' blocked, '#' no surface. */
export function summarizeWalkMap(map, { clearance, groundRange, includeCells }) {
  const { columns, rows, cellSize, min } = map;
  const grid = Array.from({ length: rows }, () => Array(columns).fill('#'));
  let walkable = 0;
  const listed = [];
  for (const [x, z, groundY, headroom] of map.cells) {
    const column = Math.round((x - min[0]) / cellSize);
    const row = Math.round((z - min[1]) / cellSize);
    const inRange = !groundRange || (groundY >= groundRange[0] && groundY <= groundRange[1]);
    const open = headroom >= clearance && inRange;
    grid[row][column] = open ? '.' : 'x';
    if (open) walkable++;
    listed.push([x, z, rounded(groundY), rounded(headroom)]);
  }
  if (includeCells && listed.length > MAXIMUM_LISTED_CELLS) {
    throw new RangeError(`includeCells lists at most ${MAXIMUM_LISTED_CELLS} cells and this region has ${listed.length} with a surface. Shrink the region or raise cellSize.`);
  }
  return {
    cellSize, min, columns, rows, surfaceCells: map.cells.length, walkableCells: walkable,
    legend: { '.': 'walkable', x: 'ground with too little headroom or outside groundRange', '#': 'no surface' },
    grid: grid.map(row => row.join('')),
    ...(includeCells ? { cells: listed } : {}),
  };
}
