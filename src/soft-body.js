// Soft body terms for the position-based cloth solver: shape matching (Muller et al., "Meshless Deformations Based on
// Shape Matching", 2005) and a volume constraint that holds pressure in a closed mesh. Both are fixed-order sums with no
// random numbers, so a soft body bakes to the same frames every time.

export const SOFT_BODY_LIMITS = Object.freeze({ maxPressure: 3, rotationIterations: 20 });

/** Throws unless every edge of the triangle list is shared by exactly two triangles, naming the first open edge. */
export function assertClosedMesh(triangles, particleCount) {
  const uses = new Map();
  for (let corner = 0; corner < triangles.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = triangles[corner + side];
      const second = triangles[corner + (side + 1) % 3];
      const key = first < second ? first * particleCount + second : second * particleCount + first;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of uses) {
    if (count !== 2) {
      const low = Math.floor(key / particleCount);
      const high = key - low * particleCount;
      throw new RangeError(`Cloth softBody.pressure needs a closed mesh, but the edge between particles ${low} and ${high} is used by ${count} triangle(s). Close the holes, or set pressure to 0 and keep only shape matching.`);
    }
  }
}

/** Signed volume of a closed triangle list (positive when the triangles wind outward). */
export function signedVolume(positions, triangles) {
  let volume = 0;
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const a = triangles[corner] * 3;
    const b = triangles[corner + 1] * 3;
    const c = triangles[corner + 2] * 3;
    volume += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      + positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  return volume;
}

/**
 * Pushes the volume toward `pressure` times the rest volume. `gradients` is a scratch array the size of `positions`.
 * Particles with no inverse mass do not move.
 */
export function solveVolume(positions, triangles, inverseMasses, restVolume, pressure, gradients) {
  gradients.fill(0);
  let volume = 0;
  for (let corner = 0; corner < triangles.length; corner += 3) {
    const a = triangles[corner] * 3;
    const b = triangles[corner + 1] * 3;
    const c = triangles[corner + 2] * 3;
    const bcX = positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1];
    const bcY = positions[b + 2] * positions[c] - positions[b] * positions[c + 2];
    const bcZ = positions[b] * positions[c + 1] - positions[b + 1] * positions[c];
    const caX = positions[c + 1] * positions[a + 2] - positions[c + 2] * positions[a + 1];
    const caY = positions[c + 2] * positions[a] - positions[c] * positions[a + 2];
    const caZ = positions[c] * positions[a + 1] - positions[c + 1] * positions[a];
    const abX = positions[a + 1] * positions[b + 2] - positions[a + 2] * positions[b + 1];
    const abY = positions[a + 2] * positions[b] - positions[a] * positions[b + 2];
    const abZ = positions[a] * positions[b + 1] - positions[a + 1] * positions[b];
    volume += (positions[a] * bcX + positions[a + 1] * bcY + positions[a + 2] * bcZ) / 6;
    gradients[a] += bcX / 6;
    gradients[a + 1] += bcY / 6;
    gradients[a + 2] += bcZ / 6;
    gradients[b] += caX / 6;
    gradients[b + 1] += caY / 6;
    gradients[b + 2] += caZ / 6;
    gradients[c] += abX / 6;
    gradients[c + 1] += abY / 6;
    gradients[c + 2] += abZ / 6;
  }
  let denominator = 0;
  for (let particle = 0; particle < inverseMasses.length; particle++) {
    const offset = particle * 3;
    denominator += inverseMasses[particle] * (gradients[offset] ** 2 + gradients[offset + 1] ** 2 + gradients[offset + 2] ** 2);
  }
  if (denominator < 1e-18) return;
  const scale = -(volume - pressure * restVolume) / denominator;
  for (let particle = 0; particle < inverseMasses.length; particle++) {
    const weight = inverseMasses[particle] * scale;
    if (weight === 0) continue;
    positions[particle * 3] += gradients[particle * 3] * weight;
    positions[particle * 3 + 1] += gradients[particle * 3 + 1] * weight;
    positions[particle * 3 + 2] += gradients[particle * 3 + 2] * weight;
  }
}

