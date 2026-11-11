import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloth, bakeCloth } from '../src/cloth.js';
import { createSelfCollision, connectedPairs, SELF_COLLISION_LIMITS } from '../src/cloth-self-collision.js';
import { BEND_MODELS, buildDihedrals, solveDihedrals } from '../src/cloth-bending.js';

// A grid of `segments` squares a side in the XZ plane, two triangles a square, 1 m across.
function grid(segments) {
  const side = segments + 1;
  const positions = new Float64Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      positions.set([column / segments, 0, row / segments], (row * side + column) * 3);
    }
  }
  const triangles = [];
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const corner = row * side + column;
      triangles.push(corner, corner + side, corner + 1, corner + 1, corner + side, corner + side + 1);
    }
  }
  return { positions, triangles: Uint32Array.from(triangles) };
}

function dihedralOf(sheet) {
  const edges = new Map();
  for (let corner = 0; corner < sheet.triangles.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = sheet.triangles[corner + side];
      const second = sheet.triangles[corner + (side + 1) % 3];
      const key = Math.min(first, second) * 100000 + Math.max(first, second);
      const entry = edges.get(key) ?? { first: Math.min(first, second), second: Math.max(first, second), opposites: [] };
      entry.opposites.push(sheet.triangles[corner + (side + 2) % 3]);
      edges.set(key, entry);
    }
  }
  return buildDihedrals(sheet.positions, [...edges.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry), 1, null);
}

test('a flat sheet has dihedral rest angles of pi (the normals as the solver builds them face opposite ways) and the solver leaves it alone', () => {
  const sheet = grid(3);
  const dihedrals = dihedralOf(sheet);
  assert.equal(dihedrals.count, 21);
  assert.ok(dihedrals.restAngles.every(angle => Math.abs(angle - Math.PI) < 1e-9));
  const before = Float64Array.from(sheet.positions);
  solveDihedrals(sheet.positions, new Float64Array(sheet.positions.length / 3).fill(1), dihedrals);
  assert.deepEqual(sheet.positions, before);
});

test('the dihedral solver pulls a folded pair of triangles back toward flat and keeps the momentum of the corners', () => {
  const positions = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0.5, 0.6, -1]);
  const flat = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0.5, 0, -1]);
  const dihedrals = buildDihedrals(flat, [{ first: 0, second: 1, opposites: [2, 3] }], 1, null);
  assert.equal(dihedrals.count, 1);
  const weights = new Float64Array(4).fill(1);
  const momentum = corners => [0, 1, 2].map(axis => [0, 1, 2, 3].reduce((sum, particle) => sum + corners[particle * 3 + axis], 0));
  // The angle between the two triangle normals as the solver measures it: pi for a flat pair, smaller as the pair folds.
  const foldOf = corners => {
    const edge = [corners[3] - corners[0], corners[4] - corners[1], corners[5] - corners[2]];
    const crossWithEdge = vector => [edge[1] * vector[2] - edge[2] * vector[1], edge[2] * vector[0] - edge[0] * vector[2], edge[0] * vector[1] - edge[1] * vector[0]];
    const one = crossWithEdge([corners[6] - corners[0], corners[7] - corners[1], corners[8] - corners[2]]);
    const two = crossWithEdge([corners[9] - corners[0], corners[10] - corners[1], corners[11] - corners[2]]);
    const cosine = (one[0] * two[0] + one[1] * two[1] + one[2] * two[2]) / (Math.hypot(...one) * Math.hypot(...two));
    return Math.PI - Math.acos(cosine);
  };
  assert.ok(foldOf(positions) > 0.5, 'the starting pair is folded');
  const startFold = foldOf(positions);
  const startMomentum = momentum(positions);
  for (let pass = 0; pass < 4; pass++) solveDihedrals(positions, weights, dihedrals);
  assert.ok(foldOf(positions) < startFold * 0.01, `the fold shrinks from ${startFold} to ${foldOf(positions)}`);
  momentum(positions).forEach((value, axis) => assert.ok(Math.abs(value - startMomentum[axis]) < 1e-9, 'the correction moves the corners by amounts that sum to zero'));
});

