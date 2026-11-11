import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloth } from '../src/cloth.js';
import { createAgentScene } from '../src/agent-scene.js';
import './support/load-agent-scene-modules.mjs';
import { foldingFlagRecipe } from '../scripts/soft-body-film.mjs';

// A 5 by 5 grid, 0.2 m across, lying on a slope tilted `degrees` about the Z axis and 2 mm above its top face (the box is 1 m thick).
function sheetOnSlope(degrees) {
  const angle = degrees * Math.PI / 180;
  const segments = 4;
  const side = segments + 1;
  const along = [Math.cos(angle), -Math.sin(angle), 0];
  const up = [Math.sin(angle), Math.cos(angle), 0];
  const positions = new Float64Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const x = (column / segments - 0.5) * 0.2;
      const z = (row / segments - 0.5) * 0.2;
      positions.set([along[0] * x + up[0] * 0.502, along[1] * x + up[1] * 0.502, z], (row * side + column) * 3);
    }
  }
  const triangles = [];
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const corner = row * side + column;
      triangles.push(corner, corner + side, corner + 1, corner + 1, corner + side, corner + side + 1);
    }
  }
  const slope = { kind: 'box', center: [0, 0, 0], axes: [along, up, [0, 0, 1]], halfExtents: [3, 0.5, 3] };
  return { positions, triangles: Uint32Array.from(triangles), slope };
}

// How far the sheet's centre slides along the slope in `seconds`.
function slideAlongSlope(degrees, seconds, options) {
  const { positions, triangles, slope } = sheetOnSlope(degrees);
  const cloth = createCloth(positions, triangles, { colliders: [slope], thickness: 0.002, ...options });
  const centre = () => cloth.positions.reduce((sum, value, index) => (index % 3 === 0 ? sum + value : sum), 0) / cloth.particleCount;
  const start = centre();
  for (let step = 0; step < seconds * 60; step++) cloth.step(1 / 60);
  return Math.abs(centre() - start) / Math.cos(degrees * Math.PI / 180);
}

test('static friction holds a sheet on a slope below the friction angle and lets it slide above it', context => {
  const held = slideAlongSlope(25, 2, { staticFriction: 1, friction: 0.05 });
  const slidingWithout = slideAlongSlope(25, 2, { friction: 0.05 });
  const slidingSteep = slideAlongSlope(60, 2, { staticFriction: 1, friction: 0.05 });
  context.diagnostic(`slid ${held.toFixed(4)} m at 25 degrees with static friction, ${slidingWithout.toFixed(3)} m without, ${slidingSteep.toFixed(3)} m at 60 degrees with it`);
  assert.ok(held < 0.005, `a 25 degree slope with staticFriction 1 holds the sheet (slid ${held} m)`);
  assert.ok(slidingWithout > 0.1, `without static friction the sheet slides (${slidingWithout} m)`);
  assert.ok(slidingSteep > 0.1, `above the friction angle (45 degrees) the sheet still slides (${slidingSteep} m)`);
  assert.equal(slideAlongSlope(25, 2, { staticFriction: 1, friction: 0.05 }), held, 'it is deterministic');
});

test('a recipe sheet takes staticFriction and pinTo.releaseAt, and a pin let go falls with the rest', () => {
  const recipe = foldingFlagRecipe({ fine: true });
  recipe.geometries[0].segments = 8;
  const sheet = recipe.cloth.sheets[0];
  assert.equal(sheet.staticFriction, 1);
  assert.equal(sheet.pinTo.releaseAt, 0.8);
  const heightOfCorner = (releaseAt, time) => {
    recipe.cloth.sheets[0].pinTo = { node: 'pole', ...(releaseAt === undefined ? {} : { releaseAt }) };
    recipe.cloth.sheets[0].selfCollision = false;
    const scene = createAgentScene(recipe);
    scene.sampleMotion(time);
    const positions = scene.parts.find(part => part.name === 'flag').geometry.positions;
    let highest = -Infinity;
    for (let index = 1; index < positions.length; index += 3) highest = Math.max(highest, positions[index]);
    return highest;
  };
  // Held, the top edge rides the pole; released at 0.2 s it falls free, so the highest point at 0.5 s differs.
  const held = heightOfCorner(undefined, 0.5);
  const released = heightOfCorner(0.2, 0.5);
  assert.notEqual(held, released, 'letting go changes where the sheet ends');
  assert.equal(heightOfCorner(0.2, 0.5), released, 'it is deterministic');
  recipe.cloth.sheets[0].staticFriction = 2;
  assert.throws(() => createAgentScene(recipe), /staticFriction/);
  recipe.cloth.sheets[0].staticFriction = 1;
  recipe.cloth.sheets[0].pinTo = { node: 'pole', releaseAt: -1 };
  assert.throws(() => createAgentScene(recipe), /releaseAt/);
});
