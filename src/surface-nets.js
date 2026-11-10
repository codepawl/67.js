// Surface nets on a regular grid of signed distances (negative inside): one vertex in each cell the surface crosses,
// one quad around each crossing grid edge. Shared by the voxel remesh and the sdf geometry.

const CELL_CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const CELL_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/** One vertex per crossed cell, at the mean of the edge crossings. Returns the cell-to-vertex map and positions. */
export function placeCellVertices(distances, grid, origin) {
  const [pointsX, pointsY, pointsZ] = grid.points;
  const cellsX = pointsX - 1;
  const cellsY = pointsY - 1;
  const cellVertex = new Int32Array(cellsX * cellsY * (pointsZ - 1)).fill(-1);
  const positions = [];
  const values = new Float64Array(8);
  for (let z = 0; z < pointsZ - 1; z++) {
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        let negative = 0;
        for (let corner = 0; corner < 8; corner++) {
          const [dx, dy, dz] = CELL_CORNERS[corner];
          values[corner] = distances[((z + dz) * pointsY + y + dy) * pointsX + x + dx];
          if (values[corner] < 0) negative++;
        }
        if (negative === 0 || negative === 8) continue;
        const sum = [0, 0, 0];
        let crossings = 0;
        for (const [start, end] of CELL_EDGES) {
          if ((values[start] < 0) === (values[end] < 0)) continue;
          const fraction = values[start] / (values[start] - values[end]);
          for (let axis = 0; axis < 3; axis++) {
            sum[axis] += CELL_CORNERS[start][axis] + fraction * (CELL_CORNERS[end][axis] - CELL_CORNERS[start][axis]);
          }
          crossings++;
        }
        cellVertex[(z * cellsY + y) * cellsX + x] = positions.length / 3;
        positions.push(
          origin[0] + (x + sum[0] / crossings) * grid.edge,
          origin[1] + (y + sum[1] / crossings) * grid.edge,
          origin[2] + (z + sum[2] / crossings) * grid.edge,
        );
      }
    }
  }
  return { cellVertex, positions };
}

// For each axis, its two other axes in cyclic order (u, v). Seen from the positive axis, the four cells around an
// edge run counterclockwise through (-1,-1), (0,-1), (0,0), (-1,0) in (u, v).
const AXIS_BASES = [[1, 2], [2, 0], [0, 1]];
const QUAD_OFFSETS = [[-1, -1], [0, -1], [0, 0], [-1, 0]];

/** One quad of cell vertices per grid edge that crosses the surface, wound so the normal points outward. */
export function quadsAroundEdges(distances, grid, cellVertex) {
  const cellsPerAxis = grid.points.map(count => count - 1);
  const [pointsX, pointsY, pointsZ] = grid.points;
  const strides = [1, pointsX, pointsX * pointsY];
  const quads = [];
  const point = [0, 0, 0];
  for (let z = 0; z < pointsZ; z++) {
    for (let y = 0; y < pointsY; y++) {
      for (let x = 0; x < pointsX; x++) {
        point[0] = x;
        point[1] = y;
        point[2] = z;
        const index = (z * pointsY + y) * pointsX + x;
        for (let axis = 0; axis < 3; axis++) {
          const [u, v] = AXIS_BASES[axis];
          if (point[axis] + 1 >= grid.points[axis] || point[u] === 0 || point[v] === 0) continue;
          const here = distances[index];
          if ((here < 0) === (distances[index + strides[axis]] < 0)) continue;
          const quad = QUAD_OFFSETS.map(([stepU, stepV]) => cellVertexAt(cellVertex, cellsPerAxis, point, axis, u, v, stepU, stepV));
          if (quad.includes(-1)) continue;
          quads.push(here < 0 ? quad : quad.reverse());
        }
      }
    }
  }
  return quads;
}

function cellVertexAt(cellVertex, cellsPerAxis, point, axis, u, v, stepU, stepV) {
  const cell = [point[0], point[1], point[2]];
  cell[u] += stepU;
  cell[v] += stepV;
  if (cell[0] >= cellsPerAxis[0] || cell[1] >= cellsPerAxis[1] || cell[2] >= cellsPerAxis[2]) return -1;
  return cellVertex[(cell[2] * cellsPerAxis[1] + cell[1]) * cellsPerAxis[0] + cell[0]];
}