test('a pinned corner is never moved by the dihedral solver', () => {
  const flat = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 0, 1, 0.5, 0, -1]);
  const dihedrals = buildDihedrals(flat, [{ first: 0, second: 1, opposites: [2, 3] }], 1, null);
  const bent = Float64Array.from([0, 0, 0, 1, 0, 0, 0.5, 0.4, 1, 0.5, 0.4, -1]);
  const weights = Float64Array.from([0, 1, 1, 1]);
  solveDihedrals(bent, weights, dihedrals);
  assert.deepEqual([...bent.slice(0, 3)], [0, 0, 0]);
});

test('a hanging sheet with dihedral bending bakes the same frames twice and folds softer than the distance bend', () => {
  const sheet = grid(10);
  const options = { pinned: [0, 10], bend: 0.3, bendModel: 'dihedral', frameCount: 60, framesPerSecond: 60, thickness: 0.002 };
  const first = bakeCloth(sheet.positions, sheet.triangles, options);
  const second = bakeCloth(sheet.positions, sheet.triangles, options);
  assert.deepEqual(first.frames, second.frames);
  assert.ok(first.frames.every(Number.isFinite));
  assert.ok(first.constraintCount < bakeCloth(sheet.positions, sheet.triangles, { ...options, bendModel: 'distance' }).constraintCount, 'dihedral bending adds no distance constraints across the edges');
});

test('dihedral bending can tear with its edge and an unknown bend model names the fix', () => {
  const sheet = grid(2);
  const cloth = createCloth(sheet.positions, sheet.triangles, { bendModel: 'dihedral', bend: 0.5, tearStretch: 1.5 });
  for (let edge = 0; edge < 12; edge++) cloth.breakConstraint(edge);
  assert.ok(cloth.broken.some(entry => entry.kind === 'bend'));
  assert.throws(() => createCloth(sheet.positions, sheet.triangles, { bendModel: 'tent' }), new RegExp(`bendModel must be one of ${BEND_MODELS.join(', ')}; found tent`));
});

test('self collision lists its pairs once per substep and accepts a sheet over the old 2000 particle limit', () => {
  assert.equal(SELF_COLLISION_LIMITS.maxParticles, 5000);
  const sheet = grid(60);
  const particleCount = sheet.positions.length / 3;
  assert.ok(particleCount > 2000);
  const cloth = createCloth(sheet.positions, sheet.triangles, { selfCollision: { radius: 0.004 }, frameCount: 4 });
  cloth.step(1 / 60);
  assert.ok(cloth.positions.every(Number.isFinite));
});

test('self collision pushes two unjoined particles apart and skips joined ones', () => {
  const start = [0, 0, 0, 0.001, 0, 0];
  const weights = new Float64Array(2).fill(1);
  const joinedPositions = Float64Array.from(start);
  const joinedContacts = createSelfCollision(0.01, 2, new Set([1]));
  joinedContacts.build(joinedPositions);
  joinedContacts.solve(joinedPositions, weights);
  assert.deepEqual([...joinedPositions], start, 'two particles joined by an edge stay where the springs hold them');
  const freePositions = Float64Array.from(start);
  const freeContacts = createSelfCollision(0.01, 2, new Set());
  freeContacts.build(freePositions);
  freeContacts.solve(freePositions, weights);
  assert.ok(freePositions[3] - freePositions[0] > 0.0199, `unjoined particles end the contact distance (0.02 m) apart, got ${freePositions[3] - freePositions[0]}`);
  assert.ok(connectedPairs({ stretchCount: 1, firsts: [0], seconds: [1] }, 3).has(1));
});

