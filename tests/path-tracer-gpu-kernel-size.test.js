import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';

// The shader compiler of the GPU drivers inlines every function call, so a function called from n places is built n times, and
// the traversal is the costliest of them: before these limits the first draw of a page took 108 s on an RTX 3060 (issue #861,
// bench/reference/cold-draw.mjs). A new call site, or a larger kernel, needs a measurement of the cold first draw first.

const VARIANTS = {
  plain: {},
  subsurface: { hasSubsurface: true },
  texelBake: { texelBake: true },
  blueNoise: { blueNoise: true },
  importance: { lightImportance: true },
  tree: { lightTree: true },
  radianceCache: { radianceCache: true },
  everything: { hasSubsurface: true, blueNoise: true, lightImportance: true, lightTree: true, radianceCache: true },
};

function callSites(source, name) {
  const calls = source.match(new RegExp(`(?<![A-Za-z0-9_])${name}\\(`, 'g')) ?? [];
  return calls.length - 1; // the definition
}

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`the ${name} kernel holds one shadow ray and one emitter sampler`, () => {
    const source = buildFragmentSource(variant);
    assert.equal(callSites(source, 'sampleEmitter'), 1, 'sampleEmitter is called from one place, in addLights');
    assert.equal(callSites(source, 'flushShadowRay'), 1, 'flushShadowRay is called from one place, in addLights');
    assert.equal(callSites(source, 'occluded'), 1, 'occluded is called from flushShadowRay only');
    assert.equal(callSites(source, 'traceRay'), 2, 'traceRay is called by intersectScene and occluded only');
    assert.equal(callSites(source, 'intersectScene'), variant.hasSubsurface ? 2 : 1, 'intersectScene is called from tracePath, and from the random walk of a subsurface scene');
  });
}

test('the plain kernel stays under its source size', () => {
  const kilobytes = buildFragmentSource().length / 1024;
  assert.ok(kilobytes < 48, `the plain kernel is ${kilobytes.toFixed(1)} KB; it was 46 KB when the cold first draw measured 27 s`);
});
