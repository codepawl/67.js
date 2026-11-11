// The noise pushes the faded edge of a local volume in and out (issue 855), so a box or a sphere reads as a cloud and not as a rounded rectangle.
// The rasterizer's post shader repeats this rule and tests/local-volume-noise.test.js compares the two renderers on a noisy volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes, localVolumeProfile, warpedFadePosition, LOCAL_VOLUME_EDGE_WARP } from '../src/local-volumes.js';

test('the warp leaves the core and the outer face where they are and moves the middle of the fade by the noise', () => {
  for (const noise of [0, 0.3, 0.5, 0.9, 1]) {
    assert.equal(warpedFadePosition(0, 0.5, noise), 0);
    assert.equal(warpedFadePosition(1, 0.5, noise), 1);
  }
  assert.equal(warpedFadePosition(0.5, 0.5, 0.5), 0.5, 'a noise of one half is neutral');
  assert.equal(warpedFadePosition(0.5, 0, 0), 0.5, 'noiseAmount 0 is neutral');
  assert.ok(warpedFadePosition(0.5, 0.5, 0) > 0.5, 'low noise pushes the edge in');
  assert.ok(warpedFadePosition(0.5, 0.5, 1) < 0.5, 'high noise pushes the edge out');
  const largest = Math.abs(warpedFadePosition(0.5, 1, 0) - 0.5);
  assert.ok(Math.abs(largest - 0.5 * LOCAL_VOLUME_EDGE_WARP) < 1e-12, 'at most half of the fade width times the warp');
});

function topEdgeHeights(noiseAmount) {
  const [volume] = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [4, 4, 4], falloff: 0.85, noiseAmount, noiseScale: 1.5 }]);
  const heights = [];
  for (let x = -1; x <= 1; x += 0.1) {
    let height = 0;
    for (let y = 0; y < 2; y += 0.01) if (localVolumeProfile(volume, x, y, 0, true) > 0.3) height = y;
    heights.push(height);
  }
  return heights;
}

test('with noise the top edge of a box wanders away from the smooth dome the plain fade draws', () => {
  const noisy = topEdgeHeights(0.6);
  const plain = topEdgeHeights(0);
  const wander = Math.max(...noisy.map((height, index) => Math.abs(height - plain[index])));
  assert.ok(wander > 0.15, `the top edge moves by only ${wander} m from the plain dome`);
});

test('the warp never lets density past the outer face of the volume', () => {
  const [box, sphere] = resolveLocalVolumes([
    { shape: 'box', center: [0, 0, 0], size: [2, 2, 2], falloff: 0.9, noiseAmount: 1, noiseScale: 3 },
    { shape: 'sphere', center: [0, 0, 0], radius: 1, falloff: 0.9, noiseAmount: 1, noiseScale: 3 },
  ]);
  for (let step = 0; step < 200; step++) {
    const x = 1 + step * 0.001;
    assert.equal(localVolumeProfile(box, x, 0.1 * step % 1, 0.3), 0);
    assert.equal(localVolumeProfile(sphere, x, 0.1, 0.2), 0);
  }
  for (let step = 0; step < 100; step++) assert.ok(localVolumeProfile(box, 0.99999, step * 0.01, 0) < 1e-3, 'density fades to nothing at the face');
});
