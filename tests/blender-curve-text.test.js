import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { curve } from '../src/modeling.js';
import { text } from '../src/text-geometry.js';

// Curve and text objects are compared by volume, area and bounds, because Blender merges the seam vertices that
// Crucible keeps for its UVs, so vertex counts differ by design. Cases and results come from tests/fixtures/blender,
// written by scripts/blender-golden.py.
const FIXTURE_DIRECTORY = new URL('./fixtures/blender/', import.meta.url);
const readFixture = name => JSON.parse(readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8'));
const { curves: curveCases, texts: textCases } = readFixture('cases.json');
const golden = readFixture('golden.json');

// Measured differences are below 2e-5 for volume and area; these leave room for another Blender release.
const CURVE_MEASURE_TOLERANCE = 1e-4;
const TEXT_MEASURE_TOLERANCE = 1e-4;
const BOUNDS_TOLERANCE = 1e-3;

function subtract(first, second) {
  return first.map((value, axis) => value - second[axis]);
}

function cross([ax, ay, az], [bx, by, bz]) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function dot(first, second) {
  return first.reduce((sum, value, axis) => sum + value * second[axis], 0);
}

function measureSurface({ positions, indices }) {
  let volume = 0;
  let area = 0;
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  const corner = index => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    corner(vertex).forEach((value, axis) => {
      lower[axis] = Math.min(lower[axis], value);
      upper[axis] = Math.max(upper[axis], value);
    });
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    const first = corner(indices[offset]);
    const second = corner(indices[offset + 1]);
    const third = corner(indices[offset + 2]);
    volume += dot(first, cross(second, third)) / 6;
    area += Math.hypot(...cross(subtract(second, first), subtract(third, first))) / 2;
  }
  return { volume, area, boundsMin: lower, boundsMax: upper };
}

function compareToBlender(measured, expected, tolerance) {
  for (const metric of ['volume', 'area']) {
    const relative = Math.abs(measured[metric] - expected[metric]) / expected[metric];
    assert.ok(relative <= tolerance, `${metric} ${measured[metric].toFixed(5)} against Blender's ${expected[metric].toFixed(5)}`);
  }
  for (const metric of ['boundsMin', 'boundsMax']) {
    measured[metric].forEach((value, axis) => {
      assert.ok(Math.abs(value - expected[metric][axis]) <= BOUNDS_TOLERANCE, `${metric}[${axis}] ${value.toFixed(5)} against Blender's ${expected[metric][axis]}`);
    });
  }
}

test('the golden file has a result for each curve and text case', () => {
  assert.deepEqual(Object.keys(golden.curves).sort(), curveCases.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(golden.texts).sort(), textCases.map(({ id }) => id).sort());
});

for (const { id, curve: spec } of curveCases) {
  test(`${id} matches Blender's evaluated Bezier curve in volume, area and bounds`, () => {
    compareToBlender(measureSurface(curve(spec.points, spec)), golden.curves[id], CURVE_MEASURE_TOLERANCE);
  });
}

for (const { id, text: spec } of textCases) {
  test(`${id} matches Blender's text object in volume, area and bounds, using the same font`, () => {
    compareToBlender(measureSurface(text(spec.text, spec)), golden.texts[id], TEXT_MEASURE_TOLERANCE);
  });
}
