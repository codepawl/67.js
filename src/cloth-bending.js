// Dihedral bending for cloth (Muller et al., "Position Based Dynamics", 2007, section 4.7). The distance bend of cloth.js ties the two far
// corners of an edge's triangles together, which gives one hard crease or a smooth tent. This one holds the angle between the two triangle
// normals at its rest value, so a sheet rolls into many soft folds and stays smooth between them.

export const BEND_MODELS = Object.freeze(['distance', 'dihedral']);

const FLAT_SINE = 1e-6;

function cross(out, offset, ax, ay, az, bx, by, bz) {
  out[offset] = ay * bz - az * by;
  out[offset + 1] = az * bx - ax * bz;
  out[offset + 2] = ax * by - ay * bx;
}

/** Normal-to-normal angle of one quad (shared edge `first`-`second`, far corners `third` and `fourth`), 0 for a flat pair. */
function quadAngle(positions, quad) {
  const [first, second, third, fourth] = quad;
  const base = first * 3;
  const edge = [positions[second * 3] - positions[base], positions[second * 3 + 1] - positions[base + 1], positions[second * 3 + 2] - positions[base + 2]];
  const toThird = [positions[third * 3] - positions[base], positions[third * 3 + 1] - positions[base + 1], positions[third * 3 + 2] - positions[base + 2]];
  const toFourth = [positions[fourth * 3] - positions[base], positions[fourth * 3 + 1] - positions[base + 1], positions[fourth * 3 + 2] - positions[base + 2]];
  const normalOne = [0, 0, 0];
  const normalTwo = [0, 0, 0];
  cross(normalOne, 0, ...edge, ...toThird);
  cross(normalTwo, 0, ...edge, ...toFourth);
  const lengthOne = Math.hypot(...normalOne);
  const lengthTwo = Math.hypot(...normalTwo);
  if (lengthOne < 1e-18 || lengthTwo < 1e-18) return null;
  const cosine = (normalOne[0] * normalTwo[0] + normalOne[1] * normalTwo[1] + normalOne[2] * normalTwo[2]) / (lengthOne * lengthTwo);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * One bend constraint per interior edge shared by two triangles: { count, quads (4 particles each, shared edge first), restAngles,
 * stiffnesses, ofEdge }. `edgeEntries` are the sorted { first, second, opposites } edges of buildConstraints, so `ofEdge[edge]`
 * is the constraint across that edge (-1 where it has none).
 */
export function buildDihedrals(positions, edgeEntries, stiffness, stiffnessWeights) {
  const quads = [];
  const restAngles = [];
  const stiffnesses = [];
  const ofEdge = new Int32Array(edgeEntries.length).fill(-1);
  edgeEntries.forEach((entry, edge) => {
    if (entry.opposites.length !== 2 || entry.opposites[0] === entry.opposites[1]) return;
    const quad = [entry.first, entry.second, entry.opposites[0], entry.opposites[1]];
    const angle = quadAngle(positions, quad);
    if (angle === null) return;
    ofEdge[edge] = restAngles.length;
    quads.push(...quad);
    restAngles.push(angle);
    stiffnesses.push(stiffnessWeights ? stiffness * Math.min(...quad.map(particle => stiffnessWeights[particle])) : stiffness);
  });
  return { count: restAngles.length, quads: Uint32Array.from(quads), restAngles: Float64Array.from(restAngles), stiffnesses: Float64Array.from(stiffnesses), ofEdge };
}

const gradients = new Float64Array(12);

// Gradients of the normal cosine with respect to the four corners, written into `gradients`; returns the cosine, or null when a triangle is degenerate.
// Written in scalars: this runs for every edge, every iteration, every substep.
function cosineGradients(positions, quads, offset) {
  const base = quads[offset] * 3;
  const second = quads[offset + 1] * 3;
  const third = quads[offset + 2] * 3;
  const fourth = quads[offset + 3] * 3;
  const ex = positions[second] - positions[base];
  const ey = positions[second + 1] - positions[base + 1];
  const ez = positions[second + 2] - positions[base + 2];
  const tx = positions[third] - positions[base];
  const ty = positions[third + 1] - positions[base + 1];
  const tz = positions[third + 2] - positions[base + 2];
  const fx = positions[fourth] - positions[base];
  const fy = positions[fourth + 1] - positions[base + 1];
  const fz = positions[fourth + 2] - positions[base + 2];
  const c1x = ey * tz - ez * ty;
  const c1y = ez * tx - ex * tz;
  const c1z = ex * ty - ey * tx;
  const c2x = ey * fz - ez * fy;
  const c2y = ez * fx - ex * fz;
  const c2z = ex * fy - ey * fx;
  const lengthOne = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const lengthTwo = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);
  if (lengthOne < 1e-18 || lengthTwo < 1e-18) return null;
  const n1x = c1x / lengthOne;
  const n1y = c1y / lengthOne;
  const n1z = c1z / lengthOne;
  const n2x = c2x / lengthTwo;
  const n2y = c2y / lengthTwo;
  const n2z = c2z / lengthTwo;
  const cosine = Math.min(1, Math.max(-1, n1x * n2x + n1y * n2y + n1z * n2z));
  // e x n1 and e x n2
  const ax = ey * n1z - ez * n1y;
  const ay = ez * n1x - ex * n1z;
  const az = ex * n1y - ey * n1x;
  const bx = ey * n2z - ez * n2y;
  const by = ez * n2x - ex * n2z;
  const bz = ex * n2y - ey * n2x;
  // t x n1, t x n2, f x n1, f x n2
  const tn1x = ty * n1z - tz * n1y;
  const tn1y = tz * n1x - tx * n1z;
  const tn1z = tx * n1y - ty * n1x;
  const tn2x = ty * n2z - tz * n2y;
  const tn2y = tz * n2x - tx * n2z;
  const tn2z = tx * n2y - ty * n2x;
  const fn1x = fy * n1z - fz * n1y;
  const fn1y = fz * n1x - fx * n1z;
  const fn1z = fx * n1y - fy * n1x;
  const fn2x = fy * n2z - fz * n2y;
  const fn2y = fz * n2x - fx * n2z;
  const fn2z = fx * n2y - fy * n2x;
  const q3x = (bx - cosine * ax) / lengthOne;
  const q3y = (by - cosine * ay) / lengthOne;
  const q3z = (bz - cosine * az) / lengthOne;
  const q4x = (ax - cosine * bx) / lengthTwo;
  const q4y = (ay - cosine * by) / lengthTwo;
  const q4z = (az - cosine * bz) / lengthTwo;
  const q2x = -(tn2x - cosine * tn1x) / lengthOne - (fn1x - cosine * fn2x) / lengthTwo;
  const q2y = -(tn2y - cosine * tn1y) / lengthOne - (fn1y - cosine * fn2y) / lengthTwo;
  const q2z = -(tn2z - cosine * tn1z) / lengthOne - (fn1z - cosine * fn2z) / lengthTwo;
  gradients[0] = -(q2x + q3x + q4x);
  gradients[1] = -(q2y + q3y + q4y);
  gradients[2] = -(q2z + q3z + q4z);
  gradients[3] = q2x;
  gradients[4] = q2y;
  gradients[5] = q2z;
  gradients[6] = q3x;
  gradients[7] = q3y;
  gradients[8] = q3z;
  gradients[9] = q4x;
  gradients[10] = q4y;
  gradients[11] = q4z;
  return cosine;
}

