import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloth } from '../src/cloth.js';

const GROUND = { kind: 'box', center: [0, -1, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], halfExtents: [5, 1, 5] };
const SPACING = 0.1;
const SIDE = 5;

// Two separate 5 by 5 sheets, the second hung 0.15 m straight above the first, so they land on each other.
function twoStackedSheets() {
  const perSheet = SIDE * SIDE;
  const positions = new Float32Array(perSheet * 2 * 3);
  const triangles = [];
  for (let sheet = 0; sheet < 2; sheet++) {
    const height = 0.05 + sheet * 0.15;
    for (let row = 0; row < SIDE; row++) {
      for (let column = 0; column < SIDE; column++) {
        positions.set([column * SPACING, height, row * SPACING], (sheet * perSheet + row * SIDE + column) * 3);
      }
    }
    for (let row = 0; row < SIDE - 1; row++) {
      for (let column = 0; column < SIDE - 1; column++) {
        const corner = sheet * perSheet + row * SIDE + column;
        triangles.push(corner, corner + SIDE, corner + SIDE + 1, corner, corner + SIDE + 1, corner + 1);
      }
    }
  }
  return { positions, triangles: Uint32Array.from(triangles), perSheet };
}

function restingGap(options) {
  const { positions, triangles, perSheet } = twoStackedSheets();
  const cloth = createCloth(positions, triangles, { colliders: [GROUND], selfCollision: true, damping: 3, ...options });
  for (let step = 0; step < 240; step++) cloth.step(1 / 60);
  const middle = (SIDE * SIDE - 1) / 2;
  return cloth.positions[(perSheet + middle) * 3 + 1] - cloth.positions[middle * 3 + 1];
}

test('a sheet that sets its thickness stacks layers 2 x thickness apart; without it the layers keep the mesh-based gap', () => {
  const byDefault = restingGap({});
  const thin = restingGap({ thickness: 0.01 });
  assert.ok(Math.abs(byDefault - SPACING * 0.9) < 0.01, `default layers rest ${byDefault} m apart, near 0.9 x the edge length`);
  assert.ok(Math.abs(thin - 0.02) < 0.004, `thickness 0.01 layers rest ${thin} m apart, near 0.02`);
});

test('a thickness beyond half the shortest edge is capped, so layers never fight the edge springs', () => {
  const capped = restingGap({ thickness: 0.4 });
  assert.ok(capped <= SPACING + 1e-3, `layers rest ${capped} m apart, at most one edge length`);
});

test('the thick-layer bake is deterministic', () => {
  assert.equal(restingGap({ thickness: 0.01 }), restingGap({ thickness: 0.01 }));
});
