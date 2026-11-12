// Deterministic large scenes for the sequence bench, built straight as FORMAT-v2 scene descriptors (`{ materials, instances }`) so they pass
// the package API and not the 400,000 triangle cap of `buildTraceScene`.
//   terrain: one subdivided, rippled surface of about `triangles` triangles under an emissive ceiling panel, plus one small box that moves.
//   forest:  one 10,000 triangle mesh instanced `instanceCount` times over a ground quad, plus a lamp; one instance moves.
import { createCamera } from '../../src/path-tracer.js';

const FLOOR_MATERIAL = 0;
const LAMP_MATERIAL = 1;
const BOX_MATERIAL = 2;
const MOVING_PART_STEPS = [-1.5, 1.5];

function translationMatrix(x, y, z, scale = 1) {
  return [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1];
}

function rippleHeight(x, z) {
  return 0.35 * Math.sin(0.7 * x) * Math.cos(0.7 * z);
}

// A square grid of `cells` by `cells` quads over [-half, half] on x and z, two triangles per quad.
export function buildRippledGrid(cells, half, heightOf = rippleHeight) {
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const step = (2 * half) / cells;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const x = -half + column * step;
      const z = -half + row * step;
      const vertex = row * side + column;
      positions.set([x, heightOf(x, z), z], vertex * 3);
      const slopeX = (heightOf(x + step, z) - heightOf(x - step, z)) / (2 * step);
      const slopeZ = (heightOf(x, z + step) - heightOf(x, z - step)) / (2 * step);
      const length = Math.hypot(slopeX, 1, slopeZ);
      normals.set([-slopeX / length, 1 / length, -slopeZ / length], vertex * 3);
      uvs.set([column / cells, row / cells], vertex * 2);
    }
  }
  const indices = new Uint32Array(cells * cells * 6);
  let cursor = 0;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const topLeft = row * side + column;
      const bottomLeft = topLeft + side;
      indices.set([topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1], cursor);
      cursor += 6;
    }
  }
  return { positions, normals, uvs, colors: new Float32Array(side * side * 3).fill(1), indices };
}

const UNIT_SQUARE = {
  positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
};
const LAMP_SQUARE = { ...UNIT_SQUARE, normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };

const MATERIALS = [
  { color: [0.55, 0.52, 0.48], roughness: 0.8 },
  { color: [1, 0.95, 0.9], emission: 6, roughness: 1 },
  { color: [0.8, 0.25, 0.2], roughness: 0.5 },
];

/** The scene descriptor with the moving instance at `step` (0 or 1) of its two placements. */
export function buildLargeScene(kind, size, step) {
  const movingX = MOVING_PART_STEPS[step];
  if (kind === 'terrain') {
    const cells = Math.round(Math.sqrt(size / 2));
    const terrain = buildRippledGrid(cells, 10);
    return { materials: MATERIALS, instances: [
      { geometry: terrain, matrix: translationMatrix(0, 0, 0), materialIndex: FLOOR_MATERIAL },
      { geometry: LAMP_SQUARE, matrix: translationMatrix(0, 7, 0, 4), materialOverride: LAMP_MATERIAL },
      { geometry: UNIT_SQUARE, matrix: translationMatrix(movingX, 1.2, 0, 0.8), materialOverride: BOX_MATERIAL },
    ] };
  }
  if (kind === 'forest') {
    const tree = buildRippledGrid(Math.round(Math.sqrt(10000 / 2)), 0.8, (x, z) => 0.4 * Math.cos(2.1 * x) * Math.sin(2.1 * z));
    const side = Math.ceil(Math.sqrt(size));
    const instances = [
      { geometry: UNIT_SQUARE, matrix: translationMatrix(0, -0.1, 0, side * 1.1), materialIndex: FLOOR_MATERIAL },
      { geometry: LAMP_SQUARE, matrix: translationMatrix(0, 9, 0, side * 0.5), materialOverride: LAMP_MATERIAL },
    ];
    for (let index = 0; index < size; index++) {
      const column = index % side;
      const row = Math.floor(index / side);
      const offsetX = (column - side / 2) * 2.2 + (index === 0 ? movingX : 0);
      const height = 0.2 + ((index * 2654435761) % 1000) / 1000 * 0.8;
      instances.push({ geometry: tree, matrix: translationMatrix(offsetX, height, (row - side / 2) * 2.2), materialIndex: BOX_MATERIAL });
    }
    return { materials: MATERIALS, instances };
  }
  throw new RangeError(`Unknown large scene "${kind}": pass terrain or forest.`);
}

/** The camera for orbit frame `frameIndex` of `frameCount`, a quarter turn around the scene. */
export function orbitCameraFor(kind, size, frameIndex, frameCount, imageWidth, imageHeight) {
  const radius = kind === 'forest' ? Math.sqrt(size) * 1.6 : 14;
  const angle = (Math.PI / 2) * frameIndex / Math.max(1, frameCount - 1) + Math.PI / 4;
  const eye = [radius * Math.sin(angle), radius * 0.45, radius * Math.cos(angle)];
  return createCamera({ eye, target: [0, 0, 0], fov: 50, near: 0.05, far: 500 }, imageWidth, imageHeight);
}

export function describeLargeScene(kind, size) {
  if (kind === 'terrain') return { kind, uniqueTriangles: 2 * Math.round(Math.sqrt(size / 2)) ** 2, instances: 3 };
  return { kind, uniqueTriangles: 2 * Math.round(Math.sqrt(10000 / 2)) ** 2, instances: size + 2 };
}