function rotationMatrix(quaternion, matrix) {
  const [x, y, z, w] = quaternion;
  matrix[0] = 1 - 2 * (y * y + z * z); matrix[1] = 2 * (x * y - z * w); matrix[2] = 2 * (x * z + y * w);
  matrix[3] = 2 * (x * y + z * w); matrix[4] = 1 - 2 * (x * x + z * z); matrix[5] = 2 * (y * z - x * w);
  matrix[6] = 2 * (x * z - y * w); matrix[7] = 2 * (y * z + x * w); matrix[8] = 1 - 2 * (x * x + y * y);
}

// Muller et al., "A Robust Method to Extract the Rotational Part of Deformations" (2016), warm-started from `quaternion`.
function extractRotation(covariance, quaternion, matrix) {
  for (let iteration = 0; iteration < SOFT_BODY_LIMITS.rotationIterations; iteration++) {
    rotationMatrix(quaternion, matrix);
    let crossX = 0;
    let crossY = 0;
    let crossZ = 0;
    let dot = 0;
    for (let column = 0; column < 3; column++) {
      const rx = matrix[column]; const ry = matrix[3 + column]; const rz = matrix[6 + column];
      const ax = covariance[column]; const ay = covariance[3 + column]; const az = covariance[6 + column];
      crossX += ry * az - rz * ay;
      crossY += rz * ax - rx * az;
      crossZ += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const scale = 1 / (Math.abs(dot) + 1e-9);
    const omegaX = crossX * scale;
    const omegaY = crossY * scale;
    const omegaZ = crossZ * scale;
    const angle = Math.hypot(omegaX, omegaY, omegaZ);
    if (angle < 1e-9) break;
    const half = Math.sin(angle / 2) / angle;
    const dx = omegaX * half;
    const dy = omegaY * half;
    const dz = omegaZ * half;
    const dw = Math.cos(angle / 2);
    const [x, y, z, w] = quaternion;
    quaternion[0] = dw * x + dx * w + dy * z - dz * y;
    quaternion[1] = dw * y - dx * z + dy * w + dz * x;
    quaternion[2] = dw * z + dx * y - dy * x + dz * w;
    quaternion[3] = dw * w - dx * x - dy * y - dz * z;
    const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    for (let index = 0; index < 4; index++) quaternion[index] /= length;
  }
  rotationMatrix(quaternion, matrix);
}

/** The rest shape a body is pulled back to: every particle's offset from the rest centre of mass. */
export function createShapeMatching(positions) {
  const particleCount = positions.length / 3;
  const center = [0, 0, 0];
  for (let particle = 0; particle < particleCount; particle++) {
    for (let axis = 0; axis < 3; axis++) center[axis] += positions[particle * 3 + axis] / particleCount;
  }
  const offsets = new Float64Array(positions.length);
  for (let particle = 0; particle < particleCount; particle++) {
    for (let axis = 0; axis < 3; axis++) offsets[particle * 3 + axis] = positions[particle * 3 + axis] - center[axis];
  }
  return { offsets, quaternion: [0, 0, 0, 1], matrix: new Float64Array(9), covariance: new Float64Array(9) };
}

/** Moves each free particle `stiffness` (0 to 1) of the way to where the best rigid fit of the rest shape puts it. */
export function solveShapeMatching(matching, positions, inverseMasses, stiffness) {
  const { offsets, quaternion, matrix, covariance } = matching;
  const particleCount = positions.length / 3;
  const center = [0, 0, 0];
  for (let particle = 0; particle < particleCount; particle++) {
    for (let axis = 0; axis < 3; axis++) center[axis] += positions[particle * 3 + axis] / particleCount;
  }
  covariance.fill(0);
  for (let particle = 0; particle < particleCount; particle++) {
    for (let row = 0; row < 3; row++) {
      const moved = positions[particle * 3 + row] - center[row];
      for (let column = 0; column < 3; column++) {
        covariance[row * 3 + column] += moved * offsets[particle * 3 + column];
      }
    }
  }
  extractRotation(covariance, quaternion, matrix);
  for (let particle = 0; particle < particleCount; particle++) {
    if (inverseMasses[particle] === 0) continue;
    for (let row = 0; row < 3; row++) {
      const goal = center[row] + matrix[row * 3] * offsets[particle * 3] + matrix[row * 3 + 1] * offsets[particle * 3 + 1] + matrix[row * 3 + 2] * offsets[particle * 3 + 2];
      positions[particle * 3 + row] += (goal - positions[particle * 3 + row]) * stiffness;
    }
  }
}
