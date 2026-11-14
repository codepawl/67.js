import test from 'node:test';
import assert from 'node:assert/strict';
import { fragmentShader } from '../src/shaders.js';

// A line-for-line port of ensureValidReflection in src/shaders.js, so the algorithm can be checked on the CPU.
const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
const scale = (vector, factor) => vector.map(value => value * factor);
const add = (left, right) => left.map((value, index) => value + right[index]);
const subtract = (left, right) => left.map((value, index) => value - right[index]);
const normalize = vector => scale(vector, 1 / Math.hypot(...vector));

function ensureValidReflection(geometricNormal, viewDirection, normalInput) {
  let normal = normalInput;
  const normalHeight = dot(normal, geometricNormal);
  if (normalHeight < 0) normal = subtract(normal, scale(geometricNormal, 2 * normalHeight));
  const reflected = subtract(scale(normal, 2 * dot(normal, viewDirection)), viewDirection);
  const threshold = Math.min(0.9 * dot(geometricNormal, viewDirection), 0.01);
  if (dot(geometricNormal, reflected) >= threshold) return normal;
  const tangentPart = subtract(normal, scale(geometricNormal, dot(normal, geometricNormal)));
  if (dot(tangentPart, tangentPart) < 1e-12) return normal;
  const axisX = normalize(tangentPart);
  const viewX = dot(viewDirection, axisX);
  const viewZ = dot(viewDirection, geometricNormal);
  const lengthSquared = viewX * viewX + viewZ * viewZ;
  const root = Math.sqrt(Math.max(viewX * viewX * (lengthSquared - threshold * threshold), 0));
  const offset = viewZ * threshold + lengthSquared;
  const firstZ2 = 0.5 * (root + offset) / lengthSquared;
  const secondZ2 = 0.5 * (offset - root) / lengthSquared;
  const firstValid = firstZ2 > 1e-5 && firstZ2 <= 1.00001;
  const secondValid = secondZ2 > 1e-5 && secondZ2 <= 1.00001;
  if (!firstValid && !secondValid) return geometricNormal;
  const first = [Math.sqrt(Math.max(1 - firstZ2, 0)), Math.sqrt(firstZ2)];
  const second = [Math.sqrt(Math.max(1 - secondZ2, 0)), Math.sqrt(secondZ2)];
  let bent = firstValid ? first : second;
  if (firstValid && secondValid) {
    const height = candidate => 2 * (candidate[0] * viewX + candidate[1] * viewZ) * candidate[1] - viewZ;
    const firstHeight = height(first);
    const secondHeight = height(second);
    if (firstHeight >= 1e-5 && secondHeight >= 1e-5) bent = firstHeight < secondHeight ? first : second;
    else bent = firstHeight > secondHeight ? first : second;
  }
  return normalize(add(scale(axisX, bent[0]), scale(geometricNormal, bent[1])));
}

const surface = [0, 1, 0];
const view = normalize([0.3, 0.4, 1]);
const reflectionHeight = normal => dot(surface, subtract(scale(normal, 2 * dot(normal, view)), view));

test('a normal that reflects above the surface is returned unchanged', () => {
  for (const tilt of [0, 0.1, -0.2, 0.35]) {
    const normal = normalize([tilt, 1, -tilt * 0.5]);
    assert.deepEqual(ensureValidReflection(surface, view, normal), normal);
  }
});

test('a normal tilted so far that the reflection goes below the surface ends above it', () => {
  const tilted = normalize([-1.2, 0.5, 0.2]);
  assert.ok(reflectionHeight(tilted) < 0, 'the input must be invalid');
  const bent = ensureValidReflection(surface, view, tilted);
  assert.ok(reflectionHeight(bent) >= 0.0099, `reflection height ${reflectionHeight(bent)}`);
  assert.ok(dot(bent, surface) > dot(tilted, surface), 'it moved toward the surface normal');
  assert.ok(Math.abs(Math.hypot(...bent) - 1) < 1e-9);
});

test('a normal pointing into the surface is folded out with its tilt kept', () => {
  const inward = normalize([0.18, -0.9, -0.14]);
  const folded = ensureValidReflection(surface, view, inward);
  assert.ok(dot(folded, surface) > 0);
  assert.ok(Math.abs(folded[0] - inward[0]) < 1e-9, 'the sideways tilt is kept');
  assert.ok(reflectionHeight(folded) >= 0.0099);
});

test('the fragment shader applies the helper to the mapped normal', () => {
  assert.match(fragmentShader, /vec3 ensureValidReflection\(/);
  assert.match(fragmentShader, /ensureValidReflection\(geometricNormal, viewDirection,/);
});
