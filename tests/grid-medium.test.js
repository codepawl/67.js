import assert from 'node:assert/strict';
import test from 'node:test';
import { createGridMedium } from '../src/grid-medium.js';

const OPEN_SPACE = { trace: () => ({ nearestTriangle: -1, nearestDistance: Infinity }) };
const WALLED_IN = { trace: () => ({ nearestTriangle: 0, nearestDistance: 0.5 }) };
const FOG_BOX = { density: 0.5, minimum: [-10, -10, -10], maximum: [10, 10, 10], color: [1, 0.5, 0.25], anisotropy: 0, maxDistance: 100 };
const SUN = { color: [2, 2, 2], direction: [0, 1, 0] };

function runLeg(medium, distance, sample = 5) {
  const origin = [0, 0, 0];
  const direction = [1, 0, 0];
  const throughput = [1, 1, 1];
  const sum = [0, 0, 0];
  const scattered = medium(origin, direction, distance, throughput, sum, 3, sample, 0);
  return { scattered, origin, direction, throughput, sum };
}

test('lighting without fog gives no medium', () => {
  assert.equal(createGridMedium({ lighting: {}, sun: SUN, tracer: OPEN_SPACE, scale: 1 }), null);
  assert.equal(createGridMedium({ lighting: { volumeFog: { density: 0 } }, sun: SUN, tracer: OPEN_SPACE, scale: 1 }), null);
});

test('a leg scatters with the probability a photon would and the path goes on from the point', () => {
  const medium = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: SUN, tracer: OPEN_SPACE, scale: 1 });
  const distance = 2;
  const trials = 4000;
  let scatterCount = 0;
  for (let sample = 0; sample < trials; sample++) {
    const leg = runLeg(medium, distance, sample);
    if (!leg.scattered) {
      assert.deepEqual(leg.throughput, [1, 1, 1]);
      assert.deepEqual(leg.origin, [0, 0, 0]);
      continue;
    }
    scatterCount++;
    assert.ok(leg.origin[0] > 0 && leg.origin[0] < distance, 'the point lies inside the leg');
    assert.ok(Math.abs(Math.hypot(...leg.direction) - 1) < 1e-9, 'the new direction is a unit vector');
    FOG_BOX.color.forEach((albedo, channel) => assert.ok(Math.abs(leg.throughput[channel] - albedo) < 1e-12));
    // Isotropic phase is 1 / (4 pi), so the sun adds throughput times albedo times its colour over 4 pi.
    FOG_BOX.color.forEach((albedo, channel) => assert.ok(Math.abs(leg.sum[channel] - albedo * 2 / (4 * Math.PI)) < 1e-12));
  }
  const expectedShare = 1 - Math.exp(-0.5 * distance);
  assert.ok(Math.abs(scatterCount / trials - expectedShare) < 0.03, `${scatterCount / trials} against ${expectedShare}`);
});

test('a shadowed sun adds nothing, and a leg outside the box is untouched', () => {
  const shadowed = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: SUN, tracer: WALLED_IN, scale: 1 });
  for (let sample = 0; sample < 50; sample++) {
    assert.deepEqual(runLeg(shadowed, 2, sample).sum, [0, 0, 0]);
  }
  const outside = createGridMedium({ lighting: { volumeFog: { ...FOG_BOX, minimum: [20, 20, 20], maximum: [30, 30, 30] } }, sun: SUN, tracer: OPEN_SPACE, scale: 1 });
  const leg = runLeg(outside, 2);
  assert.equal(leg.scattered, false);
  assert.deepEqual(leg.throughput, [1, 1, 1]);
  assert.deepEqual(leg.sum, [0, 0, 0]);
});

test('a forward scattering fog keeps the path closer to its direction than a backward one', () => {
  const meanCosine = anisotropy => {
    const medium = createGridMedium({ lighting: { volumeFog: { ...FOG_BOX, anisotropy } }, sun: null, tracer: OPEN_SPACE, scale: 1 });
    let total = 0;
    let count = 0;
    for (let sample = 0; sample < 2000; sample++) {
      const leg = runLeg(medium, 20, sample);
      if (leg.scattered) {
        total += leg.direction[0];
        count++;
      }
    }
    return total / count;
  };
  assert.ok(Math.abs(meanCosine(0.6) - 0.6) < 0.05);
  assert.ok(Math.abs(meanCosine(-0.6) + 0.6) < 0.05);
});