// The solver as it was on main before the pair list: walks the cells on every iteration. Kept here as the byte for byte reference.
function referenceSelfCollision(radius, particleCount, joined) {
  const cellSize = radius * 2;
  const cells = new Map();
  const cellOf = new Int32Array(particleCount * 3);
  const cellKey = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  return {
    build(positions) {
      cells.clear();
      for (let particle = 0; particle < particleCount; particle++) {
        for (let axis = 0; axis < 3; axis++) cellOf[particle * 3 + axis] = Math.floor(positions[particle * 3 + axis] / cellSize);
        const key = cellKey(cellOf[particle * 3], cellOf[particle * 3 + 1], cellOf[particle * 3 + 2]);
        const members = cells.get(key);
        if (members) members.push(particle);
        else cells.set(key, [particle]);
      }
    },
    solve(positions, inverseMasses) {
      const reach = radius * 2;
      for (let particle = 0; particle < particleCount; particle++) {
        const [cx, cy, cz] = [cellOf[particle * 3], cellOf[particle * 3 + 1], cellOf[particle * 3 + 2]];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              for (const other of cells.get(cellKey(cx + dx, cy + dy, cz + dz)) ?? []) {
                if (other <= particle || joined.has(particle * particleCount + other)) continue;
                pushApart(positions, inverseMasses, particle, other, reach);
              }
            }
          }
        }
      }
    },
  };
}

function pushApart(positions, inverseMasses, first, second, reach) {
  const delta = [0, 1, 2].map(axis => positions[second * 3 + axis] - positions[first * 3 + axis]);
  const distanceSquared = delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2];
  const weightSum = inverseMasses[first] + inverseMasses[second];
  if (distanceSquared >= reach * reach || distanceSquared < 1e-18 || weightSum === 0) return;
  const distance = Math.sqrt(distanceSquared);
  const correction = (reach - distance) / distance / weightSum;
  for (let axis = 0; axis < 3; axis++) {
    positions[first * 3 + axis] -= delta[axis] * correction * inverseMasses[first];
    positions[second * 3 + axis] += delta[axis] * correction * inverseMasses[second];
  }
}

test('the pair list gives exactly the positions the per-iteration cell walk gave', () => {
  const particleCount = 300;
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const start = new Float64Array(particleCount * 3).map(() => random() * 0.12);
  const inverseMasses = new Float64Array(particleCount).map((_, index) => (index % 7 === 0 ? 0 : 1 + (index % 3)));
  const joined = new Set([1, 2, 3, 40]);
  const listed = Float64Array.from(start);
  const walked = Float64Array.from(start);
  const listedContacts = createSelfCollision(0.01, particleCount, joined);
  const walkedContacts = referenceSelfCollision(0.01, particleCount, joined);
  for (let substep = 0; substep < 3; substep++) {
    listedContacts.build(listed);
    walkedContacts.build(walked);
    for (let iteration = 0; iteration < 4; iteration++) {
      listedContacts.solve(listed, inverseMasses);
      walkedContacts.solve(walked, inverseMasses);
    }
  }
  assert.notDeepEqual([...listed], [...start], 'the cluster really had contacts to resolve');
  assert.deepEqual([...listed], [...walked]);
});

test('self collision throws, naming the radius, when particles pile past the pair limit instead of dropping contacts', () => {
  const particleCount = 200;
  const pile = new Float64Array(particleCount * 3);
  for (let particle = 0; particle < particleCount; particle++) pile[particle * 3] = particle * 1e-6;
  const contacts = createSelfCollision(0.01, particleCount, new Set());
  assert.throws(() => contacts.build(pile), /selfCollision found more than 12800 particle pairs.*smaller selfCollision radius/);
});

test('a recipe sheet takes bendModel and rejects an unknown one with the field and the choices', async () => {
  const { createAgentScene } = await import('../src/agent-scene.js');
  await import('./support/load-agent-scene-modules.mjs');
  const { foldingFlagRecipe } = await import('../scripts/soft-body-film.mjs');
  const recipe = foldingFlagRecipe();
  recipe.geometries[0].segments = 6;
  recipe.cloth.sheets[0].bendModel = 'tent';
  assert.throws(() => createAgentScene(recipe), /cloth\.sheets\[0\]\.bendModel.*tent.*distance, dihedral/);
  recipe.cloth.sheets[0].bendModel = 'dihedral';
  recipe.cloth.sheets[0].bend = 0.15;
  assert.ok(createAgentScene(recipe).parts.some(part => part.name === 'flag'));
});