/** One Gauss-Seidel pass over every dihedral constraint: moves the four corners so the normals' angle returns toward its rest value. */
export function solveDihedrals(positions, inverseMasses, dihedrals) {
  const { count, quads, restAngles, stiffnesses } = dihedrals;
  for (let constraint = 0; constraint < count; constraint++) {
    const stiffness = stiffnesses[constraint];
    if (stiffness === 0) continue;
    const offset = constraint * 4;
    const cosine = cosineGradients(positions, quads, offset);
    if (cosine === null) continue;
    const sine = Math.sqrt(1 - cosine * cosine);
    if (sine < FLAT_SINE) continue;
    let weightedSquares = 0;
    for (let corner = 0; corner < 4; corner++) {
      weightedSquares += inverseMasses[quads[offset + corner]] * (gradients[corner * 3] ** 2 + gradients[corner * 3 + 1] ** 2 + gradients[corner * 3 + 2] ** 2);
    }
    if (weightedSquares < 1e-18) continue;
    const scale = -sine * (Math.acos(cosine) - restAngles[constraint]) / weightedSquares * stiffness;
    for (let corner = 0; corner < 4; corner++) {
      const weight = inverseMasses[quads[offset + corner]];
      if (weight === 0) continue;
      const index = quads[offset + corner] * 3;
      positions[index] += scale * weight * gradients[corner * 3];
      positions[index + 1] += scale * weight * gradients[corner * 3 + 1];
      positions[index + 2] += scale * weight * gradients[corner * 3 + 2];
    }
  }
}

/**
 * Bending plasticity: a fold keeps its crease like fabric does. Where a constraint's angle is further than `yieldAngle` from its rest
 * angle, the rest angle moves `setRate` of the excess toward the current angle, so the cloth stops pulling that fold flat. Call it once
 * per substep. The rest angle is always an angle the sheet has had, so it stays between 0 and pi.
 */
export function setDihedralCreases(positions, dihedrals, yieldAngle, setRate) {
  const { count, quads, restAngles, stiffnesses } = dihedrals;
  for (let constraint = 0; constraint < count; constraint++) {
    if (stiffnesses[constraint] === 0) continue;
    const cosine = cosineGradients(positions, quads, constraint * 4);
    if (cosine === null) continue;
    const deviation = Math.acos(cosine) - restAngles[constraint];
    const excess = Math.abs(deviation) - yieldAngle;
    if (excess > 0) restAngles[constraint] += Math.sign(deviation) * excess * setRate;
  }
}
