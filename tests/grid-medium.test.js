import assert from 'node:assert/strict';
import test from 'node:test';
import { createGridMedium } from '../src/grid-medium.js';

const OPEN_SPACE = { trace: () => ({ nearestTriangle: -1, nearestDistance: Infinity }) };
const WALLED_IN = { trace: () => ({ nearestTriangle: 0, nearestDistance: 0.5 }) };
const FOG_BOX = { density: 0.5, minimum: [-10, -10, -10], maximum: [10, 10, 10], color: [1, 0.5, 0.25], anisotropy: 0, maxDistance: 100 };
const SUN = { color: [2, 2, 2], direction: [0, 1, 0] };

function runLeg(medium, distance) {
  const throughput = [1, 1, 1];
  const sum = [0, 0, 0];
  medium([0, 0, 0], [1, 0, 0], distance, throughput, sum, 3, 5, 0);
  return { throughput, sum };
}

test('lighting without fog gives no medium', () => {
  assert.equal(createGridMedium({ lighting: {}, sun: SUN, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: null }), null);
  assert.equal(createGridMedium({ lighting: { volumeFog: { density: 0 } }, sun: SUN, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: null }), null);
});

test('a leg through fog is dimmed by its transmittance and gains the single scattered sun', () => {
  const medium = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: SUN, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: null });
  const { throughput, sum } = runLeg(medium, 2);
  const transmittance = Math.exp(-0.5 * 2);
  for (const value of throughput) assert.ok(Math.abs(value - transmittance) < 1e-12);
  // Isotropic phase is 1 / (4 pi), whatever point of the leg scatters.
  FOG_BOX.color.forEach((albedo, channel) => {
    const expected = (1 - transmittance) * albedo * 2 / (4 * Math.PI);
    assert.ok(Math.abs(sum[channel] - expected) < 1e-12, `channel ${channel}: ${sum[channel]} against ${expected}`);
  });
});

test('a shadowed sun scatters nothing, and a leg outside the box is untouched', () => {
  const shadowed = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: SUN, tracer: WALLED_IN, scale: 1, surfaceRadiance: null });
  assert.deepEqual(runLeg(shadowed, 2).sum, [0, 0, 0]);
  const outside = createGridMedium({ lighting: { volumeFog: { ...FOG_BOX, minimum: [20, 20, 20], maximum: [30, 30, 30] } }, sun: SUN, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: null });
  const { throughput, sum } = runLeg(outside, 2);
  assert.deepEqual(throughput, [1, 1, 1]);
  assert.deepEqual(sum, [0, 0, 0]);
});

test('fog also scatters the light of the surface it sees, in proportion to it', () => {
  const dim = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: null, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: (point, direction, out) => out.fill(0.5) });
  const bright = createGridMedium({ lighting: { volumeFog: FOG_BOX }, sun: null, tracer: OPEN_SPACE, scale: 1, surfaceRadiance: (point, direction, out) => out.fill(1) });
  const dimSum = runLeg(dim, 2).sum;
  const brightSum = runLeg(bright, 2).sum;
  assert.ok(dimSum[0] > 0);
  assert.ok(Math.abs(brightSum[0] / dimSum[0] - 2) < 1e-9);
});
