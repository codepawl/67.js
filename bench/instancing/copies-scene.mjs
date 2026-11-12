// The scene of the instancing benches and the equivalence test: N copies of one small mesh placed on a grid.
// A variant sets how the copies are placed: translate, rotscale (rotated, non-uniform scale), mirror (negative
// determinant), mirror-rotscale, emissive (translate, with one emissive material), emissive-rotscale (the same rotated and stretched), or
// emissive-degenerate (emissive, on a mesh whose first triangle has no area, so emissive entries skip it).
export const COPY_VARIANTS = ['translate', 'rotscale', 'mirror', 'mirror-rotscale', 'emissive', 'emissive-rotscale', 'emissive-degenerate'];

function midpoint(positions, first, second) {
  return [0, 1, 2].map(axis => (positions[first * 3 + axis] + positions[second * 3 + axis]) / 2);
}

// An icosphere: 20 triangles, each split in four per level, so level 2 has 320.
function icosphere(levels) {
  const golden = (1 + Math.sqrt(5)) / 2;
  let positions = [-1, golden, 0, 1, golden, 0, -1, -golden, 0, 1, -golden, 0, 0, -1, golden, 0, 1, golden, 0, -1, -golden, 0, 1, -golden, golden, 0, -1, golden, 0, 1, -golden, 0, -1, -golden, 0, 1];
  let indices = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let level = 0; level < levels; level++) {
    const next = [];
    const cache = new Map();
    const middle = (first, second) => {
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      if (!cache.has(key)) {
        cache.set(key, positions.length / 3);
        positions = positions.concat(midpoint(positions, first, second));
      }
      return cache.get(key);
    };
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const [a, b, c] = indices.slice(triangle, triangle + 3);
      const ab = middle(a, b);
      const bc = middle(b, c);
      const ca = middle(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }
  const unit = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const length = Math.hypot(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
    for (let axis = 0; axis < 3; axis++) unit[vertex * 3 + axis] = positions[vertex * 3 + axis] / length;
  }
  return { positions: unit, normals: Float32Array.from(unit), indices: Uint32Array.from(indices) };
}

const MATERIALS = [
  { color: [0.8, 0.25, 0.2], roughness: 0.5 },
  { color: [0.2, 0.6, 0.85], roughness: 0.3, metallic: 0.8 },
  { color: [0.85, 0.8, 0.3], roughness: 0.7 },
];
const EMISSIVE_MATERIAL = { color: [1, 0.6, 0.2], roughness: 0.7, emission: 4 };

// Column-major matrix of a rotation about a unit axis, times a per-axis scale, moved by `translation`.
function transformMatrix(scales, angle, translation) {
  const axis = [0.3, 0.8, 0.5];
  const length = Math.hypot(...axis);
  const [x, y, z] = axis.map(value => value / length);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const rotation = [
    [cosine + x * x * (1 - cosine), x * y * (1 - cosine) - z * sine, x * z * (1 - cosine) + y * sine],
    [y * x * (1 - cosine) + z * sine, cosine + y * y * (1 - cosine), y * z * (1 - cosine) - x * sine],
    [z * x * (1 - cosine) - y * sine, z * y * (1 - cosine) + x * sine, cosine + z * z * (1 - cosine)],
  ];
  const column = axisIndex => [0, 1, 2].map(row => rotation[row][axisIndex] * scales[axisIndex]);
  return [...column(0), 0, ...column(1), 0, ...column(2), 0, ...translation, 1];
}

function scalesFor(variant, index) {
  const uniform = 0.3 + 0.1 * ((index * 7) % 5) / 4;
  const mirrored = variant.startsWith('mirror');
  const stretched = variant.endsWith('rotscale');
  const stretch = stretched ? [1.4, 0.7, 1 + 0.1 * (index % 3)] : [1, 1, 1];
  return stretch.map((factor, axis) => uniform * factor * (mirrored && axis === 0 ? -1 : 1));
}

function buildParts(geometry, variant, copyCount) {
  const side = Math.ceil(Math.cbrt(copyCount));
  const rotates = variant.endsWith('rotscale');
  return Array.from({ length: copyCount }, (_, index) => {
    const column = index % side;
    const row = Math.floor(index / side) % side;
    const layer = Math.floor(index / (side * side));
    const translation = [(column - side / 2) * 1.1, (row - side / 2) * 1.1, -layer * 1.1];
    const matrix = transformMatrix(scalesFor(variant, index), rotates ? 0.4 + index * 0.37 : 0, translation);
    const material = variant.startsWith('emissive') && index % 4 === 0 ? EMISSIVE_MATERIAL : MATERIALS[index % MATERIALS.length];
    return { name: `copy-${index}`, geometry, matrix, material };
  });
}


export function buildCopyScene(variant, copyCount) {
  if (!COPY_VARIANTS.includes(variant)) throw new RangeError(`Pass one of ${COPY_VARIANTS.join(', ')} as the variant.`);
  const sphere = icosphere(2);
  const geometry = variant === 'emissive-degenerate' ? { ...sphere, indices: Uint32Array.from([0, 0, 0, ...sphere.indices]) } : sphere;
  return { geometry, parts: buildParts(geometry, variant, copyCount), environment: { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] } };
}
