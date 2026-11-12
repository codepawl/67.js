import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The survival rule is GPU code, so these tests pin its source: the Cycles rule (square root of the largest throughput channel,
// kernel/integrator/path_state.h `path_state_continuation_probability`) and its use at both Russian roulette sites. Measured effect
// (#966): with the plain throughput, emissive scenes carried 47 percent more error than Cycles at equal samples.
const integratorSource = readFileSync(new URL('../packages/render-native/src/cycles/integrator.wgsl', import.meta.url), 'utf8');

function functionBody(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `integrator.wgsl declares ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

test('the Russian roulette survival is the square root of the largest throughput channel, as in Cycles', () => {
  const body = functionBody(integratorSource, 'int_russian_roulette_survival');
  assert.match(body, /abs\(throughput\.x\)/, 'channels enter by magnitude, like fabs() in Cycles');
  assert.match(body, /sqrt\(largest_channel\)/, 'the largest channel goes through a square root');
  assert.match(body, /clamp\([^;]*,\s*0\.05,\s*1\.0\)/, 'survival stays in [0.05, 1]');
});

test('surface and volume paths both use the shared survival rule and keep no inline linear rule', () => {
  const callSites = integratorSource.match(/int_russian_roulette_survival\(throughput\)/g) ?? [];
  assert.equal(callSites.length, 2, 'one call after a volume scatter and one after a surface bounce');
  assert.doesNotMatch(integratorSource, /clamp\(max_channel,/, 'no survival probability is computed from the plain throughput');
});
