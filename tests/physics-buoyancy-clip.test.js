import test from 'node:test';
import assert from 'node:assert/strict';
import { bakePhysicsScene, loadPhysicsEngine } from '../src/physics.js';
import { normalizeOcean, seaHeightAt } from '../src/physics-buoyancy.js';

// The clip's sea draws its surface at y = 0.5 (the top of a unit box base), so its recipe sets level 0.5.
const CLIP_SEA = { windSpeed: 4.5, choppiness: 0.4, size: 30, seed: 5, resolution: 5, level: 0.5 };
const FRAMES_PER_SECOND = 60;
const CRATE_SIDE = 0.9;

test.before(() => loadPhysicsEngine({ buoyancy: true }));

test('crates with the clip settings float at their density and never stay sunk', () => {
  const sea = normalizeOcean(CLIP_SEA);
  for (const density of [250, 450, 600]) {
    const definition = {
      ocean: CLIP_SEA,
      bodies: [{ name: 'crate', translation: [-3.2, 1.2, 2.2], float: {} }],
      colliders: [{ name: 'crate', body: 'crate', shape: 'cuboid', halfExtents: [CRATE_SIDE / 2, CRATE_SIDE / 2, CRATE_SIDE / 2], density }],
    };
    const scene = bakePhysicsScene(definition, { frameCount: 10 * FRAMES_PER_SECOND + 1 });
    let submergedTotal = 0;
    let samples = 0;
    for (let time = 5; time <= 10; time += 0.1) {
      const [x, y, z] = scene.sample(time);
      const surface = CLIP_SEA.level + seaHeightAt(sea, x, z, time);
      assert.ok(y - surface > -0.6, `density ${density} crate sank to ${y - surface} m below the waterline at ${time} s`);
      submergedTotal += Math.min(1, Math.max(0, (surface - y) / CRATE_SIDE + 0.5));
      samples++;
    }
    const meanSubmerged = submergedTotal / samples;
    assert.ok(Math.abs(meanSubmerged - density / 1000) < 0.1, `density ${density} sat ${meanSubmerged} submerged`);
  }
});
