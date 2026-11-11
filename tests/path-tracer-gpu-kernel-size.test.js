import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// Measured source sizes in KB (plain 45.3, subsurface 50.3, texelBake 45.5, blueNoise 45.3, importance 45.3, tree 49.5, radianceCache 47.4,
// everything 56.4); each limit leaves about 1.5 KB. The plain kernel measured 27 s cold at 46 KB.
const SIZE_LIMIT_KILOBYTES = { plain: 47, subsurface: 52, texelBake: 47, blueNoise: 47, importance: 47, tree: 51, radianceCache: 49, everything: 58 };

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`the ${name} kernel stays under its source size`, () => {
    const kilobytes = buildFragmentSource(variant).length / 1024;
    assert.ok(kilobytes < SIZE_LIMIT_KILOBYTES[name], `the ${name} kernel is ${kilobytes.toFixed(1)} KB, limit ${SIZE_LIMIT_KILOBYTES[name]} KB; measure bench/reference/cold-draw.mjs before raising it`);
  });
}

test('one scene links one kernel: the gpu backend builds a program from one place and every kernel has one main', () => {
  const backend = readFileSync(new URL('../src/path-tracer-gpu.js', import.meta.url), 'utf8');
  assert.equal(backend.match(/= createProgram\(gl,/g).length, 1, 'createProgram(gl, variant) is called from one place');
  for (const variant of Object.values(VARIANTS)) {
    assert.equal(buildFragmentSource(variant).match(/void main\s*\(/g).length, 1);
  }
});

test('the cold draw bench closes the browser of every run in a finally block, so a failed run does not hold the GPU', () => {
  const bench = readFileSync(new URL('../bench/reference/cold-draw.mjs', import.meta.url), 'utf8');
  const launchIndex = bench.indexOf('chromium.launch(');
  const closeIndex = bench.indexOf('await browser.close();');
  assert.ok(launchIndex >= 0 && closeIndex > launchIndex, 'the bench launches and closes a browser');
  assert.match(bench.slice(launchIndex, closeIndex), /try \{[\s\S]*\} finally \{\s*$/, 'the close sits in the finally of a try that wraps the run');
  assert.equal(bench.match(/await browser\.close\(\)/g).length, 1);
});
