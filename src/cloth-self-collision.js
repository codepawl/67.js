// Particle-to-particle contact for cloth that folds over itself. Particles closer than twice the radius push each other
// apart, except two joined by an edge, which the stretch springs already hold. A spatial hash keeps the pass near linear;
// particles and cells are visited in index order, so the result is the same on every run.

export const SELF_COLLISION_LIMITS = Object.freeze({ maxParticles: 5000, workPerParticle: 2, pairsPerParticle: 64 });

function cellKey(x, y, z) {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
}

/** Edge keys (`low * particleCount + high`) of the stretch constraints, so joined particles are skipped. */
export function connectedPairs(constraints, particleCount) {
  const pairs = new Set();
  for (let constraint = 0; constraint < constraints.stretchCount; constraint++) {
    const first = constraints.firsts[constraint];
    const second = constraints.seconds[constraint];
    pairs.add(first < second ? first * particleCount + second : second * particleCount + first);
  }
  return pairs;
}

/** The longest radius that cannot fight the edge springs: half the shortest edge. */
export function maxSelfCollisionRadius(constraints) {
  let shortest = Infinity;
  for (let constraint = 0; constraint < constraints.stretchCount; constraint++) {
    shortest = Math.min(shortest, constraints.restLengths[constraint]);
  }
  return shortest / 2;
}

export function createSelfCollision(radius, particleCount, joined) {
  const cellSize = radius * 2;
  const reach = radius * 2;
  const cells = new Map();
  const cellOf = new Int32Array(particleCount * 3);
  // The cells are fixed for a substep, so the pairs that can touch are listed once and the solver iterations only test their distance.
  const pairCapacity = particleCount * SELF_COLLISION_LIMITS.pairsPerParticle;
  let pairs = new Int32Array(Math.min(pairCapacity, particleCount * 8) * 2);
  let pairCount = 0;
  function addPair(first, second) {
    if (pairCount >= pairCapacity) return;
    if ((pairCount + 1) * 2 > pairs.length) {
      const grown = new Int32Array(Math.min(pairCapacity, pairCount * 2) * 2);
      grown.set(pairs);
      pairs = grown;
    }
    pairs[pairCount * 2] = first;
    pairs[pairCount * 2 + 1] = second;
    pairCount++;
  }
  return {
    /** Sort the particles into cells and list the candidate pairs; call once per substep. */
    build(positions) {
      cells.clear();
      for (let particle = 0; particle < particleCount; particle++) {
        const x = Math.floor(positions[particle * 3] / cellSize);
        const y = Math.floor(positions[particle * 3 + 1] / cellSize);
        const z = Math.floor(positions[particle * 3 + 2] / cellSize);
        cellOf[particle * 3] = x;
        cellOf[particle * 3 + 1] = y;
        cellOf[particle * 3 + 2] = z;
        const key = cellKey(x, y, z);
        const members = cells.get(key);
        if (members) members.push(particle);
        else cells.set(key, [particle]);
      }
      pairCount = 0;
      for (let particle = 0; particle < particleCount; particle++) {
        const cx = cellOf[particle * 3];
        const cy = cellOf[particle * 3 + 1];
        const cz = cellOf[particle * 3 + 2];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const members = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
              if (!members) continue;
              for (const other of members) {
                if (other <= particle) continue;
                if (joined.has(particle * particleCount + other)) continue;
                addPair(particle, other);
              }
            }
          }
        }
      }
    },
    /** Push apart every listed pair that is closer than the contact distance. */
    solve(positions, inverseMasses) {
      for (let pair = 0; pair < pairCount; pair++) {
        separate(positions, inverseMasses, pairs[pair * 2], pairs[pair * 2 + 1], reach);
      }
    },
  };
}

function separate(positions, inverseMasses, first, second, reach) {
  const a = first * 3;
  const b = second * 3;
  const dx = positions[b] - positions[a];
  const dy = positions[b + 1] - positions[a + 1];
  const dz = positions[b + 2] - positions[a + 2];
  const distanceSquared = dx * dx + dy * dy + dz * dz;
  if (distanceSquared >= reach * reach || distanceSquared < 1e-18) return;
  const weightSum = inverseMasses[first] + inverseMasses[second];
  if (weightSum === 0) return;
  const distance = Math.sqrt(distanceSquared);
  const correction = (reach - distance) / distance / weightSum;
  positions[a] -= dx * correction * inverseMasses[first];
  positions[a + 1] -= dy * correction * inverseMasses[first];
  positions[a + 2] -= dz * correction * inverseMasses[first];
  positions[b] += dx * correction * inverseMasses[second];
  positions[b + 1] += dy * correction * inverseMasses[second];
  positions[b + 2] += dz * correction * inverseMasses[second];
}
