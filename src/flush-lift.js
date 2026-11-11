import { determinantSign } from './flush-search.js';
import { flushOrderOf } from './depth-layer.js';

// The flush pass (flush-resolve.js) orders two faces on one plane with a rank, a depth bias at draw time. A ray has no such bias:
// where the pass ranked two faces instead of cutting one away, the rays see both at the same distance and the face behind may win
// the pixel. The path tracer lifts each ranked triangle along its front normal by the same step the rasteriser uses (one rank is
// 0.1 mm plus 2^-19 of the largest coordinate), so the face in front is hit first. Vertices are copied for a ranked triangle, since a
// vertex may be shared by triangles of different ranks.
const RANK_STEP = 1e-4;
const RANK_RELATIVE_STEP = 2 ** -19;

/** The rank of every triangle of the geometry a part is traced with (see `traceGeometryOf`), or null when none is above zero. */
function ranksOfTracedGeometry(order) {
  if (!order) return null;
  if (order.geometry) {
    const ranks = new Uint8Array(order.geometry.indices.length / 3);
    for (const { start, count, rank } of order.ranges) ranks.fill(rank, start / 3, (start + count) / 3);
    return ranks;
  }
  return order.triangleRanks;
}

function averageScale(matrix) {
  const lengths = [0, 4, 8].map(column => Math.hypot(matrix[column], matrix[column + 1], matrix[column + 2]));
  return (lengths[0] + lengths[1] + lengths[2]) / 3 || 1;
}

function largestCoordinate(positions, matrix, scale) {
  let largest = 0;
  for (const value of positions) largest = Math.max(largest, Math.abs(value));
  return largest * scale + Math.max(Math.abs(matrix[12]), Math.abs(matrix[13]), Math.abs(matrix[14]));
}

/**
 * Returns `geometry` with every triangle ranked above zero moved toward its front by rank steps, on copied vertices. A part
 * with no ranked triangle returns the same geometry object.
 */
export function liftRankedTriangles(part, geometry) {
  const order = flushOrderOf(part);
  const ranks = ranksOfTracedGeometry(order);
  if (!ranks || !ranks.some(rank => rank > 0)) return geometry;
  const matrix = part.matrix;
  const scale = averageScale(matrix);
  const step = (RANK_STEP + largestCoordinate(geometry.positions, matrix, scale) * RANK_RELATIVE_STEP) / scale;
  const flip = determinantSign(matrix);
  const { positions, indices } = geometry;
  const vertexCount = positions.length / 3;
  const liftedTriangles = ranks.reduce((count, rank) => count + (rank > 0 ? 1 : 0), 0);
  const copied = { positions: new Float32Array((vertexCount + liftedTriangles * 3) * 3), indices: Uint32Array.from(indices) };
  copied.positions.set(positions);
  const optional = ['normals', 'uvs', 'colors'].filter(name => geometry[name]);
  const widths = { normals: 3, uvs: 2, colors: 3 };
  for (const name of optional) {
    copied[name] = new Float32Array((vertexCount + liftedTriangles * 3) * widths[name]);
    copied[name].set(geometry[name]);
  }
  let nextVertex = vertexCount;
  for (let triangle = 0; triangle < ranks.length; triangle++) {
    if (ranks[triangle] === 0) continue;
    const corners = [0, 1, 2].map(corner => indices[triangle * 3 + corner]);
    const [first, second, third] = corners.map(vertex => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]]);
    const edgeOne = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
    const edgeTwo = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
    const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const length = Math.hypot(...normal) || 1;
    const distance = ranks[triangle] * step * flip / length;
    corners.forEach((vertex, corner) => {
      const target = nextVertex++;
      for (let axis = 0; axis < 3; axis++) copied.positions[target * 3 + axis] = positions[vertex * 3 + axis] + normal[axis] * distance;
      for (const name of optional) {
        const width = widths[name];
        for (let slot = 0; slot < width; slot++) copied[name][target * width + slot] = geometry[name][vertex * width + slot];
      }
      copied.indices[triangle * 3 + corner] = target;
    });
  }
  return { ...geometry, ...copied };
}
