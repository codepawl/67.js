import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';

const NATIVE_KERNEL_SOURCE = readFileSync(new URL('../packages/render-native/src/kernel.wgsl', import.meta.url), 'utf8');

// The metal lobe (specular colour, visible normal sampling, masking, the microfacet term) and the firefly clamp.
// Cook native and Cook webgpu must give the same error on the metal reference scene at the same clamp (#936).
const SHARED_FUNCTIONS = [
  'schlick',
  'schlickColor',
  'smithMasking',
  'ggxDistribution',
  'roughnessToAlpha',
  'sampleVisibleNormal',
  'microfacetTerm',
  'specularAlbedoTerms',
  'lookupSpecularWhiteAlbedo',
  'multipleScatteringFactor',
  'dielectricSpecularAlbedo',
  'evaluateSurface',
  'sampleSurface',
  'glossyBlurAlpha',
  'prepareSurface',
  'mirrorWeight',
  'addRadiance',
];

function extractFunction(source, name) {
  const start = source.indexOf(`\nfn ${name}(`) + 1;
  assert.notEqual(start, 0, `fn ${name} is missing`);
  const firstBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = firstBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/\s+/g, ' ');
  }
  throw new Error(`fn ${name} is not closed`);
}

for (const name of SHARED_FUNCTIONS) {
  test(`${name} is the same WGSL in Cook native and Cook webgpu`, () => {
    assert.equal(extractFunction(MEGAKERNEL_SOURCE, name), extractFunction(NATIVE_KERNEL_SOURCE, name));
  });
}

test('both kernels clamp only the radiance of bounces after the first, by the same peak rule', () => {
  const clamp = extractFunction(NATIVE_KERNEL_SOURCE, 'addRadiance');
  assert.match(clamp, /if \(depth > 0\)/);
  assert.match(clamp, /amount \*= params\.cameraAndClamp\.z \/ peak/);
});

test('the tier bench gives every Cook backend the same firefly clamp and records it', () => {
  const driver = readFileSync(new URL('../bench/tiers/run-all.mjs', import.meta.url), 'utf8');
  assert.match(driver, /'--firefly-clamp', String\(fireflyClamp\)/);
  assert.match(driver, /fireflyClamp: 1000/);
  assert.doesNotMatch(driver, /1000000000/);
});

test('both kernels step camera rays through a part flagged in texel 5 of its material, and no other ray', () => {
  const nativeTrace = extractFunction(NATIVE_KERNEL_SOURCE, 'traceRay');
  assert.match(nativeTrace, /if \(cameraRay && materials\[material \+ 5\]\.y > 0\.0\) \{ continue; \}/);
  assert.match(extractFunction(NATIVE_KERNEL_SOURCE, 'occluded'), /traceRay\(origin, direction, limit, true, false\)/);
  assert.match(extractFunction(MEGAKERNEL_SOURCE, 'nearestHitIsShadowOnly'), /MATERIAL_TEXELS \+ 5\]\.y > 0\.0/);
  assert.match(extractFunction(MEGAKERNEL_SOURCE, 'intersectScene'), /cameraRay && nearestHitIsShadowOnly\(\)/);
  assert.match(extractFunction(NATIVE_KERNEL_SOURCE, 'tracePath'), /intersectScene\(position, direction, cameraRays && depth == 0\)/);
  assert.match(extractFunction(MEGAKERNEL_SOURCE, 'tracePath'), /intersectScene\(position, direction, cameraRays && depth == 0\)/);
});
